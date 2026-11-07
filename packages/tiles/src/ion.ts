// @margoengine/tiles/ion: sign-in and credits for hosted tile services. `ionAsset` asks Cesium ion's REST API for an
// asset's endpoint (its tileset or terrain URL, a short-lived token and the attributions the asset must show) and
// returns a fetch that sends the token as a bearer header to that host only, asking again once when it expires.
// `hostedTileset` signs requests to any token-based service with headers or query parameters, carrying a session
// parameter the service hands out in tile URLs on to the tiles they link. `TileCredits` lists what must be shown:
// the service's attributions, then the glTF `asset.copyright` of the tiles drawn now, most frequent first. Written
// from the ion REST API's endpoint reference (asset endpoint, bearer tokens, attributions with `collapsible`), the
// Map Tiles API documentation (key and session parameters, copyright display) and the glTF 2.0 `asset` property.
import { MargoError } from '@margoengine/math/errors';
import { glbChunks, isGLB } from '../../shared/glb.js';
import { parseJSON } from '../../shared/json.js';
import type { TileContent } from './formats.js';
import type { TilesetTile } from './tileset.js';

/** The fetch a tileset, the renderer and `terrain` take. */
export type TilesFetch = (
  input: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<Response>;

/** A credit to show with the view. */
export interface Credit {
  /** Plain text (tags of `html` removed). */
  readonly text: string;
  /** The service's own HTML for it (ion attributions, with links and logos), else undefined. */
  readonly html?: string;
  /** False: it must be on screen. True: it may sit behind a "credits" control (ion's `collapsible`). */
  readonly collapsible: boolean;
  /** Drawn tiles naming it this update; 0 for a service credit. */
  readonly count: number;
}

/** A signed tileset or terrain layer, ready for `TilesRenderer.load(engine, url, { fetch })` or `terrain(url, { fetch })`. */
export interface HostedTileset {
  /** The tileset (or terrain layer) URL. */
  readonly url: string;
  /** Signs every request to the service's host; other hosts get the request as it was. */
  readonly fetch: TilesFetch;
  /** The service's attributions, to pass to `TileCredits`. */
  readonly credits: readonly Credit[];
  /** ion's asset type ('3DTILES', 'TERRAIN', ...); '3DTILES' for `hostedTileset`. */
  readonly type: string;
}

/** Options of `hostedTileset`. */
export interface HostedTilesetOptions {
  /** Headers added to each request to the tileset's host (such as an API key header). */
  headers?: Record<string, string>;
  /** Query parameters added to each request to the tileset's host that lacks them (such as `key`). */
  query?: Record<string, string>;
  /**
   * Query parameters the service puts in tile URLs and wants on every later request (default `['session']`): the
   * last value seen on a request is added to requests without one, as relative tile URIs drop the query.
   */
  carry?: readonly string[];
  /** Credits the service asks for on top of the tiles' own copyright. */
  credits?: readonly Credit[];
  /** The fetch under the signing (tests, caches). Default `globalThis.fetch`. */
  fetch?: TilesFetch;
}

/** Options of `ionAsset`. */
export interface IonOptions {
  /** Your ion access token (sent as a bearer header, never in a URL). */
  accessToken: string;
  /** The ion API server. Default `'https://api.cesium.com/'`. */
  server?: string;
  /** The fetch under the signing (tests, caches). Default `globalThis.fetch`. */
  fetch?: TilesFetch;
}

interface Signing {
  headers: Record<string, string>;
  /** Called once on a 401 from the host; resolves new headers, shared by every request that saw the 401. */
  refresh?: () => Promise<Record<string, string>>;
}

function baseFetch(fetch: TilesFetch | undefined): TilesFetch {
  const f = fetch ?? (globalThis.fetch?.bind(globalThis) as TilesFetch | undefined);
  if (!f) throw new MargoError('unsupported', 'No fetch available; pass options.fetch');
  return f;
}

function signer(
  url: string,
  signing: Signing,
  query: Record<string, string>,
  carry: readonly string[],
  under: TilesFetch,
): TilesFetch {
  const origin = new URL(url).origin,
    carried = new Map<string, string>();
  let refreshing: Promise<Record<string, string>> | undefined;
  const send = (target: URL, init: Parameters<TilesFetch>[1]) =>
    under(target.href, { ...init, headers: { ...init?.headers, ...signing.headers } });
  return async (input, init) => {
    const target = new URL(input, url);
    if (target.origin !== origin) return under(input, init);
    for (const name of carry) {
      const value = target.searchParams.get(name);
      if (value !== null) carried.set(name, value);
      else if (carried.has(name)) target.searchParams.set(name, carried.get(name)!);
    }
    for (const [name, value] of Object.entries(query))
      if (!target.searchParams.has(name)) target.searchParams.set(name, value);
    const used = signing.headers;
    const response = await send(target, init);
    if (response.status !== 401 || !signing.refresh) return response;
    // Expired token: ask once for every request that saw it, then retry with the new one.
    if (signing.headers === used)
      refreshing ??= signing.refresh().then(
        (headers) => {
          signing.headers = headers;
          refreshing = undefined;
          return headers;
        },
        (error: unknown) => {
          refreshing = undefined;
          throw error;
        },
      );
    if (refreshing) await refreshing;
    return send(target, init);
  };
}

/**
 * A tileset on a token-based service: each request to its host gets `headers` and missing `query` parameters, and
 * `carry` parameters (a session) seen on one request go on to the next. No request is made until the tileset loads.
 */
export function hostedTileset(url: string | URL, options: HostedTilesetOptions = {}): HostedTileset {
  const href = String(url);
  if (!URL.canParse(href))
    throw new TypeError(`Invalid hosted tileset URL ${JSON.stringify(href)}; give an absolute URL`);
  const fetch = signer(
    href,
    { headers: { ...options.headers } },
    { ...options.query },
    options.carry ?? ['session'],
    baseFetch(options.fetch),
  );
  return { url: href, fetch, credits: [...(options.credits ?? [])], type: '3DTILES' };
}

interface IonEndpoint {
  type?: string;
  url?: string;
  accessToken?: string;
  externalType?: string;
  attributions?: { html?: string; collapsible?: boolean }[];
}

async function ionEndpoint(endpoint: string, token: string, fetch: TilesFetch): Promise<IonEndpoint> {
  const response = await fetch(endpoint, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) {
    let reason = '';
    try {
      reason = String((parseJSON(await response.text()) as { message?: unknown }).message ?? '');
    } catch {
      // The body is not JSON; the status says enough.
    }
    const fix =
      response.status === 401
        ? 'check the access token'
        : response.status === 404
          ? 'check the asset ID and that the token may read it'
          : 'try again later';
    throw new MargoError(
      'failed',
      `ion endpoint ${endpoint} answered ${response.status}${reason ? ` (${reason})` : ''}; ${fix}`,
    );
  }
  return parseJSON<IonEndpoint>(await response.text());
}

/**
 * Signs in to a Cesium ion asset: asks `server` for its endpoint with `accessToken`, and returns its URL, a fetch
 * that sends the asset's own token to the asset's host (asking for a new one once when it answers 401), and its
 * attributions as credits. Assets ion only points at (`externalType`, such as Bing imagery) throw `unsupported`.
 */
export async function ionAsset(assetId: number, options: IonOptions): Promise<HostedTileset> {
  if (!Number.isInteger(assetId) || assetId < 0)
    throw new RangeError(`Invalid ion asset ID ${assetId}; pass a whole number, as ion lists it`);
  if (typeof options?.accessToken !== 'string' || !options.accessToken)
    throw new TypeError('ionAsset needs { accessToken }: an ion access token');
  const under = baseFetch(options.fetch),
    endpoint = new URL(`v1/assets/${assetId}/endpoint`, options.server ?? 'https://api.cesium.com/').href;
  const json = await ionEndpoint(endpoint, options.accessToken, under);
  if (typeof json.url !== 'string' || !URL.canParse(json.url))
    throw new MargoError(
      'unsupported',
      `ion asset ${assetId} (${json.type ?? 'no type'}${json.externalType ? `, external ${json.externalType}` : ''}) has no URL to stream; use a 3D Tiles or terrain asset`,
    );
  const bearer = (token: string | undefined): Record<string, string> =>
    token ? { Authorization: `Bearer ${token}` } : {};
  const signing: Signing = {
    headers: bearer(json.accessToken),
    refresh: async () => bearer((await ionEndpoint(endpoint, options.accessToken, under)).accessToken),
  };
  const credits = (json.attributions ?? [])
    .filter((a) => typeof a?.html === 'string')
    .map((a) => ({ text: htmlText(a.html!), html: a.html, collapsible: a.collapsible !== false, count: 0 }));
  return { url: json.url, fetch: signer(json.url, signing, {}, [], under), credits, type: json.type ?? '3DTILES' };
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  copy: '\u00a9',
  reg: '\u00ae',
};

/** The text of an HTML fragment: tags removed, entities decoded, white space collapsed. Only for text output. */
export function htmlText(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, name: string) => {
      if (name[0] !== '#') return ENTITIES[name.toLowerCase()] ?? whole;
      const hex = name[1] === 'x' || name[1] === 'X',
        code = Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10);
      return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

const decoder = new TextDecoder();

/** The `asset.copyright` credits of glTF bytes (GLB or JSON), split on semicolons; none when unreadable. */
function gltfCopyright(bytes: Uint8Array): string[] {
  try {
    const json = isGLB(bytes) ? glbChunks(bytes)[0].data : bytes;
    const copyright = parseJSON<{ asset?: { copyright?: unknown } }>(decoder.decode(json)).asset?.copyright;
    return typeof copyright === 'string'
      ? copyright
          .split(';')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

const contentCredits = new WeakMap<TileContent, readonly string[]>();

/** The copyright credits a tile content names (cached per content). */
export function contentCopyright(content: TileContent): readonly string[] {
  let found = contentCredits.get(content);
  if (!found) {
    found =
      content.type === 'cmpt'
        ? [...new Set(content.tiles.flatMap((inner) => contentCopyright(inner)))]
        : content.type === 'pnts' || !content.gltf
          ? []
          : [...new Set(gltfCopyright(content.gltf))];
    contentCredits.set(content, found);
  }
  return found;
}

/** What `TileCredits.follow` watches: a `TilesRenderer`. */
export interface CreditsSource {
  readonly last: { readonly selected: readonly TilesetTile[] };
  onUpdate(listener: () => void): () => void;
}

/**
 * The credits to show with the view: the service's first (in their order), then each copyright of the drawn tiles'
 * glTF `asset.copyright` (split on semicolons), by how many drawn tiles name it, most first, ties by text.
 */
export class TileCredits {
  /** Service credits first, then the drawn tiles' copyrights. */
  list: readonly Credit[] = [];
  private readonly service: readonly Credit[];
  private key = '';
  private stop?: () => void;
  private element?: { textContent: string | null };
  constructor(service: readonly Credit[] = []) {
    this.service = service;
    this.list = [...service];
  }
  /** Follows a renderer: recounts after each selection update and writes `text()` to `element` when it changes. */
  static follow(
    tiles: CreditsSource,
    options: { credits?: readonly Credit[]; element?: { textContent: string | null } } = {},
  ): TileCredits {
    const credits = new TileCredits(options.credits);
    credits.element = options.element;
    if (credits.element) credits.element.textContent = credits.text();
    credits.stop = tiles.onUpdate(() => credits.update(tiles.last.selected));
    credits.update(tiles.last.selected);
    return credits;
  }
  /** Recounts from the tiles drawn this update; true when the list changed. */
  update(selected: readonly TilesetTile[]): boolean {
    const counts = new Map<string, number>();
    for (const tile of selected) {
      const named = new Set<string>();
      for (const content of tile.contents) for (const text of contentCopyright(content)) named.add(text);
      for (const text of named) counts.set(text, (counts.get(text) ?? 0) + 1);
    }
    const tiles = [...counts]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([text, count]) => ({ text, collapsible: false, count }));
    const key = JSON.stringify(tiles.map((c) => [c.text, c.count]));
    if (key === this.key) return false;
    this.key = key;
    this.list = [...this.service, ...tiles];
    if (this.element) this.element.textContent = this.text();
    return true;
  }
  /** The credits as plain text, joined by `separator`; `collapsible: false` only when `required` is true. */
  text(separator = ' | ', required = false): string {
    return this.list
      .filter((c) => !required || !c.collapsible)
      .map((c) => c.text)
      .join(separator);
  }
  /** The credits as HTML: the service's own HTML as it gave it, the tiles' copyright escaped. */
  html(separator = ' | '): string {
    return this.list.map((c) => c.html ?? escapeHtml(c.text)).join(separator);
  }
  /** Stops following the renderer. */
  dispose(): void {
    this.stop?.();
    this.stop = undefined;
  }
  /** Same as `dispose()`, for `using credits = TileCredits.follow(...)`. */
  [Symbol.dispose](): void {
    this.dispose();
  }
}
