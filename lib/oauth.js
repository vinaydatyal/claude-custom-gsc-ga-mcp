/**
 * The OAuth 2.1 authorization server Claude talks to.
 *
 * Claude will not accept a bare API key for a custom connector: it expects to
 * discover an authorization server, register itself, run an authorization code
 * flow with PKCE, and refresh. This module provides all of that, and delegates
 * the actual "who are you" step to Google, whose refresh token it then carries
 * inside its own sealed tokens.
 *
 * Nothing is stored server-side except spent codes and rotated refresh tokens
 * (see store.js).
 */

import { config, isAllowedRedirectUri, isLoopbackRedirectUri } from './config.js';
import { exchangeGoogleCode } from './google.js';
import { allowRequest, consumeCode, isRefreshRevoked, revokeRefresh } from './store.js';
import {
  escapeHtml,
  clientIp,
  log,
  newId,
  nowSec,
  parseForm,
  readBody,
  safeEqual,
  seal,
  sendDiscovery,
  sendHtml,
  sendJson,
  sendRedirect,
  sha256b64url,
  unseal,
} from './util.js';

const CLIENT_TTL = 365 * 24 * 3600;

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export function protectedResourceMetadata() {
  return {
    // Must equal the URL typed into Claude, character for character.
    resource: config.resourceUrl,
    authorization_servers: [config.issuer],
    scopes_supported: config.scopesSupported,
    bearer_methods_supported: ['header'],
    resource_name: 'Google Search Console',
    resource_documentation: config.baseUrl + '/',
  };
}

export function authorizationServerMetadata() {
  const md = {
    issuer: config.issuer,
    authorization_endpoint: config.baseUrl + '/authorize',
    token_endpoint: config.baseUrl + '/token',
    registration_endpoint: config.baseUrl + '/register',
    revocation_endpoint: config.baseUrl + '/revoke',
    scopes_supported: config.scopesSupported,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    // Claude registers as a public client, so it authenticates with nothing.
    token_endpoint_auth_methods_supported: ['none'],
    // Required by the MCP authorization spec so clients can verify PKCE
    // support before starting a flow.
    code_challenge_methods_supported: ['S256'],
    service_documentation: config.baseUrl + '/',
  };
  if (config.enableCimd) md.client_id_metadata_document_supported = true;
  return md;
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

/**
 * Dynamic client registration (RFC 7591). Rather than keeping a client table,
 * the registered metadata is sealed into the client_id itself, which makes
 * registration free and survives restarts and multiple instances.
 */
export async function handleRegister(req, res) {
  if (!allowRequest('reg:' + clientIp(req), 20, 20)) {
    return sendJson(res, 429, { error: 'too_many_requests' });
  }
  let body;
  try {
    // RFC 7591 §3.1: registration is JSON, unlike the token endpoint.
    body = JSON.parse(await readBody(req, 64 * 1024));
  } catch {
    return sendJson(res, 400, { error: 'invalid_client_metadata', error_description: 'body must be JSON' });
  }

  const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
  if (redirectUris.length === 0) {
    return sendJson(res, 400, { error: 'invalid_redirect_uri', error_description: 'redirect_uris is required' });
  }
  for (const uri of redirectUris) {
    if (typeof uri !== 'string' || !isAllowedRedirectUri(uri)) {
      return sendJson(res, 400, {
        error: 'invalid_redirect_uri',
        error_description: `redirect_uri not permitted by this server: ${uri}`,
      });
    }
  }

  const clientName = typeof body.client_name === 'string' ? body.client_name.slice(0, 120) : 'unnamed client';
  const clientId = seal('client', { ru: redirectUris, nm: clientName }, CLIENT_TTL);

  log('info', 'client registered', { client_name: clientName, redirect_uris: redirectUris });

  return sendJson(res, 201, {
    client_id: clientId,
    client_id_issued_at: nowSec(),
    client_name: clientName,
    redirect_uris: redirectUris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  });
}

const cimdCache = new Map();

/**
 * Client ID Metadata Document: the client_id is an https URL serving its own
 * registration metadata. Off unless ENABLE_CIMD is set.
 * @param {string} url
 */
async function resolveCimd(url) {
  const cached = cimdCache.get(url);
  if (cached && cached.exp > nowSec()) return cached.doc;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 5000);
  try {
    const r = await fetch(url, { signal: ac.signal, headers: { Accept: 'application/json' } });
    if (!r.ok) return null;
    const doc = await r.json();
    // The document must claim the exact URL it was fetched from.
    if (doc.client_id !== url || !Array.isArray(doc.redirect_uris)) return null;
    cimdCache.set(url, { doc, exp: nowSec() + 600 });
    return doc;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {string} clientId
 * @returns {Promise<{redirectUris: string[], name: string}|null>}
 */
async function resolveClient(clientId) {
  if (typeof clientId !== 'string' || clientId.length === 0) return null;
  if (clientId.startsWith('v1.')) {
    const c = unseal('client', clientId);
    if (!c) return null;
    return { redirectUris: c.ru, name: c.nm || 'client' };
  }
  if (config.enableCimd && clientId.startsWith('https://')) {
    const doc = await resolveCimd(clientId);
    if (!doc) return null;
    return { redirectUris: doc.redirect_uris, name: doc.client_name || clientId };
  }
  return null;
}

/**
 * Match a redirect URI against the client's registered list. Loopback entries
 * match regardless of port, because a native client binds an ephemeral one
 * (RFC 8252 §7.3) and Claude Code registers the portless form.
 */
function matchesRegistered(registered, actual) {
  if (registered.includes(actual)) return true;
  if (!isLoopbackRedirectUri(actual)) return false;
  let a;
  try {
    a = new URL(actual);
  } catch {
    return false;
  }
  return registered.some((r) => {
    try {
      const u = new URL(r);
      return (
        u.protocol === a.protocol &&
        u.hostname === a.hostname &&
        u.pathname === a.pathname
      );
    } catch {
      return false;
    }
  });
}

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

function errorPage(res, status, title, detail) {
  sendHtml(
    res,
    status,
    `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1.5rem;color:#1a1a1a}
h1{font-size:1.25rem;margin-bottom:.5rem}p{color:#555}code{background:#f4f4f5;padding:.1em .35em;border-radius:3px}</style>
<h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p>`
  );
}

function redirectWithError(res, redirectUri, state, error, description) {
  const u = new URL(redirectUri);
  u.searchParams.set('error', error);
  if (description) u.searchParams.set('error_description', description);
  if (state) u.searchParams.set('state', state);
  sendRedirect(res, u.toString());
}

/** Build the Google authorization URL for a validated request. */
function googleAuthUrl(pending) {
  const u = new URL(config.google.authUrl);
  u.searchParams.set('client_id', config.google.clientId);
  u.searchParams.set('redirect_uri', config.google.redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', config.google.scopes.join(' '));
  // Both are needed to be handed a refresh token every time, rather than only
  // on the user's very first consent.
  u.searchParams.set('access_type', 'offline');
  u.searchParams.set('prompt', 'consent');
  u.searchParams.set('include_granted_scopes', 'true');
  u.searchParams.set('state', pending);
  return u.toString();
}

export async function handleAuthorize(req, res, url) {
  if (!allowRequest('auth:' + clientIp(req), 30, 30)) {
    return errorPage(res, 429, 'Too many requests', 'Wait a minute and try connecting again.');
  }

  const q = url.searchParams;
  const clientId = q.get('client_id') || '';
  const redirectUri = q.get('redirect_uri') || '';
  const state = q.get('state') || '';
  const codeChallenge = q.get('code_challenge') || '';
  const method = q.get('code_challenge_method') || '';
  const responseType = q.get('response_type') || '';
  const resource = q.get('resource') || '';
  const scope = q.get('scope') || config.scopesSupported.join(' ');

  const client = await resolveClient(clientId);
  if (!client) {
    return errorPage(res, 400, 'Unknown client', 'This client is not registered with this server, or its registration has expired. Remove the connector in Claude and add it again.');
  }

  // Two independent checks: the URI must be one this client registered, and it
  // must pass the server-wide policy. The second is what stops a stranger who
  // registered a client from turning this server into an open redirect.
  if (!redirectUri || !matchesRegistered(client.redirectUris, redirectUri) || !isAllowedRedirectUri(redirectUri)) {
    return errorPage(res, 400, 'Invalid redirect URI', `This server will not redirect to ${redirectUri || '(none supplied)'}.`);
  }

  // From here on the redirect URI is trusted, so errors go back to the client.
  if (responseType !== 'code') {
    return redirectWithError(res, redirectUri, state, 'unsupported_response_type', 'only response_type=code is supported');
  }
  if (!codeChallenge || method !== 'S256') {
    return redirectWithError(res, redirectUri, state, 'invalid_request', 'PKCE with code_challenge_method=S256 is required');
  }
  if (resource && config.strictResource && resource !== config.resourceUrl) {
    return redirectWithError(res, redirectUri, state, 'invalid_target', `resource must be ${config.resourceUrl}`);
  }
  if (resource && resource !== config.resourceUrl) {
    log('warn', 'resource mismatch', { got: resource, expected: config.resourceUrl });
  }

  const pending = seal('authreq', { ru: redirectUri, st: state, cc: codeChallenge, sc: scope, rs: resource }, config.ttl.authRequest);

  // A native client's redirect is a port on this machine, which any local
  // process could have bound. Show the user where they are about to be sent.
  if (isLoopbackRedirectUri(redirectUri)) {
    return sendHtml(
      res,
      200,
      `<!doctype html><meta charset="utf-8"><title>Confirm sign-in</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1.5rem;color:#1a1a1a}
h1{font-size:1.25rem}dl{background:#f7f7f8;padding:1rem 1.25rem;border-radius:8px}dt{font-size:.8rem;color:#666;text-transform:uppercase;letter-spacing:.03em}
dd{margin:0 0 .75rem;font-family:ui-monospace,monospace;word-break:break-all}dd:last-child{margin-bottom:0}
button{font:inherit;background:#1a1a1a;color:#fff;border:0;border-radius:6px;padding:.6rem 1.2rem;cursor:pointer}
.warn{color:#8a5a00;background:#fff8e6;padding:.75rem 1rem;border-radius:6px;font-size:.9rem}</style>
<h1>Connect Google Search Console</h1>
<p>An application on this computer is asking to connect to your Search Console data.</p>
<dl><dt>Application</dt><dd>${escapeHtml(client.name)}</dd><dt>Will return to</dt><dd>${escapeHtml(redirectUri)}</dd></dl>
<p class="warn">This is a local address, so any program running on this computer could be listening on it. Only continue if you just started this sign-in yourself.</p>
<form method="POST" action="/authorize/continue">
<input type="hidden" name="pending" value="${escapeHtml(pending)}">
<button type="submit">Continue to Google</button></form>`
    );
  }

  return sendRedirect(res, googleAuthUrl(pending));
}

/** Target of the loopback confirmation form. */
export async function handleAuthorizeContinue(req, res) {
  const form = parseForm(await readBody(req, 16 * 1024));
  const pending = form.pending || '';
  if (!unseal('authreq', pending)) {
    return errorPage(res, 400, 'Sign-in expired', 'This sign-in request is no longer valid. Start it again from the application.');
  }
  return sendRedirect(res, googleAuthUrl(pending));
}

// ---------------------------------------------------------------------------
// Google callback
// ---------------------------------------------------------------------------

export async function handleGoogleCallback(req, res, url) {
  const pending = url.searchParams.get('state') || '';
  const authReq = unseal('authreq', pending);
  if (!authReq) {
    return errorPage(res, 400, 'Sign-in expired', 'This sign-in took too long or the link was opened twice. Start it again from Claude.');
  }

  const googleError = url.searchParams.get('error');
  if (googleError) {
    return redirectWithError(res, authReq.ru, authReq.st, 'access_denied', `Google reported: ${googleError}`);
  }

  const code = url.searchParams.get('code');
  if (!code) {
    return redirectWithError(res, authReq.ru, authReq.st, 'invalid_request', 'Google did not return an authorization code');
  }

  let tokens;
  try {
    tokens = await exchangeGoogleCode(code);
  } catch (err) {
    log('error', 'google code exchange failed', { error: String(err) });
    return redirectWithError(res, authReq.ru, authReq.st, 'server_error', 'Could not complete sign-in with Google');
  }

  if (!tokens.refresh_token) {
    // Without a refresh token the connection would die in an hour.
    return redirectWithError(
      res,
      authReq.ru,
      authReq.st,
      'invalid_grant',
      'Google did not return a refresh token. Remove this app at myaccount.google.com/permissions and connect again.'
    );
  }

  const email = (tokens.email || '').toLowerCase();
  if (!email || !config.allowedEmails.includes(email)) {
    log('warn', 'rejected sign-in', { email: email || '(none)' });
    return redirectWithError(res, authReq.ru, authReq.st, 'access_denied', 'This Google account is not permitted to use this server');
  }

  const authCode = seal(
    'code',
    {
      rt: tokens.refresh_token,
      em: email,
      cc: authReq.cc,
      ru: authReq.ru,
      sc: authReq.sc,
      jti: newId(12),
    },
    config.ttl.authCode
  );

  log('info', 'authorization granted', { email });

  const out = new URL(authReq.ru);
  out.searchParams.set('code', authCode);
  if (authReq.st) out.searchParams.set('state', authReq.st);
  return sendRedirect(res, out.toString());
}

// ---------------------------------------------------------------------------
// Token endpoint
// ---------------------------------------------------------------------------

function tokenError(res, error, description, status = 400) {
  return sendJson(res, status, { error, error_description: description });
}

function issueTokens(res, { rt, em, sc }) {
  const refreshJti = newId(12);
  const accessToken = seal('access', { rt, em, sc, aud: config.resourceUrl }, config.ttl.accessToken);
  const refreshToken = seal('refresh', { rt, em, sc, jti: refreshJti }, config.ttl.refreshToken);
  return sendJson(res, 200, {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: config.ttl.accessToken,
    refresh_token: refreshToken,
    scope: sc || config.scopesSupported.join(' '),
  });
}

export async function handleToken(req, res) {
  if (!allowRequest('tok:' + clientIp(req), 60, 60)) {
    return tokenError(res, 'temporarily_unavailable', 'too many requests', 429);
  }

  const ct = String(req.headers['content-type'] || '');
  if (!ct.includes('application/x-www-form-urlencoded')) {
    // RFC 6749 §4.1.3. Being strict here is better than silently misparsing.
    return tokenError(res, 'invalid_request', 'Content-Type must be application/x-www-form-urlencoded');
  }

  const form = parseForm(await readBody(req, 256 * 1024));
  const grant = form.grant_type;

  if (grant === 'authorization_code') {
    const payload = unseal('code', form.code || '');
    if (!payload) return tokenError(res, 'invalid_grant', 'authorization code is invalid or expired');

    // Single use. A replay arrives with a valid code but a spent jti.
    if (!consumeCode(payload.jti, payload.exp)) {
      return tokenError(res, 'invalid_grant', 'authorization code has already been used');
    }
    if (!form.code_verifier) return tokenError(res, 'invalid_request', 'code_verifier is required');
    if (!safeEqual(sha256b64url(form.code_verifier), payload.cc)) {
      return tokenError(res, 'invalid_grant', 'PKCE verification failed');
    }
    if (form.redirect_uri && form.redirect_uri !== payload.ru) {
      return tokenError(res, 'invalid_grant', 'redirect_uri does not match the authorization request');
    }
    log('info', 'token issued', { email: payload.em, grant });
    return issueTokens(res, payload);
  }

  if (grant === 'refresh_token') {
    const payload = unseal('refresh', form.refresh_token || '');
    if (!payload) return tokenError(res, 'invalid_grant', 'refresh token is invalid or expired');
    if (isRefreshRevoked(payload.jti)) {
      return tokenError(res, 'invalid_grant', 'refresh token has been rotated');
    }
    // Public clients must get a rotated refresh token on every use.
    revokeRefresh(payload.jti, payload.exp);
    log('debug', 'token refreshed', { email: payload.em });
    return issueTokens(res, payload);
  }

  return tokenError(res, 'unsupported_grant_type', `grant_type ${grant || '(missing)'} is not supported`);
}

/** RFC 7009. Best effort: sealed tokens cannot be unminted, only listed. */
export async function handleRevoke(req, res) {
  const form = parseForm(await readBody(req, 64 * 1024));
  const token = form.token || '';
  const payload = unseal('refresh', token);
  if (payload) revokeRefresh(payload.jti, payload.exp);
  return sendJson(res, 200, {});
}

// ---------------------------------------------------------------------------
// Resource protection
// ---------------------------------------------------------------------------

/**
 * Reject an unauthenticated MCP call in the shape Claude needs in order to
 * start a sign-in: a 401 carrying a pointer to the protected resource
 * metadata. A WWW-Authenticate header on a 200 is ignored by Claude.
 */
export function sendUnauthorized(res, description = 'authentication required') {
  const params = [
    `resource_metadata="${config.baseUrl}/.well-known/oauth-protected-resource"`,
    'error="invalid_token"',
    `error_description="${description.replace(/"/g, "'")}"`,
    `scope="${config.scopesSupported.join(' ')}"`,
  ];
  sendJson(
    res,
    401,
    { error: 'invalid_token', error_description: description },
    { 'WWW-Authenticate': `Bearer ${params.join(', ')}` }
  );
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @returns {{rt: string, em: string, sc: string}|null}
 */
export function authenticate(req) {
  const header = req.headers.authorization;
  if (!header || !/^Bearer /i.test(header)) return null;
  const token = header.slice(7).trim();
  const payload = unseal('access', token);
  if (!payload) return null;
  // Audience binding: a token minted for a different resource is not valid here.
  if (payload.aud !== config.resourceUrl) return null;
  return payload;
}

export const _internal = { resolveClient, matchesRegistered };
