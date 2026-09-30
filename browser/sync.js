export const WATCH_TOGETHER_SNAPSHOT_INTERVAL_MS = 2_000;
export const WATCH_TOGETHER_SOFT_DRIFT_SECONDS = 0.35;
export const WATCH_TOGETHER_HARD_DRIFT_SECONDS = 2;
export const WATCH_TOGETHER_SETTLED_DRIFT_SECONDS = 0.2;

export function durationsCompatible(hostDuration, guestDuration) {
  const host = Number(hostDuration);
  const guest = Number(guestDuration);
  if (!(host > 0) || !(guest > 0)) return false;
  // Authorized sources for the same title can use different cuts of the
  // credits, logos, or black frames. A one-percent window rejects ordinary
  // alternate encodes (especially short TV episodes) even though their
  // content timeline is still usable. Keep a bounded guard for an obviously
  // wrong file while allowing normal provider-to-provider runtime variance.
  const tolerance = Math.min(300, Math.max(120, host * 0.05));
  return Math.abs(host - guest) <= tolerance;
}

export function estimateClockOffset({ sentAt, hostAt, receivedAt }) {
  const start = Number(sentAt);
  const host = Number(hostAt);
  const end = Number(receivedAt);
  if (![start, host, end].every(Number.isFinite) || end < start) return 0;
  return host + (end - start) / 2 - end;
}

export function projectedHostPosition(snapshot, guestNow, hostClockOffset = 0) {
  const position = Math.max(0, Number(snapshot?.position) || 0);
  if (!snapshot?.playing) return position;
  const hostSentAtInGuestClock = (Number(snapshot.sentAt) || guestNow) - hostClockOffset;
  return Math.max(0, position + Math.max(0, guestNow - hostSentAtInGuestClock) / 1000);
}

export function guestCorrection({ currentTime, targetTime, playing, afterSeek = false }) {
  const current = Math.max(0, Number(currentTime) || 0);
  const target = Math.max(0, Number(targetTime) || 0);
  const drift = target - current;
  const absolute = Math.abs(drift);
  // The seek barrier already moved every participant to the shared position.
  // Its first playback snapshot is the commit signal, not another correction
  // pass: seeking again can replace an HLS source and interrupt autoplay.
  if (afterSeek) return { kind: "none", target, drift, rate: 1 };
  // A Play click is sent as an explicit snapshot, but must not force another
  // HLS source rebuild after the coordinated seek barrier. Large drift still
  // seeks; small drift is corrected without replacing the buffered source.
  if (!playing || absolute > WATCH_TOGETHER_HARD_DRIFT_SECONDS) {
    return { kind: absolute > 0.05 ? "seek" : "none", target, drift, rate: 1 };
  }
  if (absolute < WATCH_TOGETHER_SETTLED_DRIFT_SECONDS) {
    return { kind: "rate", target, drift, rate: 1 };
  }
  if (absolute >= WATCH_TOGETHER_SOFT_DRIFT_SECONDS) {
    return { kind: "rate", target, drift, rate: drift > 0 ? 1.05 : 0.95 };
  }
  return { kind: "none", target, drift, rate: 1 };
}
