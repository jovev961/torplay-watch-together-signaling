import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createClient } from "redis";
import { MAX_ROOM_SIZE } from "../config.js";

const LOCK_MS = 3_000;
const RETENTION_MS = 5 * 60 * 1000;

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

export class RedisRoomStore {
  constructor({ url, prefix = "twts", now = () => Date.now(), clientFactory = createClient } = {}) {
    if (!url) throw new Error("Redis URL is required.");
    this.url = url;
    this.prefix = prefix;
    this.now = now;
    this.clientFactory = clientFactory;
    this.client = null;
    this.subscriber = null;
    this.subscriptions = new Map();
  }

  key(...parts) { return [this.prefix, ...parts].join(":"); }
  roomKey(code) { return this.key("room", code); }
  lockKey(code) { return this.key("lock", code); }
  roomsKey() { return this.key("rooms"); }
  channel(name) { return this.key("channel", name); }

  async connect() {
    if (this.client?.isOpen) return;
    this.client = this.clientFactory({ url: this.url });
    this.subscriber = this.client.duplicate();
    this.client.on("error", (error) => console.error("Redis command error:", error.message));
    this.subscriber.on("error", (error) => console.error("Redis subscriber error:", error.message));
    await Promise.all([this.client.connect(), this.subscriber.connect()]);
  }

  async close() {
    const tasks = [];
    if (this.subscriber?.isOpen) tasks.push(this.subscriber.quit());
    if (this.client?.isOpen) tasks.push(this.client.quit());
    await Promise.allSettled(tasks);
  }

  async health() {
    return (await this.client.ping()) === "PONG";
  }

  async acquire(code) {
    const token = randomUUID();
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const result = await this.client.set(this.lockKey(code), token, { NX: true, PX: LOCK_MS });
      if (result === "OK") return token;
      await delay(10 + Math.floor(Math.random() * 20));
    }
    throw new Error("Room state is busy. Try again.");
  }

  async release(code, token) {
    await this.client.eval(
      "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
      { keys: [this.lockKey(code)], arguments: [token] },
    );
  }

  async readRoom(code) {
    const value = await this.client.get(this.roomKey(code));
    return value ? JSON.parse(value) : null;
  }

  async writeRoom(room) {
    await this.client.multi()
      .set(this.roomKey(room.code), JSON.stringify(room), { PXAT: room.expiresAt + RETENTION_MS })
      .zAdd(this.roomsKey(), [{ score: room.expiresAt, value: room.code }])
      .exec();
  }

  async withRoom(code, operation) {
    const token = await this.acquire(code);
    try {
      const room = await this.readRoom(code);
      const result = await operation(room);
      if (result?.delete) {
        await this.client.multi().del(this.roomKey(code)).zRem(this.roomsKey(), code).exec();
      } else if (result?.room) {
        await this.writeRoom(result.room);
      }
      return result?.value;
    } finally {
      await this.release(code, token);
    }
  }

  async createRoom(room) {
    return this.withRoom(room.code, async (existing) => {
      if (existing) return { value: false };
      return { room: clone(room), value: true };
    });
  }

  async getRoom(code) {
    return clone(await this.readRoom(code));
  }

  async joinRoom(code, participant, now) {
    return this.withRoom(code, async (room) => {
      if (!room || room.expiresAt <= now) return { value: { status: "not-found" } };
      if (Object.keys(room.participants).length >= MAX_ROOM_SIZE) return { value: { status: "full" } };
      room.participants[participant.id] = clone(participant);
      return { room, value: { status: "ok", room: clone(room) } };
    });
  }

  async resumeParticipant(code, participantId, tokenHash, connection, now) {
    return this.withRoom(code, async (room) => {
      const participant = room?.participants[participantId];
      if (!room || room.expiresAt <= now || !participant || participant.tokenHash !== tokenHash) {
        return { value: { status: "rejected" } };
      }
      const previous = clone(participant);
      Object.assign(participant, connection, { connected: true, disconnectDeadlineAt: null });
      return {
        room,
        value: { status: "ok", room: clone(room), participant: clone(participant), previous },
      };
    });
  }

  async markDisconnected(code, participantId, connectionId, deadline) {
    return this.withRoom(code, async (room) => {
      const participant = room?.participants[participantId];
      if (!participant || participant.connectionId !== connectionId) return { value: null };
      participant.connected = false;
      participant.connectionId = null;
      participant.instanceId = null;
      participant.disconnectDeadlineAt = deadline;
      return { room, value: clone(room) };
    });
  }

  async removeParticipant(code, participantId) {
    return this.withRoom(code, async (room) => {
      if (!room || !room.participants[participantId]) return { value: null };
      delete room.participants[participantId];
      return { room, value: clone(room) };
    });
  }

  async changeMedia(code, participantId, media) {
    return this.withRoom(code, async (room) => {
      if (!room || room.hostId !== participantId) return { value: null };
      room.media = clone(media);
      return { room, value: clone(room) };
    });
  }

  async closeRoom(code) {
    return this.withRoom(code, async (room) => ({ delete: Boolean(room), value: clone(room) }));
  }

  async processRoom(code, now) {
    return this.withRoom(code, async (room) => {
      if (!room) {
        await this.client.zRem(this.roomsKey(), code);
        return { value: [] };
      }
      if (room.expiresAt <= now) return { delete: true, value: [{ type: "close", reason: "expired", room: clone(room) }] };
      const actions = [];
      for (const participant of Object.values(room.participants)) {
        if (participant.connected || !participant.disconnectDeadlineAt || participant.disconnectDeadlineAt > now) continue;
        if (participant.role === "host") {
          return { delete: true, value: [{ type: "close", reason: "host-disconnected", room: clone(room) }] };
        }
        delete room.participants[participant.id];
        actions.push({ type: "guest-left", participantId: participant.id, room: clone(room) });
      }
      return actions.length ? { room, value: actions } : { value: [] };
    });
  }

  async sweep(now = this.now()) {
    const codes = await this.client.zRange(this.roomsKey(), 0, -1);
    const actions = [];
    for (const code of codes) actions.push(...await this.processRoom(code, now));
    return actions;
  }

  async resetAll() {
    const codes = await this.client.zRange(this.roomsKey(), 0, -1);
    const rooms = (await Promise.all(codes.map((code) => this.readRoom(code)))).filter(Boolean);
    if (codes.length) await this.client.del(codes.map((code) => this.roomKey(code)));
    await this.client.del(this.roomsKey());
    return rooms.map(clone);
  }

  async stats() {
    const codes = await this.client.zRange(this.roomsKey(), 0, -1);
    if (!codes.length) return { rooms: 0, participants: 0, connected: 0 };
    const values = await this.client.mGet(codes.map((code) => this.roomKey(code)));
    let rooms = 0;
    let participants = 0;
    let connected = 0;
    for (const value of values) {
      if (!value) continue;
      rooms += 1;
      for (const participant of Object.values(JSON.parse(value).participants)) {
        participants += 1;
        if (participant.connected) connected += 1;
      }
    }
    return { rooms, participants, connected };
  }

  async rateLimit(key, limit, windowMs) {
    const redisKey = this.key("rate", key);
    const count = Number(await this.client.eval(
      "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('PEXPIRE',KEYS[1],ARGV[1]) end; return n",
      { keys: [redisKey], arguments: [String(windowMs)] },
    ));
    const ttl = await this.client.pTTL(redisKey);
    return {
      allowed: count <= limit,
      remaining: Math.max(0, limit - count),
      resetAt: this.now() + Math.max(0, ttl),
    };
  }

  async publish(channel, message) {
    await this.client.publish(this.channel(channel), JSON.stringify(message));
  }

  async subscribe(channel, handler) {
    const fullChannel = this.channel(channel);
    const listener = (message) => {
      try { handler(JSON.parse(message)); }
      catch (error) { console.error("Invalid Redis event:", error.message); }
    };
    this.subscriptions.set(fullChannel, listener);
    await this.subscriber.subscribe(fullChannel, listener);
    return async () => {
      this.subscriptions.delete(fullChannel);
      if (this.subscriber?.isOpen) await this.subscriber.unsubscribe(fullChannel, listener);
    };
  }
}
