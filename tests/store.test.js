import assert from "node:assert/strict";
import test from "node:test";
import { MemoryRoomStore } from "../src/store/memory.js";

function participant(id, role = "guest") {
  return {
    id, name: id, role, tokenHash: `hash-${id}`, connected: true,
    instanceId: "instance", connectionId: `connection-${id}`, disconnectDeadlineAt: null,
  };
}

function room(expiresAt = 50_000) {
  const host = participant("host", "host");
  return {
    code: "ABC234", media: { mediaType: "movie", tmdbId: 42 }, hostId: host.id,
    createdAt: 1, expiresAt, participants: { [host.id]: host },
  };
}

test("memory store enforces eight participants atomically", async () => {
  const store = new MemoryRoomStore();
  await store.createRoom(room());
  for (let index = 1; index < 8; index += 1) {
    assert.equal((await store.joinRoom("ABC234", participant(`guest-${index}`), 2)).status, "ok");
  }
  assert.equal((await store.joinRoom("ABC234", participant("guest-8"), 2)).status, "full");
  assert.equal((await store.stats()).participants, 8);
});

test("memory store resumes only with the token hash", async () => {
  const store = new MemoryRoomStore();
  const initial = room();
  await store.createRoom(initial);
  assert.equal((await store.resumeParticipant("ABC234", "host", "wrong", {}, 2)).status, "rejected");
  const resumed = await store.resumeParticipant("ABC234", "host", "hash-host", {
    instanceId: "new-instance", connectionId: "new-connection",
  }, 2);
  assert.equal(resumed.status, "ok");
  assert.equal(resumed.participant.connectionId, "new-connection");
});

test("memory store sweeps guests and closes rooms for expired hosts", async () => {
  const store = new MemoryRoomStore();
  const initial = room();
  initial.participants.guest = { ...participant("guest"), connected: false, disconnectDeadlineAt: 10 };
  await store.createRoom(initial);
  let actions = await store.sweep(11);
  assert.equal(actions[0].type, "guest-left");
  await store.markDisconnected("ABC234", "host", "connection-host", 20);
  actions = await store.sweep(21);
  assert.deepEqual(actions.map((action) => action.type), ["close"]);
  assert.equal(actions[0].reason, "host-disconnected");
});

test("memory store expires rooms and rate limits by key", async () => {
  let stamp = 100;
  const store = new MemoryRoomStore({ now: () => stamp });
  await store.createRoom(room(110));
  assert.equal((await store.sweep(111))[0].reason, "expired");
  assert.equal((await store.rateLimit("join:ip", 2, 10)).allowed, true);
  assert.equal((await store.rateLimit("join:ip", 2, 10)).allowed, true);
  assert.equal((await store.rateLimit("join:ip", 2, 10)).allowed, false);
  stamp = 111;
  assert.equal((await store.rateLimit("join:ip", 2, 10)).allowed, true);
});
