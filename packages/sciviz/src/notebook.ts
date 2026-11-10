import { Figure, validateFigureSpec, type FigureLoadOptions, type FigureSpec } from '@margoengine/sciviz/spec';
import { applyShareView, type EmbedSelection } from '@margoengine/sciviz/share';
import { fault, typeError } from '../../shared/errors.js';

/** The small AFM model contract implemented by anywidget and native notebook hosts. */
export interface NotebookModel {
  get(name: string): unknown;
  set(name: string, value: unknown): void;
  save_changes(): void;
  on(name: string, callback: () => void): void;
  off(name: string, callback: () => void): void;
}
/** AFM view inputs. Each render owns one figure; all views share the host's model. */
export interface NotebookRenderOptions {
  readonly model: NotebookModel;
  readonly el: HTMLElement;
  readonly signal?: AbortSignal;
  /** Explicit application codecs, pipeline registry or engine. Nothing is fetched from an executable registry. */
  readonly load?: Omit<FigureLoadOptions, 'buffers' | 'signal'>;
  /** Host-owned lazy backend setup, called for auto/webgl2 only. Required for explicit webgl2. Bundled notebook hosts supply it by default. */
  readonly prepareBackend?: (options: { force: boolean; signal: AbortSignal }) => Promise<unknown>;
}
/** Convert comm byte views to a named lookup without copying their storage or losing offsets. */
export function notebookBuffers(value: unknown): ReadonlyMap<string, ArrayBufferView> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw typeError('Notebook buffers must be a dictionary of binary attachments', 'sciviz');
  const out = new Map<string, ArrayBufferView>();
  for (const [key, buffer] of Object.entries(value)) {
    if (!ArrayBuffer.isView(buffer)) throw typeError('Notebook attachments must be binary comm views', 'sciviz');
    out.set(key, buffer);
  }
  return out;
}
function camera(figure: Figure) {
  const c = figure.engine.camera;
  return { position: [...c.position], target: [...c.target], up: [...c.up], fov: c.fov, near: c.near, far: c.far };
}
function selection(figure: Figure): unknown {
  const value = figure.selection;
  return value
    ? {
        region: value.region,
        points: value.points.map((p) => ({ layer: figure.layers.indexOf(p.layer), indices: p.indices })),
      }
    : null;
}
function applySelection(figure: Figure, input: unknown): void {
  if (input == null) {
    figure.setSelection(undefined, { emit: false });
    return;
  }
  const value = input as EmbedSelection;
  if (!value.region || !Array.isArray(value.points))
    throw typeError('Notebook selection needs a region and layer/index points', 'sciviz');
  const points = value.points.map((point) => {
    const layer = figure.layers[point.layer];
    if (
      !Number.isSafeInteger(point.layer) ||
      !layer ||
      !('kind' in layer) ||
      !['scatter', 'line'].includes(String(layer.kind))
    )
      throw typeError('Notebook selection must address an existing scatter or line layer', 'sciviz');
    const raw = point.indices as unknown;
    let indices: Uint32Array;
    if (ArrayBuffer.isView(raw)) {
      if (raw.byteLength % 4) throw typeError('Notebook selection indices need uint32 bytes', 'sciviz');
      const bytes = raw.byteOffset % 4 ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength).slice() : raw;
      indices = new Uint32Array(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength / 4);
    } else {
      if (!Array.isArray(raw) || raw.some((i) => !Number.isSafeInteger(i) || i < 0 || i > 0xffffffff))
        throw typeError('Notebook selection indices must be unsigned 32-bit integers', 'sciviz');
      indices = Uint32Array.from(raw);
    }
    return { layer: layer as NonNullable<Figure['selection']>['points'][number]['layer'], indices };
  });
  figure.setSelection({ region: value.region, points }, { emit: false });
}
/** Render a portable spec as an anywidget-compatible view, with binary data and two-way camera/selection state. */
export async function render({ model, el, signal, load, prepareBackend }: NotebookRenderOptions): Promise<() => void> {
  signal?.throwIfAborted();
  let figure: Figure | undefined,
    active: AbortController | undefined,
    disposed = false,
    generation = 0;
  let detach = () => {};
  const publish = (name: string, value: unknown) => {
    model.set(name, value);
    model.save_changes();
  };
  const report = (error: unknown) => {
    active?.abort();
    detach();
    figure?.dispose();
    figure = undefined;
    const message = error instanceof Error ? error.message : String(error);
    el.textContent = message;
    publish('error', message);
    el.dispatchEvent(new CustomEvent('margo-notebook-error', { detail: error, bubbles: true }));
  };
  const syncCamera = () => {
    const current = figure;
    if (current && model.get('camera'))
      void applyShareView(current, { camera: model.get('camera') as FigureSpec['camera'] }).catch((error) => {
        if (figure === current) report(error);
      });
  };
  const syncSelection = () => {
    if (figure) applySelection(figure, model.get('selection'));
  };
  const resize = () => {
    const height = model.get('height') ?? 480;
    if (!Number.isInteger(height) || Number(height) < 100 || Number(height) > 4000)
      throw typeError('Notebook height must be an integer from 100 to 4000 pixels', 'sciviz');
    el.style.cssText = `display:block;position:relative;width:100%;height:${height}px`;
  };
  const update = async () => {
    const id = ++generation;
    active?.abort();
    detach();
    figure?.dispose();
    figure = undefined;
    const controller = new AbortController();
    active = controller;
    const spec = model.get('spec');
    validateFigureSpec(spec);
    const buffers = notebookBuffers(model.get('buffers') ?? {});
    resize();
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'display:block;width:100%;height:100%';
    canvas.setAttribute('aria-label', 'Margo scientific figure');
    el.replaceChildren(canvas);
    try {
      const backend = model.get('backend') ?? 'auto';
      if (!['auto', 'webgpu', 'webgl2'].includes(String(backend)))
        throw typeError('Notebook backend must be auto, webgpu or webgl2', 'sciviz');
      if (backend === 'webgl2' && !prepareBackend)
        throw fault('unsupported', 'WebGL2 requires prepareBackend; supply an async callback calling the compatibility layer install(options)', 'sciviz');
      if (backend !== 'webgpu') await prepareBackend?.({ force: backend === 'webgl2', signal: controller.signal });
      controller.signal.throwIfAborted();
      const next = await Figure.fromJSON(spec, canvas, { ...load, buffers, signal: controller.signal });
      if (disposed || id !== generation) {
        next.dispose();
        return;
      }
      figure = next;
      if (model.get('camera')) await applyShareView(next, { camera: model.get('camera') as FigureSpec['camera'] });
      controller.signal.throwIfAborted();
      if (model.get('selection') != null) applySelection(next, model.get('selection'));
      const moved = () => publish('camera', camera(next));
      const selected = () => publish('selection', selection(next));
      next.controls?.addEventListener('change', moved);
      next.addEventListener('selection', selected);
      detach = () => {
        next.controls?.removeEventListener('change', moved);
        next.removeEventListener('selection', selected);
      };
      publish('error', '');
      if (!disposed && id === generation)
        el.dispatchEvent(new CustomEvent('margo-notebook-ready', { detail: next, bubbles: true }));
    } catch (error) {
      if (!controller.signal.aborted) {
        if (id === generation) {
          detach();
          figure?.dispose();
          figure = undefined;
        }
        throw error;
      }
    }
  };
  const changed = () => {
    void update().catch(report);
  };
  const selectionChanged = () => {
    try {
      syncSelection();
    } catch (error) {
      report(error);
    }
  };
  const heightChanged = () => {
    try {
      resize();
    } catch (error) {
      report(error);
    }
  };
  const events = {
    'change:spec': changed,
    'change:buffers': changed,
    'change:backend': changed,
    'change:camera': syncCamera,
    'change:selection': selectionChanged,
    'change:height': heightChanged,
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    ++generation;
    active?.abort();
    detach();
    figure?.dispose();
    figure = undefined;
    for (const [name, callback] of Object.entries(events)) model.off(name, callback);
    signal?.removeEventListener('abort', dispose);
    el.replaceChildren();
  };
  for (const [name, callback] of Object.entries(events)) model.on(name, callback);
  signal?.addEventListener('abort', dispose, { once: true });
  try {
    await update();
    return dispose;
  } catch (error) {
    dispose();
    throw error;
  }
}
