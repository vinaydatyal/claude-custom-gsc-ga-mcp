/**
 * Google Ads API integration for keyword research and search volume data.
 *
 * Uses the Google Ads API v17 to access:
 * - Customer account list discovery
 * - Keyword idea generation from seed keywords
 * - Historical search volume data
 * - Competitor keyword research (if available)
 *
 * Requires: Google Ads API enabled, adwords scope, manager account access.
 */

import { config } from './config.js';
import { getGoogleAccessToken } from './google.js';
import { log } from './util.js';

class AdsError extends Error {}

/**
 * Google Ads API wrapper. Google Ads requires special headers that the generic
 * googleApi() function doesn't support (login-customer-id, developer-token).
 * @param {string} refreshToken
 * @param {string} url - Full Google Ads API URL
 * @param {Object} opts - {method, body, headers}
 */
async function googleAdsApi(refreshToken, url, opts = {}) {
  const token = await getGoogleAccessToken(refreshToken);
  const managerAccountId = config.ads.managerAccount;

  const init = {
    method: opts.method || 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'login-customer-id': managerAccountId,
      ...opts.headers,
    },
  };

  if (opts.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20_000);

  // Log the outgoing request for debugging
  log('debug', 'googleAdsApi request', {
    method: init.method,
    url,
    headers: {
      'login-customer-id': init.headers['login-customer-id'],
      'Content-Type': init.headers['Content-Type'],
    },
  });

  let r;
  try {
    r = await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }

  const text = await r.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text.slice(0, 500) };
  }

  if (!r.ok) {
    const message = json.error?.message || `Google Ads API returned HTTP ${r.status}`;
    log('warn', 'google ads api error', { url: url.split('?')[0], status: r.status, message });
    throw new AdsError(`${message} (${r.status})`);
  }

  return json;
}

/**
 * List all accessible customer accounts under the manager account.
 * @param {string} refreshToken
 * @returns {Promise<Array>} Customer accounts with IDs and names
 */
export async function listAccessibleCustomers(refreshToken) {
  try {
    const url = `${config.ads.apiBase}/customers:listAccessibleCustomers`;
    const res = await googleAdsApi(refreshToken, url, { method: 'GET' });

    const customers = (res.resourceNames || []).map((name) => {
      const customerId = name.split('/')[1];
      return { customerId, resourceName: name };
    });

    log('info', 'ads: listed accessible customers', {
      count: customers.length,
      managerAccount: config.ads.managerAccount,
    });

    return customers;
  } catch (err) {
    if (err instanceof AdsError) throw err;
    throw new AdsError(`Failed to list accessible customers: ${err.message}`);
  }
}

/**
 * Discover keywords using Google Ads Keyword Planner.
 * @param {string} refreshToken
 * @param {Object} params
 * @param {string[]} params.seedKeywords - Starting keywords for ideas
 * @param {string} params.seedUrl - Optional: competitor URL
 * @param {string} params.language - Language code (default 'en')
 * @param {string} params.geoTargets - Geo-target ID or comma-separated IDs
 * @returns {Promise<Array>} Keyword ideas with metrics
 */
export async function discoverKeywords(refreshToken, params) {
  const {
    seedKeywords = [],
    seedUrl = null,
    language = '1000', // English
    geoTargets = '2011', // Calgary
  } = params;

  try {
    const customerId = config.ads.customerAccount;

    // Validate inputs
    if (!seedKeywords.length && !seedUrl) {
      throw new AdsError('Either seedKeywords or seedUrl is required');
    }

    const url = `${config.ads.apiBase}/customers/${customerId}/keywordPlanIdeas:generateKeywordIdeas`;

    // Build request body
    const geoTargetIds = geoTargets
      .split(',')
      .map((g) => ({ geoTargetConstant: `geoTargetConstants/${g.trim()}` }));

    const body = {
      seedKeywords: seedKeywords.map((k) => ({ keyword: k })),
      language: `languageConstants/${language}`,
      geoTargetConstants: geoTargetIds,
      includeAdultKeywords: false,
      keywordPlanNetwork: 'GOOGLE_SEARCH_AND_PARTNERS',
    };

    if (seedUrl) {
      body.seedUrls = [{ url: seedUrl }];
    }

    const res = await googleAdsApi(refreshToken, url, { method: 'POST', body });

    // Parse results
    const ideas = (res.results || []).map((idea) => ({
      keyword: idea.text,
      monthlySearchVolume: idea.keywordIdeaMetrics?.avgMonthlySearches || 0,
      competitionLevel: idea.keywordIdeaMetrics?.competitionLevel || 'UNSPECIFIED',
      competitionIndex: idea.keywordIdeaMetrics?.competitionIndex || null,
      lowTopOfPageBid:
        idea.keywordIdeaMetrics?.lowTopOfPageBidMicros && idea.keywordIdeaMetrics.lowTopOfPageBidMicros > 0
          ? idea.keywordIdeaMetrics.lowTopOfPageBidMicros / 1_000_000
          : null,
      highTopOfPageBid:
        idea.keywordIdeaMetrics?.highTopOfPageBidMicros && idea.keywordIdeaMetrics.highTopOfPageBidMicros > 0
          ? idea.keywordIdeaMetrics.highTopOfPageBidMicros / 1_000_000
          : null,
    }));

    log('info', 'ads: discovered keywords', {
      count: ideas.length,
      seeds: seedKeywords.length,
      geoTargets,
    });

    return ideas;
  } catch (err) {
    if (err instanceof AdsError) throw err;
    throw new AdsError(`Keyword discovery failed: ${err.message}`);
  }
}

/**
 * Get historical search volume for keywords.
 * @param {string} refreshToken
 * @param {Object} params
 * @param {string[]} params.keywords - Keywords to research
 * @param {string} params.language - Language code (default '1000')
 * @param {string} params.geoTargets - Geo-target ID (default '2011')
 * @returns {Promise<Array>} Keywords with monthly search volume history
 */
export async function getKeywordSearchVolume(refreshToken, params) {
  const {
    keywords = [],
    language = '1000',
    geoTargets = '2011',
  } = params;

  try {
    if (!keywords.length) {
      throw new AdsError('keywords array is required');
    }

    const customerId = config.ads.customerAccount;

    const url = `${config.ads.apiBase}/customers/${customerId}/keywordPlanIdeas:generateKeywordForecastMetrics`;

    const geoTargetIds = geoTargets
      .split(',')
      .map((g) => ({ geoTargetConstant: `geoTargetConstants/${g.trim()}` }));

    const body = {
      keywordPlanNetwork: 'GOOGLE_SEARCH_AND_PARTNERS',
      keywords: keywords.map((k) => ({ text: k, matchType: 'BROAD' })),
      language: `languageConstants/${language}`,
      geoTargetConstants: geoTargetIds,
    };

    const res = await googleAdsApi(refreshToken, url, { method: 'POST', body });

    // Parse forecast results
    const results = (res.keywordForecasts || []).map((forecast) => ({
      keyword: forecast.keyword?.text || 'unknown',
      monthlySearchVolume: forecast.keywordForecast?.avgMonthlySearches || 0,
      monthlySearchVolumeLow: forecast.keywordForecast?.monthlySearchVolumeRange?.min || null,
      monthlySearchVolumeHigh: forecast.keywordForecast?.monthlySearchVolumeRange?.max || null,
      cpcMicros: forecast.keywordForecast?.avgCpcBidsMicros || null,
      competitionLevel: forecast.keywordForecast?.competitionLevel || 'UNSPECIFIED',
    }));

    log('info', 'ads: retrieved search volume', { count: results.length });
    return results;
  } catch (err) {
    if (err instanceof AdsError) throw err;
    throw new AdsError(`Search volume retrieval failed: ${err.message}`);
  }
}

/**
 * Estimate keyword difficulty based on Google Ads competition metrics.
 * Note: This is advertising competition, NOT organic SEO difficulty.
 * @param {Array} keywords - Array of keyword objects with competitionLevel/competitionIndex
 * @returns {Array} Keywords with normalized 0-100 difficulty scores
 */
export function estimateAdsDifficulty(keywords) {
  return keywords.map((kw) => {
    let score = 0;

    // Use competition index if available (already 0-100)
    if (kw.competitionIndex !== null && kw.competitionIndex !== undefined) {
      score = kw.competitionIndex;
    } else if (kw.competitionLevel) {
      // Map competition level to score
      const levelMap = {
        UNSPECIFIED: 25,
        LOW: 25,
        MEDIUM: 50,
        HIGH: 75,
      };
      score = levelMap[kw.competitionLevel] || 50;
    }

    return {
      keyword: kw.keyword,
      advertisingCompetition: kw.competitionLevel || 'UNSPECIFIED',
      competitionIndex: kw.competitionIndex,
      estimatedAdsDifficulty: score,
      note: 'This is Google Ads advertising competition, not organic SEO difficulty',
    };
  });
}

export const _internal = { AdsError };
