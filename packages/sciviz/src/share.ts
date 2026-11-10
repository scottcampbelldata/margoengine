import {
  Figure,
  validateFigureSpec,
  specHash,
  loadSpecData,
  encodeFigureValue,
  recordedTimeline,
  type FigureSpec,
  type CameraState,
  type FigureLoadOptions,
  type SpecIOOptions,
  type SpecValue,
} from '@margoengine/sciviz/spec';
import { specBase64, specUnbase64 } from './spec-values.js';
import { fault, rangeError, typeError } from '../../shared/errors.js';
export { serveEmbed, connectEmbed } from './share-embed.js';
export type { EmbedState, EmbedSelection, EmbedOptions, EmbedClient } from './share-embed.js';
import { serveEmbed } from './share-embed.js';

/** Optional camera and zero-based time step, applied after the spec has restored. */
export interface ShareView {
  readonly camera?: CameraState;
  readonly timeIndex?: number;
}
/** Versioned compressed-link payload. The spec retains its own integrity hash. */
export interface SharedFigure {
  readonly version: 1;
  readonly spec: FigureSpec;
  readonly view: ShareView;
}
/** Link view, byte bounds and cancellation. */
export interface ShareOptions extends SpecIOOptions {
  readonly view?: ShareView;
  /** Maximum URL characters. Default 32 MiB; practical browser and messaging limits vary. */
  readonly maxURLLength?: number;
}
function limit(options: SpecIOOptions): number {
  const n = options.maxBytes ?? 256 * 1024 * 1024;
  if (!Number.isSafeInteger(n) || n < 1) throw rangeError('maxBytes must be a positive safe integer', 'sciviz');
  return n;
}
async function collect(stream: ReadableStream<Uint8Array>, options: SpecIOOptions): Promise<Uint8Array> {
  const reader = stream.getReader(),
    chunks: Uint8Array[] = [];
  const abort = () => {
    void reader.cancel(options.signal?.reason);
  };
  let size = 0;
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    options.signal?.throwIfAborted();
    while (true) {
      const { done, value } = await reader.read();
      options.signal?.throwIfAborted();
      if (done) break;
      size += value.length;
      if (size > limit(options))
        throw rangeError('Share exceeds maxBytes; use less data or an explicit larger limit', 'sciviz');
      chunks.push(value);
    }
  } finally {
    options.signal?.removeEventListener('abort', abort);
    await reader.cancel();
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
function validateView(spec: FigureSpec, view: ShareView): void {
  if (!view || typeof view !== 'object') throw typeError('Share view must be an object', 'sciviz');
  if (view.camera !== undefined) validateFigureSpec({ ...spec, camera: view.camera });
  if (
    view.timeIndex !== undefined &&
    (!Number.isSafeInteger(view.timeIndex) ||
      view.timeIndex < 0 ||
      !spec.time ||
      view.timeIndex >= spec.time.times.length)
  )
    throw rangeError('Share timeIndex must identify an existing time step', 'sciviz');
}
// Identical hash-pinned arrays appear in multiple frames. Store each once inside the compressed envelope.
function pack(spec: FigureSpec): { spec: FigureSpec; data: SpecValue[] } {
  const data: SpecValue[] = [],
    keys = new Map<string, number>();
  const visit = (value: SpecValue): SpecValue => {
    if (!value || typeof value !== 'object') return value;
    if (!Array.isArray(value) && '$array' in value) {
      const key = JSON.stringify(value);
      let index = keys.get(key);
      if (index === undefined) {
        index = data.length;
        keys.set(key, index);
        data.push(value);
      }
      return { $shareData: index };
    }
    if (Array.isArray(value)) return value.map(visit);
    if ('$shareData' in value) throw typeError('Reserved share key; supply an ordinary figure spec', 'sciviz');
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visit(item)]));
  };
  return { spec: visit(spec as unknown as SpecValue) as unknown as FigureSpec, data };
}
function unpack(spec: FigureSpec, data: readonly SpecValue[]): FigureSpec {
  if (!Array.isArray(data) || data.some((value) => !value || typeof value !== 'object' || !('$array' in value)))
    throw typeError('Invalid shared array table; use the original link', 'sciviz');
  const visit = (value: SpecValue): SpecValue => {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(visit);
    if ('$shareData' in value) {
      const index = value.$shareData;
      if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || !data[index])
        throw typeError('Invalid shared array reference; use the original link', 'sciviz');
      return data[index];
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visit(item)]));
  };
  return visit(spec as unknown as SpecValue) as unknown as FigureSpec;
}
/** Save a figure or spec in a DEFLATE, unpadded base64url fragment; no server receives the fragment. */
export async function createShareURL(
  figure: Figure | FigureSpec,
  base: string | URL,
  options: ShareOptions = {},
): Promise<string> {
  options.signal?.throwIfAborted();
  const spec = 'toJSON' in figure ? await figure.toJSON(options) : figure,
    view = options.view ?? {};
  validateFigureSpec(spec);
  validateView(spec, view);
  const bytes = new TextEncoder().encode(JSON.stringify({ version: 1, ...pack(spec), view }));
  if (bytes.length > limit(options)) throw rangeError('Share exceeds maxBytes', 'sciviz');
  const compressed = await collect(new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate')), options);
  const url = new URL(base);
  url.hash = 'margo=' + specBase64(compressed).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const max = options.maxURLLength ?? 32 * 1024 * 1024;
  if (!Number.isSafeInteger(max) || max < 1 || url.href.length > max)
    throw rangeError('Share URL exceeds maxURLLength; use external pinned data or standalone HTML', 'sciviz');
  return url.href;
}
/** Decode with a streaming allocation bound. Unknown versions and malformed views reject before rendering. */
export async function readShareURL(url: string | URL, options: ShareOptions = {}): Promise<SharedFigure> {
  options.signal?.throwIfAborted();
  const hash = String(url).startsWith('#') ? String(url) : new URL(url).hash;
  const encoded = hash.slice(7);
  if (!hash.startsWith('#margo=') || !/^[\w-]+$/.test(encoded) || encoded.length % 4 === 1)
    throw typeError('Expected a versioned Margo share fragment', 'sciviz');
  if (String(url).length > (options.maxURLLength ?? 32 * 1024 * 1024))
    throw rangeError('Share URL exceeds maxURLLength', 'sciviz');
  const base64 = encoded
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(encoded.length / 4) * 4, '=');
  const bytes = specUnbase64(base64, limit(options));
  const decoded = await collect(
    new Blob([Uint8Array.from(bytes)]).stream().pipeThrough(new DecompressionStream('deflate')),
    options,
  );
  const payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decoded)) as SharedFigure & {
    data?: SpecValue[];
  };
  const result = {
    version: payload.version,
    spec: payload.data ? unpack(payload.spec, payload.data) : payload.spec,
    view: payload.view,
  };
  if (result?.version !== 1) throw typeError('Unsupported share version; use version 1', 'sciviz');
  validateFigureSpec(result.spec);
  validateView(result.spec, result.view);
  return result;
}
/** Restore a deep link and its camera/time step. The caller owns the returned figure. */
export async function openShare(
  url: string | URL,
  canvas: HTMLCanvasElement,
  options: FigureLoadOptions & ShareOptions = {},
): Promise<Figure> {
  const shared = await readShareURL(url, options);
  const figure = await Figure.fromJSON(shared.spec, canvas, options);
  try {
    await applyShareView(figure, shared.view);
    return figure;
  } catch (error) {
    figure.dispose();
    throw error;
  }
}
/** Apply a validated camera and exact time step to an existing recorded figure. */
export async function applyShareView(figure: Figure, view: ShareView): Promise<void> {
  const timeline = recordedTimeline(figure);
  if (view.timeIndex !== undefined) {
    if (
      !timeline ||
      !Number.isSafeInteger(view.timeIndex) ||
      view.timeIndex < 0 ||
      view.timeIndex >= timeline.times.length
    )
      throw rangeError('Share timeIndex must identify an existing time step', 'sciviz');
  }
  if (view.camera) {
    validateFigureSpec({
      version: 1,
      options: {},
      camera: view.camera,
      limits: [0, 1, 0, 1],
      dragMode: 'orbit',
      resources: [],
      layers: [],
    });
  }
  if (view.timeIndex !== undefined) {
    timeline!.pause();
    await timeline!.seek(view.timeIndex);
  }
  if (view.camera) Object.assign(figure.engine.camera, structuredClone(view.camera));
}
/** Resolve all pinned binary URLs into hash-checked inline arrays, including timeline frames. */
export async function inlineShareData(spec: FigureSpec, options: SpecIOOptions = {}): Promise<FigureSpec> {
  validateFigureSpec(spec);
  if (spec.sha256) {
    const { sha256, ...body } = spec;
    if ((await specHash(new TextEncoder().encode(JSON.stringify(body)))) !== sha256)
      throw fault('failed', 'Spec hash mismatch; supply the original spec', 'sciviz');
  }
  let size = 0;
  const visit = async (value: unknown): Promise<unknown> => {
    options.signal?.throwIfAborted();
    if (!value || typeof value !== 'object') return value;
    if ('$url' in value) {
      const data = await loadSpecData((value as { $url: Parameters<typeof loadSpecData>[0] }).$url, {
        ...options,
        maxBytes: limit(options) - size,
      });
      size += data.byteLength;
      return encodeFigureValue(data, options);
    }
    if ('$array' in value) {
      const array = value as unknown as { bytes: string; sha256: string };
      const bytes = specUnbase64(array.bytes, limit(options) - size);
      size += bytes.length;
      if ((await specHash(bytes)) !== array.sha256)
        throw fault('failed', 'Array hash mismatch; supply the original array', 'sciviz');
      return value;
    }
    if (Array.isArray(value)) {
      const out = [];
      for (const item of value) out.push(await visit(item));
      return out;
    }
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw typeError('Reserved share data key', 'sciviz');
      if (key === 'sha256' && 'version' in value && 'resources' in value) continue;
      out[key] = await visit(item);
    }
    if ('version' in value && 'resources' in value)
      out.sha256 = await specHash(new TextEncoder().encode(JSON.stringify(out)));
    return out;
  };
  const { sha256: _hash, ...body } = (await visit(spec)) as FigureSpec;
  return { ...body, sha256: await specHash(new TextEncoder().encode(JSON.stringify(body))) };
}
/** Offline runtime, title and optional parent messaging. */
export interface StandaloneOptions extends ShareOptions {
  /** IIFE runtime built with scripts/bundle-share.mjs, including all required optional entries and assets. */
  readonly runtime: string;
  readonly title?: string;
  /** Enable the iframe API only for this exact parent origin. Default disabled. */
  readonly parentOrigin?: string;
  readonly channel?: string;
  /** Prefer native WebGPU, with the bundled WebGL2 compatibility layer as fallback. Default auto. */
  readonly backend?: 'auto' | 'webgpu' | 'webgl2';
}
/** A single offline HTML document. Data and executable runtime are inline; no CDN or import map is needed. */
export async function exportStandalone(figure: Figure | FigureSpec, options: StandaloneOptions): Promise<Blob> {
  if (!options.runtime?.trim()) throw typeError('Supply the bundled standalone runtime', 'sciviz');
  const spec = await inlineShareData('toJSON' in figure ? await figure.toJSON(options) : figure, options);
  const view = options.view ?? {};
  validateView(spec, view);
  const payload = JSON.stringify({
    spec,
    view,
    parentOrigin: options.parentOrigin,
    channel: options.channel,
    backend: options.backend ?? 'auto',
  }).replace(/</g, '\\u003c');
  const title = (options.title ?? 'Margo scientific figure').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
  const runtime = specBase64(new TextEncoder().encode(options.runtime));
  return new Blob(
    [
      `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}canvas{display:block;width:100%;height:100%}#error{position:absolute;inset:1rem;font:16px system-ui}</style><canvas aria-label="${title}"></canvas><pre id="error" hidden></pre><script id="margo-state" type="application/json">${payload}</script><script src="data:text/javascript;base64,${runtime}"></script><script>MargoShare.startStandalone().catch(error=>{const box=document.getElementById('error');box.hidden=false;box.textContent=error.message;window.dispatchEvent(new ErrorEvent('error',{error,message:error.message}))});</script></html>`,
    ],
    { type: 'text/html;charset=utf-8' },
  );
}
/** Load options for an offline viewer with host-owned backend setup. */
export interface StandaloneLoadOptions extends FigureLoadOptions {
  /** Called for auto/webgl2 only; omit to use the installed backend. */
  readonly prepareBackend?: (options: { force: boolean; signal?: AbortSignal }) => Promise<unknown>;
}
/** @internal Entrypoint for the bundled offline viewer. Dispatches margo-ready with the restored figure. */
export async function startStandalone(options: StandaloneLoadOptions = {}): Promise<Figure> {
  const { spec, view, parentOrigin, channel, backend } = JSON.parse(
    document.getElementById('margo-state')!.textContent!,
  );
  const { prepareBackend, ...load } = options;
  load.signal?.throwIfAborted();
  if (backend !== 'webgpu') await prepareBackend?.({ force: backend === 'webgl2', signal: load.signal });
  load.signal?.throwIfAborted();
  const figure = await Figure.fromJSON(spec, document.querySelector('canvas')!, load);
  try {
    if (location.hash.startsWith('#margo=')) {
      const linked = await readShareURL(location.href);
      if (linked.spec.sha256 !== spec.sha256)
        throw fault('failed', 'Deep link belongs to a different standalone figure', 'sciviz');
      await applyShareView(figure, linked.view);
    } else await applyShareView(figure, view);
    if (parentOrigin) {
      const endpoint = serveEmbed(figure, { origin: parentOrigin, channel });
      window.addEventListener('pagehide', () => endpoint.dispose(), { once: true });
    }
    window.dispatchEvent(new CustomEvent('margo-ready', { detail: figure }));
    return figure;
  } catch (error) {
    figure.dispose();
    throw error;
  }
}
