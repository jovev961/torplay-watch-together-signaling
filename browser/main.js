import Hls from "hls.js";
import { createMediaReceiver, peerHlsLoader } from "./media-transport.js";
import { estimateClockOffset, guestCorrection, projectedHostPosition } from "./sync.js";
import { hlsPlaybackConfig } from "./hls-config.js";

const PROTOCOL = 1;
const CAPABILITY = "host-stream-v1";
const inviteId = decodeURIComponent(location.pathname.split("/").filter(Boolean).at(-1) || "");
const storageKey = `twts:browser:${inviteId}`;
const app = document.getElementById("app");
const state = {
  invite: null, room: null, socket: null, pc: null, control: null, media: null, receiver: null,
  hls: null, share: null, loadedEpoch: null, subtitle: null, subtitleUrl: null,
  loadGeneration: 0, loadCancel: null, loading: null, lastSeekId: 0, seekPending: false,
  sequence: 0, playbackWatermark: 0, pendingPlayback: null, afterSeekCommit: false,
  playbackRunning: false,
  pendingIce: [], clockOffset: 0, pingSent: 0,
  retryCount: 0, retryTimer: null, connectionTimer: null, intentional: false, joined: false,
  receiveBytes: 0, lastReceiveBytes: 0, lastHardResync: 0, driftSamples: [],
};

app.innerHTML = `<section class="card">
  <p class="eyebrow">Watch Together</p>
  <h1 id="heading">Opening invite…</h1>
  <p id="media-label" class="media-label"></p>
  <p id="room-status" role="status"></p>
  <div id="lobby" hidden><label for="guest-name">Your name</label>
    <input id="guest-name" maxlength="50" autocomplete="nickname" value="Guest">
    <button id="join" class="primary" type="button">Join Watch</button></div>
  <div id="player-area" hidden><div class="video-shell"><video id="video" playsinline preload="auto"></video>
    <div id="video-overlay" class="video-overlay" hidden></div></div>
    <div class="controls"><span id="play-state">Waiting for host</span>
      <button id="start-playback" type="button" hidden>Start playback</button>
      <button id="mute" type="button" aria-label="Mute">Mute</button>
      <label for="volume">Volume</label><input id="volume" type="range" min="0" max="1" step="0.05" value="1">
      <button id="captions" type="button" hidden>Captions on</button>
      <button id="fullscreen" type="button">Fullscreen</button></div>
    <p id="metrics" class="metrics"></p></div>
  <p id="error" role="alert" class="error" hidden></p>
  <button id="leave" type="button" class="leave" hidden>Leave room</button>
</section>`;

const el = Object.fromEntries([
  "heading", "media-label", "room-status", "lobby", "guest-name", "join", "player-area",
  "video", "video-overlay", "play-state", "start-playback", "mute", "volume", "captions",
  "fullscreen", "metrics", "error", "leave",
].map((id) => [id, document.getElementById(id)]));

function status(label, detail = "") {
  el.heading.textContent = label;
  el["room-status"].textContent = detail;
}

function showError(message) {
  el.error.textContent = message;
  el.error.hidden = false;
}

function clearError() { el.error.hidden = true; el.error.textContent = ""; }

function sendSocket(value) {
  if (state.socket?.readyState === WebSocket.OPEN) {
    state.socket.send(JSON.stringify({ protocol: PROTOCOL, ...value }));
  }
}

function sendControl(value) {
  if (state.control?.readyState === "open") state.control.send(JSON.stringify(value));
}

function storedSession() {
  try { return JSON.parse(sessionStorage.getItem(storageKey) || "null"); } catch { return null; }
}

function saveSession(value) {
  try {
    if (value) sessionStorage.setItem(storageKey, JSON.stringify(value));
    else sessionStorage.removeItem(storageKey);
  } catch {}
}

function releaseSubtitle() {
  if (state.subtitleUrl) URL.revokeObjectURL(state.subtitleUrl);
  state.subtitleUrl = null;
  el.video.querySelector("track")?.remove();
  el.captions.hidden = true;
}

function closePeer() {
  clearTimeout(state.connectionTimer);
  state.loadGeneration += 1;
  state.loadCancel?.();
  state.loadCancel = null;
  state.loading = null;
  state.hls?.destroy(); state.hls = null;
  state.receiver?.close(); state.receiver = null;
  state.control?.close(); state.control = null;
  state.media?.close(); state.media = null;
  state.pc?.close(); state.pc = null;
  state.loadedEpoch = null;
  state.share = null;
  el.video.pause();
  el.video.removeAttribute("src"); el.video.load();
  releaseSubtitle();
}

function resetMedia() {
  state.loadGeneration += 1;
  state.loadCancel?.(); state.loadCancel = null;
  state.hls?.destroy(); state.hls = null;
  state.loading = null;
  state.loadedEpoch = null;
  state.share = null;
  state.subtitle = null;
  state.lastSeekId = 0;
  state.seekPending = false;
  state.pendingPlayback = null;
  state.afterSeekCommit = false;
  el.video.pause(); el.video.removeAttribute("src"); el.video.load();
  releaseSubtitle();
  sendControl({ type: "ready", ready: false, buffering: false, duration: 0 });
}

function endRoom(message) {
  state.intentional = true;
  clearTimeout(state.retryTimer);
  saveSession(null);
  try { state.socket?.close(); } catch {}
  closePeer();
  el.lobby.hidden = true;
  el["player-area"].hidden = true;
  el.leave.hidden = true;
  status(message);
}

function mediaLabel(invite) {
  const media = invite.media || {};
  const title = invite.displayTitle || (media.mediaType === "tv" ? "TV episode" : "Movie");
  return media.mediaType === "tv"
    ? `${title} · S${media.seasonNumber}E${media.episodeNumber}` : title;
}

function updateReceiveMetrics() {
  if (!state.joined || !state.invite) return;
  const rate = Math.max(0, state.receiveBytes - state.lastReceiveBytes) * 8 / 2_000_000;
  state.lastReceiveBytes = state.receiveBytes;
  const drift = state.driftSamples.length
    ? Math.round(state.driftSamples.reduce((sum, value) => sum + value, 0) / state.driftSamples.length) : 0;
  el.metrics.textContent = `Direct receive: ${rate.toFixed(1)} Mb/s · mean drift: ${drift} ms`;
}

function videoReady(target = null) {
  return !el.video.seeking && el.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
    && (target === null || Math.abs(el.video.currentTime - target) < 1.5);
}

function waitForFrame(timeoutMs = 30_000, target = null) {
  if (videoReady(target)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("The host stream did not buffer in time.")), timeoutMs);
    const ready = () => { if (videoReady(target)) finish(); };
    const failed = () => finish(new Error("This browser could not decode the host stream."));
    function finish(error) {
      clearTimeout(timer);
      for (const event of ["loadeddata", "canplay", "seeked"]) el.video.removeEventListener(event, ready);
      el.video.removeEventListener("error", failed);
      if (error) reject(error); else resolve();
    }
    for (const event of ["loadeddata", "canplay", "seeked"]) el.video.addEventListener(event, ready);
    el.video.addEventListener("error", failed, { once: true });
  });
}

async function loadShare(share, position = share.originSeconds || 0) {
  if (!state.receiver || !Hls.isSupported()) throw new Error("This browser cannot play the host's media transport.");
  if (!share?.epoch || !(Number(share.duration) > 0)) throw new Error("Host media is unavailable.");
  const generation = ++state.loadGeneration;
  state.loadCancel?.();
  state.hls?.destroy();
  releaseSubtitle();
  el.video.pause(); el.video.removeAttribute("src"); el.video.load();
  state.share = share;
  state.loadedEpoch = null;
  status("Buffering", "Preparing the host stream…");
  const hls = new Hls({ ...hlsPlaybackConfig(share),
    loader: peerHlsLoader(state.receiver, share.epoch),
    startPosition: Math.max(0, position - (share.originSeconds || 0)),
    startFragPrefetch: false, maxBufferLength: 30, backBufferLength: 15 });
  state.hls = hls;
  await new Promise((resolve, reject) => {
    let buffered = false;
    let done = false;
    const timer = setTimeout(() => finish(new Error("The host video did not buffer in time.")), 30_000);
    state.loadCancel = () => finish(new DOMException("Media load replaced.", "AbortError"));
    const ready = () => { if (buffered && videoReady()) finish(); };
    const failed = (_event, info) => {
      if (info.fatal) finish(new Error("The host stream is unsupported or unavailable in this browser."));
    };
    function finish(error) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      el.video.removeEventListener("loadeddata", ready);
      el.video.removeEventListener("canplay", ready);
      hls.off(Hls.Events.ERROR, failed);
      if (state.loadGeneration === generation) state.loadCancel = null;
      if (error) { hls.destroy(); reject(error); } else resolve();
    }
    el.video.addEventListener("loadeddata", ready);
    el.video.addEventListener("canplay", ready);
    hls.on(Hls.Events.ERROR, failed);
    hls.on(Hls.Events.FRAG_BUFFERED, () => { buffered = true; ready(); });
    hls.on(Hls.Events.MEDIA_ATTACHED, () => hls.loadSource(
      `https://watch.invalid/wt-media/${encodeURIComponent(share.epoch)}/index.m3u8`));
    hls.attachMedia(el.video);
  });
  if (generation !== state.loadGeneration) return false;
  state.loadedEpoch = share.epoch;
  status("Connected", "Waiting for host playback");
  void loadSubtitle();
  return true;
}

async function loadSubtitle() {
  const subtitle = state.subtitle;
  if (!subtitle || subtitle.epoch !== state.loadedEpoch || !state.receiver) return;
  try {
    const bytes = await state.receiver.load(subtitle.epoch, "selected.vtt");
    if (subtitle !== state.subtitle || subtitle.epoch !== state.loadedEpoch) return;
    releaseSubtitle();
    state.subtitleUrl = URL.createObjectURL(new Blob([bytes], { type: "text/vtt" }));
    const track = document.createElement("track");
    track.src = state.subtitleUrl;
    track.kind = "subtitles";
    track.srclang = "en";
    track.label = subtitle.label || "Host captions";
    el.video.append(track);
    track.track.mode = "showing";
    el.captions.hidden = false;
  } catch { /* Captions are optional. */ }
}

function maybeLoadShare() {
  if (!state.share || !state.receiver || state.loadedEpoch === state.share.epoch || state.loading) return;
  const requestedEpoch = state.share.epoch;
  state.loading = loadShare(state.share).then((ready) => {
    if (ready) sendControl({ type: "ready", ready: true, buffering: false, duration: state.share.duration });
  }).catch((error) => {
    if (error.name !== "AbortError") {
      showError(error.message);
      status("Connection failed", "The host media could not start.");
      sendControl({ type: "ready", ready: false, buffering: false, duration: 0 });
    }
  }).finally(() => {
    state.loading = null;
    if (state.share?.epoch !== requestedEpoch) queueMicrotask(maybeLoadShare);
  });
}

async function seekToHost(message) {
  if (!Number.isSafeInteger(message.id) || message.id <= state.lastSeekId
    || !(Number(message.position) >= 0)) return;
  state.lastSeekId = message.id;
  state.playbackWatermark = state.sequence;
  state.seekPending = true;
  state.pendingPlayback = null;
  el.video.pause();
  status("Buffering", "Aligning with the host…");
  try {
    const share = message.share || state.share;
    if (!share) throw new Error("Host media is unavailable.");
    if (share.epoch !== state.loadedEpoch) await loadShare(share, message.position);
    else {
      const localPosition = Math.max(0, message.position - (share.originSeconds || 0));
      el.video.currentTime = localPosition;
      await waitForFrame(25_000, localPosition);
    }
    if (state.lastSeekId !== message.id) return;
    state.seekPending = false;
    state.afterSeekCommit = true;
    sendControl({ type: "seek-ready", id: message.id });
    status("Connected", "Waiting for host playback");
    if (state.pendingPlayback) void applyPlayback(state.pendingPlayback);
  } catch (error) {
    if (state.lastSeekId !== message.id || error.name === "AbortError") return;
    state.seekPending = false;
    sendControl({ type: "seek-failed", id: message.id });
    showError("This browser could not reach the host position. Waiting for host retry.");
    status("Connection failed", error.message);
  }
}

async function applyPlaybackMessage(message) {
  if (state.seekPending) { state.pendingPlayback = message; return; }
  if (message.sequence <= state.playbackWatermark || !state.share) return;
  const target = projectedHostPosition(message, Date.now(), state.clockOffset);
  const current = (state.share.originSeconds || 0) + el.video.currentTime;
  const correction = guestCorrection({ currentTime: current, targetTime: target,
    playing: message.playing, afterSeek: state.afterSeekCommit });
  state.afterSeekCommit = false;
  if (Number.isFinite(correction.drift)) {
    state.driftSamples.push(Math.abs(correction.drift) * 1000);
    if (state.driftSamples.length > 120) state.driftSamples.shift();
  }
  if (correction.kind === "seek" && Date.now() - state.lastHardResync > 2_000) {
    state.lastHardResync = Date.now();
    sendControl({ type: "resync-request", sequence: message.sequence });
  }
  el.video.playbackRate = correction.kind === "rate" ? correction.rate : 1;
  if (!message.playing) {
    el.video.pause();
    el["play-state"].textContent = "Host paused";
    status("Connected", "Waiting for host playback");
    return;
  }
  try {
    await el.video.play();
    if (message.sequence !== state.sequence || state.seekPending) return;
    el["start-playback"].hidden = true;
    clearError();
    status("Playing", "Synchronized with the host");
  } catch (error) {
    if (error.name === "AbortError") return;
    if (error.name === "NotAllowedError" && !el.video.muted) {
      el.video.muted = true;
      try {
        await el.video.play();
        el.video.muted = false;
        el["start-playback"].hidden = true;
        return;
      } catch { el.video.muted = false; }
    }
    el["start-playback"].hidden = false;
    el["play-state"].textContent = "Tap Start playback to allow audio";
    status("Waiting for playback", "Your browser needs one more tap to play audio.");
  }
}

async function drainPlayback() {
  if (state.playbackRunning) return;
  state.playbackRunning = true;
  try {
    while (state.pendingPlayback && !state.seekPending) {
      const message = state.pendingPlayback;
      state.pendingPlayback = null;
      await applyPlaybackMessage(message);
    }
  } finally {
    state.playbackRunning = false;
  }
}

function applyPlayback(message) {
  state.pendingPlayback = message;
  if (!state.seekPending) void drainPlayback();
}

function onControl(event) {
  let message;
  try { message = JSON.parse(event.data); } catch { return; }
  if (message.type === "share-available" && message.share?.epoch) {
    state.share = message.share;
    maybeLoadShare();
  } else if (message.type === "share-unavailable") {
    showError("The host's current media cannot be shared in this browser.");
  } else if (message.type === "subtitle-available") {
    state.subtitle = message.epoch ? message : null;
    void loadSubtitle();
  } else if (message.type === "seek-start") {
    void seekToHost(message);
  } else if (message.type === "playback" && Number.isSafeInteger(message.sequence)
    && message.sequence > state.sequence) {
    state.sequence = message.sequence;
    void applyPlayback(message);
  } else if (message.type === "pong") {
    state.clockOffset = estimateClockOffset({ sentAt: state.pingSent,
      hostAt: message.hostAt, receivedAt: Date.now() });
  }
}

function attachChannel(channel) {
  if (channel.label === "torplay-watch") {
    state.control = channel;
    channel.onmessage = onControl;
    channel.onopen = () => {
      state.pingSent = Date.now();
      sendControl({ type: "ping", id: crypto.randomUUID() });
      sendControl({ type: "ready", ready: Boolean(state.loadedEpoch), buffering: false,
        duration: state.share?.duration || 0 });
      maybeLoadShare();
    };
  } else if (channel.label === "torplay-media") {
    state.media = channel;
    channel.onopen = () => {
      state.receiver = createMediaReceiver(channel, { onBytes: (count) => { state.receiveBytes += count; } });
      maybeLoadShare();
    };
  } else channel.close();
}

async function acceptSignal(message) {
  if (message.kind === "offer") {
    closePeer();
    const pc = new RTCPeerConnection({ iceServers: [{ urls: state.invite.stunUrls }] });
    state.pc = pc;
    pc.ondatachannel = (event) => attachChannel(event.channel);
    pc.onicecandidate = (event) => {
      if (event.candidate) sendSocket({ type: "relay", targetId: state.room.hostId,
        kind: "ice", payload: event.candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") {
        clearTimeout(state.connectionTimer);
        status("Connected", "Waiting for host media…");
      } else if (pc.connectionState === "disconnected") status("Reconnecting", "Restoring the host connection…");
      else if (pc.connectionState === "failed") {
        status("Connection failed", "Direct connection to the host failed. A restrictive network may need TURN.");
        showError("Could not establish a direct WebRTC connection to the host.");
      }
    };
    state.connectionTimer = setTimeout(() => {
      if (pc.connectionState !== "connected") {
        status("Connection failed", "Could not reach the host directly.");
        showError("Check both networks and try joining again.");
      }
    }, 20_000);
    await pc.setRemoteDescription(message.payload);
    for (const candidate of state.pendingIce.splice(0)) await pc.addIceCandidate(candidate).catch(() => {});
    await pc.setLocalDescription(await pc.createAnswer());
    sendSocket({ type: "relay", targetId: state.room.hostId, kind: "answer", payload: pc.localDescription.toJSON() });
  } else if (message.kind === "ice") {
    if (state.pc?.remoteDescription) await state.pc.addIceCandidate(message.payload).catch(() => {});
    else state.pendingIce.push(message.payload);
  }
}

function handleSocket(event) {
  let message;
  try { message = JSON.parse(event.data); } catch { return; }
  if (message.type === "room") {
    if (message.mode !== "host-stream" || message.role !== "guest") {
      endRoom("This room cannot be watched in a browser."); return;
    }
    state.room = message;
    state.retryCount = 0;
    saveSession({ code: message.code, participantId: message.participantId,
      reconnectToken: message.reconnectToken });
    status("Connecting to host", "Establishing a direct WebRTC connection…");
    el["player-area"].hidden = false;
    el.leave.hidden = false;
    el.lobby.hidden = true;
  } else if (message.type === "signal") {
    if (message.fromId === state.room?.hostId) void acceptSignal(message).catch(() => {
      showError("WebRTC negotiation failed."); status("Connection failed");
    });
  } else if (message.type === "roster") {
    const host = message.participants?.find((item) => item.role === "host");
    if (host && !host.connected) status("Host disconnected", "Waiting for the host to reconnect…");
  } else if (message.type === "media-changed") {
    state.invite.media = message.media;
    state.invite.displayTitle = message.displayTitle;
    el["media-label"].textContent = mediaLabel(state.invite);
    resetMedia();
    status("Waiting for host/media", "The host changed the movie or episode…");
  } else if (message.type === "room-closed") {
    endRoom(message.reason === "expired" ? "Room expired" : "Room ended");
  } else if (message.type === "error") {
    if (message.code === "RESUME_REJECTED") {
      saveSession(null);
      sendSocket({ type: "join", name: el["guest-name"].value.trim() || "Guest",
        code: state.invite.code, inviteId, capabilities: [CAPABILITY] });
    } else {
      showError(message.message || "The room could not be joined.");
      status("Connection failed");
    }
  }
}

function openSocket() {
  if (state.intentional) return;
  const url = new URL("/signal", location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(url);
  state.socket = socket;
  status(state.retryCount ? "Reconnecting" : "Joining room", "Contacting the Watch Together service…");
  socket.onopen = () => {
    const previous = storedSession();
    if (previous?.code === state.invite.code && previous.participantId && previous.reconnectToken) {
      sendSocket({ type: "resume", ...previous, capabilities: [CAPABILITY] });
    } else {
      sendSocket({ type: "join", name: el["guest-name"].value.trim() || "Guest",
        code: state.invite.code, inviteId, capabilities: [CAPABILITY] });
    }
  };
  socket.onmessage = handleSocket;
  socket.onerror = () => { /* onclose schedules recovery */ };
  socket.onclose = () => {
    if (state.intentional || socket !== state.socket) return;
    closePeer();
    if (state.retryCount >= 5) {
      status("Connection failed", "The signaling service could not reconnect.");
      showError("Please reload the invite to try again.");
      return;
    }
    state.retryCount += 1;
    status("Reconnecting", "Restoring your room session…");
    state.retryTimer = setTimeout(openSocket, Math.min(8_000, 750 * 2 ** state.retryCount));
  };
}

async function openInvite() {
  if (!/^[A-HJ-NP-Z2-9]{6}\.[A-Za-z0-9_-]{32}$/.test(inviteId)) {
    status("Invalid invite", "Check the link and try again."); return;
  }
  try {
    const response = await fetch(`/api/invites/${encodeURIComponent(inviteId)}`, { cache: "no-store" });
    const invite = await response.json();
    if (!response.ok) throw new Error(invite.error || "This room is unavailable.");
    state.invite = invite;
    state.pendingIce = [];
    el["media-label"].textContent = mediaLabel(invite);
    status("Ready to join", `${invite.hostName} is ${invite.hostConnected ? "online" : "reconnecting"}.`);
    el.lobby.hidden = false;
  } catch (error) {
    status("Room ended or expired", error.message);
  }
}

el.join.addEventListener("click", () => {
  state.joined = true;
  clearError();
  openSocket();
});
el.leave.addEventListener("click", () => {
  sendSocket({ type: "leave" });
  endRoom("You left the room");
});
el["start-playback"].addEventListener("click", () => {
  void el.video.play().then(() => {
    el["start-playback"].hidden = true; clearError();
  }).catch(() => showError("This browser could not start playback."));
});
el.mute.addEventListener("click", () => {
  el.video.muted = !el.video.muted;
  el.mute.textContent = el.video.muted ? "Unmute" : "Mute";
  el.mute.setAttribute("aria-label", el.mute.textContent);
});
el.volume.addEventListener("input", () => { el.video.volume = Number(el.volume.value); });
el.captions.addEventListener("click", () => {
  const track = el.video.textTracks[0];
  if (!track) return;
  track.mode = track.mode === "showing" ? "disabled" : "showing";
  el.captions.textContent = track.mode === "showing" ? "Captions on" : "Captions off";
});
el.fullscreen.addEventListener("click", () => {
  if (el.video.webkitEnterFullscreen) el.video.webkitEnterFullscreen();
  else void el.video.requestFullscreen?.();
});
el.video.addEventListener("waiting", () => {
  el["play-state"].textContent = "Buffering";
  sendControl({ type: "buffering", buffering: true });
});
el.video.addEventListener("playing", () => {
  el["play-state"].textContent = "Playing";
  sendControl({ type: "buffering", buffering: false });
});
el.video.addEventListener("error", () => {
  showError("The host video could not be decoded in this browser.");
});

setInterval(updateReceiveMetrics, 2_000);
void openInvite();
