/**
 * Everything that talks to Google: the OAuth token endpoint and the Search
 * Console APIs.
 */

import { config } from './config.js';
import { log, nowSec } from './util.js';

const TIMEOUT_MS = 20_000;

/** fetch with a timeout, so a hung upstream cannot pin a request open. */
async function fetchWithTimeout(url, init = {}, timeout = TIMEOUT_MS) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read the claims out of an ID token. No signature check is needed: this one
 * came straight from Google's token endpoint over TLS, which is the case RFC
 * 9068 and OpenID Connect both treat as already authenticated.
 * @param {string} idToken
 */
function decodeIdToken(idToken) {
  try {
    const part = idToken.split('.')[1];
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

/**
 * Swap an authorization code for tokens.
 * @param {string} code
 */
export async function exchangeGoogleCode(code) {
  const body = new URLSearchParams({
    code,
    client_id: config.google.clientId,
    client_secret: config.google.clientSecret,
    redirect_uri: config.google.redirectUri,
    grant_type: 'authorization_code',
  });
  const r = await fetchWithTimeout(config.google.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(`google token exchange failed (${r.status}): ${json.error || 'unknown'}`);
  }
  const claims = json.id_token ? decodeIdToken(json.id_token) : {};
  return {
    refresh_token: json.refresh_token,
    access_token: json.access_token,
    expires_in: json.expires_in,
    email: claims.email,
    email_verified: claims.email_verified,
  };
}

// ---------------------------------------------------------------------------
// Access token cache
// ---------------------------------------------------------------------------

/**
 * Google access tokens live an hour. Caching them in memory, keyed by the
 * refresh token, saves a round trip on every single tool call. Losing the
 * cache costs one extra request, nothing more.
 * @type {Map<string, {token: string, exp: number}>}
 */
const accessCache = new Map();

/** @param {string} refreshToken */
export async function getGoogleAccessToken(refreshToken) {
  const hit = accessCache.get(refreshToken);
  if (hit && hit.exp > nowSec() + 60) return hit.token;

  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: config.google.clientId,
    client_secret: config.google.clientSecret,
    grant_type: 'refresh_token',
  });
  const r = await fetchWithTimeout(config.google.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) {
    accessCache.delete(refreshToken);
    const detail = json.error_description || json.error || `HTTP ${r.status}`;
    const err = new Error(`Google refused to refresh access: ${detail}`);
    // invalid_grant means the user revoked access or changed their password.
    err.needsReauth = json.error === 'invalid_grant';
    throw err;
  }
  const exp = nowSec() + (Number(json.expires_in) || 3600);
  accessCache.set(refreshToken, { token: json.access_token, exp });
  if (accessCache.size > 500) {
    for (const [k, v] of accessCache) if (v.exp < nowSec()) accessCache.delete(k);
  }
  return json.access_token;
}

// ---------------------------------------------------------------------------
// Search Console API
// ---------------------------------------------------------------------------

export class GoogleApiError extends Error {
  constructor(message, status, detail) {
    super(message);
    this.name = 'GoogleApiError';
    this.status = status;
    this.detail = detail;
  }
}

/**
 * One authenticated call against a Google API.
 * @param {string} refreshToken
 * @param {string} url
 * @param {{method?: string, body?: any}} [opts]
 */
export async function googleApi(refreshToken, url, opts = {}) {
  const token = await getGoogleAccessToken(refreshToken);
  const init = {
    method: opts.method || 'GET',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  };
  if (opts.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }

  let r = await fetchWithTimeout(url, init);

  // A 401 here means the cached access token died early; drop it and retry once.
  if (r.status === 401) {
    accessCache.delete(refreshToken);
    const fresh = await getGoogleAccessToken(refreshToken);
    init.headers.Authorization = `Bearer ${fresh}`;
    r = await fetchWithTimeout(url, init);
  }

  const text = await r.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text.slice(0, 500) };
  }

  if (!r.ok) {
    const apiErr = json.error || {};
    const message = apiErr.message || `Search Console API returned HTTP ${r.status}`;
    log('warn', 'google api error', { url: url.split('?')[0], status: r.status, message });
    throw new GoogleApiError(message, r.status, apiErr);
  }
  return json;
}

/** Search Console identifies properties by URL, so they need escaping in paths. */
function sitePath(siteUrl) {
  return encodeURIComponent(siteUrl);
}

export async function listSites(refreshToken) {
  const json = await googleApi(refreshToken, `${config.gsc.apiBase}/sites`);
  return json.siteEntry || [];
}

/**
 * Accept whatever the user said and turn it into a real property identifier.
 *
 * People say "example.com"; Search Console wants "sc-domain:example.com" or
 * "https://example.com/". Resolving this here means the model never has to
 * guess, and a wrong guess never silently queries the wrong property.
 *
 * @param {string} refreshToken
 * @param {string} input
 */
export async function resolveSiteUrl(refreshToken, input) {
  const sites = await listSites(refreshToken);
  const available = sites.map((s) => s.siteUrl);
  if (available.includes(input)) return input;

  const normalise = (s) =>
    s
      .toLowerCase()
      .replace(/^sc-domain:/, '')
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .replace(/\/+$/, '');

  const want = normalise(input);
  const matches = available.filter((s) => normalise(s) === want);

  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    // Prefer the domain property, which covers every subdomain and scheme.
    const domainProp = matches.find((s) => s.startsWith('sc-domain:'));
    return domainProp || matches[0];
  }
  throw new GoogleApiError(
    `No Search Console property matches "${input}". Available properties: ${available.join(', ') || '(none)'}`,
    404,
    { available }
  );
}

/**
 * @param {string} refreshToken
 * @param {string} siteUrl
 * @param {object} query
 */
export function searchAnalytics(refreshToken, siteUrl, query) {
  return googleApi(refreshToken, `${config.gsc.apiBase}/sites/${sitePath(siteUrl)}/searchAnalytics/query`, {
    method: 'POST',
    body: query,
  });
}

export function listSitemaps(refreshToken, siteUrl) {
  return googleApi(refreshToken, `${config.gsc.apiBase}/sites/${sitePath(siteUrl)}/sitemaps`);
}

export function getSitemap(refreshToken, siteUrl, feedpath) {
  return googleApi(refreshToken, `${config.gsc.apiBase}/sites/${sitePath(siteUrl)}/sitemaps/${sitePath(feedpath)}`);
}

export function submitSitemap(refreshToken, siteUrl, feedpath) {
  return googleApi(refreshToken, `${config.gsc.apiBase}/sites/${sitePath(siteUrl)}/sitemaps/${sitePath(feedpath)}`, {
    method: 'PUT',
  });
}

export function deleteSitemap(refreshToken, siteUrl, feedpath) {
  return googleApi(refreshToken, `${config.gsc.apiBase}/sites/${sitePath(siteUrl)}/sitemaps/${sitePath(feedpath)}`, {
    method: 'DELETE',
  });
}

export function inspectUrl(refreshToken, siteUrl, inspectionUrl, languageCode = 'en-US') {
  return googleApi(refreshToken, `${config.gsc.inspectBase}/urlInspection/index:inspect`, {
    method: 'POST',
    body: { siteUrl, inspectionUrl, languageCode },
  });
}

export const _internal = { accessCache, decodeIdToken };
