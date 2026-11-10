/// <reference lib="esnext.disposable" preserve="true" />
import { fault } from '../../shared/errors.js';
import type { Figure } from './figure.js';
import { RectsLayer } from './rects.js';
import { aggregateRaster } from './aggregate.js';
import { shadeAggregate, type AggregateShadeOptions } from './aggregate-shade.js';
import { CrossFilter } from './table.js';
import type { RasterAggregate, RasterAggregateOptions, RasterBin, RasterTable } from './aggregate-types.js';

/** A live figure raster. Pan/zoom completion re-aggregates the original rows in the new window. */
export interface RasterBindingOptions extends RasterAggregateOptions {
  readonly shade?: AggregateShadeOptions;
  /** Default true. */ readonly interactive?: boolean;
  readonly name?: string;
  /** Show the original bin statistics under the pointer, default true. */ readonly tooltip?: boolean;
}
/** Retained raster trace, latest numerical result and asynchronous refresh boundary. */
export interface RasterBinding {
  readonly result: RasterAggregate | undefined;
  readonly error: unknown;
  readonly layer: RectsLayer | undefined;
  /** Explicit completion/error boundary, also for programmatic Figure.setLimits(). */ refresh(): Promise<void>;
  /** Change colours without reading any table rows. */ shade(options: AggregateShadeOptions): void;
  /** Physical-coordinate hover with the original statistics, unaffected by spreading. */ at(
    x: number,
    y: number,
  ): RasterBin | undefined;
  dispose(): void;
  [Symbol.dispose](): void;
}

/** Aggregate and attach a live 2D raster with view updates and original-statistic tooltips. */
export async function bindRasterAggregate(
  figure: Figure,
  table: RasterTable,
  options: RasterBindingOptions,
): Promise<RasterBinding> {
  if (!figure.is2d) throw fault('unsupported', 'Raster aggregation requires a 2D figure', 'sciviz');
  let result: RasterAggregate | undefined,
    layer: RectsLayer | undefined,
    error: unknown,
    disposed = false,
    generation = 0,
    shades = options.shade;
  const canvas = (figure.engine as unknown as { canvas: HTMLCanvasElement }).canvas;
  const lifetime = new AbortController();
  const tooltip = options.tooltip === false ? undefined : document.createElement('div');
  if (tooltip) {
    tooltip.setAttribute('role', 'status');
    tooltip.style.cssText =
      'position:fixed;display:none;pointer-events:none;z-index:10000;padding:8px 12px;border-radius:4px;background:#18232c;color:white;font:12px/1.6 system-ui;white-space:pre';
    document.body.append(tooltip);
  }
  let current: AbortController | undefined;
  function draw(): void {
    if (!result || disposed) return;
    const pixels = shadeAggregate(result, shades),
      rects: number[] = [],
      values: number[] = [],
      colours: number[] = [],
      [x0, x1, y0, y1] = result.bounds;
    for (let b = 0; b < pixels.length; b++)
      if (pixels[b]) {
        const x = b % result.width,
          y = Math.floor(b / result.width);
        rects.push(
          x0 + (x / result.width) * (x1 - x0),
          y0 + (y / result.height) * (y1 - y0),
          x0 + ((x + 1) / result.width) * (x1 - x0),
          y0 + ((y + 1) / result.height) * (y1 - y0),
        );
        values.push(result.count[b]);
        colours.push(pixels[b]);
      }
    const next = new RectsLayer(
      figure.renderer,
      'heatmap',
      Float32Array.from(rects),
      Float32Array.from(values),
      Uint32Array.from(colours),
      { name: options.name, swatch: '#dd9028' },
    );
    figure.addChartLayer(next);
    if (layer) figure.remove(layer);
    layer = next;
    figure.render();
  }
  const refresh = async () => {
    if (disposed) throw fault('disposed', 'Raster binding is disposed', 'sciviz');
    const version = ++generation;
    current?.abort();
    current = new AbortController();
    const signal = AbortSignal.any([lifetime.signal, current.signal, ...(options.signal ? [options.signal] : [])]);
    const bounds = figure.bounds.slice(0, 4) as [number, number, number, number];
    try {
      const next = await aggregateRaster(table, { ...options, bounds, signal });
      if (version !== generation || disposed) return;
      result = next;
      error = undefined;
      draw();
    } catch (cause) {
      if (version === generation && !disposed) {
        error = cause;
        throw cause;
      }
    }
  };
  const changed = () => {
    void refresh().catch((cause: unknown) => {
      error = cause;
    });
  };
  const hover = (event: PointerEvent) => {
    if (!tooltip || !result) return;
    const rect = canvas.getBoundingClientRect(),
      area = figure.plotArea;
    const u = (event.clientX - rect.left - area.x) / area.width,
      v = 1 - (event.clientY - rect.top - area.y) / area.height;
    if (u < 0 || u > 1 || v < 0 || v > 1) {
      tooltip.style.display = 'none';
      return;
    }
    const [x0, x1, y0, y1] = result.bounds,
      bin = result.at(x0 + u * (x1 - x0), y0 + v * (y1 - y0));
    if (!bin) {
      tooltip.style.display = 'none';
      return;
    }
    tooltip.textContent =
      `Rows ${bin.count}  Valid ${bin.valid}\nSum ${bin.sum}  Mean ${bin.mean}\nMin ${bin.min}  Max ${bin.max}\nFirst ${bin.first} (row ${bin.firstRow ?? '-'})  Last ${bin.last} (row ${bin.lastRow ?? '-'})` +
      Object.entries(bin.categories)
        .map(([key, count]) => `\n${key}: ${count}`)
        .join('');
    tooltip.style.display = 'block';
    tooltip.style.left = `${Math.min(event.clientX + 12, innerWidth - tooltip.offsetWidth - 8)}px`;
    tooltip.style.top = `${Math.min(event.clientY + 12, innerHeight - tooltip.offsetHeight - 8)}px`;
  };
  const leave = () => {
    if (tooltip) tooltip.style.display = 'none';
  };
  const abort = () => dispose();
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    generation++;
    lifetime.abort();
    canvas.removeEventListener('wheel', changed);
    canvas.removeEventListener('pointerup', changed);
    canvas.removeEventListener('pointermove', hover);
    canvas.removeEventListener('pointerleave', leave);
    tooltip?.remove();
    if (table instanceof CrossFilter) table.removeEventListener('change', changed);
    options.signal?.removeEventListener('abort', abort);
    if (layer) figure.remove(layer);
    layer = undefined;
  };
  const binding: RasterBinding = {
    get result() {
      return result;
    },
    get error() {
      return error;
    },
    get layer() {
      return layer;
    },
    refresh,
    shade(next) {
      if (disposed) throw fault('disposed', 'Raster binding is disposed', 'sciviz');
      shades = next;
      draw();
    },
    at(x, y) {
      return result?.at(x, y);
    },
    dispose,
    [Symbol.dispose]: dispose,
  };
  try {
    figure.setLimits(options.bounds);
    await refresh();
    options.signal?.throwIfAborted();
    if (options.interactive ?? true) {
      canvas.addEventListener('wheel', changed, { passive: true });
      canvas.addEventListener('pointerup', changed);
    }
    canvas.addEventListener('pointermove', hover, { passive: true });
    canvas.addEventListener('pointerleave', leave);
    if (table instanceof CrossFilter) table.addEventListener('change', changed);
    options.signal?.addEventListener('abort', abort, { once: true });
    return binding;
  } catch (cause) {
    dispose();
    throw cause;
  }
}
