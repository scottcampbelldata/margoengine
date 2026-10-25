// The browser side of the margoengine Python package. It turns a plot specification (written by margoengine's
// Figure: layers whose arrays arrive as binary buffers) into a @margoengine/sciviz figure. Used two ways:
// - by the JupyterLab widget (see `extension`, loaded through remoteEntry.js), with buffers from the widget protocol;
// - by `Figure.save_html`, with buffers base64-encoded in the page (see `renderPayload`).
import { OrbitControls } from '@margoengine/controls/orbit';
import { Figure, type ColormapSource, type Layer } from '@margoengine/sciviz';

type V3 = [number, number, number];

/** The view's camera in scene units (the plot box spans about -1 to 1): the widget's `camera` attribute. */
export interface CameraState {
  position?: V3;
  target?: V3;
  up?: V3;
  fov?: number;
}

// The orbit controls of each figure built here (Figure.create's own controls are not reachable, so they are made here).
const orbits = new WeakMap<Figure, OrbitControls>();

/** The figure's camera now. */
export function readCamera(figure: Figure): Required<CameraState> {
  const c = figure.engine.camera;
  const v = (a: readonly number[]): V3 => [a[0], a[1], a[2]];
  return { position: v(c.position), target: v(c.target), up: v(c.up), fov: c.fov };
}

/** Moves the figure's camera to the given parts of `state` (the others stay). */
export function applyCamera(figure: Figure, state: CameraState | null | undefined): void {
  if (!state) return;
  const c = figure.engine.camera;
  if (state.position) c.position = [...state.position];
  if (state.target) c.target = [...state.target];
  if (state.up) c.up = [...state.up];
  if (state.fov !== undefined) c.fov = state.fov;
}

/** True when `state` already matches the figure's camera in every part it gives. */
export function sameCamera(figure: Figure, state: CameraState | null | undefined): boolean {
  if (!state) return true;
  const now = readCamera(figure);
  const close = (a: readonly number[], b: readonly number[]) => a.every((x, k) => Math.abs(x - b[k]) <= 1e-9);
  return (
    (!state.position || close(state.position, now.position)) &&
    (!state.target || close(state.target, now.target)) &&
    (!state.up || close(state.up, now.up)) &&
    (state.fov === undefined || Math.abs(state.fov - now.fov) <= 1e-9)
  );
}

/** The orbit controls of a figure from {@link buildFigure}. */
export function orbitOf(figure: Figure): OrbitControls | undefined {
  return orbits.get(figure);
}

/** An array descriptor; `buffer` holds the float32 bytes once restored from the message or the page. */
interface ArraySpec {
  dtype: 'float32';
  shape: number[];
  buffer?: DataView | ArrayBuffer | Uint8Array;
}

interface LayerSpec {
  type: 'scatter' | 'line' | 'surface' | 'volume' | 'isosurface';
  [key: string]: unknown;
}

/** The plot specification. */
export interface PlotSpec {
  version: 1;
  theme: 'dark' | 'light';
  height: number;
  aspect: [number, number, number];
  titles: { x?: string; y?: string; z?: string };
  axes: boolean;
  pointBudget: number;
  layers: LayerSpec[];
  colorbars: { colormap: ColormapSource; range: [number, number]; label?: string }[];
}

/** Float32 values of an array descriptor (copied, so any byte alignment works). */
export function floats(spec: ArraySpec | undefined): Float32Array | undefined {
  if (!spec) return undefined;
  const b = spec.buffer;
  if (!b) throw new TypeError(`Array of shape [${spec.shape}] arrived without its bytes; see https://margoengine.com/errors#sciviz`);
  const bytes = b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  const out = new Float32Array(bytes.byteLength / 4);
  new Uint8Array(out.buffer).set(bytes);
  return out;
}

/**
 * Builds the figure for `spec` in `host` (which gets a canvas), with orbit controls and the camera at `camera` when
 * given. Resolves the figure; dispose it to tear down.
 */
export async function buildFigure(host: HTMLElement, spec: PlotSpec, camera?: CameraState | null): Promise<Figure> {
  if (spec?.version !== 1) throw new TypeError('This plot needs a newer @margoengine/jupyter; update the margoengine package');
  host.replaceChildren();
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'display:block;width:100%;height:100%';
  canvas.setAttribute('aria-label', 'Margo figure');
  host.append(canvas);
  if (!(await navigator.gpu?.requestAdapter())) {
    host.textContent = 'This figure needs a browser with WebGPU: Chrome, Edge or Safari (margoengine.com/webgpu.html).';
    throw new Error('WebGPU unavailable');
  }
  const figure = await Figure.create(canvas, {
    theme: spec.theme,
    aspect: spec.aspect,
    titles: spec.titles,
    axes: spec.axes,
    pointBudget: spec.pointBudget,
    controls: false,
  });
  // The same orbit controls Figure.create would attach, kept here so the widget can follow and set the camera.
  const orbit = OrbitControls.attach(figure.engine);
  orbit.enableDamping = true;
  orbit.minDistance = 0.5;
  orbit.maxDistance = 20;
  orbits.set(figure, orbit);
  applyCamera(figure, camera);
  const added: Promise<Layer | undefined>[] = spec.layers.map(async (layer) => {
    const a = (key: string) => floats(layer[key] as ArraySpec | undefined);
    switch (layer.type) {
      case 'scatter':
        return figure.scatter(
          { x: a('x')!, y: a('y')!, z: a('z'), color: a('color'), size: a('size') },
          { colormap: layer.colormap as ColormapSource, range: layer.range as [number, number], size: layer.pointSize as number | undefined, edl: !!layer.edl },
        );
      case 'line':
        return figure.line({ x: a('x')!, y: a('y')!, z: a('z'), color: a('color') }, { colormap: layer.colormap as ColormapSource, range: layer.range as [number, number], width: layer.width as number });
      case 'surface': {
        const z = layer.z as ArraySpec;
        return figure.surface(a('z')!, {
          nx: z.shape[1],
          ny: z.shape[0],
          x: layer.x as [number, number],
          y: layer.y as [number, number],
          colormap: layer.colormap as ColormapSource,
          range: layer.range as [number, number],
          contours: layer.contours as number,
        });
      }
      case 'volume':
        return figure.volume(a('values')!, {
          dims: layer.dims as [number, number, number],
          bounds: layer.bounds as [number, number, number, number, number, number] | undefined,
          colormap: layer.colormap as ColormapSource,
          range: layer.range as [number, number],
          opacity: layer.opacity as [number, number][] | undefined,
          density: layer.density as number,
          mode: layer.mode as 'composite' | 'mip',
        });
      case 'isosurface':
        return figure.isosurface(a('values')!, layer.level as number, {
          dims: layer.dims as [number, number, number],
          bounds: layer.bounds as [number, number, number, number, number, number] | undefined,
          color: layer.color as string | undefined,
        });
      default:
        console.warn(`margoengine: unknown layer type ${String(layer.type)}`);
        return undefined;
    }
  });
  await Promise.all(added);
  for (const bar of spec.colorbars) figure.colorbar(bar.colormap, bar.range, { label: bar.label });
  return figure;
}

/** Puts buffers back into a specification at their paths (the widget protocol's buffer_paths). */
export function restoreBuffers<T>(state: T, paths: (string | number)[][], buffers: (DataView | ArrayBuffer | Uint8Array)[]): T {
  paths.forEach((path, k) => {
    let target = state as Record<string | number, unknown>;
    for (const key of path.slice(0, -1)) target = target[key] as Record<string | number, unknown>;
    target[path[path.length - 1]] = buffers[k];
  });
  return state;
}

/** Renders a `save_html` payload (`{ spec, bufferPaths, buffers, camera }` with base64 buffers) into `host`. */
export function renderPayload(
  host: HTMLElement,
  payload: { spec: PlotSpec; bufferPaths: (string | number)[][]; buffers: string[]; camera?: CameraState | null },
): Promise<Figure> {
  const buffers = payload.buffers.map((b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
  return buildFigure(host, restoreBuffers(payload.spec, payload.bufferPaths, buffers), payload.camera);
}

/** Disposes a figure from {@link buildFigure} with its orbit controls. */
export function disposeFigure(figure: Figure | undefined): void {
  if (!figure) return;
  orbits.get(figure)?.dispose();
  orbits.delete(figure);
  figure.dispose();
}

/** The minimal surface of `@jupyter-widgets/base` this widget uses (from the host's widget manager at runtime). */
export interface WidgetsBase {
  DOMWidgetModel: unknown;
  DOMWidgetView: unknown;
  IJupyterWidgetRegistry?: unknown;
}

/** The synced model as the view sees it (a Backbone model of the widget manager). */
interface ModelLike {
  get(name: string): unknown;
  set(name: string, value: unknown): void;
  save_changes(): void;
  on(event: string, callback: () => void, context?: unknown): void;
}

/** How often, at most, the view reports camera moves to the kernel (milliseconds). */
const CAMERA_REPORT_MS = 100;

/**
 * The widget classes, MargoFigureModel and MargoFigureView, extending the widget manager's own base classes (`base`).
 * Used by the JupyterLab extension and by the classic AMD module that VS Code loads.
 */
export function widgetClasses(base: WidgetsBase) {
  const Model = base.DOMWidgetModel as unknown as new (...args: unknown[]) => { defaults(): Record<string, unknown> };
  class MargoFigureModel extends Model {
    override defaults(): Record<string, unknown> {
      return {
        ...super.defaults(),
        _model_name: 'MargoFigureModel',
        _model_module: '@margoengine/jupyter',
        _model_module_version: '^1.0.0',
        _view_name: 'MargoFigureView',
        _view_module: '@margoengine/jupyter',
        _view_module_version: '^1.0.0',
        spec: null,
        camera: null,
      };
    }
  }
  const View = base.DOMWidgetView as unknown as new (...args: unknown[]) => {
    el: HTMLElement;
    model: ModelLike;
    remove(): void;
  };
  class MargoFigureView extends View {
    #figure: Promise<Figure | undefined> | undefined;
    #report: ReturnType<typeof setTimeout> | undefined;
    render(): void {
      this.#draw();
      this.model.on('change:spec', () => this.#draw(), this);
      // The kernel moved the camera (fig.camera = ...): follow, unless this view is already there.
      this.model.on(
        'change:camera',
        () =>
          void this.#figure?.then((figure) => {
            const camera = this.model.get('camera') as CameraState | null;
            if (figure && !sameCamera(figure, camera)) applyCamera(figure, camera);
          }),
        this,
      );
    }
    #draw(): void {
      const spec = this.model.get('spec') as PlotSpec;
      this.el.style.cssText = `position:relative;width:100%;height:${spec?.height ?? 480}px`;
      const previous = this.#figure;
      // Buffers arrive as DataViews at their paths: the widget manager has already restored them. A rebuilt figure
      // keeps the model's camera.
      this.#figure = (async () => {
        disposeFigure(await previous);
        const figure = await buildFigure(this.el, spec, this.model.get('camera') as CameraState | null).catch((error: Error) => {
          if (error.message !== 'WebGPU unavailable') this.el.textContent = `Margo figure failed: ${error.message}`;
          return undefined;
        });
        if (figure) {
          const orbit = orbitOf(figure)!;
          orbit.addEventListener('change', () => this.#schedule(figure));
          orbit.addEventListener('end', () => this.#schedule(figure));
          this.#schedule(figure);
        }
        return figure;
      })();
    }
    // Reports the camera at most every CAMERA_REPORT_MS while it moves; the last report is taken after the last move.
    #schedule(figure: Figure): void {
      if (this.#report !== undefined) return;
      this.#report = setTimeout(() => {
        this.#report = undefined;
        // Nothing to report when the model already holds this whole camera (a partial one set by the kernel is
        // completed with the parts it left out).
        const known = this.model.get('camera') as CameraState | null;
        const whole = !!known?.position && !!known.target && !!known.up && known.fov !== undefined;
        if (whole && sameCamera(figure, known)) return;
        this.model.set('camera', readCamera(figure));
        this.model.save_changes();
      }, CAMERA_REPORT_MS);
    }
    override remove(): void {
      clearTimeout(this.#report);
      void this.#figure?.then(disposeFigure);
      super.remove();
    }
  }
  return { MargoFigureModel, MargoFigureView };
}

/**
 * The JupyterLab plugin: registers MargoFigureModel and MargoFigureView under `@margoengine/jupyter` with the widget
 * manager.
 */
export function extension(base: WidgetsBase) {
  const exports = widgetClasses(base);
  return {
    id: '@margoengine/jupyter:plugin',
    autoStart: true,
    requires: [base.IJupyterWidgetRegistry],
    activate(_app: unknown, registry: { registerWidget(widget: { name: string; version: string; exports: Record<string, unknown> }): void }) {
      registry.registerWidget({ name: '@margoengine/jupyter', version: '1.0.0', exports });
    },
  };
}
