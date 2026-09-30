import assert from "node:assert/strict";
import test from "node:test";
import WebSocket from "ws";
import { createTwtsService } from "../src/service.js";
import { MemoryRoomStore } from "../src/store/memory.js";

const TEST_ENV = {
  NODE_ENV: "test",
  WATCH_TOGETHER_STORE: "memory",
  WATCH_TOGETHER_ALLOWED_ORIGINS: "http://localhost:3000",
  TWTS_ADMIN_USERNAME: "admin",
  TWTS_ADMIN_PASSWORD: "test-password",
  TWTS_ADMIN_SESSION_SECRET: "test-session-secret-that-is-long-enough",
};

class Inbox {
  constructor(socket) {
    this.messages = [];
    this.waiters = [];
    socket.on("message", (data) => {
      const value = JSON.parse(String(data));
      const index = this.waiters.findIndex((waiter) => waiter.type === value.type);
      if (index >= 0) this.waiters.splice(index, 1)[0].resolve(value);
      else this.messages.push(value);
    });
  }

  next(type, timeoutMs = 2_000) {
    const existing = this.messages.findIndex((message) => message.type === type);
    if (existing >= 0) return Promise.resolve(this.messages.splice(existing, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { type, resolve: (value) => { clearTimeout(timer); resolve(value); } };
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error(`Timed out waiting for ${type}.`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }
}

async function open(port, origin = "http://localhost:3000") {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/signal`, { origin });
    socket.once("open", () => resolve({ socket, inbox: new Inbox(socket) }));
    socket.once("error", reject);
  });
}

function send(socket, message) {
  socket.send(JSON.stringify({ protocol: 1, ...message }));
}

async function service(options = {}) {
  const instance = await createTwtsService({ env: TEST_ENV, heartbeatIntervalMs: 5_000, ...options });
  const address = await instance.listen(0, "127.0.0.1");
  return { instance, port: address.port, base: `http://127.0.0.1:${address.port}` };
}

test("health, room lifecycle, and WebRTC relay work end to end", async () => {
  const { instance, port, base } = await service();
  const sockets = [];
  try {
    const health = await fetch(`${base}/health`).then((response) => response.json());
    assert.deepEqual(health, { status: "ok", service: "torplay-watch-together", protocol: 1, storage: "memory" });
    const host = await open(port);
    const guest = await open(port);
    sockets.push(host.socket, guest.socket);
    send(host.socket, { type: "create", name: "Host", media: { mediaType: "movie", tmdbId: 42 } });
    const hostRoom = await host.inbox.next("room");
    assert.equal(hostRoom.role, "host");
    assert.match(hostRoom.code, /^[A-HJ-NP-Z2-9]{6}$/);
    send(guest.socket, { type: "join", name: "Guest", code: hostRoom.code });
    const guestRoom = await guest.inbox.next("room");
    assert.equal(guestRoom.hostId, hostRoom.participantId);
    assert.equal((await host.inbox.next("peer-joined")).participant.id, guestRoom.participantId);
    send(host.socket, {
      type: "relay", targetId: guestRoom.participantId, kind: "offer", payload: { type: "offer", sdp: "v=0" },
    });
    const signal = await guest.inbox.next("signal");
    assert.equal(signal.fromId, hostRoom.participantId);
    assert.equal(signal.payload.sdp, "v=0");
    send(host.socket, { type: "leave" });
    assert.equal((await guest.inbox.next("room-closed")).reason, "host-left");
  } finally {
    for (const socket of sockets) socket.terminate();
    await instance.close();
  }
});

test("host-stream rooms require capable clients and preserve mode across resume", async () => {
  const { instance, port } = await service({ reconnectGraceMs: 1_000 });
  const sockets = [];
  try {
    const host = await open(port);
    const oldGuest = await open(port);
    sockets.push(host.socket, oldGuest.socket);
    send(host.socket, { type: "create", name: "Host", media: { mediaType: "movie", tmdbId: 42 },
      mode: "host-stream", capabilities: ["host-stream-v1"] });
    const hostRoom = await host.inbox.next("room");
    assert.equal(hostRoom.mode, "host-stream");
    assert.equal((await instance.store.getRoom(hostRoom.code)).mode, "host-stream");

    send(oldGuest.socket, { type: "join", name: "Old client", code: hostRoom.code });
    assert.equal((await oldGuest.inbox.next("error")).code, "UPGRADE_REQUIRED");

    host.socket.terminate();
    const resumed = await open(port);
    sockets.push(resumed.socket);
    send(resumed.socket, { type: "resume", code: hostRoom.code, participantId: hostRoom.participantId,
      reconnectToken: hostRoom.reconnectToken });
    assert.equal((await resumed.inbox.next("error")).code, "UPGRADE_REQUIRED");
    send(resumed.socket, { type: "resume", code: hostRoom.code, participantId: hostRoom.participantId,
      reconnectToken: hostRoom.reconnectToken, capabilities: ["host-stream-v1"] });
    const restored = await resumed.inbox.next("room");
    assert.equal(restored.mode, "host-stream");
  } finally {
    for (const socket of sockets) socket.terminate();
    await instance.close();
  }
});

test("origin allowlist rejects untrusted WebSocket upgrades", async () => {
  const { instance, port } = await service();
  try {
    await assert.rejects(open(port, "https://evil.example"), /403|Unexpected server response/);
  } finally {
    await instance.close();
  }
});

test("offer and ICE relay use active in-memory routes without room-store reads", async () => {
  const store = new MemoryRoomStore();
  let reads = 0;
  const originalGetRoom = store.getRoom.bind(store);
  store.getRoom = async (...args) => {
    reads += 1;
    return originalGetRoom(...args);
  };
  const { instance, port } = await service({ store });
  const sockets = [];
  try {
    const host = await open(port);
    const guest = await open(port);
    sockets.push(host.socket, guest.socket);
    send(host.socket, { type: "create", name: "Host", media: { mediaType: "movie", tmdbId: 42 } });
    const hostRoom = await host.inbox.next("room");
    send(guest.socket, { type: "join", name: "Guest", code: hostRoom.code });
    const guestRoom = await guest.inbox.next("room");
    await host.inbox.next("peer-joined");
    send(host.socket, {
      type: "relay", targetId: guestRoom.participantId, kind: "ice", payload: { candidate: "candidate:1" },
    });
    await guest.inbox.next("signal");
    assert.equal(reads, 0);
  } finally {
    for (const socket of sockets) socket.terminate();
    await instance.close();
  }
});

test("host can resume during grace and room closes after grace", async () => {
  const { instance, port } = await service({ reconnectGraceMs: 30 });
  const sockets = [];
  try {
    const host = await open(port);
    const guest = await open(port);
    sockets.push(host.socket, guest.socket);
    send(host.socket, { type: "create", name: "Host", media: { mediaType: "movie", tmdbId: 7 } });
    const hostRoom = await host.inbox.next("room");
    send(guest.socket, { type: "join", name: "Guest", code: hostRoom.code });
    await guest.inbox.next("room");
    host.socket.terminate();
    const resumed = await open(port);
    sockets.push(resumed.socket);
    send(resumed.socket, {
      type: "resume", code: hostRoom.code, participantId: hostRoom.participantId,
      reconnectToken: hostRoom.reconnectToken,
    });
    assert.equal((await resumed.inbox.next("room")).role, "host");
    resumed.socket.terminate();
    assert.equal((await guest.inbox.next("room-closed", 1_000)).reason, "host-disconnected");
  } finally {
    for (const socket of sockets) socket.terminate();
    await instance.close();
  }
});

function cookieFrom(response) {
  return response.headers.get("set-cookie").split(";")[0];
}

test("admin GUI authenticates and exposes aggregate operations only", async () => {
  let hookCalls = 0;
  const { instance, base } = await service({
    env: { ...TEST_ENV, TWTS_VERCEL_DEPLOY_HOOK_URL: "https://deploy.example/hook" },
    fetchImpl: async () => { hookCalls += 1; return { ok: true, status: 201 }; },
  });
  try {
    const page = await fetch(`${base}/admin`);
    assert.equal(page.status, 200);
    assert.doesNotMatch(await page.text(), /test-password|test-session-secret/);
    assert.equal((await fetch(`${base}/admin/api/status`)).status, 401);
    const login = await fetch(`${base}/admin/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base },
      body: JSON.stringify({ username: "admin", password: "test-password" }),
    });
    assert.equal(login.status, 200);
    const cookie = cookieFrom(login);
    const statusResponse = await fetch(`${base}/admin/api/status`, { headers: { Cookie: cookie } });
    const status = await statusResponse.json();
    assert.deepEqual(status.stats, { rooms: 0, participants: 0, connected: 0 });
    assert.equal(JSON.stringify(status).includes("test-password"), false);
    const restart = await fetch(`${base}/admin/api/actions/restart`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie, Origin: base },
      body: JSON.stringify({ confirm: "RESTART" }),
    });
    assert.equal(restart.status, 200);
    assert.equal(hookCalls, 1);
  } finally {
    await instance.close();
  }
});

test("admin mutations reject cross-origin requests", async () => {
  const { instance, base } = await service();
  try {
    const login = await fetch(`${base}/admin/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base },
      body: JSON.stringify({ username: "admin", password: "test-password" }),
    });
    const response = await fetch(`${base}/admin/api/actions/cleanup`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieFrom(login), Origin: "https://evil.example" },
      body: "{}",
    });
    assert.equal(response.status, 403);
  } finally {
    await instance.close();
  }
});

test("browser invite lookup and join preserve native room codes", async () => {
  const { instance, port, base } = await service();
  const sockets = [];
  try {
    const host = await open(port);
    sockets.push(host.socket);
    send(host.socket, { type: "create", name: "Host", media: { mediaType: "movie", tmdbId: 42 },
      displayTitle: "Example Film", mode: "host-stream", capabilities: ["host-stream-v1"] });
    const room = await host.inbox.next("room");
    assert.match(room.inviteId, new RegExp(`^${room.code}\\.[A-Za-z0-9_-]{32}$`));
    assert.equal(room.displayTitle, "Example Film");
    const lobby = await fetch(`${base}/api/invites/${room.inviteId}`);
    assert.equal(lobby.status, 200);
    const summary = await lobby.json();
    assert.equal(summary.displayTitle, "Example Film");
    assert.equal(summary.hostConnected, true);
    assert.deepEqual(summary.media, { mediaType: "movie", tmdbId: 42 });
    assert.ok(Array.isArray(summary.stunUrls));
    assert.equal("participants" in summary, false);
    assert.equal("reconnectToken" in summary, false);
    assert.equal((await fetch(`${base}/join/${room.inviteId}`)).status, 200);
    const guestScript = await fetch(`${base}/guest/app.js`);
    assert.equal(guestScript.status, 200);
    assert.match(guestScript.headers.get("content-type"), /javascript/);
    assert.equal((await fetch(`${base}/guest/style.css`)).status, 200);
    assert.equal((await fetch(`${base}/api/invites/${room.code}.${"x".repeat(32)}`)).status, 404);

    const invalid = await open(port);
    sockets.push(invalid.socket);
    send(invalid.socket, { type: "join", name: "Browser", code: room.code,
      inviteId: `${room.code}.${"x".repeat(32)}`, capabilities: ["host-stream-v1"] });
    assert.equal((await invalid.inbox.next("error")).code, "INVALID_INVITE");

    const browser = await open(port, base);
    sockets.push(browser.socket);
    send(browser.socket, { type: "join", name: "Browser", code: room.code,
      inviteId: room.inviteId, capabilities: ["host-stream-v1"] });
    assert.equal((await browser.inbox.next("room")).role, "guest");
    const native = await open(port);
    sockets.push(native.socket);
    send(native.socket, { type: "join", name: "Native", code: room.code, capabilities: ["host-stream-v1"] });
    assert.equal((await native.inbox.next("room")).role, "guest");
    send(host.socket, { type: "change-media", media: { mediaType: "tv", tmdbId: 99,
      seasonNumber: 1, episodeNumber: 4 }, displayTitle: "Example Series" });
    assert.equal((await browser.inbox.next("media-changed")).displayTitle, "Example Series");
    const changed = await fetch(`${base}/api/invites/${room.inviteId}`).then((response) => response.json());
    assert.equal(changed.displayTitle, "Example Series");
    assert.equal(changed.media.episodeNumber, 4);
    send(host.socket, { type: "leave" });
    assert.equal((await fetch(`${base}/api/invites/${room.inviteId}`)).status, 404);
  } finally {
    for (const socket of sockets) socket.terminate();
    await instance.close();
  }
});
