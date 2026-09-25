import assert from "node:assert/strict";
import test from "node:test";
import {
  ProtocolError,
  generateParticipant,
  hashToken,
  normalizeMedia,
  normalizeName,
  normalizeRoomCode,
  parseMessage,
} from "../src/protocol.js";

test("normalizes public room inputs", () => {
  assert.equal(normalizeRoomCode(" ab-c 234 "), "ABC234");
  assert.equal(normalizeName("  Viewer  "), "Viewer");
  assert.deepEqual(normalizeMedia({ mediaType: "show", tmdbId: "42", seasonNumber: 0, episodeNumber: 3 }), {
    mediaType: "tv", tmdbId: 42, seasonNumber: 0, episodeNumber: 3,
  });
});

test("rejects private media-source fields", () => {
  const privateMessages = [
    { protocol: 1, type: "create", name: "Host", media: { mediaType: "movie", tmdbId: 1, sourceUrl: "https://private" } },
    { protocol: 1, type: "create", name: "Host", media: { mediaType: "movie", tmdbId: 1 }, provider: "debrid" },
    { protocol: 1, type: "join", name: "Guest", code: "ABC234", credentials: { token: "secret" } },
  ];
  for (const message of privateMessages) {
    assert.throws(() => parseMessage(JSON.stringify(message)), ProtocolError);
  }
});

test("requires protocol v1 and exact message fields", () => {
  assert.throws(() => parseMessage(JSON.stringify({ type: "leave" })), /Protocol/);
  assert.throws(() => parseMessage(JSON.stringify({ protocol: 2, type: "leave" })), /Protocol/);
  assert.throws(() => parseMessage(JSON.stringify({ protocol: 1, type: "leave", extra: true })), /Unexpected/);
});

test("validates WebRTC offer, answer, and ICE payloads", () => {
  const targetId = "123e4567-e89b-42d3-a456-426614174000";
  assert.deepEqual(parseMessage(JSON.stringify({
    protocol: 1, type: "relay", targetId, kind: "offer", payload: { type: "offer", sdp: "v=0" },
  })).payload, { type: "offer", sdp: "v=0" });
  assert.deepEqual(parseMessage(JSON.stringify({
    protocol: 1, type: "relay", targetId, kind: "ice", payload: { candidate: "candidate:1", sdpMLineIndex: 0 },
  })).payload, { candidate: "candidate:1", sdpMLineIndex: 0 });
  assert.throws(() => parseMessage(JSON.stringify({
    protocol: 1, type: "relay", targetId, kind: "offer", payload: { type: "answer", sdp: "v=0" },
  })), /SDP/);
});

test("hashes reconnect tokens without retaining the plaintext", () => {
  const participant = generateParticipant();
  assert.equal(participant.tokenHash, hashToken(participant.reconnectToken));
  assert.notEqual(participant.tokenHash, participant.reconnectToken);
  assert.equal(participant.tokenHash.length, 64);
});
