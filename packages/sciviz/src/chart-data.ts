// Internal handshake between optional chart controllers and live data; no optional entry imports another entry.
import type { Figure, LineLayer, ScatterLayer } from './figure.js';
import type { LiveData } from './stream.js';
/** @internal Raw-data mapping owned by a chart controller. */
export interface ChartDataAdapter {
  read(layer: LineLayer | ScatterLayer): LiveData | undefined;
  update(layer: LineLayer | ScatterLayer, data: LiveData, signal?: AbortSignal): Promise<void>;
  forwardX(value: number): number;
  inverseX(value: number): number;
}
/** @internal Weak keys avoid extending Figure lifetime or adding import-time listeners. */
export const chartDataAdapters = new WeakMap<Figure, ChartDataAdapter>();
