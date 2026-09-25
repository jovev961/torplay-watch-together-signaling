import assert from "node:assert/strict";
import test from "node:test";
import { RedisRoomStore } from "../src/store/redis.js";

const url = process.env.TEST_REDIS_URL;

test("Redis adapter shares room state and pub/sub", { skip: !url }, async () => {
  const prefix = `twts-test-${Date.now()}`;
  const first = new RedisRoomStore({ url, prefix });
  const second = new RedisRoomStore({ url, prefix });
  await Promise.all([first.connect(), second.connect()]);
  try {
    const room = {
      code: "ABC234", media: { mediaType: "movie", tmdbId: 1 }, hostId: "host",
      createdAt: Date.now(), expiresAt: Date.now() + 60_000,
      participants: { host: { id: "host", name: "Host", role: "host", connected: true } },
    };
    assert.equal(await first.createRoom(room), true);
    assert.equal((await second.getRoom("ABC234")).hostId, "host");
    const received = new Promise((resolve) => second.subscribe("test", resolve));
    await first.publish("test", { ok: true });
    assert.deepEqual(await received, { ok: true });
    assert.equal((await first.resetAll()).length, 1);
  } finally {
    await Promise.allSettled([first.close(), second.close()]);
  }
});
