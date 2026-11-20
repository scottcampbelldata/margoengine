import { LoaderError, httpRefusal } from './types.js';

/** Options of fetchBytes and fetchResource: an AbortSignal, the size limit, a custom fetch, RequestInit and guards. */
export interface FetchOptions {
  signal?: AbortSignal;
  /** Maximum response size in bytes. Default 256 MiB. */
  maxBytes?: number;
  /** Custom fetch, for example one that adds credentials. Default `globalThis.fetch`. */
  fetch?: typeof fetch;
  /** Extra `RequestInit` (headers, credentials, ...). */
  init?: RequestInit;
  /**
   * URL schemes allowed for the link and every redirect, such as `['https:']`. Default: any scheme the fetch takes.
   * Refused with LoaderError code `'url'`.
   */
  protocols?: readonly string[];
  /**
   * True refuses a link or redirect to this computer or a private network by its host: `localhost` and `*.localhost`
   * (RFC 6761), IPv4 0/8, loopback 127/8, private 10/8, 172.16/12 and 192.168/16 (RFC 1918), shared 100.64/10
   * (RFC 6598), link-local 169.254/16 (RFC 3927), and IPv6 loopback, unspecified, unique local fc00::/7 (RFC 4193),
   * link-local fe80::/10 (RFC 4291) and IPv4-mapped forms of those; also a link with a user name or password.
   * Default false. Refused with code `'url'`. It reads the host as written: a public name whose DNS answer is private
   * is not caught.
   */
  publicOnly?: boolean;
  /** Your own host test, run on the link and every redirect after `publicOnly`: false refuses (code `'url'`). */
  allowHost?: (hostname: string, url: URL) => boolean;
  /**
   * Redirects followed by hand (`redirect: 'manual'`), each hop checked against `protocols`, `publicOnly` and
   * `allowHost`; one more is refused with code `'limit'`. Default 20 when a guard is set; with no guard the fetch
   * follows redirects itself. A browser hides manual redirects (an opaque response), so there a guarded redirect is
   * refused with `'unsupported'`; Node and other servers follow them.
   */
  maxRedirects?: number;
  /**
   * Media types accepted, matched against the response's `Content-Type` essence (type/subtype, no parameters):
   * `'text/html'`, or `'text/*'` for a whole type. Default: any. Refused with code `'unsupported'` before the body is
   * read.
   */
  accept?: readonly string[];
}

/** What fetchResource returns: the body, the final URL after redirects, its media type and status, and the hops. */
export interface FetchedResource {
  bytes: Uint8Array;
  /** The final URL, after redirects. */
  url: string;
  /** The response's `Content-Type` as sent (parameters such as `charset` included), or `''`. */
  type: string;
  status: number;
  /** Redirects followed by hand (0 when the fetch followed them itself). */
  redirects: number;
}

const F = 'load';
/** The default response size limit of fetchBytes: 256 MiB. */
export const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
const short = (url: string | URL) => String(url).slice(0, 200);

/** An IPv4 dotted quad as a number, or undefined. */
function ipv4(host: string): number | undefined {
  const parts = host.split('.');
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p) || +p > 255)) return undefined;
  return parts.reduce((n, p) => n * 256 + +p, 0);
}
// Base (as a number) and prefix length of each IPv4 range publicOnly refuses.
const PRIVATE4: [number, number][] = (
  [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.168.0.0', 16],
  ] as const
).map(([base, bits]) => [ipv4(base)!, bits]);
const private4 = (n: number) => PRIVATE4.some(([base, bits]) => n >= base && n < base + 2 ** (32 - bits));
/**
 * True for a host that names this computer or a private network as written (FetchOptions.publicOnly). WHATWG URL
 * parsing has already turned short and hexadecimal IPv4 forms into dotted quads, and IPv6 into its bracketed,
 * compressed, lower-case text.
 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  const v4 = ipv4(host);
  if (v4 !== undefined) return private4(v4);
  if (!host.startsWith('[')) return false;
  const v6 = host.slice(1, -1);
  if (v6 === '::1' || v6 === '::') return true;
  const mapped = /^::ffff:(.+)$/.exec(v6);
  if (mapped) {
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(mapped[1]),
      n = ipv4(mapped[1]) ?? (hex ? parseInt(hex[1], 16) * 65536 + parseInt(hex[2], 16) : undefined);
    return n !== undefined && private4(n);
  }
  const first = parseInt(v6.split(':')[0] || '0', 16);
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
}

/** Throws when `url` fails the guards of `options`. */
function guard(url: URL, options: FetchOptions, hop: number): void {
  const where = hop ? `a redirect to ${short(url.href)}` : short(url.href);
  if (options.protocols && !options.protocols.includes(url.protocol))
    throw new LoaderError(F, 'url', `${where} uses ${url.protocol}; allowed: ${options.protocols.join(', ')}`);
  if (options.publicOnly) {
    if (url.username || url.password) throw new LoaderError(F, 'url', `${where} carries a user name or password`);
    if (isPrivateHost(url.hostname))
      throw new LoaderError(F, 'url', `${where} is this computer or a private network; public hosts only`);
  }
  if (options.allowHost && !options.allowHost(url.hostname, url))
    throw new LoaderError(F, 'url', `${where}: host ${url.hostname} refused by allowHost`);
}

/** The `Content-Type` essence (WHATWG MIME Sniffing): type/subtype, lower case, without parameters. */
const essence = (type: string) => type.split(';')[0].trim().toLowerCase();
const accepted = (type: string, accept: readonly string[]) =>
  accept.some((a) => {
    const want = a.trim().toLowerCase();
    return want.endsWith('/*') ? essence(type).startsWith(want.slice(0, -1)) : essence(type) === want;
  });

/** Fetches `url` into memory, enforcing `maxBytes` on both Content-Length and the streamed body. */
export async function fetchBytes(url: string | URL, options: FetchOptions = {}): Promise<Uint8Array> {
  return (await fetchResource(url, options)).bytes;
}

/**
 * Fetches `url` like fetchBytes and also returns the final URL, media type, status and redirects followed. With
 * `protocols`, `publicOnly`, `allowHost` or `maxRedirects` it follows redirects by hand and checks every hop, for links
 * from untrusted sources; `accept` refuses other media types before the body is read. An error the custom `fetch`
 * throws is kept as the LoaderError's `cause`.
 */
export async function fetchResource(url: string | URL, options: FetchOptions = {}): Promise<FetchedResource> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES,
    maxRedirects = options.maxRedirects ?? 20;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
    throw new LoaderError(F, 'range', 'maxBytes must be a non-negative integer');
  if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0)
    throw new LoaderError(F, 'range', 'maxRedirects must be a non-negative integer');
  const guarded = !!(options.protocols || options.publicOnly || options.allowHost || options.maxRedirects !== undefined),
    doFetch = options.fetch ?? globalThis.fetch,
    signal = options.signal;
  if (typeof doFetch !== 'function') throw new LoaderError(F, 'unsupported', 'fetch is not available');
  if (signal?.aborted) throw new LoaderError(F, 'aborted', `aborted before fetching ${short(url)}`);
  let target: string | URL = url,
    redirects = 0,
    response: Response;
  for (;;) {
    if (guarded) {
      try {
        target = new URL(target);
      } catch (error) {
        throw new LoaderError(F, 'url', `${short(target)} is not an absolute URL`, { cause: error });
      }
      guard(target, options, redirects);
    }
    try {
      response = await doFetch(target, { ...options.init, ...(guarded ? { redirect: 'manual' as const } : {}), signal });
    } catch (error) {
      if (signal?.aborted)
        throw new LoaderError(F, 'aborted', `aborted while fetching ${short(target)}`, { cause: error });
      throw new LoaderError(F, 'fetch', `request for ${short(target)} failed (${(error as Error)?.message ?? error})`, {
        cause: error,
      });
    }
    if (!guarded) break;
    if (response.type === 'opaqueredirect') {
      void response.body?.cancel().catch(() => {});
      throw new LoaderError(F, 'unsupported', `${short(target)} redirects, and this fetch hides redirects from checks`);
    }
    if (response.status < 300 || response.status > 399 || response.status === 304) break;
    const location = response.headers.get('location');
    void response.body?.cancel().catch(() => {});
    if (!location)
      throw new LoaderError(F, 'fetch', `${short(target)} answered HTTP ${response.status} with no Location`, {
        status: response.status,
      });
    if (redirects >= maxRedirects) throw new LoaderError(F, 'limit', `more than ${maxRedirects} redirects from ${short(url)}`);
    target = new URL(location, target);
    redirects++;
  }
  const where = response.url || String(target),
    type = response.headers.get('content-type') ?? '';
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new LoaderError(F, 'fetch', `request for ${short(where)} returned HTTP ${response.status}`, httpRefusal(response));
  }
  if (options.accept && !accepted(type, options.accept)) {
    void response.body?.cancel().catch(() => {});
    throw new LoaderError(
      F,
      'unsupported',
      `${short(where)} is ${essence(type) || 'of no stated type'}; accepted: ${options.accept.join(', ')}`,
    );
  }
  const bytes = await readBody(response, maxBytes, signal, where);
  return { bytes, url: where, type, status: response.status, redirects };
}

/** The body of `response`, at most `maxBytes` by its Content-Length and as it streams. */
async function readBody(
  response: Response,
  maxBytes: number,
  signal: AbortSignal | undefined,
  url: string,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    const error = new LoaderError(F, 'limit', `response is ${declared} bytes, more than the limit of ${maxBytes}`);
    void response.body?.cancel(error).catch(() => {});
    throw error;
  }
  if (!response.body) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.length > maxBytes)
      throw new LoaderError(F, 'limit', `response is ${buffer.length} bytes, more than the limit of ${maxBytes}`);
    return buffer;
  }
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > maxBytes) throw new LoaderError(F, 'limit', `response exceeds the limit of ${maxBytes} bytes`);
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel(error).catch(() => {});
    if (error instanceof LoaderError) throw error;
    if (signal?.aborted)
      throw new LoaderError(F, 'aborted', `aborted while reading ${short(url)}`, { cause: error });
    throw new LoaderError(F, 'fetch', `reading ${short(url)} failed (${(error as Error)?.message ?? error})`, {
      cause: error,
    });
  }
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Fetches `url` and parses it with `parse`, for example `load('/scan.ply', parsePLY, {signal, maxVertices: 1e6})`.
 * The same options object goes to the parser, so limits and `signal` apply to both steps.
 */
export async function load<T, O extends object = object>(
  url: string | URL,
  parse: (input: Uint8Array, options?: O) => T | Promise<T>,
  options?: O & FetchOptions,
): Promise<T> {
  const bytes = await fetchBytes(url, options);
  if (options?.signal?.aborted) throw new LoaderError(F, 'aborted', 'aborted');
  return parse(bytes, options);
}
