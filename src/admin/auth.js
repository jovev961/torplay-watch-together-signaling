import { createHmac, randomBytes } from "node:crypto";
import { adminConfigured } from "../config.js";
import { safeEqual } from "../protocol.js";

const COOKIE_NAME = "twts_admin";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

function sign(value, secret) {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function parseCookies(header) {
  const cookies = {};
  for (const entry of String(header || "").split(";")) {
    const separator = entry.indexOf("=");
    if (separator < 1) continue;
    cookies[entry.slice(0, separator).trim()] = entry.slice(separator + 1).trim();
  }
  return cookies;
}

export function createSession(config, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({
    username: config.adminUsername,
    expiresAt: now + SESSION_TTL_MS,
    nonce: randomBytes(16).toString("base64url"),
  })).toString("base64url");
  return `${payload}.${sign(payload, config.adminSessionSecret)}`;
}

export function verifySession(request, config, now = Date.now()) {
  if (!adminConfigured(config)) return false;
  const token = parseCookies(request.headers.cookie)[COOKIE_NAME];
  if (!token) return false;
  const separator = token.lastIndexOf(".");
  if (separator < 1) return false;
  const payload = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  if (!safeEqual(signature, sign(payload, config.adminSessionSecret))) return false;
  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return session.username === config.adminUsername && Number(session.expiresAt) > now;
  } catch {
    return false;
  }
}

export function validCredentials(username, password, config) {
  return adminConfigured(config)
    && safeEqual(String(username || ""), config.adminUsername)
    && safeEqual(String(password || ""), config.adminPassword);
}

export function sessionCookie(token, secure) {
  return `${COOKIE_NAME}=${token}; Path=/; Max-Age=${SESSION_TTL_MS / 1000}; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}

export function clearSessionCookie(secure) {
  return `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}

export function requestOrigin(request) {
  const protocol = String(request.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
  const host = String(request.headers["x-forwarded-host"] || request.headers.host || "").split(",")[0].trim();
  return host ? `${protocol}://${host}` : "";
}

export function validCsrfOrigin(request) {
  const origin = String(request.headers.origin || "");
  return Boolean(origin && origin === requestOrigin(request));
}
