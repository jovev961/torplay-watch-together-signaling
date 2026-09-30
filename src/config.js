export const PROTOCOL_VERSION = 1;
export const ROOM_TTL_MS = 12 * 60 * 60 * 1000;
export const RECONNECT_GRACE_MS = 15_000;
export const MAX_ROOM_SIZE = 8;
export const MAX_MESSAGE_BYTES = 64 * 1024;
export const ROOM_CODE_LENGTH = 6;
export const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function parseOrigins(value) {
  const origins = new Set();
  for (const entry of String(value || "").split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const url = new URL(trimmed);
    if (!new Set(["http:", "https:"]).has(url.protocol) || url.origin !== trimmed) {
      throw new Error(`Invalid WATCH_TOGETHER_ALLOWED_ORIGINS entry: ${trimmed}`);
    }
    origins.add(url.origin);
  }
  return origins;
}

function parseStunUrls(value) {
  const urls = String(value || "stun:stun.cloudflare.com:3478,stun:stun.l.google.com:19302")
    .split(",").map((url) => url.trim()).filter(Boolean);
  if (!urls.length || urls.some((url) => !/^stuns?:[^\s]+$/i.test(url))) {
    throw new Error("WATCH_TOGETHER_STUN_URLS must contain STUN URLs.");
  }
  return [...new Set(urls)];
}

export function readConfig(env = process.env) {
  const store = env.WATCH_TOGETHER_STORE || (env.REDIS_URL ? "redis" : "memory");
  if (!new Set(["memory", "redis"]).has(store)) {
    throw new Error("WATCH_TOGETHER_STORE must be memory or redis.");
  }
  if (store === "redis" && !env.REDIS_URL) {
    throw new Error("REDIS_URL is required when WATCH_TOGETHER_STORE=redis.");
  }
  const sessionSecret = String(env.TWTS_ADMIN_SESSION_SECRET || "");
  if (sessionSecret && sessionSecret.length < 32) {
    throw new Error("TWTS_ADMIN_SESSION_SECRET must contain at least 32 characters.");
  }
  return {
    host: env.HOST || "127.0.0.1",
    port: Number(env.PORT) || 8787,
    store,
    redisUrl: env.REDIS_URL || "",
    redisPrefix: env.TWTS_REDIS_PREFIX || "twts",
    allowedOrigins: parseOrigins(env.WATCH_TOGETHER_ALLOWED_ORIGINS),
    stunUrls: parseStunUrls(env.WATCH_TOGETHER_STUN_URLS),
    adminUsername: String(env.TWTS_ADMIN_USERNAME || ""),
    adminPassword: String(env.TWTS_ADMIN_PASSWORD || ""),
    adminSessionSecret: sessionSecret,
    deployHookUrl: String(env.TWTS_VERCEL_DEPLOY_HOOK_URL || ""),
    isProduction: env.NODE_ENV === "production" || Boolean(env.VERCEL),
  };
}

export function adminConfigured(config) {
  return Boolean(config.adminUsername && config.adminPassword && config.adminSessionSecret);
}
