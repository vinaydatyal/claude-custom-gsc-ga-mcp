/**
 * The small amount of state that cannot be carried inside a sealed token:
 * which authorization codes have been spent, which refresh tokens have been
 * rotated out, and per-IP rate limiting.
 *
 * All of it is expiring, so losing it on restart degrades gracefully: a
 * restarted server simply accepts a rotated-out refresh token until it
 * expires on its own. Set STATE_DIR to keep it across restarts.
 */

import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { log, nowSec } from './util.js';

/** @type {Map<string, number>} jti -> expiry (unix seconds) */
const usedCodes = new Map();
/** @type {Map<string, number>} jti -> expiry (unix seconds) */
const revokedRefresh = new Map();

const statePath = config.stateDir ? join(config.stateDir, 'gsc-mcp-state.json') : null;
let dirty = false;

function load() {
  if (!statePath) return;
  try {
    mkdirSync(config.stateDir, { recursive: true });
    const raw = JSON.parse(readFileSync(statePath, 'utf8'));
    for (const [k, v] of Object.entries(raw.usedCodes || {})) usedCodes.set(k, v);
    for (const [k, v] of Object.entries(raw.revokedRefresh || {})) revokedRefresh.set(k, v);
    log('info', 'state loaded', { usedCodes: usedCodes.size, revoked: revokedRefresh.size });
  } catch (err) {
    if (err.code !== 'ENOENT') log('warn', 'could not load state', { error: String(err) });
  }
}

function persist() {
  if (!statePath || !dirty) return;
  try {
    const body = JSON.stringify({
      usedCodes: Object.fromEntries(usedCodes),
      revokedRefresh: Object.fromEntries(revokedRefresh),
    });
    const tmp = statePath + '.tmp';
    writeFileSync(tmp, body);
    renameSync(tmp, statePath);
    dirty = false;
  } catch (err) {
    log('warn', 'could not persist state', { error: String(err) });
  }
}

function sweep(map) {
  const now = nowSec();
  for (const [k, exp] of map) if (exp < now) map.delete(k);
}

/**
 * Mark an authorization code as spent.
 * @returns {boolean} false if it had already been used
 */
export function consumeCode(jti, exp) {
  if (usedCodes.has(jti)) return false;
  usedCodes.set(jti, exp);
  dirty = true;
  return true;
}

/** @returns {boolean} true if this refresh token has been rotated out */
export function isRefreshRevoked(jti) {
  return revokedRefresh.has(jti);
}

export function revokeRefresh(jti, exp) {
  revokedRefresh.set(jti, exp);
  dirty = true;
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

/** @type {Map<string, {tokens: number, last: number}>} */
const buckets = new Map();

/**
 * Leaky-bucket limiter. Public endpoints (/register, /token, /authorize) are
 * reachable by anyone who finds the URL, so they get a modest cap.
 * @param {string} key
 * @param {number} capacity
 * @param {number} refillPerMinute
 */
export function allowRequest(key, capacity = 30, refillPerMinute = 30) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b) {
    b = { tokens: capacity, last: now };
    buckets.set(key, b);
  }
  const elapsedMin = (now - b.last) / 60000;
  b.tokens = Math.min(capacity, b.tokens + elapsedMin * refillPerMinute);
  b.last = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

// ---------------------------------------------------------------------------

let timer = null;

export function startStore() {
  load();
  timer = setInterval(() => {
    sweep(usedCodes);
    sweep(revokedRefresh);
    if (buckets.size > 10000) buckets.clear();
    persist();
  }, 60_000);
  timer.unref?.();
}

export function stopStore() {
  if (timer) clearInterval(timer);
  persist();
}

export const _internal = { usedCodes, revokedRefresh, buckets };
