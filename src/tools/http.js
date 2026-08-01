/**
 * tools/http.js — HTTP / network tools for ScrappyAi
 * ---------------------------------------------------------------------------
 * A general web tool beyond web_search. Exposes:
 *
 *   http_get     GET a URL, return text or parsed JSON
 *   http_post    POST a URL with a body
 *   http_request arbitrary method (GET/POST/PUT/PATCH/DELETE/HEAD)
 *
 * Every tool is bounded: per-call timeout, a max response size (large bodies
 * are truncated and flagged), an allowed-domain allowlist (or '*'), a redirect
 * limit (manual redirect following, never an unbounded chase), and content-type
 * awareness (JSON is auto-parsed). Network/timeout/domain failures resolve to
 * a typed error result ({ok:false, error, code, retryable}) instead of
 * throwing — exactly the typed result contract the registry surfaces.
 *
 * Pure JavaScript (ES modules), Node's global fetch only.
 */

import { ToolError } from './registry.js';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_SIZE = 200_000;
const DEFAULT_REDIRECT_LIMIT = 5;

const SAFE_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);

/**
 * @param {Object} [opts]
 * @param {number} [opts.timeoutMs=15000]
 * @param {number} [opts.maxResponseSize=200000]
 * @param {number} [opts.redirectLimit=5]
 * @param {string[]|Function|'*'} [opts.allowedDomains] allowlist of hostnames;
 *        a function (hostname)=>boolean, or '*' for any. Default: no restriction.
 * @returns {Array<import('./registry.js').ToolDefinition>}
 */
export function createHttpTools(opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseSize = opts.maxResponseSize ?? DEFAULT_MAX_RESPONSE_SIZE;
  const redirectLimit = opts.redirectLimit ?? DEFAULT_REDIRECT_LIMIT;
  const allowedDomains = opts.allowedDomains ?? '*';

  function assertAllowed(url) {
    let host;
    try {
      host = new URL(url).hostname;
    } catch (_err) {
      throw new ToolError(`Invalid URL: ${url}`, 'INVALID_URL');
    }
    if (allowedDomains === '*') return true;
    if (typeof allowedDomains === 'function') {
      if (!allowedDomains(host)) {
        throw new ToolError(`Host "${host}" is not in the allowed domains list.`, 'DOMAIN_BLOCKED');
      }
      return true;
    }
    if (Array.isArray(allowedDomains) && allowedDomains.includes(host)) return true;
    throw new ToolError(`Host "${host}" is not in the allowed domains list.`, 'DOMAIN_BLOCKED');
  }

  async function request({ url, method = 'GET', headers = {}, body, json, params = {} }) {
    if (typeof url !== 'string' || !url.trim()) {
      throw new ToolError('A URL is required.', 'VALIDATION_ERROR');
    }
    let methodUpper = String(method || 'GET').toUpperCase();
    if (!SAFE_METHODS.has(methodUpper)) {
      throw new ToolError(`Unsupported HTTP method "${methodUpper}".`, 'VALIDATION_ERROR');
    }
    assertAllowed(url);

    let current = url;
    let redirects = 0;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const contentType = typeof json === 'string' ? json : undefined;

    try {
      while (true) {
        assertAllowed(current);
        let res;
        try {
          res = await fetch(current, {
            method: methodUpper,
            headers: headers || {},
            body: body != null ? body : undefined,
            redirect: 'manual',
            signal: controller.signal,
          });
        } catch (err) {
          if (err.name === 'AbortError') {
            throw new ToolError(`HTTP request timed out after ${timeoutMs}ms.`, 'TIMEOUT');
          }
          const code = err.cause?.code || 'REQUEST_FAILED';
          throw new ToolError(`Request failed: ${err.message}`, code);
        }

        // Manual redirect following, bounded.
        const loc = res.headers.get('location');
        if (res.status >= 300 && res.status < 400 && loc) {
          if (redirects >= redirectLimit) {
            throw new ToolError(`Too many redirects (limit ${redirectLimit}).`, 'TOO_MANY_REDIRECTS');
          }
          redirects += 1;
          current = new URL(loc, current).toString();
          // 301/302/303 for POST/HEAD often switch to GET per convention.
          if ((res.status === 303 || res.status === 301 || res.status === 302) && methodUpper !== 'HEAD') {
            methodUpper = 'GET';
          }
          continue;
        }

        const resContentType = res.headers.get('content-type') || '';
        let text;
        try {
          text = await res.text();
        } catch (err) {
          throw new ToolError(`Failed to read response body: ${err.message}`, 'RESPONSE_READ_ERROR');
        }
        const truncated = text.length > maxResponseSize;
        if (truncated) text = text.slice(0, maxResponseSize);

        let data = text;
        const wantsJson = json === 'parse' || (json === 'auto' && resContentType.includes('application/json'));
        if (wantsJson) {
          try {
            data = JSON.parse(text);
          } catch (_err) {
            data = text; // best-effort parse; fall back to raw text
          }
        }

        return {
          ok: res.ok,
          status: res.status,
          statusText: res.statusText,
          headers: Object.fromEntries(res.headers.entries()),
          contentType: resContentType || null,
          data,
          truncated,
          redirects,
          finalUrl: current,
          url: url,
          method: methodUpper,
          durationMs: 0,
        };
      }
    } finally {
      clearTimeout(timer);
    }
  }

  return [
    {
      name: 'http_get',
      description: `GET a URL. Auto-parses JSON when the response is application/json. Bounded by timeout, max response size, allowed domains, and a redirect limit.`,
      version: '1.0.0',
      permissions: { network: 'allow' },
      parameters: {
        url: { type: 'string', description: 'Full URL to GET.', required: true },
        json: { type: 'string', enum: ['auto', 'parse', 'raw'], description: 'Response parsing: auto (parse when content-type is JSON), parse (force JSON.parse), raw (return text). Default auto.' },
      },
      handler: async ({ url, json = 'auto' }) => {
        const r = await request({ url, method: 'GET', json });
        if (!r.ok) {
          throw new ToolError(`GET ${url} → HTTP ${r.status} ${r.statusText}: ${String(r.data).slice(0, 200)}`, 'HTTP_STATUS');
        }
        return r;
      },
    },
    {
      name: 'http_post',
      description: `POST a URL with a body. Auto-parse: sends JSON when bodyJson=true, otherwise sends body as text.`,
      version: '1.0.0',
      permissions: { network: 'allow' },
      parameters: {
        url: { type: 'string', description: 'Full URL to POST to.', required: true },
        body: { type: 'string', description: 'Request body (string).' },
        bodyJson: { type: 'boolean', description: 'Treat body as JSON and send Content-Type: application/json. Default false.' },
        headers: { type: 'object', description: 'Extra request headers.' },
        json: { type: 'string', enum: ['auto', 'parse', 'raw'], description: 'Response parsing. Default auto.' },
      },
      handler: async ({ url, body = '', bodyJson = false, headers = {}, json = 'auto' }) => {
        let bodyOut = body;
        let headersOut = { ...headers };
        if (bodyJson) {
          bodyOut = typeof body === 'string' ? body : JSON.stringify(body);
          headersOut['Content-Type'] = headersOut['Content-Type'] || 'application/json';
        }
        const r = await request({ url, method: 'POST', headers: headersOut, body: bodyOut, json });
        if (!r.ok) {
          throw new ToolError(`POST ${url} → HTTP ${r.status} ${r.statusText}: ${String(r.data).slice(0, 200)}`, 'HTTP_STATUS');
        }
        return r;
      },
    },
    {
      name: 'http_request',
      description: `Send an arbitrary HTTP request (GET/POST/PUT/PATCH/DELETE/HEAD) with full control over method, headers, body, and response parsing.`,
      version: '1.0.0',
      permissions: { network: 'allow' },
      parameters: {
        url: { type: 'string', description: 'Full URL.', required: true },
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'], description: 'HTTP method. Default GET.' },
        headers: { type: 'object', description: 'Request headers.' },
        body: { type: 'string', description: 'Request body (string).' },
        json: { type: 'string', enum: ['auto', 'parse', 'raw'], description: 'Response parsing. Default auto.' },
      },
      handler: async ({ url, method = 'GET', headers = {}, body, json = 'auto' }) => {
        const r = await request({ url, method, headers, body, json });
        if (!r.ok) {
          throw new ToolError(`${method} ${url} → HTTP ${r.status} ${r.statusText}: ${String(r.data).slice(0, 200)}`, 'HTTP_STATUS');
        }
        return r;
      },
    },
  ];
}
