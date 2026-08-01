/**
 * tools/search.js — web search via a SearXNG instance
 * -----------------------------------------------
 * Registers a "web_search" tool that calls a SearXNG /search endpoint
 * (JSON API — SearXNG must have `json` enabled in its `formats` setting for
 * the target instance, which is true for the default instance this project
 * points at).
 *
 * Docs: https://docs.searxng.org/dev/search_api.html
 *
 * Pure JavaScript (ES modules), uses global fetch (Node >= 18).
 */

import { createLogger } from '../core/logger.js';

const log = createLogger('tools:search');

const DEFAULT_BASE_URL = 'https://searxng-production-a06a.up.railway.app/';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESULTS = 8;

const VALID_FORMATS = ['json', 'csv', 'rss'];
const VALID_TIME_RANGES = ['day', 'month', 'year'];
const VALID_SAFESEARCH = [0, 1, 2];

/**
 * @param {Object} [opts]
 * @param {string} [opts.baseUrl] SearXNG instance base URL.
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.maxResults] cap on results returned to the reasoner (context hygiene).
 * @returns {import('./registry.js').ToolDefinition}
 */
export function createWebSearchTool(opts = {}) {
  const {
    baseUrl = process.env.SEARXNG_BASE_URL || DEFAULT_BASE_URL,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxResults = DEFAULT_MAX_RESULTS,
  } = opts;

  const searchUrl = new URL('search', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);

  return {
    name: 'web_search',
    description:
      'Search the web via a SearXNG meta-search instance. Returns titles, URLs, and snippets.',
    parameters: {
      q: { type: 'string', required: true, description: 'Search query.' },
      format: { type: 'string', enum: VALID_FORMATS, description: 'Response format. Default "json".' },
      categories: {
        type: 'string',
        description: 'Comma-separated categories, e.g. "general,news,images,videos,science,files,social media,it".',
      },
      engines: { type: 'string', description: 'Comma-separated engine names, e.g. "google,bing,duckduckgo".' },
      language: { type: 'string', description: 'Result language, e.g. "en", "fa", "de".' },
      pageno: { type: 'number', description: 'Page number, default 1.' },
      time_range: { type: 'string', enum: VALID_TIME_RANGES, description: 'Restrict by recency.' },
      safesearch: { type: 'number', enum: VALID_SAFESEARCH, description: '0 = off, 1 = moderate, 2 = strict.' },
    },
    handler: async (args) => {
      const query = String(args.q || '').trim();
      if (!query) throw searchError('Empty query.', 'EMPTY_QUERY');

      const format = args.format || 'json';
      const params = new URLSearchParams();
      params.set('q', query);
      params.set('format', format);
      if (args.categories) params.set('categories', args.categories);
      if (args.engines) params.set('engines', args.engines);
      if (args.language) params.set('language', args.language);
      if (args.pageno) params.set('pageno', String(args.pageno));
      if (args.time_range) params.set('time_range', args.time_range);
      if (args.safesearch !== undefined) params.set('safesearch', String(args.safesearch));

      const url = `${searchUrl.toString()}?${params.toString()}`;
      const startedAt = Date.now();
      log.info('search:start', { query, format, url });

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res;
      try {
        res = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
      } catch (err) {
        log.error('search:request_failed', { query, durationMs: Date.now() - startedAt, error: err.message });
        throw searchError(`SearXNG request failed: ${err.message}`, 'REQUEST_FAILED');
      } finally {
        clearTimeout(timer);
      }

      if (!res.ok) {
        const body = await safeText(res);
        log.error('search:http_error', { query, status: res.status, durationMs: Date.now() - startedAt });
        throw searchError(
          `SearXNG returned HTTP ${res.status}: ${body.slice(0, 300)}`,
          'HTTP_ERROR'
        );
      }

      if (format !== 'json') {
        const text = await res.text();
        log.info('search:done', { query, format, durationMs: Date.now() - startedAt, rawChars: text.length });
        return { query, format, raw: text };
      }

      let payload;
      try {
        payload = await res.json();
      } catch (err) {
        log.error('search:bad_json', { query, durationMs: Date.now() - startedAt, error: err.message });
        throw searchError(`SearXNG returned non-JSON body: ${err.message}`, 'BAD_JSON');
      }

      const results = Array.isArray(payload.results) ? payload.results : [];
      const output = {
        query,
        numResults: results.length,
        results: results.slice(0, maxResults).map((r) => ({
          title: r.title,
          url: r.url,
          content: r.content,
          engine: r.engine,
          score: r.score,
        })),
        suggestions: payload.suggestions || [],
      };
      log.info('search:done', {
        query,
        durationMs: Date.now() - startedAt,
        numResults: output.numResults,
        returned: output.results.length,
      });
      return output;
    },
  };
}

async function safeText(res) {
  try {
    return await res.text();
  } catch (_err) {
    return '';
  }
}

function searchError(message, code) {
  const err = new Error(message);
  err.code = code || 'SEARCH_ERROR';
  return err;
}

export default createWebSearchTool;
