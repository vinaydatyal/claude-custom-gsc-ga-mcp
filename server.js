#!/usr/bin/env node
/**
 * gsc-mcp — a personal remote MCP server for Google Search Console and
 * Google Analytics 4, over one Google sign-in.
 *
 * One process, no dependencies, no database. It serves three things:
 *   1. OAuth 2.1 discovery, registration and token endpoints, which is what
 *      claude.ai requires before it will add a custom connector;
 *   2. a Google sign-in bridge that turns a Google refresh token into this
 *      server's own sealed tokens;
 *   3. the MCP endpoint itself, exposing Search Console as tools.
 */

import { createServer } from 'node:http';
import { assertConfigValid, config } from './lib/config.js';
import { handleMcpPost } from './lib/mcp.js';
import {
  authenticate,
  authorizationServerMetadata,
  handleAuthorize,
  handleAuthorizeContinue,
  handleGoogleCallback,
  handleRegister,
  handleRevoke,
  handleToken,
  protectedResourceMetadata,
  sendUnauthorized,
} from './lib/oauth.js';
import { startStore, stopStore } from './lib/store.js';
import { availableTools } from './lib/tools.js';
import {
  clientIp,
  escapeHtml,
  log,
  readBody,
  sendCorsPreflight,
  sendDiscovery,
  sendHtml,
  sendJson,
  sendText,
} from './lib/util.js';

assertConfigValid();
startStore();

// RFC 8414 and RFC 9728 allow the well-known path to carry the resource path
// as a suffix, so /.well-known/oauth-protected-resource/mcp must work as well
// as the bare path. Claude probes both.
function isWellKnown(pathname, name) {
  return pathname === `/.well-known/${name}` || pathname.startsWith(`/.well-known/${name}/`);
}

function landingPage() {
  const tools = availableTools().map((t) => `<li><code>${escapeHtml(t.name)}</code> — ${escapeHtml(t.title)}</li>`).join('');
  return `<!doctype html><meta charset="utf-8"><title>Search Console + Analytics MCP</title>
<style>body{font:16px/1.6 system-ui,-apple-system,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1.5rem;color:#1a1a1a}
h1{font-size:1.4rem;margin-bottom:.25rem}h2{font-size:1rem;margin-top:2rem}p{color:#555}
code{background:#f4f4f5;padding:.15em .4em;border-radius:3px;font-size:.9em}
ul{padding-left:1.1rem}li{margin:.25rem 0}.url{display:block;background:#f7f7f8;padding:.85rem 1rem;border-radius:8px;word-break:break-all;margin:.5rem 0}</style>
<h1>Search Console + Analytics MCP</h1>
<p>A private MCP server. Add it to Claude as a custom connector using this URL:</p>
<code class="url">${escapeHtml(config.resourceUrl)}</code>
<p>Leave the client ID and secret blank — the server registers Claude automatically. You will be asked to sign in with Google, and only permitted accounts can connect.</p>
<h2>Tools</h2><ul>${tools}</ul>
<h2>Mode</h2><p>Search Console: ${config.enableWrite ? 'read and write (sitemap submission enabled)' : 'read-only'}. Analytics 4: ${config.enableGa4 ? 'read-only' : 'disabled'}.</p>`;
}

const server = createServer(async (req, res) => {
  const started = Date.now();
  let url;
  try {
    url = new URL(req.url, config.baseUrl);
  } catch {
    return sendText(res, 400, 'bad request');
  }
  const { pathname } = url;
  const method = req.method || 'GET';

  try {
    if (method === 'OPTIONS') return sendCorsPreflight(res);

    // ---- health and landing ------------------------------------------------
    if (pathname === '/healthz') {
      return sendJson(res, 200, { ok: true, version: config.version, write: config.enableWrite });
    }
    if (pathname === '/' && method === 'GET') {
      return sendHtml(res, 200, landingPage());
    }

    // ---- OAuth discovery ---------------------------------------------------
    if (method === 'GET' && isWellKnown(pathname, 'oauth-protected-resource')) {
      return sendDiscovery(res, protectedResourceMetadata());
    }
    if (
      method === 'GET' &&
      (isWellKnown(pathname, 'oauth-authorization-server') || isWellKnown(pathname, 'openid-configuration'))
    ) {
      return sendDiscovery(res, authorizationServerMetadata());
    }

    // ---- OAuth endpoints ---------------------------------------------------
    if (pathname === '/register' && method === 'POST') return await handleRegister(req, res);
    if (pathname === '/authorize' && method === 'GET') return await handleAuthorize(req, res, url);
    if (pathname === '/authorize/continue' && method === 'POST') return await handleAuthorizeContinue(req, res);
    if (pathname === '/oauth/google/callback' && method === 'GET') return await handleGoogleCallback(req, res, url);
    if (pathname === '/token' && method === 'POST') return await handleToken(req, res);
    if (pathname === '/revoke' && method === 'POST') return await handleRevoke(req, res);

    // ---- MCP ---------------------------------------------------------------
    if (pathname === config.mcpPath) {
      const ctx = authenticate(req);
      if (!ctx) {
        // This 401 is how a sign-in starts: Claude reads the pointer in the
        // WWW-Authenticate header to find the authorization server.
        return sendUnauthorized(res);
      }
      if (method === 'POST') {
        const raw = await readBody(req);
        return await handleMcpPost(raw, res, { refreshToken: ctx.rt, email: ctx.em });
      }
      if (method === 'GET') {
        // No server-initiated stream: this server answers each POST directly.
        return sendText(res, 405, 'this server does not open SSE streams', { Allow: 'POST, DELETE' });
      }
      if (method === 'DELETE') {
        // Stateless, so there is no session to tear down.
        return sendJson(res, 200, { ok: true });
      }
      return sendText(res, 405, 'method not allowed', { Allow: 'POST, DELETE' });
    }

    return sendText(res, 404, 'not found');
  } catch (err) {
    const status = err?.statusCode || 500;
    log('error', 'request failed', { path: pathname, method, status, error: String(err?.stack || err) });
    if (!res.headersSent) sendJson(res, status, { error: status === 413 ? 'payload_too_large' : 'server_error' });
  } finally {
    log('debug', 'request', { method, path: pathname, ms: Date.now() - started, ip: clientIp(req) });
  }
});

// Keep well clear of the 10s budget Claude allows OAuth endpoints, and the
// 30s it allows refreshes.
server.headersTimeout = 20_000;
server.requestTimeout = 60_000;
server.keepAliveTimeout = 65_000;

server.listen(config.port, config.host, () => {
  log('info', 'listening', {
    url: config.baseUrl,
    connectorUrl: config.resourceUrl,
    port: config.port,
    write: config.enableWrite,
    cimd: config.enableCimd,
    allowedEmails: config.allowedEmails.length,
    tools: availableTools().length,
    secret: config.secretFingerprint,
  });
});

function shutdown(signal) {
  log('info', 'shutting down', { signal });
  stopStore();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export { server };
