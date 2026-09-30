export const MEDIA_CHUNK_BYTES = 16 * 1024;
export const MEDIA_MAX_ASSET_BYTES = 8 * 1024 * 1024;
const MAX_BUFFERED_BYTES = 256 * 1024;
const VALID_ASSET = /^(?:index\.m3u8|init\.mp4|segment-\d{5}\.(?:ts|m4s)|selected\.vtt)$/;
const SAFE_MEDIA_ERRORS = new Set([
  "Media request is not authorized.", "The shared media asset is unavailable.",
  "The media asset exceeds the transfer limit.", "The shared media asset is empty.",
  "The direct media connection stalled.", "Too many media requests.",
  "Invalid media asset length.", "Incomplete media asset.", "Invalid media chunk.",
  "Media transfer timed out.", "Media request cancelled.", "Direct media connection closed.",
]);

export function mediaAssetKind(asset) {
  if (asset === "index.m3u8") return "playlist";
  if (asset === "init.mp4") return "init";
  if (asset === "selected.vtt") return "caption";
  return /^segment-\d{5}\.(?:ts|m4s)$/.test(asset || "") ? "segment" : "invalid";
}

export function logMediaEvent(side, event, details = {}) {
  if (typeof window !== "undefined") {
    console.info("[Watch Together media]", { side, event, ...details });
  }
}

export function shouldRequestGuestSubtitle(canPlay, subtitleEpoch, sharedEpoch, loadedEpoch) {
  return Boolean(canPlay && subtitleEpoch && subtitleEpoch === sharedEpoch
    && subtitleEpoch === loadedEpoch);
}

export function peerAssetName(url, epoch) {
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.origin !== "https://watch.invalid"
    || parsed.pathname !== `/wt-media/${encodeURIComponent(epoch)}/${parsed.pathname.split("/").at(-1)}`
    || parsed.search || parsed.hash) return null;
  const asset = parsed.pathname.split("/").at(-1);
  return VALID_ASSET.test(asset) ? asset : null;
}

function decodeMessage(data) {
  if (typeof data !== "string") return null;
  try { return JSON.parse(data); } catch { return null; }
}

function sendJson(channel, message) {
  if (channel.readyState !== "open") throw new Error("The direct media connection closed.");
  channel.send(JSON.stringify(message));
}

async function waitForSpace(channel, signal) {
  if (channel.bufferedAmount < MAX_BUFFERED_BYTES) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("The direct media connection stalled.")), 15_000);
    function finish(error) {
      clearTimeout(timer);
      channel.removeEventListener("bufferedamountlow", onLow);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    }
    const onLow = () => finish();
    const onAbort = () => finish(new Error("Media transfer cancelled."));
    channel.addEventListener("bufferedamountlow", onLow, { once: true });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (channel.bufferedAmount < MAX_BUFFERED_BYTES) onLow();
  });
}

export function createMediaSender(channel, { getShare, isAuthorized, onBytes = () => {} }) {
  channel.bufferedAmountLowThreshold = MAX_BUFFERED_BYTES / 2;
  let active = null;
  let queued = null;
  let requestTimes = [];
  let closed = false;
  let loggedSegmentEpoch = null;
  let loggedPlaylistEpoch = null;

  function traceRequest(message) {
    const kind = mediaAssetKind(message.asset);
    if (kind === "playlist") {
      if (loggedPlaylistEpoch === message.epoch) return false;
      loggedPlaylistEpoch = message.epoch;
    }
    if (kind === "segment") {
      if (loggedSegmentEpoch === message.epoch) return false;
      loggedSegmentEpoch = message.epoch;
    }
    return true;
  }

  async function transfer(message) {
    const controller = new AbortController();
    active = { id: message.id, controller };
    const kind = mediaAssetKind(message.asset);
    const traced = traceRequest(message);
    let responseStatus = null;
    try {
      const share = getShare();
      const authorized = isAuthorized();
      if (traced) logMediaEvent("host", "asset-request", { id: message.id, kind,
        authorized, shareAvailable: Boolean(share), epochMatches: share?.epoch === message.epoch });
      if (!authorized || !share || message.epoch !== share.epoch
        || !VALID_ASSET.test(message.asset)) throw new Error("Media request is not authorized.");
      const url = message.asset === "selected.vtt" ? share.subtitleUrl
        : `/api/watch-together/shares/${encodeURIComponent(share.id)}/${message.asset}`;
      if (!url) throw new Error("Media request is not authorized.");
      const response = await fetch(url,
        { signal: controller.signal, cache: "no-store" });
      responseStatus = response.status;
      if (traced) logMediaEvent("host", "asset-fetch", { id: message.id, kind, status: responseStatus });
      if (!response.ok || !response.body) throw new Error("The shared media asset is unavailable.");
      const limit = message.asset === "selected.vtt" ? 2 * 1024 * 1024 : MEDIA_MAX_ASSET_BYTES;
      // Browsers may strip or rewrite Content-Length after HTTP compression.
      // Read a bounded asset first so the peer gets the actual byte count.
      const reader = response.body.getReader();
      const parts = [];
      let length = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > limit) throw new Error("The media asset exceeds the transfer limit.");
          parts.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      if (!length) throw new Error("The shared media asset is empty.");
      if (!isAuthorized() || getShare() !== share || controller.signal.aborted) {
        throw new Error("Media request is not authorized.");
      }
      sendJson(channel, { type: "asset-start", id: message.id, length });
      for (const part of parts) {
        for (let offset = 0; offset < part.byteLength; offset += MEDIA_CHUNK_BYTES) {
          if (!isAuthorized() || getShare() !== share || controller.signal.aborted) {
            throw new Error("Media request is not authorized.");
          }
          await waitForSpace(channel, controller.signal);
          const slice = part.subarray(offset, offset + MEDIA_CHUNK_BYTES);
          const frame = new Uint8Array(4 + slice.byteLength);
          new DataView(frame.buffer).setUint32(0, message.id);
          frame.set(slice, 4);
          channel.send(frame.buffer);
          onBytes(slice.byteLength);
        }
      }
      sendJson(channel, { type: "asset-end", id: message.id });
      if (traced) logMediaEvent("host", "asset-sent", { id: message.id, kind, bytes: length });
    } catch (error) {
      const safeMessage = SAFE_MEDIA_ERRORS.has(error.message)
        ? error.message : "The shared media asset could not be transferred.";
      logMediaEvent("host", "asset-failed", { id: message.id, kind,
        reason: safeMessage, status: responseStatus, aborted: controller.signal.aborted });
      if (!controller.signal.aborted && channel.readyState === "open") {
        sendJson(channel, { type: "asset-error", id: message.id,
          message: safeMessage });
      }
    } finally {
      if (active?.id === message.id) active = null;
      if (queued && !closed) {
        const next = queued;
        queued = null;
        void transfer(next);
      }
    }
  }

  function onMessage(event) {
    const message = decodeMessage(event.data);
    if (!message) return;
    if (message.type === "asset-cancel") {
      if (active?.id === message.id) active.controller.abort();
      if (queued?.id === message.id) queued = null;
      return;
    }
    if (message.type !== "asset-request" || !Number.isSafeInteger(message.id)
      || message.id < 1 || typeof message.asset !== "string") return;
    const now = Date.now();
    requestTimes = requestTimes.filter((stamp) => now - stamp < 1_000);
    requestTimes.push(now);
    if (requestTimes.length > 8 || (active && queued)) {
      logMediaEvent("host", "asset-rejected", { id: message.id,
        kind: mediaAssetKind(message.asset), reason: "request-limit" });
      sendJson(channel, { type: "asset-error", id: message.id, message: "Too many media requests." });
      return;
    }
    if (active) queued = message;
    else void transfer(message);
  }
  channel.addEventListener("message", onMessage);
  return {
    close() {
      closed = true;
      active?.controller.abort();
      queued = null;
      channel.removeEventListener("message", onMessage);
    },
  };
}

export function createMediaReceiver(channel, { onBytes = () => {} } = {}) {
  let sequence = 0;
  const requests = new Map();
  let loggedSegmentEpoch = null;
  let loggedPlaylistEpoch = null;

  function traceAsset(asset, epoch) {
    const kind = mediaAssetKind(asset);
    if (kind === "playlist") {
      if (loggedPlaylistEpoch === epoch) return false;
      loggedPlaylistEpoch = epoch;
    }
    if (kind === "segment") {
      if (loggedSegmentEpoch === epoch) return false;
      loggedSegmentEpoch = epoch;
    }
    return true;
  }

  function fail(request, reason) {
    clearTimeout(request.timer);
    requests.delete(request.id);
    logMediaEvent("guest", "asset-failed", { id: request.id,
      kind: request.kind, reason: SAFE_MEDIA_ERRORS.has(reason) ? reason : "Unexpected transfer error." });
    request.reject(new Error(reason));
  }

  function onMessage(event) {
    const message = decodeMessage(event.data);
    if (message) {
      const request = requests.get(message.id);
      if (!request) return;
      if (message.type === "asset-error") return fail(request, message.message || "Media transfer failed.");
      if (message.type === "asset-start") {
        if (!Number.isSafeInteger(message.length) || message.length < 1
          || message.length > MEDIA_MAX_ASSET_BYTES) return fail(request, "Invalid media asset length.");
        request.length = message.length;
        request.bytes = new Uint8Array(message.length);
        if (request.traced) logMediaEvent("guest", "asset-start", { id: request.id,
          kind: request.kind, bytes: message.length });
      } else if (message.type === "asset-end") {
        if (!request.bytes || request.offset !== request.length) return fail(request, "Incomplete media asset.");
        clearTimeout(request.timer);
        requests.delete(request.id);
        if (request.traced) logMediaEvent("guest", "asset-complete", { id: request.id,
          kind: request.kind, bytes: request.length });
        request.resolve(request.bytes.buffer);
      }
      return;
    }
    if (!(event.data instanceof ArrayBuffer) || event.data.byteLength < 5) return;
    const view = new DataView(event.data);
    const request = requests.get(view.getUint32(0));
    if (!request?.bytes || request.offset + event.data.byteLength - 4 > request.length) {
      if (request) fail(request, "Invalid media chunk.");
      return;
    }
    const bytes = new Uint8Array(event.data, 4);
    request.bytes.set(bytes, request.offset);
    request.offset += bytes.byteLength;
    onBytes(bytes.byteLength);
  }
  channel.binaryType = "arraybuffer";
  channel.addEventListener("message", onMessage);
  return {
    load(epoch, asset, signal) {
      if (channel.readyState !== "open" || !VALID_ASSET.test(asset)) {
        return Promise.reject(new Error("Direct media is unavailable."));
      }
      const id = ++sequence;
      const kind = mediaAssetKind(asset);
      const traced = traceAsset(asset, epoch);
      if (traced) logMediaEvent("guest", "asset-request", { id, kind });
      return new Promise((resolve, reject) => {
        const request = { id, kind, traced, resolve, reject, offset: 0, length: 0, bytes: null,
          timer: setTimeout(() => fail(request, "Media transfer timed out."), 20_000) };
        requests.set(id, request);
        const cancel = () => {
          try { sendJson(channel, { type: "asset-cancel", id }); } catch {}
          fail(request, "Media request cancelled.");
        };
        signal?.addEventListener("abort", cancel, { once: true });
        const originalResolve = request.resolve;
        const originalReject = request.reject;
        request.resolve = (value) => { signal?.removeEventListener("abort", cancel); originalResolve(value); };
        request.reject = (error) => { signal?.removeEventListener("abort", cancel); originalReject(error); };
        try { sendJson(channel, { type: "asset-request", id, epoch, asset }); }
        catch (error) { fail(request, error.message); }
      });
    },
    close() {
      channel.removeEventListener("message", onMessage);
      for (const request of requests.values()) fail(request, "Direct media connection closed.");
    },
  };
}

export function peerHlsLoader(receiver, epoch) {
  return class PeerHlsLoader {
    constructor() { this.stats = { loading: { start: 0, first: 0, end: 0 }, loaded: 0, total: 0,
      parsing: { start: 0, end: 0 }, buffering: { start: 0, first: 0, end: 0 },
      aborted: false, retry: 0, chunkCount: 0, bwEstimate: 0 }; }
    load(context, _config, callbacks) {
      this.context = context;
      this.controller = new AbortController();
      this.stats.loading.start = performance.now();
      const asset = peerAssetName(context.url, epoch);
      if (!asset) {
        logMediaEvent("guest", "hls-asset-rejected", { kind: "invalid", type: context.type });
        callbacks.onError({ code: 400, text: "Invalid peer asset." }, context, null, this.stats);
        return;
      }
      void receiver.load(epoch, asset, this.controller.signal).then((data) => {
        if (this.stats.aborted) return;
        this.stats.loading.first = this.stats.loading.end = performance.now();
        this.stats.loaded = this.stats.total = data.byteLength;
        callbacks.onSuccess({ url: context.url,
          data: context.responseType === "text" ? new TextDecoder().decode(data) : data },
        this.stats, context, null);
      }).catch((error) => {
        if (!this.stats.aborted) callbacks.onError({ code: 503, text: error.message }, context, null, this.stats);
      });
    }
    abort() { this.stats.aborted = true; this.controller?.abort(); }
    destroy() { this.abort(); }
  };
}
