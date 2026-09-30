export function hlsPlaybackConfig(details = {}) {
  return {
    // Worker demuxing keeps high-bitrate fMP4 work off the UI thread. Hls.js
    // falls back to inline demuxing itself when a worker cannot be created.
    enableWorker: true,
    startFragPrefetch: true,
    startPosition: Math.max(0, Number(details?.startOffsetSeconds) || 0),
  };
}
