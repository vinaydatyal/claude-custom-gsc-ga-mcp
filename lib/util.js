/**
 * Small helpers: sealed tokens, HTTP plumbing, dates.
 *
 * The server keeps no database. Every token it issues is an authenticated,
 * encrypted blob that carries its own payload, so a restart or a second
 * instance does not invalidate anyone's connection.
 */

import { createHash, createCipheriv, createDecipheriv, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

/** @param {Buffer|string} b */
export function b64url(b) {
  return Buffer.from(b).toString('base64url');
}

/** @param {string} s */
export function unb64url(s) {
  return Buffer.from(s, 'base64url');
}

/** @param {string} s */
export function sha256b64url(s) {
  return createHash('sha256').update(s).digest('base64url');
}

/** Constant-time string compare that tolerates different lengths. */
export function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// ---------------------------------------------------------------------------
// Sealed tokens
// ---------------------------------------------------------------------------

const keyCache = new Map();

/**
 * Derive a distinct key per purpose, so a token minted as (say) a refresh
 * token can never be replayed as an access token even though both are sealed
 * with the same master secret.
 * @param {string} purpose
 */
function keyFor(purpose) {
  let k = keyCache.get(purpose);
  if (!k) {
    k = Buffer.from(hkdfSync('sha256', Buffer.from(config.secret), Buffer.from('gsc-mcp.v1'), Buffer.from(purpose), 32));
    keyCache.set(purpose, k);
  }
  return k;
}

/**
 * Encrypt-and-authenticate a payload. The purpose string is bound in as
 * additional authenticated data as well as being the key label.
 * @param {string} purpose
 * @param {object} payload
 * @param {number} ttlSeconds
 */
export function seal(purpose, payload, ttlSeconds) {
  const body = { ...payload, iat: nowSec(), exp: nowSec() + ttlSeconds };
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFor(purpose), iv);
  cipher.setAAD(Buffer.from(purpose));
  const ct = Buffer.concat([cipher.update(JSON.stringify(body), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${b64url(iv)}.${b64url(Buffer.concat([ct, tag]))}`;
}

/**
 * Reverse of seal(). Returns null for anything that is not a valid, unexpired
 * token for this exact purpose — never throws on attacker-controlled input.
 * @param {string} purpose
 * @param {string} token
 * @returns {any|null}
 */
export function unseal(purpose, token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  try {
    const iv = unb64url(parts[1]);
    const blob = unb64url(parts[2]);
    if (iv.length !== 12 || blob.length < 17) return null;
    const ct = blob.subarray(0, blob.length - 16);
    const tag = blob.subarray(blob.length - 16);
    const decipher = createDecipheriv('aes-256-gcm', keyFor(purpose), iv);
    decipher.setAAD(Buffer.from(purpose));
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
    const body = JSON.parse(pt);
    if (typeof body.exp !== 'number' || body.exp < nowSec()) return null;
    return body;
  } catch {
    return null;
  }
}

export function nowSec() {
  return Math.floor(Date.now() / 1000);
}

export function newId(bytes = 16) {
  return randomBytes(bytes).toString('base64url');
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const CORS = {
  // Claude calls the MCP endpoint server-side, but browser-based inspectors
  // and the MCP debugger call it from a page, so the preflight has to work.
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id, WWW-Authenticate',
  'Access-Control-Max-Age': '86400',
};

/** @param {import('node:http').ServerResponse} res */
export function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...CORS,
    ...headers,
  });
  res.end(payload);
}

/** Discovery documents are safe to cache and are fetched on every connect. */
export function sendDiscovery(res, body) {
  sendJson(res, 200, body, { 'Cache-Control': 'public, max-age=300' });
}

export function sendText(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...CORS,
    ...headers,
  });
  res.end(body);
}

export function sendHtml(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
    'X-Frame-Options': 'DENY',
    ...headers,
  });
  res.end(body);
}

export function sendRedirect(res, location) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

export function sendNoContent(res, status = 202) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...CORS });
  res.end();
}

export function sendCorsPreflight(res) {
  res.writeHead(204, CORS);
  res.end();
}

/**
 * Read a request body with a hard size cap.
 * @param {import('node:http').IncomingMessage} req
 */
export function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('payload too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Parse a body as form-urlencoded (what RFC 6749 requires at /token). */
export function parseForm(raw) {
  const out = {};
  for (const [k, v] of new URLSearchParams(raw)) out[k] = v;
  return out;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Client IP, honouring one layer of reverse proxy. */
export function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

export function log(level, msg, extra = {}) {
  if (LEVELS[level] > (LEVELS[config.logLevel] ?? 2)) return;
  const line = { t: new Date().toISOString(), level, msg, ...extra };
  const out = level === 'error' || level === 'warn' ? console.error : console.log;
  out(JSON.stringify(line));
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/** @param {Date} d */
function iso(d) {
  return d.toISOString().slice(0, 10);
}

/**
 * Accept either an ISO date or a relative expression, so a model can say
 * "28daysAgo" without having to know today's date.
 * Supported: YYYY-MM-DD | today | yesterday | NdaysAgo | NweeksAgo | NmonthsAgo
 * @param {string} value
 * @param {Date} [ref]
 */
export function resolveDate(value, ref = new Date()) {
  if (typeof value !== 'string') throw new Error('date must be a string');
  const v = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const d = new Date(v + 'T00:00:00Z');
    if (Number.isNaN(d.getTime())) throw new Error(`invalid date: ${value}`);
    return v;
  }
  const base = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate()));
  const lower = v.toLowerCase();
  if (lower === 'today') return iso(base);
  if (lower === 'yesterday') {
    base.setUTCDate(base.getUTCDate() - 1);
    return iso(base);
  }
  const m = lower.match(/^(\d+)\s*(day|days|week|weeks|month|months)ago$/) || lower.match(/^(\d+)\s*(day|days|week|weeks|month|months)\s*ago$/);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2];
    if (unit.startsWith('day')) base.setUTCDate(base.getUTCDate() - n);
    else if (unit.startsWith('week')) base.setUTCDate(base.getUTCDate() - n * 7);
    else base.setUTCMonth(base.getUTCMonth() - n);
    return iso(base);
  }
  throw new Error(`unrecognised date: ${value} (use YYYY-MM-DD, today, yesterday, or "28daysAgo")`);
}

/** Inclusive day count between two ISO dates. */
export function daysBetween(startIso, endIso) {
  const a = Date.parse(startIso + 'T00:00:00Z');
  const b = Date.parse(endIso + 'T00:00:00Z');
  return Math.round((b - a) / 86400000) + 1;
}

/** Shift an ISO date by n days. */
export function shiftDate(isoDate, days) {
  const d = new Date(Date.parse(isoDate + 'T00:00:00Z'));
  d.setUTCDate(d.getUTCDate() + days);
  return iso(d);
}
