/**
 * Configuration, loaded once at boot from the environment.
 *
 * Everything the server needs is here, validated up front so that a
 * misconfigured deployment fails on start rather than halfway through an
 * OAuth flow.
 */

import { createHash } from 'node:crypto';

/** @param {string} name @param {string} [fallback] */
function env(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return v;
}

/** @param {string|undefined} v */
function bool(v, fallback = false) {
  if (v === undefined || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(v);
}

/** Strip any trailing slash so URL concatenation is predictable. */
function trimSlash(u) {
  return u.replace(/\/+$/, '');
}

const errors = [];

// ---------------------------------------------------------------------------
// Core identity
// ---------------------------------------------------------------------------

// The public origin this server is reachable at, e.g. https://gsc.example.com
// This is the OAuth issuer, so it must be exactly what Claude sees.
let baseUrl = env('BASE_URL');
if (!baseUrl) {
  errors.push('BASE_URL is required (the public https:// origin of this server, e.g. https://gsc.example.com)');
  baseUrl = 'http://localhost:8080';
}
baseUrl = trimSlash(baseUrl);

const isLocal = /^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(baseUrl);
if (!baseUrl.startsWith('https://') && !isLocal) {
  errors.push(`BASE_URL must use https:// (got ${baseUrl})`);
}

// The MCP endpoint path. The protected-resource metadata "resource" value must
// match the URL the user types into Claude exactly, so keep these in sync.
const mcpPath = env('MCP_PATH', '/mcp');
const resourceUrl = baseUrl + mcpPath;

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

const secret = env('SERVER_SECRET');
if (!secret) {
  errors.push('SERVER_SECRET is required (generate with: npm run secret)');
} else if (secret.length < 32) {
  errors.push('SERVER_SECRET must be at least 32 characters');
}

const googleClientId = env('GOOGLE_CLIENT_ID');
const googleClientSecret = env('GOOGLE_CLIENT_SECRET');
if (!googleClientId) errors.push('GOOGLE_CLIENT_ID is required');
if (!googleClientSecret) errors.push('GOOGLE_CLIENT_SECRET is required');

// ---------------------------------------------------------------------------
// Who is allowed in
// ---------------------------------------------------------------------------

// This server is on the public internet and accepts dynamic client
// registration from anyone. The email allowlist is the thing that actually
// stops a stranger from connecting it to their own Claude account.
const allowedEmails = (env('ALLOWED_EMAILS', '') || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
if (allowedEmails.length === 0) {
  errors.push('ALLOWED_EMAILS is required (comma-separated Google account emails permitted to connect)');
}

// ---------------------------------------------------------------------------
// Scopes and capabilities
// ---------------------------------------------------------------------------

const enableWrite = bool(env('GSC_ENABLE_WRITE'), false);

// Google Analytics 4 rides on the same connection: same Google account, same
// sign-in, one extra scope. Turning it off narrows what the server is allowed
// to read, which is worth doing if you have no GA4 properties.
const enableGa4 = bool(env('GA4_ENABLED'), true);

// Google Ads Keyword Planner. Requires Google Ads API enabled in Google Cloud.
// Uses the same OAuth connection as GSC/GA4.
// Default to TRUE since we have the accounts configured
const enableAds = bool(env('ADS_ENABLED'), true);

const googleScopes = [
  'openid',
  'email',
  enableWrite
    ? 'https://www.googleapis.com/auth/webmasters'
    : 'https://www.googleapis.com/auth/webmasters.readonly',
  // Covers both the Analytics Data API and property discovery via the Admin
  // API. GA4 is read-only here regardless of GSC_ENABLE_WRITE.
  ...(enableGa4 ? ['https://www.googleapis.com/auth/analytics.readonly'] : []),
  // Google Ads API for keyword research and search volume data
  ...(enableAds ? ['https://www.googleapis.com/auth/adwords'] : []),
];

// Scopes we advertise to Claude. These are ours, not Google's.
const scopesSupported = [
  'gsc.read',
  ...(enableWrite ? ['gsc.write'] : []),
  ...(enableGa4 ? ['ga4.read'] : []),
  ...(enableAds ? ['ads.read'] : []),
  'offline_access',
];

// Client ID Metadata Documents are an alternative to DCR. Off by default:
// stateless DCR costs this server nothing, and DCR is the better-exercised
// path. Turn it on if you would rather Claude not register a client each time.
const enableCimd = bool(env('ENABLE_CIMD'), false);

// ---------------------------------------------------------------------------
// Redirect URI policy
// ---------------------------------------------------------------------------

// Anyone can register a client here, so registered redirect URIs alone are not
// a safe basis for redirecting a user. Every redirect target must also pass
// this policy, which is what prevents this server being used as an open
// redirect to launder an authorization code.
const extraRedirectUris = (env('EXTRA_REDIRECT_URIS', '') || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const hostedClaudeRedirects = [
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
];

/**
 * Claude Code is a native client and uses an RFC 8252 loopback redirect on an
 * ephemeral port, so the port must be ignored when matching.
 * @param {string} uri
 */
export function isAllowedRedirectUri(uri) {
  if (hostedClaudeRedirects.includes(uri)) return true;
  if (extraRedirectUris.includes(uri)) return true;
  let u;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) {
    // Port deliberately ignored (RFC 8252 §7.3). Path must still match.
    return u.pathname === '/callback' || u.pathname === '/oauth/callback';
  }
  return false;
}

/** True for loopback targets, which get an extra confirmation screen. */
export function isLoopbackRedirectUri(uri) {
  try {
    const u = new URL(uri);
    return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Upstream endpoints (overridable so the test suite can point at a local stub)
// ---------------------------------------------------------------------------

const google = {
  authUrl: env('GOOGLE_AUTH_URL', 'https://accounts.google.com/o/oauth2/v2/auth'),
  tokenUrl: env('GOOGLE_TOKEN_URL', 'https://oauth2.googleapis.com/token'),
  clientId: googleClientId,
  clientSecret: googleClientSecret,
  scopes: googleScopes,
  redirectUri: baseUrl + '/oauth/google/callback',
};

const gsc = {
  apiBase: trimSlash(env('GSC_API_BASE', 'https://www.googleapis.com/webmasters/v3')),
  inspectBase: trimSlash(env('GSC_INSPECT_BASE', 'https://searchconsole.googleapis.com/v1')),
};

const ga4 = {
  dataBase: trimSlash(env('GA4_DATA_BASE', 'https://analyticsdata.googleapis.com/v1beta')),
  adminBase: trimSlash(env('GA4_ADMIN_BASE', 'https://analyticsadmin.googleapis.com/v1beta')),
};

const ads = {
  apiBase: trimSlash(env('ADS_API_BASE', 'https://googleads.googleapis.com/v17')),
  // Hardcoded manager and customer accounts for Bees Build
  managerAccount: '6890738472', // 689-073-8472
  customerAccount: '9598893562', // 959-889-3562
};

// ---------------------------------------------------------------------------
// Lifetimes
// ---------------------------------------------------------------------------

const ttl = {
  authRequest: 10 * 60, // the Google round trip
  authCode: 60, // our code, exchanged immediately
  accessToken: Number(env('ACCESS_TOKEN_TTL', '3600')),
  refreshToken: Number(env('REFRESH_TOKEN_TTL', String(30 * 24 * 3600))),
};

export const config = {
  baseUrl,
  mcpPath,
  resourceUrl,
  issuer: baseUrl,
  port: Number(env('PORT', '8080')),
  host: env('HOST', '0.0.0.0'),
  secret: secret || 'invalid',
  allowedEmails,
  enableWrite,
  enableGa4,
  enableAds,
  enableCimd,
  scopesSupported,
  google,
  gsc,
  ga4,
  ads,
  ttl,
  stateDir: env('STATE_DIR'),
  logLevel: env('LOG_LEVEL', 'info'),
  strictResource: bool(env('STRICT_RESOURCE'), false),
  serverName: env('SERVER_NAME', 'gsc-mcp'),
  version: '1.0.0',
  /** Short non-secret fingerprint, handy in logs. */
  secretFingerprint: secret ? createHash('sha256').update(secret).digest('hex').slice(0, 8) : 'none',
  configErrors: errors,
};

/** Print config problems and exit. Called from server.js. */
export function assertConfigValid() {
  if (errors.length === 0) return;
  console.error('\nConfiguration problems:\n');
  for (const e of errors) console.error('  - ' + e);
  console.error('\nSee .env.example and the README for what each value is.\n');
  process.exit(1);
}
