import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
} from "./config.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const HOST_STREAM_CAPABILITY = "host-stream-v1";
const INVITE_PATTERN = /^([A-HJ-NP-Z2-9]{6})\.([A-Za-z0-9_-]{32})$/;
const FORBIDDEN_KEYS = new Set([
  "apikey", "credential", "credentials", "debrid", "fileid", "filename",
  "magnet", "password", "playbackurl", "provider", "providerid", "sessionid",
  "source", "sourceurl", "streamurl", "torrent", "url",
]);

export class ProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function fail(message, code = "INVALID_REQUEST") {
  throw new ProtocolError(code, message);
}

function exactKeys(value, required, optional = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Messages must be JSON objects.");
  const allowed = new Set([...required, ...optional]);
  for (const key of required) if (!(key in value)) fail(`Missing ${key}.`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`Unexpected field: ${key}.`);
}

function scanForbidden(value, path = "message", allowRelayPayload = false) {
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) fail(`${path}.${key} is not allowed.`);
    if (!(allowRelayPayload && path === "message" && key === "payload")) {
      scanForbidden(nested, `${path}.${key}`, allowRelayPayload);
    }
  }
}

export function normalizeDisplayTitle(value) {
  if (value === undefined || value === null || value === "") return null;
  const title = String(value).trim();
  if (!title || title.length > 160 || /[\u0000-\u001f\u007f]/.test(title)
    || /https?:\/\//i.test(title)) fail("Display title is invalid.");
  return title;
}

export function generateInviteId(code, random = randomBytes) {
  return code + "." + random(24).toString("base64url");
}

export function inviteRoomCode(value) {
  const match = INVITE_PATTERN.exec(String(value || ""));
  return match ? match[1] : null;
}

export function normalizeName(value) {
  const name = String(value || "").trim();
  if (!name || name.length > 50 || /[\u0000-\u001f\u007f]/.test(name)) {
    fail("Participant names must contain 1 to 50 printable characters.");
  }
  return name;
}

export function normalizeRoomCode(value) {
  const code = String(value || "").trim().toUpperCase().replace(/[\s-]+/g, "");
  if (code.length !== ROOM_CODE_LENGTH || [...code].some((character) => !ROOM_CODE_ALPHABET.includes(character))) {
    fail("Room codes contain six supported letters or numbers.");
  }
  return code;
}

function integer(value, label, allowZero = false) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < (allowZero ? 0 : 1)) fail(`${label} is invalid.`);
  return number;
}

function normalizeRoomMode(value) {
  if (value === undefined || value === null || value === "independent") return "independent";
  if (value === "host-stream") return value;
  fail("Room mode is invalid.");
}

function normalizeCapabilities(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8
      || value.some((capability) => typeof capability !== "string" || capability.length > 64)) {
    fail("Client capabilities are invalid.");
  }
  return [...new Set(value)];
}

export function normalizeMedia(value) {
  exactKeys(value, ["mediaType", "tmdbId"], ["seasonNumber", "episodeNumber"]);
  const mediaType = value.mediaType === "show" ? "tv" : value.mediaType;
  if (!new Set(["movie", "tv"]).has(mediaType)) fail("Media type must be movie or tv.");
  const media = { mediaType, tmdbId: integer(value.tmdbId, "TMDB ID") };
  if (mediaType === "tv") {
    media.seasonNumber = integer(value.seasonNumber, "Season number", true);
    media.episodeNumber = integer(value.episodeNumber, "Episode number");
  } else if (value.seasonNumber !== undefined || value.episodeNumber !== undefined) {
    fail("Movies cannot include season or episode numbers.");
  }
  return media;
}

function normalizeId(value, label) {
  const id = String(value || "");
  if (!UUID_PATTERN.test(id)) fail(`${label} is invalid.`);
  return id;
}

function normalizeRelay(kind, payload) {
  if (!new Set(["offer", "answer", "ice"]).has(kind)) fail("Relay kind is invalid.", "INVALID_RELAY");
  if (kind === "offer" || kind === "answer") {
    exactKeys(payload, ["type", "sdp"]);
    if (payload.type !== kind || typeof payload.sdp !== "string" || !payload.sdp || payload.sdp.length > 32_768) {
      fail("SDP payload is invalid.", "INVALID_RELAY");
    }
    return { type: kind, sdp: payload.sdp };
  }
  exactKeys(payload, ["candidate"], ["sdpMid", "sdpMLineIndex", "usernameFragment"]);
  if (typeof payload.candidate !== "string" || payload.candidate.length > 8_192) fail("ICE candidate is invalid.", "INVALID_RELAY");
  if (payload.sdpMid !== undefined && payload.sdpMid !== null
      && (typeof payload.sdpMid !== "string" || payload.sdpMid.length > 256)) fail("ICE sdpMid is invalid.", "INVALID_RELAY");
  if (payload.sdpMLineIndex !== undefined && payload.sdpMLineIndex !== null
      && (!Number.isInteger(payload.sdpMLineIndex) || payload.sdpMLineIndex < 0 || payload.sdpMLineIndex > 65_535)) {
    fail("ICE line index is invalid.", "INVALID_RELAY");
  }
  if (payload.usernameFragment !== undefined && payload.usernameFragment !== null
      && (typeof payload.usernameFragment !== "string" || payload.usernameFragment.length > 256)) {
    fail("ICE username fragment is invalid.", "INVALID_RELAY");
  }
  return {
    candidate: payload.candidate,
    ...(payload.sdpMid !== undefined ? { sdpMid: payload.sdpMid } : {}),
    ...(payload.sdpMLineIndex !== undefined ? { sdpMLineIndex: payload.sdpMLineIndex } : {}),
    ...(payload.usernameFragment !== undefined ? { usernameFragment: payload.usernameFragment } : {}),
  };
}

export function parseMessage(data) {
  const text = String(data);
  if (Buffer.byteLength(text) > MAX_MESSAGE_BYTES) fail("Message is too large.", "MESSAGE_TOO_LARGE");
  let value;
  try { value = JSON.parse(text); }
  catch { fail("Messages must be valid JSON.", "INVALID_JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Messages must be JSON objects.");
  if (value.protocol !== PROTOCOL_VERSION) fail("Protocol version is not supported.", "PROTOCOL_MISMATCH");
  scanForbidden(value, "message", value.type === "relay");
  switch (value.type) {
    case "create":
      exactKeys(value, ["protocol", "type", "name", "media"], ["mode", "capabilities", "displayTitle"]);
      return {
        protocol: PROTOCOL_VERSION,
        type: "create",
        name: normalizeName(value.name),
        media: normalizeMedia(value.media),
        mode: normalizeRoomMode(value.mode),
        capabilities: normalizeCapabilities(value.capabilities),
        displayTitle: normalizeDisplayTitle(value.displayTitle),
      };
    case "join":
      exactKeys(value, ["protocol", "type", "name", "code"], ["capabilities", "inviteId"]);
      return {
        protocol: PROTOCOL_VERSION,
        type: "join",
        name: normalizeName(value.name),
        code: normalizeRoomCode(value.code),
        capabilities: normalizeCapabilities(value.capabilities),
        inviteId: value.inviteId === undefined ? null : String(value.inviteId),
      };
    case "resume": {
      exactKeys(value, ["protocol", "type", "code", "participantId", "reconnectToken"], ["capabilities"]);
      const token = String(value.reconnectToken || "");
      if (token.length < 32 || token.length > 200) fail("Reconnect token is invalid.");
      return {
        protocol: PROTOCOL_VERSION, type: "resume", code: normalizeRoomCode(value.code),
        participantId: normalizeId(value.participantId, "Participant ID"), reconnectToken: token,
        capabilities: normalizeCapabilities(value.capabilities),
      };
    }
    case "relay":
      exactKeys(value, ["protocol", "type", "targetId", "kind", "payload"]);
      return {
        protocol: PROTOCOL_VERSION, type: "relay", targetId: normalizeId(value.targetId, "Target ID"),
        kind: value.kind, payload: normalizeRelay(value.kind, value.payload),
      };
    case "change-media":
      exactKeys(value, ["protocol", "type", "media"], ["displayTitle"]);
      return { protocol: PROTOCOL_VERSION, type: "change-media", media: normalizeMedia(value.media),
        displayTitle: normalizeDisplayTitle(value.displayTitle) };
    case "leave":
      exactKeys(value, ["protocol", "type"]);
      return { protocol: PROTOCOL_VERSION, type: "leave" };
    default:
      fail("Unknown signaling message.", "UNKNOWN_MESSAGE");
  }
}

export function generateRoomCode(random = randomBytes) {
  return [...random(ROOM_CODE_LENGTH)]
    .map((byte) => ROOM_CODE_ALPHABET[byte % ROOM_CODE_ALPHABET.length]).join("");
}

export function generateParticipant() {
  const reconnectToken = randomBytes(32).toString("base64url");
  return { id: randomUUID(), reconnectToken, tokenHash: hashToken(reconnectToken) };
}

export function hashToken(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

export function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function publicParticipant(participant) {
  return { id: participant.id, name: participant.name, role: participant.role, connected: participant.connected };
}

export function publicRoster(room) {
  return Object.values(room.participants).map(publicParticipant);
}
