import { EventEmitter } from "node:events";
import { MAX_ROOM_SIZE } from "../config.js";

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

export class MemoryRoomStore {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.rooms = new Map();
    this.rates = new Map();
    this.events = new EventEmitter();
  }

  async connect() {}
  async close() { this.events.removeAllListeners(); }
  async health() { return true; }

  async createRoom(room) {
    if (this.rooms.has(room.code)) return false;
    this.rooms.set(room.code, clone(room));
    return true;
  }

  async getRoom(code) {
    return clone(this.rooms.get(code));
  }

  async joinRoom(code, participant, now) {
    const room = this.rooms.get(code);
    if (!room || room.expiresAt <= now) return { status: "not-found" };
    if (Object.keys(room.participants).length >= MAX_ROOM_SIZE) return { status: "full" };
    room.participants[participant.id] = clone(participant);
    return { status: "ok", room: clone(room) };
  }

  async resumeParticipant(code, participantId, tokenHash, connection, now) {
    const room = this.rooms.get(code);
    const participant = room?.participants[participantId];
    if (!room || room.expiresAt <= now || !participant || participant.tokenHash !== tokenHash) return { status: "rejected" };
    const previous = clone(participant);
    Object.assign(participant, connection, { connected: true, disconnectDeadlineAt: null });
    return { status: "ok", room: clone(room), participant: clone(participant), previous };
  }

  async markDisconnected(code, participantId, connectionId, deadline) {
    const room = this.rooms.get(code);
    const participant = room?.participants[participantId];
    if (!participant || participant.connectionId !== connectionId) return null;
    participant.connected = false;
    participant.connectionId = null;
    participant.instanceId = null;
    participant.disconnectDeadlineAt = deadline;
    return clone(room);
  }

  async removeParticipant(code, participantId) {
    const room = this.rooms.get(code);
    if (!room || !room.participants[participantId]) return null;
    delete room.participants[participantId];
    return clone(room);
  }

  async changeMedia(code, participantId, media) {
    const room = this.rooms.get(code);
    if (!room || room.hostId !== participantId) return null;
    room.media = clone(media);
    return clone(room);
  }

  async closeRoom(code) {
    const room = this.rooms.get(code);
    if (!room) return null;
    this.rooms.delete(code);
    return clone(room);
  }

  async sweep(now = this.now()) {
    const actions = [];
    for (const code of [...this.rooms.keys()]) actions.push(...await this.processRoom(code, now));
    return actions;
  }

  async processRoom(code, now = this.now()) {
    const room = this.rooms.get(code);
    if (!room) return [];
    if (room.expiresAt <= now) {
      this.rooms.delete(room.code);
      return [{ type: "close", reason: "expired", room: clone(room) }];
    }
    const actions = [];
    for (const participant of Object.values(room.participants)) {
      if (participant.connected || !participant.disconnectDeadlineAt || participant.disconnectDeadlineAt > now) continue;
      if (participant.role === "host") {
        this.rooms.delete(room.code);
        return [{ type: "close", reason: "host-disconnected", room: clone(room) }];
      }
      delete room.participants[participant.id];
      actions.push({ type: "guest-left", participantId: participant.id, room: clone(room) });
    }
    return actions;
  }

  async resetAll() {
    const rooms = [...this.rooms.values()].map(clone);
    this.rooms.clear();
    return rooms;
  }

  async stats() {
    let participants = 0;
    let connected = 0;
    for (const room of this.rooms.values()) {
      for (const participant of Object.values(room.participants)) {
        participants += 1;
        if (participant.connected) connected += 1;
      }
    }
    return { rooms: this.rooms.size, participants, connected };
  }

  async rateLimit(key, limit, windowMs) {
    const now = this.now();
    let bucket = this.rates.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      this.rates.set(key, bucket);
    }
    bucket.count += 1;
    return { allowed: bucket.count <= limit, remaining: Math.max(0, limit - bucket.count), resetAt: bucket.resetAt };
  }

  async publish(channel, message) {
    queueMicrotask(() => this.events.emit(channel, clone(message)));
  }

  async subscribe(channel, handler) {
    this.events.on(channel, handler);
    return () => this.events.off(channel, handler);
  }
}
