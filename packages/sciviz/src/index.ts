/// <reference lib="esnext.disposable" preserve="true" />
// @margoengine/sciviz: scientific visualisation for Margo Engine. Optional and tree-shakable; adds nothing to core.
// The points, lines, labels, controls and compute packages load with import() only when a figure uses them.
export { Figure, createFigure } from './figure.js';
export type {
  BarLayerOptions,
  CreateFigureOptions,
  FieldData,
  FieldStyleOptions,
  QuiverLayerOptions,
  StreamlinesLayerOptions,
  HeatmapLayerOptions,
  HistogramLayerOptions,
  Margin,
  FigureEventMap,
  FigureOptions,
  Layer,
  LineLayer,
  LineLayerOptions,
  PickResult,
  ScatterData,
  ScatterLayer,
  ScatterLayerOptions,
  PointSelection,
} from './figure.js';
export { RectsLayer } from './rects.js';
export { Legend } from './legend.js';
export type { LegendEntry, LegendPosition } from './legend.js';
export type { ScaleType } from './scales.js';
export type { PNGOptions, SVGOptions } from './export.js';
export { histogram } from './charts.js';
export type { Bins, BinOptions } from './charts.js';
export { SurfaceLayer } from './surface.js';
export type { SurfaceLayerOptions } from './surface.js';
export { VolumeLayer, SliceLayer, transferTable } from './volume.js';
export type { ClipPlane, VolumeLayerOptions } from './volume.js';
export { IsosurfaceLayer } from './isosurface.js';
export type { IsosurfaceLayerOptions } from './isosurface.js';
export { ColorBar } from './colorbar.js';
export type { ColorBarOptions } from './colorbar.js';
export { THEMES } from './axes.js';
export type { AxesOptions, Theme } from './axes.js';
export { SciRenderer } from './render.js';
export { dataToScene } from './layer.js';
export type { Bounds, ColormapSource, DataSource } from './layer.js';
export { Colormap, colormap, colormapNames, cubehelix, describeColormap, diverging } from './colormaps.js';
export type { ColormapKind, ColormapName, SRGB } from './colormaps.js';
export { ticks, formatTick, formatValue, niceNumber } from './ticks.js';
export type { DragMode } from './interact.js';
export type { SelectRegion } from './pick.js';
export type { Ticks } from './ticks.js';
