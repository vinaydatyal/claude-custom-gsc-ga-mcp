/**
 * MCP over Streamable HTTP.
 *
 * This server is stateless: it issues no session id and keeps no per-client
 * state, so every POST is answered with a single JSON response rather than an
 * SSE stream. That is explicitly allowed by the transport, and it means the
 * server can be restarted or run behind several instances without dropping a
 * connection.
 */

import { config } from './config.js';
import { callTool, toolDescriptors } from './tools.js';
import { log, sendJson, sendNoContent } from './util.js';

const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
const PARSE_ERROR = -32700;

function result(id, value) {
  return { jsonrpc: '2.0', id, result: value };
}

function error(id, code, message, data) {
  const err = { code, message };
  if (data !== undefined) err.data = data;
  return { jsonrpc: '2.0', id, error: err };
}

const GSC_INSTRUCTIONS = `Google Search Console — how people found the site in Google Search.

- Data lags about two days. A query ending today shows little or nothing for the last day or two unless dataState is "all".
- Search Console omits queries made by very few people, so query-level clicks never sum to the site total. Compare totals to totals.
- Average position is an average of the best position per impression. Lower is better, so a negative positionDelta is an improvement.
- Properties come in two kinds: "sc-domain:example.com" covers every subdomain and scheme, while "https://example.com/" covers only that exact prefix. Tools accept a bare domain and resolve it.

Start with list_properties when the property is not known. Use search_analytics for one period, compare_periods for before-and-after, and top_movers to find what drove a change.`;

const GA4_INSTRUCTIONS = `

Google Analytics 4 — what people did once they arrived.

- Start with ga4_list_properties when the property is not known; GA4 properties are numeric IDs, unrelated to Search Console property names.
- Dates are evaluated in the property's own time zone, which may not be yours.
- "conversions" was renamed "keyEvents". If a field name is rejected, ga4_metadata lists exactly what that property accepts, custom dimensions included.
- A breakdown can come back with an "(other)" row when a property exceeds its cardinality limit; the response says so when it happens.

The two sources answer different halves of a question, and the interesting work is usually joining them. Search Console knows impressions, clicks and ranking position for a page; GA4 knows what happened after the click — sessions, engagement, conversions. A page whose clicks held steady while its conversions fell is a GA4 story, not a ranking one. Match them on the page URL: Search Console reports a full URL in its "page" dimension, GA4 reports a path in "landingPage", so compare paths rather than whole URLs.`;

const INSTRUCTIONS = GSC_INSTRUCTIONS + (config.enableGa4 ? GA4_INSTRUCTIONS : '');

/**
 * Handle one JSON-RPC message.
 * @param {any} msg
 * @param {{refreshToken: string, email: string}} ctx
 * @returns {Promise<object|null>} null for notifications
 */
async function dispatch(msg, ctx) {
  if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) {
    return error(null, INVALID_REQUEST, 'message must be a JSON-RPC object');
  }
  if (msg.jsonrpc !== '2.0') {
    return error(msg.id ?? null, INVALID_REQUEST, 'jsonrpc must be "2.0"');
  }

  const { method, params, id } = msg;
  const isNotification = id === undefined || id === null;

  // Responses to requests this server never sends: acknowledge and move on.
  if (method === undefined) return null;

  switch (method) {
    case 'initialize': {
      const requested = params?.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION;
      log('info', 'client initialized', {
        email: ctx.email,
        client: params?.clientInfo?.name,
        clientVersion: params?.clientInfo?.version,
        protocolVersion,
      });
      return result(id, {
        protocolVersion,
        capabilities: {
          // listChanged is false: the tool set is fixed for the life of a
          // connection, so there is nothing to notify about.
          tools: { listChanged: false },
        },
        serverInfo: {
          name: config.serverName,
          title: 'Google Search Console',
          version: config.version,
        },
        instructions: INSTRUCTIONS,
      });
    }

    case 'notifications/initialized':
    case 'notifications/cancelled':
    case 'notifications/progress':
      return null;

    case 'ping':
      return result(id, {});

    case 'tools/list':
      return result(id, { tools: toolDescriptors() });

    case 'tools/call': {
      const name = params?.name;
      if (typeof name !== 'string') {
        return error(id, INVALID_PARAMS, 'params.name is required');
      }
      const started = Date.now();
      const out = await callTool(name, params.arguments || {}, ctx);
      log('info', 'tool called', { tool: name, ms: Date.now() - started, isError: Boolean(out.isError) });
      return result(id, out);
    }

    // Declared capabilities do not include these, but a client may probe.
    case 'resources/list':
      return result(id, { resources: [] });
    case 'prompts/list':
      return result(id, { prompts: [] });

    default:
      if (isNotification) return null;
      return error(id, METHOD_NOT_FOUND, `method not found: ${method}`);
  }
}

/**
 * Handle a POST to the MCP endpoint.
 * @param {string} raw request body
 * @param {import('node:http').ServerResponse} res
 * @param {{refreshToken: string, email: string}} ctx
 */
export async function handleMcpPost(raw, res, ctx) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return sendJson(res, 400, error(null, PARSE_ERROR, 'request body is not valid JSON'));
  }

  const batch = Array.isArray(parsed);
  const messages = batch ? parsed : [parsed];
  if (batch && messages.length === 0) {
    return sendJson(res, 400, error(null, INVALID_REQUEST, 'batch must not be empty'));
  }

  const responses = [];
  for (const msg of messages) {
    try {
      const out = await dispatch(msg, ctx);
      if (out) responses.push(out);
    } catch (err) {
      log('error', 'dispatch failed', { error: String(err?.stack || err) });
      const id = msg && typeof msg === 'object' ? msg.id ?? null : null;
      if (id !== null) responses.push(error(id, INTERNAL_ERROR, 'internal error'));
    }
  }

  // Nothing to say: the payload was all notifications or responses.
  if (responses.length === 0) return sendNoContent(res, 202);

  return sendJson(res, 200, batch ? responses : responses[0], {
    'MCP-Protocol-Version': LATEST_PROTOCOL_VERSION,
  });
}

export const _internal = { dispatch, SUPPORTED_PROTOCOL_VERSIONS };
