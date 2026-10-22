/**
 * End-to-end smoke test.
 *
 * Starts a stub that impersonates Google's OAuth and Search Console APIs,
 * starts the real server pointed at it, and walks the whole connector
 * lifecycle: discovery, registration, authorization, code exchange, MCP calls,
 * refresh rotation, and the failure cases that matter for security.
 *
 * Run with: npm test
 */

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';

const GOOGLE_PORT = 8791;
const SERVER_PORT = 8790;
const BASE = `http://localhost:${SERVER_PORT}`;
const MCP_URL = `${BASE}/mcp`;
const CLAUDE_REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    failures.push({ name, detail });
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

// ---------------------------------------------------------------------------
// Google stub
// ---------------------------------------------------------------------------

/** What the stub will claim the signed-in user's email is. */
let stubEmail = 'owner@example.com';
let stubWithholdRefreshToken = false;
/** The body of the most recent GA4 report request, for asserting what we sent. */
let lastGa4Request = null;
const apiCalls = [];

function fakeIdToken(email) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ email, email_verified: true, sub: '123' })).toString('base64url');
  return `${header}.${payload}.signature-not-checked`;
}

const googleStub = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${GOOGLE_PORT}`);
  const json = (code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  // Authorization endpoint: bounce straight back with a code.
  if (url.pathname === '/auth') {
    const redirect = new URL(url.searchParams.get('redirect_uri'));
    redirect.searchParams.set('code', 'google-auth-code');
    redirect.searchParams.set('state', url.searchParams.get('state'));
    res.writeHead(302, { Location: redirect.toString() });
    return res.end();
  }

  // Token endpoint: both the code exchange and later refreshes.
  if (url.pathname === '/token') {
    return json(200, {
      access_token: 'google-access-token',
      expires_in: 3600,
      ...(stubWithholdRefreshToken ? {} : { refresh_token: 'google-refresh-token' }),
      id_token: fakeIdToken(stubEmail),
    });
  }

  // Search Console API.
  if (url.pathname === '/gsc/sites') {
    apiCalls.push('sites');
    return json(200, {
      siteEntry: [
        { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' },
        { siteUrl: 'https://shop.example.net/', permissionLevel: 'siteFullUser' },
      ],
    });
  }

  if (url.pathname.endsWith('/searchAnalytics/query')) {
    const body = JSON.parse(await readAll(req));
    apiCalls.push(`query:${body.dimensions?.join(',') || 'totals'}:${body.startDate}`);
    if (!body.dimensions || body.dimensions.length === 0) {
      // Undimensioned totals differ between the two periods so the delta is
      // visible in the comparison test.
      const isCurrent = body.startDate >= '2026-01-15';
      return json(200, {
        rows: [{ clicks: isCurrent ? 1000 : 800, impressions: isCurrent ? 50000 : 45000, ctr: 0.02, position: 12.5 }],
      });
    }
    const isCurrent = body.startDate >= '2026-01-15';
    return json(200, {
      rows: isCurrent
        ? [
            { keys: ['blue widgets'], clicks: 120, impressions: 3000, ctr: 0.04, position: 5.2 },
            { keys: ['red widgets'], clicks: 40, impressions: 2000, ctr: 0.02, position: 18.4 },
            { keys: ['brand new term'], clicks: 15, impressions: 500, ctr: 0.03, position: 9.0 },
          ]
        : [
            { keys: ['blue widgets'], clicks: 60, impressions: 2500, ctr: 0.024, position: 8.9 },
            { keys: ['red widgets'], clicks: 95, impressions: 2600, ctr: 0.036, position: 11.1 },
            { keys: ['retired term'], clicks: 50, impressions: 900, ctr: 0.055, position: 7.0 },
          ],
    });
  }

  if (url.pathname.includes('/sitemaps')) {
    apiCalls.push('sitemaps');
    return json(200, { sitemap: [{ path: 'https://example.com/sitemap.xml', lastDownloaded: '2026-01-20T00:00:00Z', errors: '0', warnings: '2' }] });
  }

  if (url.pathname === '/inspect/urlInspection/index:inspect') {
    apiCalls.push('inspect');
    return json(200, {
      inspectionResult: {
        inspectionResultLink: 'https://search.google.com/search-console/inspect?x=1',
        indexStatusResult: { verdict: 'PASS', coverageState: 'Submitted and indexed', googleCanonical: 'https://example.com/a' },
      },
    });
  }

  // --- Google Analytics 4 ---------------------------------------------------

  if (url.pathname === '/ga4admin/accountSummaries') {
    apiCalls.push('ga4:accountSummaries');
    return json(200, {
      accountSummaries: [
        {
          account: 'accounts/100',
          displayName: 'Acme',
          propertySummaries: [
            { property: 'properties/123456789', displayName: 'Example.com Web', propertyType: 'PROPERTY_TYPE_ORDINARY' },
            { property: 'properties/987654321', displayName: 'Example Shop', propertyType: 'PROPERTY_TYPE_ORDINARY' },
            { property: 'properties/555000111', displayName: 'Example Shop Staging', propertyType: 'PROPERTY_TYPE_ORDINARY' },
          ],
        },
      ],
    });
  }

  if (url.pathname.endsWith(':runReport')) {
    const body = JSON.parse(await readAll(req));
    lastGa4Request = body;
    apiCalls.push('ga4:runReport');

    const dims = (body.dimensions || []).map((d) => d.name);
    const mets = (body.metrics || []).map((m) => m.name);
    const ranges = body.dateRanges || [];
    const comparing = ranges.length > 1;

    const metricHeaders = mets.map((name) => ({ name, type: 'TYPE_INTEGER' }));
    const mv = (n) => mets.map(() => ({ value: String(n) }));

    if (comparing) {
      // One row per channel per date range, including a channel that exists
      // only in the current period and one only in the previous.
      const matrix = [
        ['Organic Search', 'current', 500],
        ['Organic Search', 'previous', 400],
        ['Direct', 'current', 100],
        ['Direct', 'previous', 150],
        ['Paid Search', 'current', 50],
        ['Referral', 'previous', 30],
      ];
      return json(200, {
        dimensionHeaders: [...dims.map((name) => ({ name })), { name: 'dateRange' }],
        metricHeaders,
        rows: matrix.map(([channel, range, value]) => ({
          dimensionValues: [...dims.map(() => ({ value: channel })), { value: range }],
          metricValues: mv(value),
        })),
        rowCount: matrix.length,
        metadata: { currencyCode: 'USD', timeZone: 'America/New_York' },
      });
    }

    if (dims.length === 0) {
      return json(200, {
        dimensionHeaders: [],
        metricHeaders,
        rows: [{ dimensionValues: [], metricValues: mv(1234) }],
        rowCount: 1,
        metadata: { currencyCode: 'USD', timeZone: 'America/New_York' },
      });
    }

    const values = ['Organic Search', 'Direct', 'Paid Search'];
    return json(200, {
      dimensionHeaders: dims.map((name) => ({ name })),
      metricHeaders,
      rows: values.map((v, i) => ({
        dimensionValues: dims.map(() => ({ value: v })),
        metricValues: mv((i + 1) * 100),
      })),
      totals: [{ dimensionValues: [], metricValues: mv(600) }],
      rowCount: values.length,
      metadata: { currencyCode: 'USD', timeZone: 'America/New_York' },
    });
  }

  if (url.pathname.endsWith(':runRealtimeReport')) {
    const body = JSON.parse(await readAll(req));
    lastGa4Request = body;
    apiCalls.push('ga4:realtime');
    const mets = (body.metrics || []).map((m) => m.name);
    return json(200, {
      dimensionHeaders: (body.dimensions || []).map((d) => ({ name: d.name })),
      metricHeaders: mets.map((name) => ({ name, type: 'TYPE_INTEGER' })),
      rows: [
        {
          dimensionValues: (body.dimensions || []).map(() => ({ value: 'United States' })),
          metricValues: mets.map(() => ({ value: '42' })),
        },
      ],
      rowCount: 1,
    });
  }

  if (url.pathname.endsWith('/metadata')) {
    apiCalls.push('ga4:metadata');
    return json(200, {
      dimensions: [
        { apiName: 'landingPage', uiName: 'Landing page', description: 'The page path associated with the first pageview in a session.' },
        { apiName: 'country', uiName: 'Country', description: 'The country from which activity originated.' },
        { apiName: 'customUser:plan_tier', uiName: 'Plan tier', description: 'Custom user dimension.', customDefinition: true },
      ],
      metrics: [
        { apiName: 'sessions', uiName: 'Sessions', description: 'The number of sessions.' },
        { apiName: 'keyEvents', uiName: 'Key events', description: 'The count of key events.' },
        { apiName: 'customEvent:signup_value', uiName: 'Signup value', description: 'Custom metric.', customDefinition: true },
      ],
    });
  }

  json(404, { error: { message: 'stub: no route', code: 404 } });
});

function readAll(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data || '{}'));
  });
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let child;

async function startServer() {
  googleStub.listen(GOOGLE_PORT);
  await once(googleStub, 'listening');

  child = spawn(process.execPath, ['server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...process.env,
      BASE_URL: BASE,
      PORT: String(SERVER_PORT),
      SERVER_SECRET: randomBytes(32).toString('base64url'),
      GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'test-client-secret',
      ALLOWED_EMAILS: 'owner@example.com',
      GSC_ENABLE_WRITE: 'true',
      LOG_LEVEL: 'warn',
      GOOGLE_AUTH_URL: `http://localhost:${GOOGLE_PORT}/auth`,
      GOOGLE_TOKEN_URL: `http://localhost:${GOOGLE_PORT}/token`,
      GSC_API_BASE: `http://localhost:${GOOGLE_PORT}/gsc`,
      GSC_INSPECT_BASE: `http://localhost:${GOOGLE_PORT}/inspect`,
      GA4_ENABLED: 'true',
      GA4_DATA_BASE: `http://localhost:${GOOGLE_PORT}/ga4data`,
      GA4_ADMIN_BASE: `http://localhost:${GOOGLE_PORT}/ga4admin`,
      STATE_DIR: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.env.VERBOSE && process.stdout.write(`    [server] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`    [server] ${d}`));

  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${BASE}/healthz`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

async function stopServer() {
  child?.kill('SIGKILL');
  googleStub.close();
}

// ---------------------------------------------------------------------------
// OAuth helpers
// ---------------------------------------------------------------------------

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function register(redirectUris = [CLAUDE_REDIRECT]) {
  const r = await fetch(`${BASE}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Claude Test', redirect_uris: redirectUris }),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

/** Run the full authorization leg and return the authorization code. */
async function authorize(clientId, challenge, { redirectUri = CLAUDE_REDIRECT, state = 'xyz' } = {}) {
  const authUrl = new URL(`${BASE}/authorize`);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('resource', MCP_URL);

  const r1 = await fetch(authUrl, { redirect: 'manual' });
  if (r1.status !== 302) return { stage: 'authorize', status: r1.status, body: await r1.text() };

  // Hop to the Google stub, which bounces back to our callback.
  const r2 = await fetch(r1.headers.get('location'), { redirect: 'manual' });
  if (r2.status !== 302) return { stage: 'google', status: r2.status };

  const r3 = await fetch(r2.headers.get('location'), { redirect: 'manual' });
  const final = new URL(r3.headers.get('location') || 'http://invalid');
  return {
    stage: 'callback',
    status: r3.status,
    code: final.searchParams.get('code'),
    state: final.searchParams.get('state'),
    error: final.searchParams.get('error'),
    errorDescription: final.searchParams.get('error_description'),
    location: final.toString(),
  };
}

async function exchange(params) {
  const r = await fetch(`${BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

let rpcId = 0;
async function rpc(token, method, params) {
  const r = await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  const text = await r.text();
  return { status: r.status, headers: r.headers, body: text ? JSON.parse(text) : null };
}

// ---------------------------------------------------------------------------
// The tests
// ---------------------------------------------------------------------------

async function run() {
  await startServer();

  // -- Discovery ------------------------------------------------------------
  section('Discovery');
  {
    const prm = await fetch(`${BASE}/.well-known/oauth-protected-resource`).then((r) => r.json());
    check('protected resource metadata names the exact MCP URL', prm.resource === MCP_URL, prm.resource);
    check('protected resource metadata lists the authorization server', prm.authorization_servers?.[0] === BASE);

    const suffixed = await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`).then((r) => r.json());
    check('path-suffixed well-known variant resolves too', suffixed.resource === MCP_URL);

    const asm = await fetch(`${BASE}/.well-known/oauth-authorization-server`).then((r) => r.json());
    check('issuer matches the base URL', asm.issuer === BASE, asm.issuer);
    check('advertises S256 PKCE', asm.code_challenge_methods_supported?.includes('S256'));
    check('advertises a registration endpoint', typeof asm.registration_endpoint === 'string');
    check('advertises public-client token auth', asm.token_endpoint_auth_methods_supported?.includes('none'));
    check('supports the refresh_token grant', asm.grant_types_supported?.includes('refresh_token'));
    check('both products are advertised as scopes', asm.scopes_supported?.includes('gsc.read') && asm.scopes_supported?.includes('ga4.read'), JSON.stringify(asm.scopes_supported));
  }

  // -- The 401 handshake ----------------------------------------------------
  section('Unauthenticated handshake');
  {
    const r = await rpc(null, 'initialize', { protocolVersion: '2025-11-25' });
    check('unauthenticated MCP call returns 401', r.status === 401, `got ${r.status}`);
    const wa = r.headers.get('www-authenticate') || '';
    check('401 carries a resource_metadata pointer', wa.includes('resource_metadata='), wa);
    check('pointer is an absolute URL', wa.includes(`${BASE}/.well-known/oauth-protected-resource`), wa);

    const bad = await rpc('v1.not-a-real-token', 'initialize', {});
    check('a garbage bearer token is also a 401', bad.status === 401);
  }

  // -- Registration ---------------------------------------------------------
  section('Dynamic client registration');
  let clientId;
  {
    const reg = await register();
    check('registration returns 201', reg.status === 201, `got ${reg.status}`);
    check('registration issues a client_id', typeof reg.body.client_id === 'string' && reg.body.client_id.length > 10);
    check('registration reports public-client auth', reg.body.token_endpoint_auth_method === 'none');
    clientId = reg.body.client_id;

    const evil = await register(['https://attacker.example/steal']);
    check('an off-policy redirect URI is refused', evil.status === 400, `got ${evil.status}`);
    check('refusal uses the RFC 7591 error code', evil.body.error === 'invalid_redirect_uri');

    const loopback = await register(['http://localhost/callback']);
    check('a Claude Code loopback redirect is accepted', loopback.status === 201);
  }

  // -- Authorization code flow ---------------------------------------------
  section('Authorization code flow');
  let accessToken;
  let refreshToken;
  {
    const { verifier, challenge } = pkce();
    const auth = await authorize(clientId, challenge);
    check('the flow ends at the Claude callback', auth.location?.startsWith(CLAUDE_REDIRECT), auth.location);
    check('an authorization code comes back', Boolean(auth.code), auth.error || 'no code');
    check('state is returned untouched', auth.state === 'xyz');

    const tok = await exchange({
      grant_type: 'authorization_code',
      code: auth.code,
      code_verifier: verifier,
      redirect_uri: CLAUDE_REDIRECT,
      client_id: clientId,
    });
    check('code exchange succeeds', tok.status === 200, JSON.stringify(tok.body));
    check('an access token is issued', typeof tok.body.access_token === 'string');
    check('a refresh token is issued', typeof tok.body.refresh_token === 'string');
    check('expires_in is present', typeof tok.body.expires_in === 'number');
    accessToken = tok.body.access_token;
    refreshToken = tok.body.refresh_token;

    // Replay of the same code must fail even though the code itself is valid.
    const replay = await exchange({
      grant_type: 'authorization_code',
      code: auth.code,
      code_verifier: verifier,
      redirect_uri: CLAUDE_REDIRECT,
      client_id: clientId,
    });
    check('replaying an authorization code fails', replay.status === 400);
    check('replay reports invalid_grant', replay.body.error === 'invalid_grant', replay.body.error);
  }

  // -- PKCE enforcement -----------------------------------------------------
  section('PKCE and parameter enforcement');
  {
    const { challenge } = pkce();
    const auth = await authorize(clientId, challenge);
    const wrong = await exchange({
      grant_type: 'authorization_code',
      code: auth.code,
      code_verifier: randomBytes(32).toString('base64url'),
      redirect_uri: CLAUDE_REDIRECT,
      client_id: clientId,
    });
    check('a mismatched code_verifier is rejected', wrong.status === 400 && wrong.body.error === 'invalid_grant', JSON.stringify(wrong.body));

    const authUrl = new URL(`${BASE}/authorize`);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', CLAUDE_REDIRECT);
    authUrl.searchParams.set('state', 'abc');
    const noPkce = await fetch(authUrl, { redirect: 'manual' });
    const loc = new URL(noPkce.headers.get('location'));
    check('an authorize request without PKCE is refused', loc.searchParams.get('error') === 'invalid_request', loc.search);

    const openRedirect = new URL(`${BASE}/authorize`);
    openRedirect.searchParams.set('response_type', 'code');
    openRedirect.searchParams.set('client_id', clientId);
    openRedirect.searchParams.set('redirect_uri', 'https://attacker.example/steal');
    openRedirect.searchParams.set('code_challenge', challenge);
    openRedirect.searchParams.set('code_challenge_method', 'S256');
    const orRes = await fetch(openRedirect, { redirect: 'manual' });
    check('an unregistered redirect_uri never redirects', orRes.status === 400, `got ${orRes.status}`);

    const form = await fetch(`${BASE}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    check('the token endpoint rejects a JSON body', form.status === 400);
  }

  // -- Email allowlist ------------------------------------------------------
  section('Account allowlist');
  {
    stubEmail = 'stranger@elsewhere.com';
    const { challenge } = pkce();
    const auth = await authorize(clientId, challenge);
    check('a non-allowlisted Google account is refused', auth.error === 'access_denied', auth.error || 'no error');
    check('no authorization code is issued to a stranger', !auth.code);
    stubEmail = 'owner@example.com';

    stubWithholdRefreshToken = true;
    const noRefresh = await authorize(clientId, pkce().challenge);
    check('a sign-in with no refresh token is refused', noRefresh.error === 'invalid_grant', noRefresh.error || 'no error');
    stubWithholdRefreshToken = false;
  }

  // -- MCP ------------------------------------------------------------------
  section('MCP protocol');
  {
    const init = await rpc(accessToken, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0' },
    });
    check('initialize succeeds', init.status === 200 && !init.body.error, JSON.stringify(init.body?.error));
    check('the requested protocol version is echoed', init.body.result?.protocolVersion === '2025-06-18', init.body.result?.protocolVersion);
    check('tools capability is advertised', Boolean(init.body.result?.capabilities?.tools));
    check('server instructions are included', typeof init.body.result?.instructions === 'string');

    const unknownVersion = await rpc(accessToken, 'initialize', { protocolVersion: '1999-01-01' });
    check('an unknown protocol version falls back to a supported one', unknownVersion.body.result?.protocolVersion === '2025-11-25');

    const notif = await fetch(MCP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    check('a notification gets 202 with no body', notif.status === 202, `got ${notif.status}`);

    const ping = await rpc(accessToken, 'ping', {});
    check('ping responds', ping.body.result && Object.keys(ping.body.result).length === 0);

    const unknown = await rpc(accessToken, 'does/not/exist', {});
    check('an unknown method returns -32601', unknown.body.error?.code === -32601, JSON.stringify(unknown.body));

    check('GA4 instructions are included when GA4 is on', init.body.result?.instructions?.includes('Google Analytics 4'));

    const list = await rpc(accessToken, 'tools/list', {});
    const tools = list.body.result?.tools || [];
    check('tools are listed', tools.length === 14, `got ${tools.length}`);
    check('both products are present in one tool set', tools.some((t) => t.name === 'search_analytics') && tools.some((t) => t.name === 'ga4_run_report'));
    check('every tool has a schema', tools.every((t) => t.inputSchema?.type === 'object'));
    check('every tool has a description', tools.every((t) => typeof t.description === 'string' && t.description.length > 40));
    check('read-only tools are annotated', tools.find((t) => t.name === 'search_analytics')?.annotations?.readOnlyHint === true);
    check('delete_sitemap is marked destructive', tools.find((t) => t.name === 'delete_sitemap')?.annotations?.destructiveHint === true);
  }

  // -- Tools ----------------------------------------------------------------
  section('Search Console tools');
  {
    const props = await rpc(accessToken, 'tools/call', { name: 'list_properties', arguments: {} });
    const propsText = props.body.result?.content?.[0]?.text || '';
    check('list_properties returns the account properties', propsText.includes('sc-domain:example.com'), propsText.slice(0, 120));
    check('list_properties is not an error', !props.body.result?.isError);

    const sa = await rpc(accessToken, 'tools/call', {
      name: 'search_analytics',
      arguments: { siteUrl: 'example.com', dimensions: ['query'], startDate: '2026-01-15', endDate: '2026-01-28' },
    });
    const saText = sa.body.result?.content?.[0]?.text || '';
    const saJson = JSON.parse(saText);
    check('a bare domain resolves to the real property', saJson.site === 'sc-domain:example.com', saJson.site);
    check('rows are named by dimension rather than positional', saJson.rows?.[0]?.query === 'blue widgets', JSON.stringify(saJson.rows?.[0]));
    check('totals are fetched alongside the breakdown', saJson.totals?.clicks === 1000, JSON.stringify(saJson.totals));
    check('the period is echoed back with a day count', saJson.period?.days === 14, String(saJson.period?.days));

    const rel = await rpc(accessToken, 'tools/call', {
      name: 'search_analytics',
      arguments: { siteUrl: 'example.com', startDate: '28daysAgo', endDate: 'yesterday' },
    });
    check('relative dates are accepted', !rel.body.result?.isError, rel.body.result?.content?.[0]?.text?.slice(0, 160));

    const badDim = await rpc(accessToken, 'tools/call', {
      name: 'search_analytics',
      arguments: { siteUrl: 'example.com', dimensions: ['nonsense'] },
    });
    check('an invalid dimension is a readable tool error', badDim.body.result?.isError === true);

    const badSite = await rpc(accessToken, 'tools/call', {
      name: 'search_analytics',
      arguments: { siteUrl: 'not-mine.test' },
    });
    const badSiteText = badSite.body.result?.content?.[0]?.text || '';
    check('an unknown property lists what is available', badSite.body.result?.isError === true && badSiteText.includes('sc-domain:example.com'), badSiteText.slice(0, 160));

    const cmp = await rpc(accessToken, 'tools/call', {
      name: 'compare_periods',
      arguments: { siteUrl: 'example.com', dimensions: ['query'], startDate: '2026-01-15', endDate: '2026-01-28' },
    });
    const cmpJson = JSON.parse(cmp.body.result?.content?.[0]?.text || '{}');
    check('comparison defaults to the preceding window', cmpJson.previousPeriod?.startDate === '2026-01-01' && cmpJson.previousPeriod?.endDate === '2026-01-14', JSON.stringify(cmpJson.previousPeriod));
    check('totals carry a percentage change', cmpJson.totals?.clicks?.pctChange === 25, String(cmpJson.totals?.clicks?.pctChange));
    check('a term present only in the current period is flagged new', cmpJson.rows?.some((r) => r.query === 'brand new term' && r.isNew), 'missing isNew');
    check('a term that vanished is still reported', cmpJson.rows?.some((r) => r.query === 'retired term' && r.isLost), 'missing isLost');

    const movers = await rpc(accessToken, 'tools/call', {
      name: 'top_movers',
      arguments: { siteUrl: 'example.com', dimension: 'query', metric: 'clicks', startDate: '2026-01-15', endDate: '2026-01-28' },
    });
    const mJson = JSON.parse(movers.body.result?.content?.[0]?.text || '{}');
    check('the top gainer is the query that grew most', mJson.gainers?.[0]?.query === 'blue widgets', JSON.stringify(mJson.gainers?.[0]));
    check('the top loser is the query that fell most', mJson.losers?.[0]?.query === 'red widgets', JSON.stringify(mJson.losers?.[0]));
    check('gains and losses are separated', mJson.gainers?.every((r) => r.clicksDelta > 0) && mJson.losers?.every((r) => r.clicksDelta < 0));

    const posMovers = await rpc(accessToken, 'tools/call', {
      name: 'top_movers',
      arguments: { siteUrl: 'example.com', metric: 'position', startDate: '2026-01-15', endDate: '2026-01-28' },
    });
    const pJson = JSON.parse(posMovers.body.result?.content?.[0]?.text || '{}');
    check('position gains mean movement towards position 1', pJson.gainers?.[0]?.positionDelta < 0, JSON.stringify(pJson.gainers?.[0]));

    const inspect = await rpc(accessToken, 'tools/call', {
      name: 'inspect_url',
      arguments: { siteUrl: 'example.com', inspectionUrl: 'https://example.com/a' },
    });
    check('inspect_url returns the index verdict', (inspect.body.result?.content?.[0]?.text || '').includes('Submitted and indexed'));

    const sitemaps = await rpc(accessToken, 'tools/call', { name: 'list_sitemaps', arguments: { siteUrl: 'example.com' } });
    check('list_sitemaps returns the submitted sitemaps', (sitemaps.body.result?.content?.[0]?.text || '').includes('sitemap.xml'));

    const unknownTool = await rpc(accessToken, 'tools/call', { name: 'no_such_tool', arguments: {} });
    check('an unknown tool is a tool error, not a protocol error', unknownTool.body.result?.isError === true && !unknownTool.body.error);
  }

  // -- GA4 ------------------------------------------------------------------
  section('Google Analytics 4 tools');
  {
    const props = await rpc(accessToken, 'tools/call', { name: 'ga4_list_properties', arguments: {} });
    const propsJson = JSON.parse(props.body.result?.content?.[0]?.text || '{}');
    check('ga4_list_properties flattens properties across accounts', propsJson.count === 3, String(propsJson.count));
    check('the numeric property id is extracted', propsJson.properties?.[0]?.propertyId === '123456789', propsJson.properties?.[0]?.propertyId);

    const byName = await rpc(accessToken, 'tools/call', {
      name: 'ga4_run_report',
      arguments: { property: 'Example Shop', dimensions: ['sessionDefaultChannelGroup'] },
    });
    const byNameJson = JSON.parse(byName.body.result?.content?.[0]?.text || '{}');
    check('an exact display name resolves to its property', byNameJson.property === 'properties/987654321', byNameJson.property);

    const ambiguous = await rpc(accessToken, 'tools/call', { name: 'ga4_run_report', arguments: { property: 'Example' } });
    const ambiguousText = ambiguous.body.result?.content?.[0]?.text || '';
    check('an ambiguous property name errors rather than guessing', ambiguous.body.result?.isError === true && ambiguousText.includes('more than one'), ambiguousText.slice(0, 120));
    check('the ambiguity error lists the candidates', ambiguousText.includes('987654321'));

    const missing = await rpc(accessToken, 'tools/call', { name: 'ga4_run_report', arguments: { property: 'nothing-like-this' } });
    check('an unknown property lists what is available', missing.body.result?.isError === true && (missing.body.result?.content?.[0]?.text || '').includes('Example.com Web'));

    const report = await rpc(accessToken, 'tools/call', {
      name: 'ga4_run_report',
      arguments: { property: '123456789', dimensions: ['sessionDefaultChannelGroup'], startDate: '2026-01-15', endDate: '2026-01-28' },
    });
    const reportJson = JSON.parse(report.body.result?.content?.[0]?.text || '{}');
    check('a numeric id becomes a resource name without an admin lookup', reportJson.property === 'properties/123456789', reportJson.property);
    check('default metrics are applied when none are given', lastGa4Request?.metrics?.map((m) => m.name).join(',') === 'sessions,totalUsers,screenPageViews', JSON.stringify(lastGa4Request?.metrics));
    check('rows are flattened from parallel header arrays', reportJson.rows?.[0]?.sessionDefaultChannelGroup === 'Organic Search', JSON.stringify(reportJson.rows?.[0]));
    check('metric values are numbers, not strings', typeof reportJson.rows?.[0]?.sessions === 'number', typeof reportJson.rows?.[0]?.sessions);
    check('totals are returned alongside rows', reportJson.totals?.sessions === 600, JSON.stringify(reportJson.totals));
    check('the property time zone is surfaced', reportJson.timeZone === 'America/New_York');
    check('limit is sent as a string, as the API requires', typeof lastGa4Request?.limit === 'string', typeof lastGa4Request?.limit);
    check('totals are requested via metricAggregations', lastGa4Request?.metricAggregations?.includes('TOTAL'));

    await rpc(accessToken, 'tools/call', {
      name: 'ga4_run_report',
      arguments: {
        property: '123456789',
        metrics: ['sessions'],
        dimensions: ['landingPage'],
        dimensionFilters: [
          { dimension: 'landingPage', operator: 'beginsWith', value: '/blog' },
          { dimension: 'country', values: ['United States', 'Canada'] },
        ],
        metricFilters: [{ metric: 'sessions', operator: 'greaterThan', value: 10 }],
        orderBy: { metric: 'sessions', desc: true },
      },
    });
    const andGroup = lastGa4Request?.dimensionFilter?.andGroup?.expressions || [];
    check('two dimension filters become an AND group', andGroup.length === 2, JSON.stringify(lastGa4Request?.dimensionFilter)?.slice(0, 140));
    check('a string filter maps to the right match type', andGroup[0]?.filter?.stringFilter?.matchType === 'BEGINS_WITH');
    check('a values list becomes an inListFilter', andGroup[1]?.filter?.inListFilter?.values?.length === 2);
    check('a metric filter becomes a numericFilter', lastGa4Request?.metricFilter?.filter?.numericFilter?.operation === 'GREATER_THAN', JSON.stringify(lastGa4Request?.metricFilter));
    check('orderBy becomes a metric ordering', lastGa4Request?.orderBys?.[0]?.metric?.metricName === 'sessions');

    const badOperator = await rpc(accessToken, 'tools/call', {
      name: 'ga4_run_report',
      arguments: { property: '123456789', dimensionFilters: [{ dimension: 'country', operator: 'sortOf', value: 'x' }] },
    });
    check('an unknown filter operator is a readable error', badOperator.body.result?.isError === true && (badOperator.body.result?.content?.[0]?.text || '').includes('unknown dimension filter operator'));

    const cmp = await rpc(accessToken, 'tools/call', {
      name: 'ga4_compare_periods',
      arguments: { property: '123456789', metrics: ['sessions'], dimensions: ['sessionDefaultChannelGroup'], startDate: '2026-01-15', endDate: '2026-01-28' },
    });
    const cmpJson = JSON.parse(cmp.body.result?.content?.[0]?.text || '{}');
    check('two date ranges are sent in one request', lastGa4Request?.dateRanges?.length === 2, JSON.stringify(lastGa4Request?.dateRanges));
    check('the comparison window defaults to the preceding period', cmpJson.previousPeriod?.startDate === '2026-01-01' && cmpJson.previousPeriod?.endDate === '2026-01-14', JSON.stringify(cmpJson.previousPeriod));
    const organic = cmpJson.rows?.find((r) => r.sessionDefaultChannelGroup === 'Organic Search');
    check('the dateRange dimension is pivoted into deltas', organic?.sessions === 500 && organic?.sessionsPrevious === 400, JSON.stringify(organic));
    check('percentage change is computed', organic?.sessionsPctChange === 25, String(organic?.sessionsPctChange));
    check('the biggest mover sorts first', cmpJson.rows?.[0]?.sessionDefaultChannelGroup === 'Organic Search', cmpJson.rows?.[0]?.sessionDefaultChannelGroup);
    check('a channel new this period is flagged', cmpJson.rows?.some((r) => r.sessionDefaultChannelGroup === 'Paid Search' && r.isNew));
    check('a channel that disappeared is still reported', cmpJson.rows?.some((r) => r.sessionDefaultChannelGroup === 'Referral' && r.isLost && r.sessionsPrevious === 30));

    const realtime = await rpc(accessToken, 'tools/call', { name: 'ga4_realtime_report', arguments: { property: '123456789', dimensions: ['country'] } });
    const rtJson = JSON.parse(realtime.body.result?.content?.[0]?.text || '{}');
    check('realtime defaults to activeUsers', lastGa4Request?.metrics?.[0]?.name === 'activeUsers');
    check('realtime rows come back shaped', rtJson.rows?.[0]?.country === 'United States' && rtJson.rows?.[0]?.activeUsers === 42, JSON.stringify(rtJson.rows?.[0]));

    const meta = await rpc(accessToken, 'tools/call', { name: 'ga4_metadata', arguments: { property: '123456789', search: 'landing' } });
    const metaJson = JSON.parse(meta.body.result?.content?.[0]?.text || '{}');
    check('metadata search narrows the field list', metaJson.dimensionCount === 1 && metaJson.dimensions?.[0]?.apiName === 'landingPage', JSON.stringify(metaJson.dimensions));
    check('metadata reports how many fields exist in total', metaJson.totalAvailable?.dimensions === 3);

    const customMeta = await rpc(accessToken, 'tools/call', { name: 'ga4_metadata', arguments: { property: '123456789', customOnly: true } });
    const customJson = JSON.parse(customMeta.body.result?.content?.[0]?.text || '{}');
    check('customOnly returns just the custom definitions', customJson.metricCount === 1 && customJson.metrics?.[0]?.apiName === 'customEvent:signup_value', JSON.stringify(customJson.metrics));
    check('custom fields are marked as custom', customJson.dimensions?.[0]?.custom === true);
  }

  // -- Refresh --------------------------------------------------------------
  section('Token refresh and rotation');
  {
    const first = await exchange({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId });
    check('refresh returns a new access token', first.status === 200 && typeof first.body.access_token === 'string');
    check('refresh rotates the refresh token', first.body.refresh_token && first.body.refresh_token !== refreshToken);

    const reuse = await exchange({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId });
    check('the rotated-out refresh token stops working', reuse.status === 400, `got ${reuse.status}`);
    check('reuse reports invalid_grant', reuse.body.error === 'invalid_grant', reuse.body.error);

    const working = await rpc(first.body.access_token, 'tools/list', {});
    check('the newly refreshed access token works', working.status === 200 && !working.body.error);

    const bogus = await exchange({ grant_type: 'refresh_token', refresh_token: 'v1.aaa.bbb', client_id: clientId });
    check('a forged refresh token is rejected', bogus.status === 400 && bogus.body.error === 'invalid_grant');

    const badGrant = await exchange({ grant_type: 'client_credentials', client_id: clientId });
    check('client_credentials is refused', badGrant.body.error === 'unsupported_grant_type');
  }

  // -- Token confusion ------------------------------------------------------
  section('Token separation');
  {
    // A refresh token must not be usable as a bearer token, and vice versa.
    const asBearer = await rpc(refreshToken, 'tools/list', {});
    check('a refresh token cannot be used as a bearer token', asBearer.status === 401, `got ${asBearer.status}`);

    const accessAsRefresh = await exchange({ grant_type: 'refresh_token', refresh_token: accessToken, client_id: clientId });
    check('an access token cannot be used as a refresh token', accessAsRefresh.status === 400);

    const asCode = await exchange({
      grant_type: 'authorization_code',
      code: accessToken,
      code_verifier: 'whatever',
      client_id: clientId,
    });
    check('an access token cannot be used as an authorization code', asCode.status === 400);
  }

  // -- Transport details ----------------------------------------------------
  section('Transport details');
  {
    const get = await fetch(MCP_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
    check('GET on the MCP endpoint is 405, not a hang', get.status === 405, `got ${get.status}`);

    const opts = await fetch(MCP_URL, { method: 'OPTIONS' });
    check('CORS preflight is answered', opts.status === 204 && opts.headers.get('access-control-allow-origin') === '*');

    const batch = await fetch(MCP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify([
        { jsonrpc: '2.0', id: 'a', method: 'ping' },
        { jsonrpc: '2.0', id: 'b', method: 'ping' },
      ]),
    });
    const batchBody = await batch.json();
    check('a JSON-RPC batch returns an array of responses', Array.isArray(batchBody) && batchBody.length === 2);

    const malformed = await fetch(MCP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: 'not json at all',
    });
    check('a malformed body returns a parse error', malformed.status === 400);

    const health = await fetch(`${BASE}/healthz`).then((r) => r.json());
    check('health endpoint reports ok', health.ok === true);

    const landing = await fetch(`${BASE}/`);
    check('the landing page shows the connector URL', (await landing.text()).includes(MCP_URL));
  }

  await stopServer();

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed) {
    for (const f of failures) console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ''}`);
    process.exit(1);
  }
}

run().catch(async (err) => {
  console.error('\nharness error:', err);
  await stopServer();
  process.exit(1);
});
