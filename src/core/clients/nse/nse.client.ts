// ─────────────────────────────────────────────────────────────
// NSE requires a browser-like session (cookies) before any
// API call will succeed. This client handles:
//  1. Session initialisation (GET nseindia.com → sets cookies)
//  2. Authenticated API calls with correct headers
//  3. Automatic session refresh on 401/403
// ─────────────────────────────────────────────────────────────

import https from 'https';
import zlib from 'zlib';
import { logger } from '@core/utils/logger';
import { AppError } from '@core/middleware/error-handler';

// ── Types ────────────────────────────────────────────────────

export interface NseClientOptions {
  /** ms to wait between requests. NSE rate-limits aggressively. Default 1500 */
  requestDelay?: number;
  /** How old the session can be before forcing a refresh (ms). Default 8 min */
  sessionTtl?: number;
}

interface Session {
  cookies: string;
  initialisedAt: number;
}

interface HttpResponse {
  body: string;
  headers: NodeJS.Dict<string | string[]>;
  status: number;
}

// ── Constants ────────────────────────────────────────────────

const BASE = 'https://www.nseindia.com';

const HEADERS_BASE: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  Referer: 'https://www.nseindia.com/',
  Connection: 'keep-alive',
  'Sec-Fetch-Site': 'same-origin',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Dest': 'empty',
  'X-Requested-With': 'XMLHttpRequest',
};

// ── Sleep helper ─────────────────────────────────────────────

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── Low-level HTTPS fetch ─────────────────────────────────────
// Using Node's built-in https to avoid adding axios as a dep.
// fetch() works too in Node 18+ but https gives us response headers.

function httpsGet(
  url: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    // Abort before even starting the request
    if (signal?.aborted) {
      const err = new Error('Request aborted') as NodeJS.ErrnoException;
      err.name = 'AbortError';
      reject(err);
      return;
    }
    const req = https.get(
      url,
      { headers, signal } as Parameters<typeof https.get>[1],
      (res) => {
        const chunks: Buffer[] = [];

        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          const encoding = res.headers['content-encoding'];

          const decompress = (buf: Buffer): Promise<Buffer> => {
            if (encoding === 'br')
              return new Promise((resolveDecomp, rejectDecomp) =>
                zlib.brotliDecompress(buf, (e, d) => (e ? rejectDecomp(e) : resolveDecomp(d))),
              );
            if (encoding === 'gzip')
              return new Promise((resolveDecomp, rejectDecomp) =>
                zlib.gunzip(buf, (e, d) => (e ? rejectDecomp(e) : resolveDecomp(d))),
              );
            if (encoding === 'deflate')
              return new Promise((resolveDecomp, rejectDecomp) =>
                zlib.inflate(buf, (e, d) => (e ? rejectDecomp(e) : resolveDecomp(d))),
              );
            return Promise.resolve(buf);
          };

          decompress(raw)
            .then((body) =>
              resolve({
                body: body.toString('utf-8'),
                headers: res.headers,
                status: res.statusCode ?? 0,
              }),
            )
            .catch(reject);
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(60_000, () => {
      req.destroy(new Error('NSE request timed out after 60s'));
    });
  });
}

/** Extract Set-Cookie values from response headers */
function extractCookies(headers: NodeJS.Dict<string | string[]>): string {
  const raw = headers['set-cookie'];
  if (!raw) return '';
  const cookies = Array.isArray(raw) ? raw : [raw];
  return cookies
    .map((c) => c.split(';')[0]) // keep only name=value
    .join('; ');
}

/** Merge two cookie strings — later values win on key conflict. */
function mergeCookies(a: string, b: string): string {
  const merged = new Map<string, string>();
  [a, b].forEach((cookieStr) => {
    cookieStr.split('; ').forEach((pair) => {
      const [k, ...rest] = pair.split('=');
      if (k) merged.set(k.trim(), rest.join('='));
    });
  });
  return Array.from(merged.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

// ── NseClient ─────────────────────────────────────────────────

export class NseClient {
  private session: Session | null = null;
  private readonly requestDelay: number;
  private readonly sessionTtl: number;

  constructor(options: NseClientOptions = {}) {
    this.requestDelay = options.requestDelay ?? 1500;
    this.sessionTtl = options.sessionTtl ?? 8 * 60 * 1000; // 8 minutes
  }

  // ── Session management ─────────────────────────────────────

  /** Force-invalidate the current session so the next request re-initialises it. */
  resetSession(): void {
    this.session = null;
    logger.info('NSE: session reset (forced)');
  }

  private sessionExpired(): boolean {
    if (!this.session) return true;
    return Date.now() - this.session.initialisedAt > this.sessionTtl;
  }

  async initSession(): Promise<void> {
    logger.info('NSE: initialising session');

    // Step 1: Hit homepage to get initial cookies
    const homeRes = await httpsGet(BASE, HEADERS_BASE);
    let cookies = extractCookies(homeRes.headers);

    // Step 2: Visit the block-deal page so NSE registers a valid navigation path
    await sleep(1500);
    const pageRes = await httpsGet(`${BASE}/market-data/block-deal`, {
      ...HEADERS_BASE,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      Cookie: cookies,
    });
    const pageCookies = extractCookies(pageRes.headers);
    if (pageCookies) {
      cookies = mergeCookies(cookies, pageCookies);
    }

    // Step 3: Hit a lightweight API endpoint to "warm up" the session
    await sleep(1500);
    const warmRes = await httpsGet(`${BASE}/api/market-status`, {
      ...HEADERS_BASE,
      Cookie: cookies,
    });
    const moreCookies = extractCookies(warmRes.headers);
    if (moreCookies) {
      cookies = mergeCookies(cookies, moreCookies);
    }

    this.session = { cookies, initialisedAt: Date.now() };
    logger.info('NSE: session ready');
  }

  // ── Authenticated GET ──────────────────────────────────────

  async get<T>(path: string, signal?: AbortSignal): Promise<T> {
    if (this.sessionExpired()) {
      await this.initSession();
    }

    await sleep(this.requestDelay);

    const url = `${BASE}${path}`;

    let res: HttpResponse;
    try {
      res = await httpsGet(
        url,
        {
          ...HEADERS_BASE,
          Referer: `${BASE}/market-data/block-deal`,
          Cookie: this.session!.cookies,
        },
        signal,
      );
    } catch (err) {
      // Timeout or connection error — reset session and retry once
      logger.warn(
        { errorMessage: (err as Error).message, path },
        'NSE: request failed, re-establishing session and retrying',
      );
      this.session = null;
      await this.initSession();
      await sleep(this.requestDelay);

      res = await httpsGet(
        url,
        {
          ...HEADERS_BASE,
          Referer: `${BASE}/market-data/block-deal`,
          Cookie: this.session!.cookies,
        },
        signal,
      );
    }

    if (res.status === 401 || res.status === 403) {
      // Session stale — refresh once and retry
      logger.warn({ path, status: res.status }, 'NSE: session rejected, refreshing');
      this.session = null;
      await this.initSession();
      await sleep(this.requestDelay);

      const retryRes = await httpsGet(
        url,
        {
          ...HEADERS_BASE,
          Referer: `${BASE}/market-data/block-deal`,
          Cookie: this.session!.cookies,
        },
        signal,
      );

      if (retryRes.status >= 400) {
        throw new AppError(
          502,
          `NSE API error ${retryRes.status} on ${path} after session refresh`,
          'NSE_AUTH_FAILED',
          { path, status: retryRes.status },
        );
      }

      try {
        return JSON.parse(retryRes.body) as T;
      } catch {
        throw new AppError(
          502,
          `NSE returned non-JSON for ${path}: ${retryRes.body.slice(0, 200)}`,
          'NSE_INVALID_RESPONSE',
          { path },
        );
      }
    }

    if (res.status >= 400) {
      throw new AppError(
        502,
        `NSE API error ${res.status} on ${path}`,
        'NSE_UPSTREAM_ERROR',
        { path, status: res.status },
      );
    }

    try {
      return JSON.parse(res.body) as T;
    } catch {
      throw new AppError(
        502,
        `NSE returned non-JSON for ${path}: ${res.body.slice(0, 200)}`,
        'NSE_INVALID_RESPONSE',
        { path },
      );
    }
  }
}

// Singleton — one session shared across the app
export const nseClient = new NseClient();
