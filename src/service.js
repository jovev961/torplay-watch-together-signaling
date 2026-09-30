import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { WebSocketServer, WebSocket } from "ws";
import {
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  RECONNECT_GRACE_MS,
  ROOM_TTL_MS,
  adminConfigured,
  readConfig,
} from "./config.js";
import {
  ProtocolError,
  HOST_STREAM_CAPABILITY,
  generateParticipant,
  generateRoomCode,
  generateInviteId,
  inviteRoomCode,
  safeEqual,
  hashToken,
  parseMessage,
  publicParticipant,
  publicRoster,
} from "./protocol.js";
import { createStore } from "./store/index.js";
import {
  clearSessionCookie,
  createSession,
  requestOrigin,
  sessionCookie,
  validCredentials,
  validCsrfOrigin,
  verifySession,
} from "./admin/auth.js";
import { ADMIN_PAGE } from "./admin/page.js";

const RATE_WINDOW_MS = 60_000;
const LOGIN_WINDOW_MS = 15 * 60_000;

function routePath(request) {
  const pathname = new URL(request.url || "/", "http://localhost").pathname;
  return pathname.replace(/^\/api\/server(?=\/|$)/, "") || "/";
}

function clientIp(request) {
  return String(request.headers["x-forwarded-for"] || request.socket.remoteAddress || "unknown")
    .split(",")[0].trim().slice(0, 128);
}

function writeJson(response, status, value, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  response.end(JSON.stringify(value));
}

function writeHtml(response, status, html) {
  response.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  });
  response.end(html);
}

const GUEST_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Watch Together</title><link rel="stylesheet" href="/guest/style.css"></head>
<body><main id="app" aria-live="polite"><p>Opening invite…</p></main>
<script type="module" src="/guest/app.js"></script></body></html>`;

function writeGuestHtml(response) {
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self' ws: wss:; media-src blob:; worker-src blob:; frame-ancestors 'none'; base-uri 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(GUEST_HTML);
}

async function readJson(request, maxBytes = 8_192) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new ProtocolError("REQUEST_TOO_LARGE", "Request is too large.");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
  catch { throw new ProtocolError("INVALID_JSON", "Request must contain valid JSON."); }
}

function socketSend(socket, value) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
}

export async function createTwtsService({
  env = process.env,
  now = () => Date.now(),
  store: suppliedStore,
  roomTtlMs = ROOM_TTL_MS,
  reconnectGraceMs = RECONNECT_GRACE_MS,
  heartbeatIntervalMs = 30_000,
  fetchImpl = fetch,
} = {}) {
  const config = readConfig(env);
  const store = suppliedStore || createStore(config, { now });
  await store.connect();

  const instanceId = randomUUID();
  const startedAt = now();
  const connections = new Map();
  const socketState = new WeakMap();
  const roomRoutes = new Map();
  const deadlineTimers = new Map();
  let lastCleanupAt = null;
  let lastRestartAt = null;
  let sweeping = false;
  let closing = false;

  const httpServer = createServer((request, response) => {
    void handleHttp(request, response).catch((error) => {
      console.error("HTTP request failed:", error.message);
      if (!response.headersSent) writeJson(response, 500, { error: "Internal service error." });
      else response.end();
    });
  });
  const webSockets = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

  function sendError(socket, code, message) {
    socketSend(socket, { type: "error", code, message });
  }

  async function deliverEnvelope(participant, event, close = null) {
    if (!participant?.connected || !participant.instanceId || !participant.connectionId) return;
    const envelope = { connectionId: participant.connectionId, event, close };
    if (participant.instanceId === instanceId) deliverLocal(envelope);
    else await store.publish(`instance:${participant.instanceId}`, envelope);
  }

  function deliverLocal({ connectionId, event, close }) {
    const socket = connections.get(connectionId);
    if (!socket) return;
    if (event) socketSend(socket, event);
    if (close && socket.readyState < WebSocket.CLOSING) socket.close(close.code || 4000, close.reason || "Room closed");
  }

  function applyRouteSync(sync) {
    roomRoutes.set(sync.code, new Map(sync.participants.map((participant) => [participant.id, participant])));
  }

  async function syncRoutes(room) {
    const participants = Object.values(room.participants).map((participant) => ({
      id: participant.id,
      role: participant.role,
      connected: participant.connected,
      instanceId: participant.instanceId,
      connectionId: participant.connectionId,
    }));
    const instances = new Set(participants.map((participant) => participant.instanceId).filter(Boolean));
    const sync = { code: room.code, hostId: room.hostId, participants };
    for (const targetInstance of instances) {
      if (targetInstance === instanceId) applyRouteSync(sync);
      else await store.publish(`instance:${targetInstance}`, { internal: { type: "route-sync", ...sync } });
    }
  }

  async function broadcastRoom(room, event, { exceptId = null, close = null } = {}) {
    await Promise.all(Object.values(room.participants)
      .filter((participant) => participant.id !== exceptId)
      .map((participant) => deliverEnvelope(participant, event, close)));
  }

  async function publishRoster(room) {
    await syncRoutes(room);
    await broadcastRoom(room, { type: "roster", participants: publicRoster(room) });
  }

  function attach(socket, connectionId, room, participant) {
    socketState.set(socket, {
      code: room.code,
      participantId: participant.id,
      connectionId,
      role: participant.role,
      hostId: room.hostId,
    });
    scheduleRoomDeadline(room);
  }

  async function roomMessage(socket, room, participant, reconnectToken) {
    socketSend(socket, {
      type: "room",
      protocol: PROTOCOL_VERSION,
      code: room.code,
      participantId: participant.id,
      reconnectToken,
      role: participant.role,
      hostId: room.hostId,
      media: room.media,
      mode: room.mode || "independent",
      displayTitle: room.displayTitle || null,
      ...(participant.role === "host" ? { inviteId: room.inviteId || null } : {}),
      participants: publicRoster(room),
      expiresAt: room.expiresAt,
    });
    await publishRoster(room);
  }

  async function createRoom(socket, connectionId, message, ip) {
    if (socketState.has(socket)) return sendError(socket, "ALREADY_JOINED", "Leave the current room first.");
    const rate = await store.rateLimit(`create:${ip}`, 5, RATE_WINDOW_MS);
    if (!rate.allowed) return sendError(socket, "RATE_LIMITED", "Too many rooms were created from this address.");
    if (message.mode === "host-stream" && !message.capabilities.includes(HOST_STREAM_CAPABILITY)) {
      return sendError(socket, "UPGRADE_REQUIRED", "This client cannot host a streamed room.");
    }
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const code = generateRoomCode();
      const generated = generateParticipant();
      const participant = {
        id: generated.id,
        tokenHash: generated.tokenHash,
        name: message.name,
        role: "host",
        connected: true,
        instanceId,
        connectionId,
        disconnectDeadlineAt: null,
      };
      const stamp = now();
      const room = {
        code,
        inviteId: generateInviteId(code),
        displayTitle: message.displayTitle,
        media: message.media,
        mode: message.mode,
        hostId: participant.id,
        createdAt: stamp,
        expiresAt: stamp + roomTtlMs,
        participants: { [participant.id]: participant },
      };
      if (!await store.createRoom(room)) continue;
      attach(socket, connectionId, room, participant);
      await roomMessage(socket, room, participant, generated.reconnectToken);
      return;
    }
    sendError(socket, "ROOM_ALLOCATION_FAILED", "A room code could not be allocated.");
  }

  async function joinRoom(socket, connectionId, message, ip) {
    if (socketState.has(socket)) return sendError(socket, "ALREADY_JOINED", "Leave the current room first.");
    const rate = await store.rateLimit(`join:${ip}`, 20, RATE_WINDOW_MS);
    if (!rate.allowed) return sendError(socket, "RATE_LIMITED", "Too many room joins were attempted from this address.");
    if (message.inviteId) {
      const inviteRoom = inviteRoomCode(message.inviteId) === message.code
        ? await store.getRoom(message.code) : null;
      if (!inviteRoom?.inviteId || !safeEqual(inviteRoom.inviteId, message.inviteId)) {
        return sendError(socket, "INVALID_INVITE", "This invite is invalid or has expired.");
      }
    }
    const generated = generateParticipant();
    const participant = {
      id: generated.id,
      tokenHash: generated.tokenHash,
      name: message.name,
      role: "guest",
      connected: true,
      instanceId,
      connectionId,
      disconnectDeadlineAt: null,
    };
    const result = await store.joinRoom(message.code, participant, now());
    if (result.status === "not-found") return sendError(socket, "ROOM_NOT_FOUND", "That room does not exist or has closed.");
    if (result.status === "full") return sendError(socket, "ROOM_FULL", "That room is full.");
    if (result.room.mode === "host-stream" && !message.capabilities.includes(HOST_STREAM_CAPABILITY)) {
      await store.removeParticipant(message.code, participant.id);
      return sendError(socket, "UPGRADE_REQUIRED", "This room requires a newer TorPlay client.");
    }
    attach(socket, connectionId, result.room, participant);
    await roomMessage(socket, result.room, participant, generated.reconnectToken);
    await deliverEnvelope(result.room.participants[result.room.hostId], {
      type: "peer-joined", participant: publicParticipant(participant),
    });
  }

  async function resumeRoom(socket, connectionId, message) {
    if (socketState.has(socket)) return sendError(socket, "ALREADY_JOINED", "Leave the current room first.");
    const existing = await store.getRoom(message.code);
    if (existing?.mode === "host-stream" && !message.capabilities.includes(HOST_STREAM_CAPABILITY)) {
      return sendError(socket, "UPGRADE_REQUIRED", "This room requires a newer TorPlay client.");
    }
    const result = await store.resumeParticipant(message.code, message.participantId, hashToken(message.reconnectToken), {
      instanceId, connectionId,
    }, now());
    if (result.status !== "ok") return sendError(socket, "RESUME_REJECTED", "The room session could not be resumed.");
    if (result.previous.connected && result.previous.connectionId) {
      const envelope = {
        connectionId: result.previous.connectionId,
        event: null,
        close: { code: 4001, reason: "Replaced by resumed connection" },
      };
      if (result.previous.instanceId === instanceId) deliverLocal(envelope);
      else if (result.previous.instanceId) await store.publish(`instance:${result.previous.instanceId}`, envelope);
    }
    attach(socket, connectionId, result.room, result.participant);
    await roomMessage(socket, result.room, result.participant, message.reconnectToken);
    if (result.participant.role === "guest") {
      await deliverEnvelope(result.room.participants[result.room.hostId], {
        type: "peer-joined", participant: publicParticipant(result.participant), resumed: true,
      });
    }
  }

  async function relay(socket, message) {
    const state = socketState.get(socket);
    if (!state) return sendError(socket, "NOT_JOINED", "Join a room before relaying signaling data.");
    const target = roomRoutes.get(state.code)?.get(message.targetId);
    const allowed = state.role === "host" ? target?.role === "guest" : target?.id === state.hostId;
    if (!allowed) return sendError(socket, "INVALID_RELAY", "That signaling relay is not allowed.");
    await deliverEnvelope(target, {
      type: "signal", fromId: state.participantId, kind: message.kind, payload: message.payload,
    });
  }

  async function changeMedia(socket, message) {
    const state = socketState.get(socket);
    if (!state) return sendError(socket, "NOT_JOINED", "Join a room first.");
    const room = await store.changeMedia(state.code, state.participantId, message.media, message.displayTitle);
    if (!room) return sendError(socket, "HOST_ONLY", "Only the host can change media.");
    await broadcastRoom(room, { type: "media-changed", media: room.media, displayTitle: room.displayTitle || null }, { exceptId: state.participantId });
  }

  async function leaveRoom(socket) {
    const state = socketState.get(socket);
    if (!state) return;
    socketState.delete(socket);
    const room = await store.getRoom(state.code);
    const participant = room?.participants[state.participantId];
    if (!participant) return;
    if (participant.role === "host") {
      const closed = await store.closeRoom(room.code);
      if (closed) await broadcastRoom(closed, { type: "room-closed", reason: "host-left" }, {
        exceptId: participant.id,
        close: { code: 4000, reason: "Host left" },
      });
    } else {
      const updated = await store.removeParticipant(room.code, participant.id);
      if (updated) {
        await deliverEnvelope(updated.participants[updated.hostId], { type: "peer-left", participantId: participant.id });
        await publishRoster(updated);
      }
    }
    if (socket.readyState < WebSocket.CLOSING) socket.close(1000, "Left room");
  }

  async function handleSocketMessage(socket, connectionId, data, ip) {
    let message;
    try { message = parseMessage(data); }
    catch (error) {
      return sendError(socket, error.code || "INVALID_REQUEST", error.message || "Invalid request.");
    }
    switch (message.type) {
      case "create": return createRoom(socket, connectionId, message, ip);
      case "join": return joinRoom(socket, connectionId, message, ip);
      case "resume": return resumeRoom(socket, connectionId, message);
      case "relay": return relay(socket, message);
      case "change-media": return changeMedia(socket, message);
      case "leave": return leaveRoom(socket);
      default: return undefined;
    }
  }

  async function handleSocketClose(socket) {
    const state = socketState.get(socket);
    socketState.delete(socket);
    if (!state || closing) return;
    const room = await store.markDisconnected(
      state.code, state.participantId, state.connectionId, now() + reconnectGraceMs,
    );
    if (room) {
      await publishRoster(room);
      await scheduleAcrossRoom(room);
    }
  }

  async function applySweepActions(actions) {
    for (const action of actions) {
      if (action.type === "close") {
        await broadcastRoom(action.room, { type: "room-closed", reason: action.reason }, {
          close: { code: 4000, reason: action.reason },
        });
      } else if (action.type === "guest-left") {
        await deliverEnvelope(action.room.participants[action.room.hostId], {
          type: "peer-left", participantId: action.participantId,
        });
        await publishRoster(action.room);
      }
    }
  }

  function nextRoomDeadline(room) {
    const deadlines = [room.expiresAt];
    for (const participant of Object.values(room.participants)) {
      if (!participant.connected && participant.disconnectDeadlineAt) deadlines.push(participant.disconnectDeadlineAt);
    }
    return Math.min(...deadlines);
  }

  function scheduleDeadline(code, deadline) {
    const existing = deadlineTimers.get(code);
    if (existing && existing.deadline <= deadline) return;
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      deadlineTimers.delete(code);
      void processRoomDeadline(code).catch((error) => console.error("Room deadline failed:", error.message));
    }, Math.max(0, deadline - now()));
    timer.unref?.();
    deadlineTimers.set(code, { deadline, timer });
  }

  function scheduleRoomDeadline(room) {
    scheduleDeadline(room.code, nextRoomDeadline(room));
  }

  async function scheduleAcrossRoom(room) {
    const deadline = nextRoomDeadline(room);
    const instances = new Set(Object.values(room.participants)
      .map((participant) => participant.instanceId).filter(Boolean));
    for (const targetInstance of instances) {
      if (targetInstance === instanceId) scheduleDeadline(room.code, deadline);
      else await store.publish(`instance:${targetInstance}`, {
        internal: { type: "schedule-deadline", code: room.code, deadline },
      });
    }
  }

  async function processRoomDeadline(code) {
    const actions = await store.processRoom(code, now());
    await applySweepActions(actions);
    const room = await store.getRoom(code);
    if (room) scheduleRoomDeadline(room);
    else roomRoutes.delete(code);
  }

  async function sweep() {
    if (sweeping || closing) return [];
    sweeping = true;
    try {
      const actions = await store.sweep(now());
      await applySweepActions(actions);
      lastCleanupAt = now();
      return actions;
    } finally {
      sweeping = false;
    }
  }

  async function resetRooms(reason = "service-restarted") {
    const rooms = await store.resetAll();
    lastRestartAt = now();
    await store.publish("admin", { type: "reset", reason, at: lastRestartAt });
    return rooms.length;
  }

  function closeLocalRooms(reason) {
    for (const [connectionId, socket] of connections) {
      if (!socketState.has(socket)) continue;
      socketSend(socket, { type: "room-closed", reason });
      socketState.delete(socket);
      if (socket.readyState < WebSocket.CLOSING) socket.close(1012, "Service restart");
      connections.delete(connectionId);
    }
    roomRoutes.clear();
    for (const { timer } of deadlineTimers.values()) clearTimeout(timer);
    deadlineTimers.clear();
  }

  async function adminStatus() {
    let storageReady = false;
    try { storageReady = await store.health(); }
    catch { storageReady = false; }
    return {
      status: storageReady ? "ok" : "degraded",
      service: "torplay-watch-together",
      protocol: PROTOCOL_VERSION,
      storage: { type: config.store, ready: storageReady },
      stats: await store.stats(),
      configuration: {
        allowedOrigins: config.allowedOrigins.size > 0,
        adminConfigured: adminConfigured(config),
        deployHook: Boolean(config.deployHookUrl),
      },
      uptimeSeconds: Math.max(0, (now() - startedAt) / 1000),
      lastCleanupAt,
      lastRestartAt,
    };
  }

  function requireAdmin(request, response) {
    if (!verifySession(request, config, now())) {
      writeJson(response, 401, { error: "Authentication required." });
      return false;
    }
    return true;
  }

  function requireAdminPost(request, response) {
    if (!requireAdmin(request, response)) return false;
    if (!validCsrfOrigin(request)) {
      writeJson(response, 403, { error: "Request origin was rejected." });
      return false;
    }
    return true;
  }

  async function handleAdmin(request, response, path) {
    if (request.method === "GET" && path === "/admin") {
      if (!adminConfigured(config)) return writeJson(response, 503, { error: "Admin credentials are not configured." });
      return writeHtml(response, 200, ADMIN_PAGE);
    }
    if (request.method === "POST" && path === "/admin/api/login") {
      if (!adminConfigured(config)) return writeJson(response, 503, { error: "Admin credentials are not configured." });
      if (!validCsrfOrigin(request)) return writeJson(response, 403, { error: "Request origin was rejected." });
      const rate = await store.rateLimit(`admin-login:${clientIp(request)}`, 5, LOGIN_WINDOW_MS);
      if (!rate.allowed) return writeJson(response, 429, { error: "Too many login attempts. Try again later." });
      const body = await readJson(request);
      if (!validCredentials(body.username, body.password, config)) return writeJson(response, 401, { error: "Invalid username or password." });
      const secure = config.isProduction || requestOrigin(request).startsWith("https://");
      return writeJson(response, 200, { ok: true }, { "Set-Cookie": sessionCookie(createSession(config, now()), secure) });
    }
    if (request.method === "POST" && path === "/admin/api/logout") {
      if (!validCsrfOrigin(request)) return writeJson(response, 403, { error: "Request origin was rejected." });
      const secure = config.isProduction || requestOrigin(request).startsWith("https://");
      return writeJson(response, 200, { ok: true }, { "Set-Cookie": clearSessionCookie(secure) });
    }
    if (request.method === "GET" && path === "/admin/api/status") {
      if (!requireAdmin(request, response)) return;
      return writeJson(response, 200, await adminStatus());
    }
    if (request.method === "POST" && path.startsWith("/admin/api/actions/")) {
      if (!requireAdminPost(request, response)) return;
      const action = path.slice("/admin/api/actions/".length);
      const body = await readJson(request);
      if (action === "test-storage") {
        const ready = await store.health();
        return writeJson(response, 200, { ok: ready, message: ready ? "Storage connection succeeded." : "Storage is unavailable." });
      }
      if (action === "cleanup") {
        const actions = await sweep();
        return writeJson(response, 200, { ok: true, affected: actions.length, message: `Cleanup processed ${actions.length} expired item(s).` });
      }
      if (action === "reset") {
        if (body.confirm !== "RESET") return writeJson(response, 400, { error: "Reset confirmation is required." });
        const rooms = await resetRooms("service-reset");
        return writeJson(response, 200, { ok: true, rooms, message: `Reset ${rooms} active room(s).` });
      }
      if (action === "restart") {
        if (body.confirm !== "RESTART") return writeJson(response, 400, { error: "Restart confirmation is required." });
        if (!config.deployHookUrl) return writeJson(response, 409, { error: "The Vercel deploy hook is not configured." });
        const rooms = await resetRooms("service-restarted");
        try {
          const hookResponse = await fetchImpl(config.deployHookUrl, { method: "POST", redirect: "error" });
          if (!hookResponse.ok) throw new Error(`Deploy hook returned ${hookResponse.status}.`);
          return writeJson(response, 200, { ok: true, rooms, redeployTriggered: true, message: `Reset ${rooms} room(s) and requested a new deployment.` });
        } catch (error) {
          return writeJson(response, 502, {
            error: `Room state was reset, but redeployment failed: ${error.message}`,
            rooms,
            redeployTriggered: false,
          });
        }
      }
      return writeJson(response, 404, { error: "Unknown admin action." });
    }
    writeJson(response, 404, { error: "Not found." });
  }

  async function handleHttp(request, response) {
    const path = routePath(request);
    if (request.method === "GET" && path === "/health") {
      let ready = false;
      try { ready = await store.health(); }
      catch { ready = false; }
      return writeJson(response, ready ? 200 : 503, {
        status: ready ? "ok" : "degraded",
        service: "torplay-watch-together",
        protocol: PROTOCOL_VERSION,
        storage: config.store,
      }, { "Access-Control-Allow-Origin": "*" });
    }
    if (request.method === "GET" && /^\/join\/[A-HJ-NP-Z2-9]{6}\.[A-Za-z0-9_-]{32}$/.test(path)) {
      return writeGuestHtml(response);
    }
    if (request.method === "GET" && path.startsWith("/guest/")) {
      const file = path === "/guest/app.js" ? "app.js" : path === "/guest/style.css" ? "style.css" : null;
      if (!file) return writeJson(response, 404, { error: "Not found." });
      try {
        const contents = await readFile(new URL(`../public/guest/${file}`, import.meta.url));
        response.writeHead(200, { "Content-Type": file.endsWith(".js")
          ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8",
          "Cache-Control": "public, max-age=300", "X-Content-Type-Options": "nosniff" });
        response.end(contents);
      } catch { writeJson(response, 404, { error: "Guest asset unavailable." }); }
      return;
    }
    if (request.method === "GET" && path.startsWith("/api/invites/")) {
      const inviteId = path.slice("/api/invites/".length);
      const code = inviteRoomCode(inviteId);
      const rate = await store.rateLimit(`invite:${clientIp(request)}`, 60, RATE_WINDOW_MS);
      if (!rate.allowed) return writeJson(response, 429, { error: "Too many invite requests." });
      const room = code ? await store.getRoom(code) : null;
      if (!room || room.mode !== "host-stream" || room.expiresAt <= now()
        || !room.inviteId || !safeEqual(room.inviteId, inviteId)) {
        return writeJson(response, 404, { error: "This room does not exist or has expired." });
      }
      const host = room.participants[room.hostId];
      return writeJson(response, 200, { code: room.code, mode: room.mode,
        media: room.media, displayTitle: room.displayTitle || null,
        hostName: host?.name || "Host", hostConnected: Boolean(host?.connected),
        expiresAt: room.expiresAt, stunUrls: config.stunUrls });
    }
    if (path === "/admin" || path.startsWith("/admin/")) return handleAdmin(request, response, path);
    writeJson(response, 404, { error: "Not found." });
  }

  httpServer.on("upgrade", (request, socket, head) => {
    const origin = String(request.headers.origin || "");
    const sameOrigin = origin === `${config.isProduction ? "https" : "http"}://${request.headers.host}`;
    const allowed = routePath(request) === "/signal"
      && (!config.allowedOrigins.size || config.allowedOrigins.has(origin) || sameOrigin);
    if (!allowed) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    webSockets.handleUpgrade(request, socket, head, (webSocket) => webSockets.emit("connection", webSocket, request));
  });

  webSockets.on("connection", (socket, request) => {
    const connectionId = randomUUID();
    const ip = clientIp(request);
    socket.isAlive = true;
    connections.set(connectionId, socket);
    socket.on("pong", () => { socket.isAlive = true; });
    socket.on("message", (data) => {
      void handleSocketMessage(socket, connectionId, data, ip).catch((error) => {
        console.error("Signaling operation failed:", error.message);
        sendError(socket, "SERVICE_ERROR", "The signaling operation failed.");
      });
    });
    socket.on("close", () => {
      connections.delete(connectionId);
      void handleSocketClose(socket).catch((error) => console.error("Disconnect cleanup failed:", error.message));
    });
    socket.on("error", () => {});
  });

  const unsubscribeInstance = await store.subscribe(`instance:${instanceId}`, (message) => {
    if (message.internal?.type === "route-sync") applyRouteSync(message.internal);
    else if (message.internal?.type === "schedule-deadline") {
      scheduleDeadline(message.internal.code, message.internal.deadline);
    } else deliverLocal(message);
  });
  const unsubscribeAdmin = await store.subscribe("admin", (message) => {
    if (message.type === "reset") {
      lastRestartAt = message.at || now();
      closeLocalRooms(message.reason || "service-restarted");
    }
  });

  const heartbeatTimer = setInterval(() => {
    for (const socket of connections.values()) {
      if (socket.isAlive === false) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      socket.ping();
    }
  }, heartbeatIntervalMs);
  heartbeatTimer.unref?.();

  return {
    config,
    httpServer,
    store,
    instanceId,
    async listen(port = config.port, host = config.host) {
      await new Promise((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(port, host, () => {
          httpServer.removeListener("error", reject);
          resolve();
        });
      });
      return httpServer.address();
    },
    async close() {
      closing = true;
      clearInterval(heartbeatTimer);
      for (const { timer } of deadlineTimers.values()) clearTimeout(timer);
      await Promise.allSettled([unsubscribeInstance(), unsubscribeAdmin()]);
      for (const socket of connections.values()) socket.terminate();
      await new Promise((resolve) => webSockets.close(() => resolve()));
      if (httpServer.listening) await new Promise((resolve) => httpServer.close(resolve));
      await store.close();
    },
  };
}
