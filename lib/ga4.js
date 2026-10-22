/**
 * Google Analytics 4: the Data API for reporting, and the Admin API for
 * finding out which properties exist.
 *
 * Both are reached with the same Google credentials as Search Console, through
 * the shared googleApi() helper, so there is one sign-in and one token.
 */

import { config } from './config.js';
import { GoogleApiError, googleApi } from './google.js';

/** GA4 accepts these date forms natively, in the property's own time zone. */
const GA4_NATIVE_DATE = /^(today|yesterday|\d+daysAgo|\d{4}-\d{2}-\d{2})$/;

/**
 * Pass GA4's own date vocabulary straight through rather than resolving it
 * here. The API evaluates "7daysAgo" in the property's time zone, which this
 * server has no way of knowing; converting it to a UTC date would quietly
 * shift the window by a day for anyone outside UTC.
 * @param {string} value
 */
export function ga4Date(value) {
  const v = String(value || '').trim();
  if (GA4_NATIVE_DATE.test(v)) return v;
  // Forms GA4 does not understand are converted, accepting the time zone
  // caveat, because a month-scale window rarely turns on a single day.
  const m = v.toLowerCase().match(/^(\d+)\s*(week|weeks|month|months)ago$/);
  if (m) {
    const n = Number(m[1]);
    const d = new Date();
    if (m[2].startsWith('week')) d.setUTCDate(d.getUTCDate() - n * 7);
    else d.setUTCMonth(d.getUTCMonth() - n);
    return d.toISOString().slice(0, 10);
  }
  throw new GoogleApiError(
    `Unrecognised GA4 date "${value}". Use YYYY-MM-DD, "today", "yesterday" or "28daysAgo".`,
    400,
    {}
  );
}

// ---------------------------------------------------------------------------
// Property discovery
// ---------------------------------------------------------------------------

/**
 * Every GA4 property the account can see, flattened across accounts.
 * @param {string} refreshToken
 */
export async function listGa4Properties(refreshToken) {
  const out = [];
  let pageToken;
  do {
    const url = new URL(`${config.ga4.adminBase}/accountSummaries`);
    url.searchParams.set('pageSize', '200');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const json = await googleApi(refreshToken, url.toString());
    for (const account of json.accountSummaries || []) {
      for (const p of account.propertySummaries || []) {
        out.push({
          property: p.property, // "properties/123456789"
          propertyId: String(p.property || '').replace('properties/', ''),
          displayName: p.displayName,
          propertyType: p.propertyType,
          account: account.account,
          accountName: account.displayName,
        });
      }
    }
    pageToken = json.nextPageToken;
  } while (pageToken);
  return out;
}

/**
 * Turn whatever the caller said into a "properties/123456789" resource name.
 *
 * Accepts the numeric id, the full resource name, or a property's display
 * name — people know their property as "Example.com - GA4", not as a number.
 * An ambiguous name is an error listing the candidates rather than a guess,
 * because silently reporting on the wrong property is worse than failing.
 *
 * @param {string} refreshToken
 * @param {string} input
 */
export async function resolveGa4Property(refreshToken, input) {
  const raw = String(input || '').trim();
  if (/^properties\/\d+$/.test(raw)) return raw;
  if (/^\d+$/.test(raw)) return `properties/${raw}`;

  const properties = await listGa4Properties(refreshToken);
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const want = norm(raw);

  const exact = properties.filter((p) => norm(p.displayName) === want);
  const partial = exact.length ? exact : properties.filter((p) => norm(p.displayName).includes(want) && want.length >= 3);

  if (partial.length === 1) return partial[0].property;
  if (partial.length > 1) {
    throw new GoogleApiError(
      `"${input}" matches more than one GA4 property. Use the numeric id instead: ` +
        partial.map((p) => `${p.displayName} (${p.propertyId})`).join('; '),
      400,
      { candidates: partial }
    );
  }
  throw new GoogleApiError(
    `No GA4 property matches "${input}". Available: ` +
      (properties.map((p) => `${p.displayName} (${p.propertyId})`).join('; ') || '(none)'),
    404,
    { available: properties }
  );
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

const STRING_OPERATORS = {
  exact: 'EXACT',
  contains: 'CONTAINS',
  beginsWith: 'BEGINS_WITH',
  endsWith: 'ENDS_WITH',
  fullRegex: 'FULL_REGEXP',
  partialRegex: 'PARTIAL_REGEXP',
};

const NUMERIC_OPERATORS = {
  equals: 'EQUAL',
  lessThan: 'LESS_THAN',
  lessOrEqual: 'LESS_THAN_OR_EQUAL',
  greaterThan: 'GREATER_THAN',
  greaterOrEqual: 'GREATER_THAN_OR_EQUAL',
};

/**
 * Build a GA4 FilterExpression from a flat list of conditions, combined with
 * AND. The real structure is a recursive tree; this covers the cases a report
 * request actually needs without exposing that to the model.
 * @param {Array<object>} filters
 */
export function buildDimensionFilter(filters) {
  if (!Array.isArray(filters) || filters.length === 0) return undefined;
  const expressions = filters.map((f) => {
    const field = f.dimension;
    if (!field) throw new GoogleApiError('each dimension filter needs a "dimension"', 400, {});
    if (Array.isArray(f.values) && f.values.length) {
      return {
        filter: {
          fieldName: field,
          inListFilter: { values: f.values.map(String), caseSensitive: Boolean(f.caseSensitive) },
        },
      };
    }
    const op = STRING_OPERATORS[f.operator || 'exact'];
    if (!op) {
      throw new GoogleApiError(
        `unknown dimension filter operator "${f.operator}". Use one of: ${Object.keys(STRING_OPERATORS).join(', ')}, or pass "values" for a list match.`,
        400,
        {}
      );
    }
    const expr = {
      filter: {
        fieldName: field,
        stringFilter: { matchType: op, value: String(f.value ?? ''), caseSensitive: Boolean(f.caseSensitive) },
      },
    };
    return f.not ? { notExpression: expr } : expr;
  });
  return expressions.length === 1 ? expressions[0] : { andGroup: { expressions } };
}

/** @param {Array<object>} filters */
export function buildMetricFilter(filters) {
  if (!Array.isArray(filters) || filters.length === 0) return undefined;
  const expressions = filters.map((f) => {
    const op = NUMERIC_OPERATORS[f.operator || 'greaterThan'];
    if (!f.metric) throw new GoogleApiError('each metric filter needs a "metric"', 400, {});
    if (!op) {
      throw new GoogleApiError(
        `unknown metric filter operator "${f.operator}". Use one of: ${Object.keys(NUMERIC_OPERATORS).join(', ')}.`,
        400,
        {}
      );
    }
    return {
      filter: {
        fieldName: f.metric,
        numericFilter: { operation: op, value: { doubleValue: Number(f.value) } },
      },
    };
  });
  return expressions.length === 1 ? expressions[0] : { andGroup: { expressions } };
}

/** @param {object} orderBy */
export function buildOrderBys(orderBy) {
  if (!orderBy) return undefined;
  const desc = orderBy.desc !== false;
  if (orderBy.metric) return [{ metric: { metricName: orderBy.metric }, desc }];
  if (orderBy.dimension) return [{ dimension: { dimensionName: orderBy.dimension }, desc }];
  return undefined;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

export function runReport(refreshToken, property, body) {
  return googleApi(refreshToken, `${config.ga4.dataBase}/${property}:runReport`, { method: 'POST', body });
}

export function runRealtimeReport(refreshToken, property, body) {
  return googleApi(refreshToken, `${config.ga4.dataBase}/${property}:runRealtimeReport`, { method: 'POST', body });
}

export function getMetadata(refreshToken, property) {
  return googleApi(refreshToken, `${config.ga4.dataBase}/${property}/metadata`);
}

/**
 * Flatten the Data API's parallel header and value arrays into plain rows.
 *
 * The API returns dimension and metric values positionally, with names only in
 * the headers, and every metric as a string. Rows come back here named and
 * numeric, which is what makes them usable without the model having to
 * cross-reference headers.
 *
 * @param {object} res RunReportResponse
 */
export function shapeGa4Rows(res) {
  const dimNames = (res.dimensionHeaders || []).map((h) => h.name);
  const metricNames = (res.metricHeaders || []).map((h) => h.name);
  const metricTypes = Object.fromEntries((res.metricHeaders || []).map((h) => [h.name, h.type]));

  const toNumber = (value, type) => {
    if (value === undefined || value === null || value === '') return 0;
    const n = Number(value);
    if (Number.isNaN(n)) return value;
    // Integers stay integers; rates and currency keep a sensible precision.
    if (type === 'TYPE_INTEGER') return n;
    return Math.round(n * 10000) / 10000;
  };

  const rows = (res.rows || []).map((r) => {
    const out = {};
    dimNames.forEach((name, i) => {
      out[name] = r.dimensionValues?.[i]?.value;
    });
    metricNames.forEach((name, i) => {
      out[name] = toNumber(r.metricValues?.[i]?.value, metricTypes[name]);
    });
    return out;
  });

  const totals = {};
  const totalRow = res.totals?.[0];
  if (totalRow) {
    metricNames.forEach((name, i) => {
      totals[name] = toNumber(totalRow.metricValues?.[i]?.value, metricTypes[name]);
    });
  }

  return { dimensions: dimNames, metrics: metricNames, rows, totals: totalRow ? totals : undefined };
}

export const _internal = { STRING_OPERATORS, NUMERIC_OPERATORS };
