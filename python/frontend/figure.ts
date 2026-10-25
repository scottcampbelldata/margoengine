// The browser side of the margoengine Python package. It turns a plot specification (written by margoengine's
// Figure: layers whose arrays arrive as binary buffers) into a @margoengine/sciviz figure. Used two ways:
// - by the JupyterLab widget (see `extension`, loaded through remoteEntry.js), with buffers from the widget protocol;
// - by `Figure.save_html`, with buffers base64-encoded in the page (see `renderPayload`).
import { Figure, type ColormapSource, type Layer } from '@margoengine/sciviz';

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

/** Builds the figure for `spec` in `host` (which gets a canvas). Resolves the figure; dispose it to tear down. */
export async function buildFigure(host: HTMLElement, spec: PlotSpec): Promise<Figure> {
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
  });
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

/** Renders a `save_html` payload (`{ spec, bufferPaths, buffers }` with base64 buffers) into `host`. */
export function renderPayload(host: HTMLElement, payload: { spec: PlotSpec; bufferPaths: (string | number)[][]; buffers: string[] }): Promise<Figure> {
  const buffers = payload.buffers.map((b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
  return buildFigure(host, restoreBuffers(payload.spec, payload.bufferPaths, buffers));
}

/** The minimal surface of `@jupyter-widgets/base` this widget uses (taken from JupyterLab's shared scope at runtime). */
interface WidgetsBase {
  DOMWidgetModel: unknown;
  DOMWidgetView: unknown;
  IJupyterWidgetRegistry: unknown;
}

/**
 * The JupyterLab plugin: registers MargoFigureModel and MargoFigureView under `@margoengine/jupyter` with the widget
 * manager. The widget classes extend the manager's own base classes, passed in as `base`.
 */
export function extension(base: WidgetsBase) {
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
      };
    }
  }
  const View = base.DOMWidgetView as unknown as new (...args: unknown[]) => {
    el: HTMLElement;
    model: { get(name: string): unknown; on(event: string, callback: () => void, context?: unknown): void };
    remove(): void;
  };
  class MargoFigureView extends View {
    #figure: Promise<Figure | undefined> | undefined;
    render(): void {
      this.#draw();
      this.model.on('change:spec', () => this.#draw(), this);
    }
    #draw(): void {
      const spec = this.model.get('spec') as PlotSpec;
      this.el.style.cssText = `position:relative;width:100%;height:${spec?.height ?? 480}px`;
      const previous = this.#figure;
      // Buffers arrive as DataViews at their paths: the widget manager has already restored them.
      this.#figure = (async () => {
        (await previous)?.dispose();
        return buildFigure(this.el, spec).catch((error: Error) => {
          if (error.message !== 'WebGPU unavailable') this.el.textContent = `Margo figure failed: ${error.message}`;
          return undefined;
        });
      })();
    }
    override remove(): void {
      void this.#figure?.then((figure) => figure?.dispose());
      super.remove();
    }
  }
  return {
    id: '@margoengine/jupyter:plugin',
    autoStart: true,
    requires: [base.IJupyterWidgetRegistry],
    activate(_app: unknown, registry: { registerWidget(widget: { name: string; version: string; exports: Record<string, unknown> }): void }) {
      registry.registerWidget({ name: '@margoengine/jupyter', version: '1.0.0', exports: { MargoFigureModel, MargoFigureView } });
    },
  };
}
