export const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';

/**
 * The one bucket the manager keeps its backups in.
 *
 * Bucket names are unique within an account, not across Cloudflare, so a fixed
 * name is enough - and it is what lets a second machine signed in to the same
 * account find the recovery points the first one wrote without being told.
 */
export const BACKUP_BUCKET_NAME = 'sillytavern-manager-backup';

export type R2Jurisdiction = 'default' | 'eu' | 'us' | 'fedramp' | 'fedramp-high';

export interface CloudflareAccount {
  readonly id: string;
  readonly name: string;
}

export interface R2Bucket {
  readonly name: string;
  readonly createdAt: string | null;
  readonly location: string | null;
  readonly jurisdiction: R2Jurisdiction;
}

/** What the last response said about the API rate limit, when it said anything. */
export interface RateLimitState {
  readonly remaining: number;
  /** Seconds until the window resets. */
  readonly resetSeconds: number;
  readonly observedAt: number;
}

export class CloudflareApiError extends Error {
  public readonly code: string;
  public readonly status: number;
  /** Cloudflare's own error codes from the response envelope. */
  public readonly apiCodes: readonly number[];
  public constructor(code: string, status: number, message: string, apiCodes: readonly number[] = []) {
    super(message);
    this.code = code;
    this.status = status;
    this.apiCodes = apiCodes;
  }
}

/**
 * The API said to stop.
 *
 * Cloudflare's limit is per user and shared with everything else the user does:
 * going past it blocks the whole API, dashboard included, for five minutes.
 * Nothing here retries on its own. The caller waits `retryAfterSeconds` or gives up.
 */
export class CloudflareRateLimitError extends CloudflareApiError {
  public readonly retryAfterSeconds: number;
  public constructor(retryAfterSeconds: number) {
    super('cloudflare_rate_limited', 429, `Cloudflare's API rate limit was reached; try again in ${retryAfterSeconds} seconds`);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Cloudflare's code for an account that has never turned R2 on.
 *
 * R2 is not part of an account by default: somebody has to accept its terms
 * once, in the dashboard, and until they do every R2 call comes back with this
 * and the sentence "Please enable R2 through the Cloudflare Dashboard". It is
 * worth telling apart from every other refusal, because it is the only one the
 * reader can fix in a minute and the only one where saying "the bucket could
 * not be created" would send them looking in the wrong place.
 */
export const R2_NOT_ENABLED_CODE = 10042;

/** Whether this failure is an account that has not turned R2 on. */
export function isR2NotEnabled(error: unknown): boolean {
  if (!(error instanceof CloudflareApiError)) return false;
  return error.apiCodes.includes(R2_NOT_ENABLED_CODE) || /enable r2/iu.test(error.message);
}

export interface CloudflareApiOptions {
  /** Called for every request, so an expired token can be refreshed in between. */
  readonly accessToken: () => Promise<string>;
  readonly fetchImpl?: typeof fetch;
  readonly baseUrl?: string;
  readonly now?: () => number;
}

export interface RequestOptions {
  readonly query?: Record<string, string | undefined>;
  readonly body?: unknown;
  /** Sent as multipart instead of JSON, which is how Worker scripts are uploaded. */
  readonly form?: FormData;
  readonly headers?: Record<string, string>;
  readonly signal?: AbortSignal | undefined;
}

export interface Envelope {
  readonly result: unknown;
  readonly resultInfo: Record<string, unknown> | null;
}

export class CloudflareApi {
  private readonly accessToken: () => Promise<string>;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly now: () => number;
  private rateLimitState: RateLimitState | null = null;

  public constructor(options: CloudflareApiOptions) {
    this.accessToken = options.accessToken;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = (options.baseUrl ?? CLOUDFLARE_API_BASE).replace(/\/+$/u, '');
    this.now = options.now ?? Date.now;
  }

  public get rateLimit(): RateLimitState | null {
    return this.rateLimitState;
  }

  /** The accounts this grant reaches, which is what the user picked on the consent screen. */
  public async listAccounts(signal?: AbortSignal): Promise<CloudflareAccount[]> {
    const accounts: CloudflareAccount[] = [];
    for (let page = 1; ; page += 1) {
      const { result, resultInfo } = await this.request('GET', '/accounts', { query: { page: String(page), per_page: '50' }, signal });
      for (const entry of asArray(result)) {
        if (isRecord(entry) && typeof entry.id === 'string') accounts.push({ id: entry.id, name: typeof entry.name === 'string' ? entry.name : entry.id });
      }
      const totalPages = typeof resultInfo?.total_pages === 'number' ? resultInfo.total_pages : 1;
      if (page >= totalPages || asArray(result).length === 0) return accounts;
    }
  }

  public async listBuckets(accountId: string, options: { nameContains?: string; jurisdiction?: R2Jurisdiction; signal?: AbortSignal } = {}): Promise<R2Bucket[]> {
    const buckets: R2Bucket[] = [];
    let cursor: string | undefined;
    do {
      const { result, resultInfo } = await this.request('GET', `/accounts/${segment(accountId)}/r2/buckets`, {
        query: { per_page: '1000', name_contains: options.nameContains, cursor },
        headers: jurisdictionHeader(options.jurisdiction),
        signal: options.signal,
      });
      const listed = isRecord(result) ? asArray(result.buckets) : [];
      for (const entry of listed) {
        const bucket = toBucket(entry);
        if (bucket) buckets.push(bucket);
      }
      cursor = typeof resultInfo?.cursor === 'string' && resultInfo.cursor && listed.length > 0 ? resultInfo.cursor : undefined;
    } while (cursor);
    return buckets;
  }

  public async createBucket(accountId: string, name: string, options: { jurisdiction?: R2Jurisdiction; signal?: AbortSignal } = {}): Promise<R2Bucket> {
    const { result } = await this.request('POST', `/accounts/${segment(accountId)}/r2/buckets`, {
      body: { name, storageClass: 'Standard' },
      headers: jurisdictionHeader(options.jurisdiction),
      signal: options.signal,
    });
    // Standard, always: the free tier does not cover Infrequent Access, and a
    // backup that is restored at all is read far more than that class expects.
    return toBucket(result) ?? { name, createdAt: null, location: null, jurisdiction: options.jurisdiction ?? 'default' };
  }

  /**
   * The manager's bucket in this account, created if it is not there yet.
   *
   * Two machines connecting at once can both find nothing and both create. The
   * loser's create fails because the bucket exists, which is the answer it was
   * after, so it looks again rather than reporting an error.
   */
  public async ensureBackupBucket(accountId: string, signal?: AbortSignal): Promise<{ bucket: R2Bucket; created: boolean }> {
    const existing = await this.findBucket(accountId, BACKUP_BUCKET_NAME, signal ? { signal } : {});
    if (existing) return { bucket: existing, created: false };
    try {
      return { bucket: await this.createBucket(accountId, BACKUP_BUCKET_NAME, signal ? { signal } : {}), created: true };
    } catch (error: unknown) {
      if (!(error instanceof CloudflareApiError) || error.status !== 409) throw error;
      const raced = await this.findBucket(accountId, BACKUP_BUCKET_NAME, signal ? { signal } : {});
      if (raced) return { bucket: raced, created: false };
      throw error;
    }
  }

  /** A bucket by its exact name, or null when this account has none by that name. */
  public async findBucket(accountId: string, name: string, options: { jurisdiction?: R2Jurisdiction; signal?: AbortSignal } = {}): Promise<R2Bucket | null> {
    const jurisdiction = options.jurisdiction ?? 'default';
    // name_contains narrows the listing to a page; the exact match is still ours to make.
    const buckets = await this.listBuckets(accountId, { nameContains: name, jurisdiction, ...(options.signal ? { signal: options.signal } : {}) });
    return buckets.find((bucket) => bucket.name === name && bucket.jurisdiction === jurisdiction) ?? null;
  }

  /**
   * A GraphQL Analytics query.
   *
   * GraphQL does not answer with the REST envelope: a failed query is still a
   * 200, with `errors` beside `data`. Treating that as success would show a
   * usage of nothing, which reads as "nothing used" rather than "not known".
   */
  public async graphql(query: string, variables: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const response = await this.fetchImpl(`${this.baseUrl}/graphql`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${await this.accessToken()}` },
      body: JSON.stringify({ query, variables }),
      ...(signal ? { signal } : {}),
    });
    this.observeRateLimit(response.headers);
    if (response.status === 429) throw new CloudflareRateLimitError(retryAfter(response.headers));
    const parsed: unknown = await response.json().catch(() => null);
    const errors = isRecord(parsed) && Array.isArray(parsed.errors) ? parsed.errors.filter(isRecord) : [];
    if (!response.ok || errors.length > 0 || !isRecord(parsed) || !isRecord(parsed.data)) {
      const detail = errors.map((error) => (typeof error.message === 'string' ? error.message : '')).filter(Boolean).join('; ').slice(0, 300);
      throw new CloudflareApiError(response.ok ? 'cloudflare_graphql_failed' : errorCode(response.status), response.status, `Cloudflare analytics query failed (${response.status})${detail ? `: ${detail}` : ''}`);
    }
    return parsed.data;
  }

  /** For the Worker calls in `workers.ts`, which share this token, error handling and rate limit. */
  public async call(method: string, path: string, options: RequestOptions = {}): Promise<Envelope> {
    return await this.request(method, path, options);
  }

  private async request(method: string, path: string, options: RequestOptions = {}): Promise<Envelope> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) if (value !== undefined) url.searchParams.set(key, value);
    const headers: Record<string, string> = { accept: 'application/json', authorization: `Bearer ${await this.accessToken()}`, ...options.headers };
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    const response = await this.fetchImpl(url, {
      method,
      headers,
      ...(options.form ? { body: options.form } : options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    this.observeRateLimit(response.headers);
    if (response.status === 429) throw new CloudflareRateLimitError(retryAfter(response.headers));
    const parsed: unknown = await response.json().catch(() => null);
    const errors = isRecord(parsed) ? asArray(parsed.errors).filter(isRecord) : [];
    if (!response.ok || !isRecord(parsed) || parsed.success !== true) {
      const apiCodes = errors.map((error) => error.code).filter((code): code is number => typeof code === 'number');
      const detail = errors.map((error) => (typeof error.message === 'string' ? error.message : '')).filter(Boolean).join('; ').slice(0, 300);
      throw new CloudflareApiError(errorCode(response.status), response.status, `Cloudflare API ${method} ${path} failed (${response.status})${detail ? `: ${detail}` : ''}`, apiCodes);
    }
    return { result: parsed.result, resultInfo: isRecord(parsed.result_info) ? parsed.result_info : null };
  }

  private observeRateLimit(headers: Headers): void {
    const parsed = parseRateLimit(headers.get('ratelimit'));
    if (parsed) this.rateLimitState = { ...parsed, observedAt: this.now() };
  }
}

/**
 * Read the `Ratelimit` header, e.g. `"default";r=50;t=30`.
 *
 * With several limits listed, the one closest to running out is what matters.
 */
export function parseRateLimit(value: string | null): { remaining: number; resetSeconds: number } | null {
  if (!value) return null;
  let tightest: { remaining: number; resetSeconds: number } | null = null;
  for (const item of value.split(',')) {
    const remaining = /;\s*r=(\d+)/u.exec(item)?.[1];
    const reset = /;\s*t=(\d+)/u.exec(item)?.[1];
    if (remaining === undefined) continue;
    const candidate = { remaining: Number(remaining), resetSeconds: reset === undefined ? 0 : Number(reset) };
    if (!tightest || candidate.remaining < tightest.remaining) tightest = candidate;
  }
  return tightest;
}

/** The S3 endpoint for an account, which differs for buckets bound to a jurisdiction. */
export function s3Endpoint(accountId: string, jurisdiction: R2Jurisdiction = 'default'): string {
  if (!/^[0-9a-f]{32}$/u.test(accountId)) throw new CloudflareApiError('cloudflare_invalid_account', 400, 'The Cloudflare account ID is not valid');
  return jurisdiction === 'default' ? `https://${accountId}.r2.cloudflarestorage.com` : `https://${accountId}.${jurisdiction}.r2.cloudflarestorage.com`;
}

/**
 * The account and jurisdiction an R2 S3 endpoint belongs to, or null for any
 * other S3 service. The inverse of `s3Endpoint`.
 */
export function parseS3Endpoint(endpoint: string): { accountId: string; jurisdiction: R2Jurisdiction } | null {
  let url: URL;
  try { url = new URL(endpoint); } catch { return null; }
  const match = /^([0-9a-f]{32})(?:\.(eu|us|fedramp|fedramp-high))?\.r2\.cloudflarestorage\.com$/u.exec(url.hostname.toLowerCase());
  if (!match?.[1] || (url.pathname !== '/' && url.pathname !== '')) return null;
  return { accountId: match[1], jurisdiction: (match[2] ?? 'default') as R2Jurisdiction };
}

function errorCode(status: number): string {
  if (status === 401) return 'cloudflare_unauthorized';
  if (status === 403) return 'cloudflare_forbidden';
  if (status === 404) return 'cloudflare_not_found';
  if (status === 409) return 'cloudflare_conflict';
  return 'cloudflare_request_failed';
}

function retryAfter(headers: Headers): number {
  const seconds = Number(headers.get('retry-after'));
  // The documented lockout is five minutes, so that is the wait when none is given.
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : 300;
}

function jurisdictionHeader(jurisdiction: R2Jurisdiction | undefined): Record<string, string> {
  return jurisdiction && jurisdiction !== 'default' ? { 'cf-r2-jurisdiction': jurisdiction } : {};
}

function toBucket(value: unknown): R2Bucket | null {
  if (!isRecord(value) || typeof value.name !== 'string') return null;
  const jurisdiction = typeof value.jurisdiction === 'string' && ['default', 'eu', 'us', 'fedramp', 'fedramp-high'].includes(value.jurisdiction) ? value.jurisdiction as R2Jurisdiction : 'default';
  return {
    name: value.name,
    createdAt: typeof value.creation_date === 'string' ? value.creation_date : null,
    location: typeof value.location === 'string' ? value.location : null,
    jurisdiction,
  };
}

export function segment(value: string): string {
  if (!/^[0-9a-f]{32}$/u.test(value)) throw new CloudflareApiError('cloudflare_invalid_account', 400, 'The Cloudflare account ID is not valid');
  return value;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
