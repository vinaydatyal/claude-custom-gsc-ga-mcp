/**
 * The MCP tool surface.
 *
 * Each tool is defined with a JSON Schema that Claude reads directly, so the
 * descriptions here are doing real work: they are the only thing telling the
 * model what a Search Console property identifier looks like, which metrics
 * move in which direction, and how stale the data is.
 */

import { config } from './config.js';
import {
  buildDimensionFilter,
  buildMetricFilter,
  buildOrderBys,
  ga4Date,
  getMetadata,
  listGa4Properties,
  resolveGa4Property,
  runRealtimeReport,
  runReport,
  shapeGa4Rows,
} from './ga4.js';
import {
  GoogleApiError,
  deleteSitemap,
  getSitemap,
  inspectUrl,
  listSitemaps,
  listSites,
  resolveSiteUrl,
  searchAnalytics,
  submitSitemap,
} from './google.js';
import { daysBetween, resolveDate, shiftDate } from './util.js';

const MAX_RESPONSE_BYTES = 250_000;
const VALID_DIMENSIONS = ['query', 'page', 'country', 'device', 'searchAppearance', 'date', 'hour'];
const VALID_OPERATORS = ['equals', 'notEquals', 'contains', 'notContains', 'includingRegex', 'excludingRegex'];

// ---------------------------------------------------------------------------
// Shared schema fragments
// ---------------------------------------------------------------------------

const siteProp = {
  type: 'string',
  description:
    'The Search Console property. A bare domain like "example.com" is resolved against the properties this account owns, or pass the exact identifier ("sc-domain:example.com" for a domain property, "https://example.com/" for a URL-prefix one).',
};

const dateProp = (what, dflt) => ({
  type: 'string',
  description: `${what} as YYYY-MM-DD, or a relative expression: "today", "yesterday", "28daysAgo", "3monthsAgo". Defaults to "${dflt}". Search Console data is final only after about two days.`,
});

const filtersProp = {
  type: 'array',
  description:
    'Optional filters, combined with AND. Regex filters use RE2 syntax and are limited to 4096 characters by the API.',
  items: {
    type: 'object',
    properties: {
      dimension: { type: 'string', enum: VALID_DIMENSIONS, description: 'Which dimension to filter on.' },
      operator: { type: 'string', enum: VALID_OPERATORS, description: 'Comparison to apply.' },
      expression: { type: 'string', description: 'Value to compare against. Country uses three-letter codes such as "usa"; device is "DESKTOP", "MOBILE" or "TABLET".' },
    },
    required: ['dimension', 'operator', 'expression'],
    additionalProperties: false,
  },
};

const typeProp = {
  type: 'string',
  enum: ['web', 'image', 'video', 'news', 'googleNews', 'discover'],
  description: 'Which search surface to report on. Defaults to "web". Note that "discover" and "googleNews" support fewer dimensions.',
};

const dataStateProp = {
  type: 'string',
  enum: ['final', 'all'],
  description:
    'Use "final" (the default) for settled data, or "all" to include the most recent, still-incomplete days. Fresh data moves, so prefer "final" for anything being compared over time.',
};

const ga4PropertyProp = {
  type: 'string',
  description:
    'The GA4 property: its numeric ID ("123456789"), the full resource name ("properties/123456789"), or its display name as it appears in Analytics. A display name matching more than one property is an error rather than a guess.',
};

const ga4DateProp = (what, dflt) => ({
  type: 'string',
  description: `${what} as YYYY-MM-DD, or "today", "yesterday", "NdaysAgo". Defaults to "${dflt}". Dates are evaluated in the property's own time zone.`,
});

const ga4DimensionFiltersProp = {
  type: 'array',
  description: 'Optional dimension filters, combined with AND.',
  items: {
    type: 'object',
    properties: {
      dimension: { type: 'string', description: 'GA4 dimension API name, for example "landingPage".' },
      operator: {
        type: 'string',
        enum: ['exact', 'contains', 'beginsWith', 'endsWith', 'fullRegex', 'partialRegex'],
        description: 'How to match. Defaults to "exact". Ignored when "values" is given.',
      },
      value: { type: 'string', description: 'The value to match.' },
      values: { type: 'array', items: { type: 'string' }, description: 'Match any value in this list, instead of a single value.' },
      caseSensitive: { type: 'boolean', description: 'Defaults to false.' },
      not: { type: 'boolean', description: 'Invert this condition.' },
    },
    required: ['dimension'],
    additionalProperties: false,
  },
};

const ga4MetricFiltersProp = {
  type: 'array',
  description: 'Optional metric filters, applied after aggregation like a SQL HAVING clause. Useful for dropping long-tail noise, for example sessions greater than 10.',
  items: {
    type: 'object',
    properties: {
      metric: { type: 'string', description: 'GA4 metric API name.' },
      operator: {
        type: 'string',
        enum: ['equals', 'lessThan', 'lessOrEqual', 'greaterThan', 'greaterOrEqual'],
        description: 'Defaults to "greaterThan".',
      },
      value: { type: 'number', description: 'The number to compare against.' },
    },
    required: ['metric', 'value'],
    additionalProperties: false,
  },
};

const ga4OrderByProp = {
  type: 'object',
  description: 'How to sort the rows. Give either a metric or a dimension, not both.',
  properties: {
    metric: { type: 'string', description: 'Sort by this metric.' },
    dimension: { type: 'string', description: 'Sort by this dimension.' },
    desc: { type: 'boolean', description: 'Descending. Defaults to true.' },
  },
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function round(n, places) {
  if (typeof n !== 'number' || Number.isNaN(n)) return n;
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

/** Turn the API's positional `keys` array into named fields. */
function shapeRows(rows, dimensions) {
  return (rows || []).map((r) => {
    const out = {};
    dimensions.forEach((d, i) => {
      out[d] = r.keys?.[i];
    });
    out.clicks = r.clicks ?? 0;
    out.impressions = r.impressions ?? 0;
    out.ctr = round(r.ctr ?? 0, 4);
    out.position = round(r.position ?? 0, 2);
    return out;
  });
}

function buildQuery(args, { dimensions = [] } = {}) {
  const startDate = resolveDate(args.startDate || '28daysAgo');
  const endDate = resolveDate(args.endDate || 'today');
  if (startDate > endDate) {
    throw new ToolError(`startDate (${startDate}) is after endDate (${endDate})`);
  }
  const query = {
    startDate,
    endDate,
    dimensions,
    type: args.type || 'web',
    dataState: args.dataState || 'final',
    rowLimit: Math.min(Math.max(Number(args.rowLimit) || 1000, 1), 25000),
    startRow: Math.max(Number(args.startRow) || 0, 0),
  };
  if (args.aggregationType) query.aggregationType = args.aggregationType;
  if (Array.isArray(args.filters) && args.filters.length) {
    query.dimensionFilterGroups = [
      {
        groupType: 'and',
        filters: args.filters.map((f) => {
          if (!VALID_DIMENSIONS.includes(f.dimension)) throw new ToolError(`unknown filter dimension: ${f.dimension}`);
          if (!VALID_OPERATORS.includes(f.operator)) throw new ToolError(`unknown filter operator: ${f.operator}`);
          return { dimension: f.dimension, operator: f.operator, expression: String(f.expression) };
        }),
      },
    ];
  }
  return query;
}

/** A failure the model should see and can act on, rather than a server fault. */
export class ToolError extends Error {}

function validateDimensions(dimensions) {
  for (const d of dimensions) {
    if (!VALID_DIMENSIONS.includes(d)) {
      throw new ToolError(`unknown dimension "${d}". Valid dimensions: ${VALID_DIMENSIONS.join(', ')}`);
    }
  }
}

/** Totals need their own undimensioned query; the API will not add them. */
async function fetchTotals(refreshToken, siteUrl, baseQuery) {
  const totalsQuery = { ...baseQuery, dimensions: [], rowLimit: 1, startRow: 0 };
  const res = await searchAnalytics(refreshToken, siteUrl, totalsQuery);
  const row = res.rows?.[0];
  if (!row) return { clicks: 0, impressions: 0, ctr: 0, position: 0 };
  return {
    clicks: row.clicks ?? 0,
    impressions: row.impressions ?? 0,
    ctr: round(row.ctr ?? 0, 4),
    position: round(row.position ?? 0, 2),
  };
}

/**
 * Join two periods on their dimension keys and compute deltas.
 * For position, a negative delta is an improvement — the output says so.
 */
function diffRows(currentRows, previousRows, dimensions) {
  const keyOf = (r) => dimensions.map((d) => r[d] ?? '').join('\u0000');
  const prev = new Map(previousRows.map((r) => [keyOf(r), r]));
  const seen = new Set();
  const out = [];

  for (const cur of currentRows) {
    const k = keyOf(cur);
    seen.add(k);
    const p = prev.get(k);
    const row = {};
    dimensions.forEach((d) => (row[d] = cur[d]));
    row.clicks = cur.clicks;
    row.clicksPrevious = p ? p.clicks : 0;
    row.clicksDelta = cur.clicks - (p ? p.clicks : 0);
    row.impressions = cur.impressions;
    row.impressionsPrevious = p ? p.impressions : 0;
    row.impressionsDelta = cur.impressions - (p ? p.impressions : 0);
    row.ctr = cur.ctr;
    row.ctrPrevious = p ? p.ctr : 0;
    row.position = cur.position;
    row.positionPrevious = p ? p.position : null;
    row.positionDelta = p ? round(cur.position - p.position, 2) : null;
    row.isNew = !p;
    out.push(row);
  }

  // Rows that existed before and have vanished entirely are the most
  // interesting losses, so they must not be dropped.
  for (const p of previousRows) {
    const k = keyOf(p);
    if (seen.has(k)) continue;
    const row = {};
    dimensions.forEach((d) => (row[d] = p[d]));
    row.clicks = 0;
    row.clicksPrevious = p.clicks;
    row.clicksDelta = -p.clicks;
    row.impressions = 0;
    row.impressionsPrevious = p.impressions;
    row.impressionsDelta = -p.impressions;
    row.ctr = 0;
    row.ctrPrevious = p.ctr;
    row.position = null;
    row.positionPrevious = p.position;
    row.positionDelta = null;
    row.isLost = true;
    out.push(row);
  }
  return out;
}

/** Work out the window immediately before the current one. */
function precedingWindow(startDate, endDate) {
  const len = daysBetween(startDate, endDate);
  return { start: shiftDate(startDate, -len), end: shiftDate(startDate, -1) };
}

/** Keep a response from blowing past the context it has to fit into. */
function capRows(payload, rowsKey = 'rows') {
  let text = JSON.stringify(payload, null, 2);
  if (text.length <= MAX_RESPONSE_BYTES) return text;
  const rows = payload[rowsKey] || [];
  let keep = rows.length;
  while (keep > 10 && text.length > MAX_RESPONSE_BYTES) {
    keep = Math.floor(keep * 0.6);
    const trimmed = {
      ...payload,
      [rowsKey]: rows.slice(0, keep),
      truncated: {
        returned: keep,
        of: rows.length,
        note: 'Response was truncated to fit. Narrow the date range, add a filter, or page with startRow.',
      },
    };
    text = JSON.stringify(trimmed, null, 2);
  }
  return text;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

/** @type {Array<{name:string,title:string,description:string,inputSchema:object,write?:boolean,handler:Function}>} */
const TOOLS = [
  {
    name: 'list_properties',
    title: 'List Search Console properties',
    description:
      'List every Search Console property this Google account can access, with the permission level held on each. Start here when the property to use is not already known.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async handler(_args, ctx) {
      const sites = await listSites(ctx.refreshToken);
      return JSON.stringify(
        {
          account: ctx.email,
          count: sites.length,
          properties: sites.map((s) => ({
            siteUrl: s.siteUrl,
            permissionLevel: s.permissionLevel,
            kind: s.siteUrl?.startsWith('sc-domain:') ? 'domain' : 'url-prefix',
          })),
        },
        null,
        2
      );
    },
  },

  {
    name: 'search_analytics',
    title: 'Query search performance',
    description:
      'The main Search Console performance report: clicks, impressions, CTR and average position, broken down by any combination of query, page, country, device, search appearance, date or hour. Use this for "how is X performing", "top queries", "which pages get traffic", and anything needing raw numbers for one period.',
    inputSchema: {
      type: 'object',
      properties: {
        siteUrl: siteProp,
        dimensions: {
          type: 'array',
          items: { type: 'string', enum: VALID_DIMENSIONS },
          description:
            'How to break the data down, in the order the columns should nest. Omit for site-wide totals. Note that Search Console drops queries made by very few users, so query-level clicks will not sum to the site total.',
        },
        startDate: dateProp('Start of the period', '28daysAgo'),
        endDate: dateProp('End of the period', 'today'),
        filters: filtersProp,
        type: typeProp,
        dataState: dataStateProp,
        rowLimit: { type: 'integer', description: 'Rows to return, 1 to 25000. Defaults to 1000.' },
        startRow: { type: 'integer', description: 'Zero-based offset for paging through more than rowLimit rows.' },
        aggregationType: {
          type: 'string',
          enum: ['auto', 'byPage', 'byProperty'],
          description: 'How to aggregate duplicate results. Leave unset unless you specifically need byPage or byProperty.',
        },
        includeTotals: {
          type: 'boolean',
          description: 'Also return period totals alongside the breakdown. Defaults to true, and costs one extra API call.',
        },
      },
      required: ['siteUrl'],
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const dimensions = Array.isArray(args.dimensions) ? args.dimensions : [];
      validateDimensions(dimensions);
      const siteUrl = await resolveSiteUrl(ctx.refreshToken, args.siteUrl);
      const query = buildQuery(args, { dimensions });

      const res = await searchAnalytics(ctx.refreshToken, siteUrl, query);
      const rows = shapeRows(res.rows, dimensions);

      const payload = {
        site: siteUrl,
        period: { startDate: query.startDate, endDate: query.endDate, days: daysBetween(query.startDate, query.endDate) },
        searchType: query.type,
        dataState: query.dataState,
        dimensions,
        rowCount: rows.length,
        rows,
      };

      if (dimensions.length && args.includeTotals !== false) {
        payload.totals = await fetchTotals(ctx.refreshToken, siteUrl, query);
      } else if (!dimensions.length && rows.length) {
        payload.totals = { clicks: rows[0].clicks, impressions: rows[0].impressions, ctr: rows[0].ctr, position: rows[0].position };
      }
      if (rows.length === query.rowLimit) {
        payload.morePages = `Exactly rowLimit rows came back, so there are probably more. Call again with startRow=${query.startRow + query.rowLimit}.`;
      }
      return capRows(payload);
    },
  },

  {
    name: 'compare_periods',
    title: 'Compare two periods',
    description:
      'Compare search performance between two periods and return totals plus a per-row breakdown of what changed. Use this for "is traffic up or down", "how does this month compare to last", or any before-and-after question, such as around a site change or an algorithm update. If no previous period is given, the equivalent window immediately before the current one is used.',
    inputSchema: {
      type: 'object',
      properties: {
        siteUrl: siteProp,
        dimensions: {
          type: 'array',
          items: { type: 'string', enum: VALID_DIMENSIONS },
          description: 'How to break down the comparison. Omit to compare totals only.',
        },
        startDate: dateProp('Start of the current period', '28daysAgo'),
        endDate: dateProp('End of the current period', 'today'),
        previousStartDate: { type: 'string', description: 'Start of the period to compare against. Defaults to the window of equal length immediately before the current one.' },
        previousEndDate: { type: 'string', description: 'End of the comparison period. Defaults to the day before startDate.' },
        filters: filtersProp,
        type: typeProp,
        dataState: dataStateProp,
        rowLimit: { type: 'integer', description: 'Rows to pull per period, 1 to 25000. Defaults to 1000.' },
      },
      required: ['siteUrl'],
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const dimensions = Array.isArray(args.dimensions) ? args.dimensions : [];
      validateDimensions(dimensions);
      const siteUrl = await resolveSiteUrl(ctx.refreshToken, args.siteUrl);
      const current = buildQuery(args, { dimensions });

      const prev = args.previousStartDate
        ? { start: resolveDate(args.previousStartDate), end: resolveDate(args.previousEndDate || shiftDate(current.startDate, -1)) }
        : precedingWindow(current.startDate, current.endDate);
      const previous = { ...current, startDate: prev.start, endDate: prev.end };

      const [curRes, prevRes, curTotals, prevTotals] = await Promise.all([
        searchAnalytics(ctx.refreshToken, siteUrl, current),
        searchAnalytics(ctx.refreshToken, siteUrl, previous),
        fetchTotals(ctx.refreshToken, siteUrl, current),
        fetchTotals(ctx.refreshToken, siteUrl, previous),
      ]);

      const payload = {
        site: siteUrl,
        currentPeriod: { startDate: current.startDate, endDate: current.endDate, days: daysBetween(current.startDate, current.endDate) },
        previousPeriod: { startDate: previous.startDate, endDate: previous.endDate, days: daysBetween(previous.startDate, previous.endDate) },
        searchType: current.type,
        dataState: current.dataState,
        note: 'positionDelta is negative when average position improved, because position 1 is better than position 10.',
        totals: {
          clicks: { current: curTotals.clicks, previous: prevTotals.clicks, delta: curTotals.clicks - prevTotals.clicks, pctChange: pct(curTotals.clicks, prevTotals.clicks) },
          impressions: { current: curTotals.impressions, previous: prevTotals.impressions, delta: curTotals.impressions - prevTotals.impressions, pctChange: pct(curTotals.impressions, prevTotals.impressions) },
          ctr: { current: curTotals.ctr, previous: prevTotals.ctr, delta: round(curTotals.ctr - prevTotals.ctr, 4) },
          position: { current: curTotals.position, previous: prevTotals.position, delta: round(curTotals.position - prevTotals.position, 2) },
        },
      };

      if (dimensions.length) {
        const rows = diffRows(shapeRows(curRes.rows, dimensions), shapeRows(prevRes.rows, dimensions), dimensions);
        rows.sort((a, b) => Math.abs(b.clicksDelta) - Math.abs(a.clicksDelta));
        payload.dimensions = dimensions;
        payload.rowCount = rows.length;
        payload.rows = rows;
      }
      return capRows(payload);
    },
  },

  {
    name: 'top_movers',
    title: 'Biggest gains and losses',
    description:
      'Find the queries, pages, countries or devices that gained or lost the most between two periods. A focused view of compare_periods: it returns only the largest movers in each direction, which is what a traffic-drop or traffic-spike investigation actually needs.',
    inputSchema: {
      type: 'object',
      properties: {
        siteUrl: siteProp,
        dimension: {
          type: 'string',
          enum: ['query', 'page', 'country', 'device', 'searchAppearance'],
          description: 'What to rank the movement by. Defaults to "query".',
        },
        metric: {
          type: 'string',
          enum: ['clicks', 'impressions', 'position'],
          description: 'Which metric the movement is measured on. Defaults to "clicks".',
        },
        limit: { type: 'integer', description: 'How many gainers and how many losers to return. Defaults to 20 of each.' },
        startDate: dateProp('Start of the current period', '28daysAgo'),
        endDate: dateProp('End of the current period', 'today'),
        previousStartDate: { type: 'string', description: 'Start of the comparison period. Defaults to the equivalent window immediately before.' },
        previousEndDate: { type: 'string', description: 'End of the comparison period.' },
        minImpressions: { type: 'integer', description: 'Ignore rows below this impression count in both periods, to filter out noise. Defaults to 0.' },
        filters: filtersProp,
        type: typeProp,
        dataState: dataStateProp,
      },
      required: ['siteUrl'],
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const dimension = args.dimension || 'query';
      const metric = args.metric || 'clicks';
      const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 200);
      const minImpressions = Math.max(Number(args.minImpressions) || 0, 0);
      const siteUrl = await resolveSiteUrl(ctx.refreshToken, args.siteUrl);

      // Pull deep so the ranking is drawn from a real population, not the top
      // slice of each period.
      const current = buildQuery({ ...args, rowLimit: 25000 }, { dimensions: [dimension] });
      const prev = args.previousStartDate
        ? { start: resolveDate(args.previousStartDate), end: resolveDate(args.previousEndDate || shiftDate(current.startDate, -1)) }
        : precedingWindow(current.startDate, current.endDate);
      const previous = { ...current, startDate: prev.start, endDate: prev.end };

      const [curRes, prevRes] = await Promise.all([
        searchAnalytics(ctx.refreshToken, siteUrl, current),
        searchAnalytics(ctx.refreshToken, siteUrl, previous),
      ]);

      let rows = diffRows(shapeRows(curRes.rows, [dimension]), shapeRows(prevRes.rows, [dimension]), [dimension]);
      if (minImpressions > 0) {
        rows = rows.filter((r) => r.impressions >= minImpressions || r.impressionsPrevious >= minImpressions);
      }

      let gainers;
      let losers;
      if (metric === 'position') {
        // Only rows present in both periods have a meaningful position move.
        const ranked = rows.filter((r) => r.positionDelta !== null);
        gainers = [...ranked].sort((a, b) => a.positionDelta - b.positionDelta).slice(0, limit);
        losers = [...ranked].sort((a, b) => b.positionDelta - a.positionDelta).slice(0, limit);
      } else {
        const key = metric === 'impressions' ? 'impressionsDelta' : 'clicksDelta';
        gainers = [...rows].sort((a, b) => b[key] - a[key]).filter((r) => r[key] > 0).slice(0, limit);
        losers = [...rows].sort((a, b) => a[key] - b[key]).filter((r) => r[key] < 0).slice(0, limit);
      }

      return capRows(
        {
          site: siteUrl,
          dimension,
          metric,
          currentPeriod: { startDate: current.startDate, endDate: current.endDate },
          previousPeriod: { startDate: previous.startDate, endDate: previous.endDate },
          note:
            metric === 'position'
              ? 'Ranked by change in average position. Gainers moved towards position 1 (negative positionDelta).'
              : `Ranked by change in ${metric}. Rows marked isNew had no data in the previous period; isLost rows disappeared entirely.`,
          rowsCompared: rows.length,
          gainers,
          losers,
        },
        'gainers'
      );
    },
  },

  {
    name: 'inspect_url',
    title: 'Inspect the index status of a URL',
    description:
      'Ask Search Console what it knows about one specific URL: whether it is indexed, when it was last crawled, which canonical Google picked, whether the sitemap and referring pages were found, plus mobile usability and rich result status. Use this for "why is this page not showing up" or "is this indexed". The API allows a limited number of inspections per property per day.',
    inputSchema: {
      type: 'object',
      properties: {
        siteUrl: siteProp,
        inspectionUrl: { type: 'string', description: 'The full URL to inspect. It must belong to the property given in siteUrl.' },
        languageCode: { type: 'string', description: 'BCP-47 language for the human-readable result strings. Defaults to "en-US".' },
      },
      required: ['siteUrl', 'inspectionUrl'],
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const siteUrl = await resolveSiteUrl(ctx.refreshToken, args.siteUrl);
      const res = await inspectUrl(ctx.refreshToken, siteUrl, args.inspectionUrl, args.languageCode || 'en-US');
      const r = res.inspectionResult || {};
      return JSON.stringify(
        {
          site: siteUrl,
          inspectedUrl: args.inspectionUrl,
          inspectionResultLink: r.inspectionResultLink,
          indexStatus: r.indexStatusResult,
          mobileUsability: r.mobileUsabilityResult,
          richResults: r.richResultsResult,
          ampResult: r.ampResult,
        },
        null,
        2
      );
    },
  },

  {
    name: 'list_sitemaps',
    title: 'List sitemaps',
    description:
      'List the sitemaps submitted for a property, with when each was last downloaded, how many URLs it contains per content type, and any errors or warnings Google recorded.',
    inputSchema: {
      type: 'object',
      properties: {
        siteUrl: siteProp,
        sitemapIndex: { type: 'string', description: 'Optional: the full URL of a sitemap index, to list only the sitemaps inside it.' },
      },
      required: ['siteUrl'],
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const siteUrl = await resolveSiteUrl(ctx.refreshToken, args.siteUrl);
      const res = await listSitemaps(ctx.refreshToken, siteUrl);
      return JSON.stringify({ site: siteUrl, count: (res.sitemap || []).length, sitemaps: res.sitemap || [] }, null, 2);
    },
  },

  {
    name: 'get_sitemap',
    title: 'Get one sitemap',
    description: 'Fetch the full Search Console record for a single submitted sitemap, including per-type URL counts and processing errors.',
    inputSchema: {
      type: 'object',
      properties: {
        siteUrl: siteProp,
        feedpath: { type: 'string', description: 'The full URL of the sitemap, for example https://example.com/sitemap.xml' },
      },
      required: ['siteUrl', 'feedpath'],
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const siteUrl = await resolveSiteUrl(ctx.refreshToken, args.siteUrl);
      const res = await getSitemap(ctx.refreshToken, siteUrl, args.feedpath);
      return JSON.stringify({ site: siteUrl, sitemap: res }, null, 2);
    },
  },

  {
    name: 'submit_sitemap',
    title: 'Submit a sitemap',
    description: 'Submit or resubmit a sitemap to Search Console for a property. Submitting a sitemap already on file asks Google to fetch it again.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        siteUrl: siteProp,
        feedpath: { type: 'string', description: 'The full URL of the sitemap to submit, for example https://example.com/sitemap.xml' },
      },
      required: ['siteUrl', 'feedpath'],
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const siteUrl = await resolveSiteUrl(ctx.refreshToken, args.siteUrl);
      await submitSitemap(ctx.refreshToken, siteUrl, args.feedpath);
      return JSON.stringify({ site: siteUrl, submitted: args.feedpath, status: 'accepted', note: 'Google processes sitemaps asynchronously; check list_sitemaps later for the result.' }, null, 2);
    },
  },

  {
    name: 'delete_sitemap',
    title: 'Remove a sitemap',
    description: 'Remove a sitemap from a Search Console property. This only withdraws the submission; it does not change the file on the site or remove any indexed pages.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        siteUrl: siteProp,
        feedpath: { type: 'string', description: 'The full URL of the sitemap to remove.' },
      },
      required: ['siteUrl', 'feedpath'],
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const siteUrl = await resolveSiteUrl(ctx.refreshToken, args.siteUrl);
      await deleteSitemap(ctx.refreshToken, siteUrl, args.feedpath);
      return JSON.stringify({ site: siteUrl, removed: args.feedpath, status: 'deleted' }, null, 2);
    },
  },

  // -------------------------------------------------------------------------
  // Google Analytics 4
  // -------------------------------------------------------------------------

  {
    name: 'ga4_list_properties',
    title: 'List GA4 properties',
    description:
      'List every Google Analytics 4 property this account can access, with its numeric property ID and the account it belongs to. Start here when the GA4 property to report on is not already known.',
    ga4: true,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async handler(_args, ctx) {
      const properties = await listGa4Properties(ctx.refreshToken);
      return JSON.stringify({ account: ctx.email, count: properties.length, properties }, null, 2);
    },
  },

  {
    name: 'ga4_run_report',
    title: 'Run a GA4 report',
    description:
      'The main Google Analytics 4 report: any combination of GA4 dimensions and metrics over a date range. Use it for sessions and users by channel, landing page performance, conversions by source, event counts, and anything about what people did on the site — as opposed to how they found it in Google Search, which is what the Search Console tools cover.',
    ga4: true,
    inputSchema: {
      type: 'object',
      properties: {
        property: ga4PropertyProp,
        metrics: {
          type: 'array',
          items: { type: 'string' },
          description:
            'GA4 metric API names. Common ones: sessions, totalUsers, activeUsers, newUsers, screenPageViews, engagedSessions, engagementRate, bounceRate, averageSessionDuration, eventCount, keyEvents, totalRevenue. Defaults to sessions, totalUsers and screenPageViews. Note that "conversions" was renamed "keyEvents"; if one is rejected try the other, or call ga4_metadata to see exactly what this property accepts.',
        },
        dimensions: {
          type: 'array',
          items: { type: 'string' },
          description:
            'GA4 dimension API names. Common ones: date, sessionDefaultChannelGroup, sessionSource, sessionMedium, sessionSourceMedium, landingPage, pagePath, pageTitle, country, deviceCategory, eventName, newVsReturning. Omit for property-wide totals.',
        },
        startDate: ga4DateProp('Start of the range', '28daysAgo'),
        endDate: ga4DateProp('End of the range', 'yesterday'),
        dimensionFilters: ga4DimensionFiltersProp,
        metricFilters: ga4MetricFiltersProp,
        orderBy: ga4OrderByProp,
        limit: { type: 'integer', description: 'Rows to return, up to 100000. Defaults to 1000.' },
        offset: { type: 'integer', description: 'Zero-based row offset, for paging.' },
        keepEmptyRows: { type: 'boolean', description: 'Include rows where every metric is zero. Defaults to false.' },
      },
      required: ['property'],
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const property = await resolveGa4Property(ctx.refreshToken, args.property);
      const metrics = (Array.isArray(args.metrics) && args.metrics.length ? args.metrics : ['sessions', 'totalUsers', 'screenPageViews']).map((name) => ({ name }));
      const dimensions = (Array.isArray(args.dimensions) ? args.dimensions : []).map((name) => ({ name }));

      const body = {
        dimensions,
        metrics,
        dateRanges: [{ startDate: ga4Date(args.startDate || '28daysAgo'), endDate: ga4Date(args.endDate || 'yesterday') }],
        limit: String(Math.min(Math.max(Number(args.limit) || 1000, 1), 100000)),
        offset: String(Math.max(Number(args.offset) || 0, 0)),
        keepEmptyRows: Boolean(args.keepEmptyRows),
        metricAggregations: dimensions.length ? ['TOTAL'] : undefined,
        dimensionFilter: buildDimensionFilter(args.dimensionFilters),
        metricFilter: buildMetricFilter(args.metricFilters),
        orderBys: buildOrderBys(args.orderBy),
      };

      const res = await runReport(ctx.refreshToken, property, body);
      const shaped = shapeGa4Rows(res);

      return capRows({
        property,
        period: { startDate: body.dateRanges[0].startDate, endDate: body.dateRanges[0].endDate },
        timeZone: res.metadata?.timeZone,
        currencyCode: res.metadata?.currencyCode,
        dimensions: shaped.dimensions,
        metrics: shaped.metrics,
        totals: shaped.totals,
        rowCount: res.rowCount ?? shaped.rows.length,
        returned: shaped.rows.length,
        sampled: res.metadata?.dataLossFromOtherRow
          ? 'Some rows were grouped into an "(other)" row because the property exceeded its cardinality limit, so this breakdown is incomplete.'
          : undefined,
        rows: shaped.rows,
      });
    },
  },

  {
    name: 'ga4_compare_periods',
    title: 'Compare two GA4 periods',
    description:
      'Compare Google Analytics 4 metrics between two periods and return per-row deltas and percentage changes. Use it for "did traffic drop", "how did this month compare", or to check whether a Search Console change in impressions actually translated into sessions and conversions. If no previous period is given, the equivalent window immediately before the current one is used.',
    ga4: true,
    inputSchema: {
      type: 'object',
      properties: {
        property: ga4PropertyProp,
        metrics: {
          type: 'array',
          items: { type: 'string' },
          description: 'GA4 metric API names. Defaults to sessions, totalUsers and screenPageViews.',
        },
        dimensions: {
          type: 'array',
          items: { type: 'string' },
          description: 'How to break the comparison down, for example ["sessionDefaultChannelGroup"] or ["landingPage"]. Omit to compare totals only. Do not pass "date" here — it would compare each day against itself.',
        },
        startDate: ga4DateProp('Start of the current period', '28daysAgo'),
        endDate: ga4DateProp('End of the current period', 'yesterday'),
        previousStartDate: { type: 'string', description: 'Start of the comparison period. Defaults to the window of equal length immediately before the current one.' },
        previousEndDate: { type: 'string', description: 'End of the comparison period. Defaults to the day before startDate.' },
        dimensionFilters: ga4DimensionFiltersProp,
        orderBy: ga4OrderByProp,
        limit: { type: 'integer', description: 'Rows per period, up to 100000. Defaults to 1000.' },
      },
      required: ['property'],
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const property = await resolveGa4Property(ctx.refreshToken, args.property);
      const metricNames = Array.isArray(args.metrics) && args.metrics.length ? args.metrics : ['sessions', 'totalUsers', 'screenPageViews'];
      const dimensionNames = Array.isArray(args.dimensions) ? args.dimensions : [];

      // Resolved to absolute dates because the preceding window has to be
      // computed by length. GA4 evaluates these in the property's time zone.
      const startDate = resolveDate(args.startDate || '28daysAgo');
      const endDate = resolveDate(args.endDate || 'yesterday');
      const prev = args.previousStartDate
        ? { start: resolveDate(args.previousStartDate), end: resolveDate(args.previousEndDate || shiftDate(startDate, -1)) }
        : precedingWindow(startDate, endDate);

      const body = {
        // Two date ranges make the API add a "dateRange" dimension to each row,
        // so both periods come back in a single call.
        dateRanges: [
          { startDate, endDate, name: 'current' },
          { startDate: prev.start, endDate: prev.end, name: 'previous' },
        ],
        dimensions: dimensionNames.map((name) => ({ name })),
        metrics: metricNames.map((name) => ({ name })),
        limit: String(Math.min(Math.max(Number(args.limit) || 1000, 1), 100000)),
        dimensionFilter: buildDimensionFilter(args.dimensionFilters),
        orderBys: buildOrderBys(args.orderBy),
      };

      const res = await runReport(ctx.refreshToken, property, body);
      const shaped = shapeGa4Rows(res);

      const keyOf = (r) => dimensionNames.map((d) => r[d] ?? '').join('\u0000');
      const current = new Map();
      const previous = new Map();
      for (const row of shaped.rows) {
        (row.dateRange === 'previous' ? previous : current).set(keyOf(row), row);
      }

      const keys = new Set([...current.keys(), ...previous.keys()]);
      const rows = [];
      for (const k of keys) {
        const c = current.get(k);
        const p = previous.get(k);
        const row = {};
        dimensionNames.forEach((d) => (row[d] = (c || p)[d]));
        for (const m of metricNames) {
          const cv = c ? c[m] ?? 0 : 0;
          const pv = p ? p[m] ?? 0 : 0;
          row[m] = cv;
          row[`${m}Previous`] = pv;
          row[`${m}Delta`] = round(cv - pv, 4);
          row[`${m}PctChange`] = pct(cv, pv);
        }
        if (!p) row.isNew = true;
        if (!c) row.isLost = true;
        rows.push(row);
      }

      const primary = metricNames[0];
      rows.sort((a, b) => Math.abs(b[`${primary}Delta`] ?? 0) - Math.abs(a[`${primary}Delta`] ?? 0));

      const totalsFor = (name) => {
        let sum = 0;
        for (const row of shaped.rows) if ((row.dateRange === 'previous') === (name === 'previous')) sum += Number(row[primary]) || 0;
        return sum;
      };

      return capRows({
        property,
        timeZone: res.metadata?.timeZone,
        currentPeriod: { startDate, endDate, days: daysBetween(startDate, endDate) },
        previousPeriod: { startDate: prev.start, endDate: prev.end, days: daysBetween(prev.start, prev.end) },
        metrics: metricNames,
        dimensions: dimensionNames,
        note: dimensionNames.length
          ? `Sorted by the size of the change in ${primary}. Rows marked isNew had no data in the previous period; isLost rows had none in the current one.`
          : 'Property-wide totals for both periods.',
        summary: dimensionNames.length
          ? { metric: primary, current: round(totalsFor('current'), 4), previous: round(totalsFor('previous'), 4) }
          : undefined,
        rowCount: rows.length,
        rows,
      });
    },
  },

  {
    name: 'ga4_realtime_report',
    title: 'GA4 realtime activity',
    description:
      'What is happening on the site right now: active users in the last 30 minutes, broken down by page, country, device or source. Use this to check whether something is live and receiving traffic, not for historical analysis — the realtime API supports only a small set of dimensions and metrics.',
    ga4: true,
    inputSchema: {
      type: 'object',
      properties: {
        property: ga4PropertyProp,
        dimensions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Realtime dimensions: unifiedScreenName, country, city, deviceCategory, platform, eventName, audienceName. Omit for a single total.',
        },
        metrics: {
          type: 'array',
          items: { type: 'string' },
          description: 'Realtime metrics: activeUsers, screenPageViews, eventCount, keyEvents. Defaults to activeUsers.',
        },
        limit: { type: 'integer', description: 'Rows to return. Defaults to 50.' },
      },
      required: ['property'],
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const property = await resolveGa4Property(ctx.refreshToken, args.property);
      const res = await runRealtimeReport(ctx.refreshToken, property, {
        dimensions: (Array.isArray(args.dimensions) ? args.dimensions : []).map((name) => ({ name })),
        metrics: (Array.isArray(args.metrics) && args.metrics.length ? args.metrics : ['activeUsers']).map((name) => ({ name })),
        limit: String(Math.min(Math.max(Number(args.limit) || 50, 1), 1000)),
      });
      const shaped = shapeGa4Rows(res);
      return capRows({
        property,
        window: 'the last 30 minutes',
        dimensions: shaped.dimensions,
        metrics: shaped.metrics,
        totals: shaped.totals,
        rowCount: shaped.rows.length,
        rows: shaped.rows,
      });
    },
  },

  {
    name: 'ga4_metadata',
    title: 'List GA4 dimensions and metrics',
    description:
      'List the dimension and metric API names a specific GA4 property accepts, including any custom dimensions, custom metrics and calculated metrics defined on it. Use this when a report is rejected for an unknown field name, or to find what a property calls something.',
    ga4: true,
    inputSchema: {
      type: 'object',
      properties: {
        property: ga4PropertyProp,
        search: { type: 'string', description: 'Only return fields whose API name, display name or description contains this text. Strongly recommended — a property can expose several hundred fields.' },
        customOnly: { type: 'boolean', description: 'Return only the custom and calculated fields defined on this property.' },
      },
      required: ['property'],
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const property = await resolveGa4Property(ctx.refreshToken, args.property);
      const res = await getMetadata(ctx.refreshToken, property);
      const needle = (args.search || '').toLowerCase();

      const shape = (f) => ({
        apiName: f.apiName,
        uiName: f.uiName,
        description: f.description,
        custom: Boolean(f.customDefinition),
      });
      const keep = (f) => {
        if (args.customOnly && !f.customDefinition) return false;
        if (!needle) return true;
        return `${f.apiName} ${f.uiName} ${f.description}`.toLowerCase().includes(needle);
      };

      const dimensions = (res.dimensions || []).filter(keep).map(shape);
      const metrics = (res.metrics || []).filter(keep).map(shape);

      return capRows(
        {
          property,
          filter: needle || (args.customOnly ? 'custom fields only' : 'none'),
          dimensionCount: dimensions.length,
          metricCount: metrics.length,
          totalAvailable: { dimensions: (res.dimensions || []).length, metrics: (res.metrics || []).length },
          metrics,
          dimensions,
        },
        'dimensions'
      );
    },
  },
];

function pct(current, previous) {
  if (!previous) return current ? null : 0;
  return round(((current - previous) / previous) * 100, 1);
}

/** Tools available given the configured Google scopes. */
export function availableTools() {
  return TOOLS.filter((t) => (!t.write || config.enableWrite) && (!t.ga4 || config.enableGa4));
}

/** The tools/list payload. */
export function toolDescriptors() {
  return availableTools().map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: {
      readOnlyHint: !t.write,
      destructiveHint: t.name === 'delete_sitemap',
      idempotentHint: !t.write || t.name !== 'submit_sitemap',
      openWorldHint: true,
    },
  }));
}

/**
 * Run a tool. Expected failures come back as isError content so the model can
 * read and react to them; only genuine faults throw.
 * @param {string} name
 * @param {object} args
 * @param {{refreshToken: string, email: string}} ctx
 */
export async function callTool(name, args, ctx) {
  const tool = availableTools().find((t) => t.name === name);
  if (!tool) {
    const known = availableTools().map((t) => t.name).join(', ');
    return { content: [{ type: 'text', text: `Unknown tool "${name}". Available: ${known}` }], isError: true };
  }
  try {
    const text = await tool.handler(args || {}, ctx);
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    if (err instanceof ToolError) {
      return { content: [{ type: 'text', text: err.message }], isError: true };
    }
    if (err instanceof GoogleApiError) {
      const api = name.startsWith('ga4_') ? 'Google Analytics' : 'Search Console';
      let hint = '';
      if (err.status === 403 && /insufficient authentication scopes/i.test(err.message)) {
        // The stored Google grant predates a scope this server now needs.
        hint = ' The Google sign-in behind this connection does not cover this API. Disconnect the connector in Claude and connect it again to re-authorize.';
      } else if (err.status === 403) {
        hint = ` This usually means the Google account does not have access to that property, or the ${api} API is not enabled in the Google Cloud project.`;
      } else if (err.status === 429) {
        hint = ` ${api} is rate limiting this account; wait and try again.`;
      } else if (err.status === 400 && name.startsWith('ga4_')) {
        hint = ' If a field name was rejected, call ga4_metadata to see exactly which dimensions and metrics this property accepts.';
      }
      return { content: [{ type: 'text', text: `${api} error (${err.status}): ${err.message}.${hint}` }], isError: true };
    }
    if (err?.needsReauth) {
      return {
        content: [{ type: 'text', text: 'Google access was revoked for this connection. Disconnect and reconnect the connector to sign in again.' }],
        isError: true,
      };
    }
    return { content: [{ type: 'text', text: `Tool failed: ${err?.message || String(err)}` }], isError: true };
  }
}

export const _internal = { diffRows, precedingWindow, shapeRows, capRows, pct };
