import { LinearToSRGB, SRGBToLinear } from '@margoengine/math/color';
import { fault } from '../../shared/errors.js';
import { maskColor } from '../../shared/selection-mask.js';
import type { Colormap } from './colormaps.js';
import type { VectorGeometry } from './vector-types.js';
import type { LineLayer, ScatterLayer } from './figure.js';
import type { Line } from '@margoengine/lines';

/** @internal Live series snapshot, including point reorder, colour encoding, alpha and per-point sizes. */
export function seriesSnapshot(layer: LineLayer | ScatterLayer | Line): VectorGeometry & { visible: boolean } {
  const points = 'kind' in layer && layer.kind === 'scatter' ? layer.cloud : undefined,
    line = 'kind' in layer ? (layer.kind === 'line' ? layer.line : undefined) : layer,
    material = points?.material ?? line!.material,
    count = points?.count ?? line!.count,
    positions = points
      ? points.positions.slice()
      : Float32Array.from({ length: count * 3 }, (_, i) => line!.points[Math.floor(i / 3) * 4 + (i % 3)]),
    colors = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    for (let k = 0; k < 4; k++) {
      let value = 1;
      if (points?.colors) {
        value =
          points.colorFormat === 'float'
            ? points.floatColors![i * 4 + k]
            : ((points.colors[i] >>> (k * 8)) & 255) / 255;
        if (k < 3 && points.colorSpace === 'srgb') value = SRGBToLinear(value);
      } else if (line?.colors && line.material.vertexColors !== false) value = line.colors[i * 4 + k];
      colors[i * 4 + k] =
        k < 3 ? Math.max(0, Math.min(1, LinearToSRGB(value * material.color[k]))) : value * material.opacity;
    }
  }
  const mask = (points ?? line!).mask;
  if (points) {
    const sizes = Float32Array.from({ length: count }, (_, i) =>
      Math.min(
        points.material.maxPixelSize,
        Math.max(points.material.minPixelSize, points.material.size * (points.sizes?.[i] ?? 1)),
      ),
    );
    const snapshot = {
      kind: 'points' as const,
      positions,
      colors,
      visible: points.visible,
      width: points.material.size,
      shape: points.material.shape,
      sizes,
    };
    if (!mask) return snapshot;
    // The selection mask as the point shader applies it: filtered points leave, the rest fade or highlight.
    const kept: number[] = [];
    for (let i = 0; i < count; i++) {
      const shown = maskColor(mask, colors.subarray(i * 4, i * 4 + 3), i);
      if (!shown) continue;
      colors.set(shown, i * 4);
      kept.push(i);
    }
    const pick = <T extends Float32Array>(a: T, n: number): T =>
      Float32Array.from({ length: kept.length * n }, (_, k) => a[kept[Math.floor(k / n)] * n + (k % n)]) as T;
    return { ...snapshot, positions: pick(positions, 3), colors: pick(colors, 4), sizes: pick(sizes, 1) };
  }
  const segments = line!.mode === 'segments';
  if (!mask) return { kind: 'line', positions, colors, width: line!.material.width, visible: line!.visible, segments };
  // A masked line becomes segments, each selected when both ends are, as the line shader draws it.
  const pairs: number[] = [];
  for (let i = 0; i + 1 < count; i += segments ? 2 : 1) pairs.push(i, i + 1);
  const outPositions: number[] = [],
    outColors: number[] = [];
  for (let k = 0; k < pairs.length; k += 2) {
    const ends = pairs
      .slice(k, k + 2)
      .map((i) => maskColor(mask, colors.subarray(i * 4, i * 4 + 3), pairs[k], pairs[k + 1]));
    if (!ends[0] || !ends[1]) continue;
    for (let e = 0; e < 2; e++) {
      const i = pairs[k + e];
      outPositions.push(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
      outColors.push(...ends[e]!, colors[i * 4 + 3]);
    }
  }
  return {
    kind: 'line',
    positions: Float32Array.from(outPositions),
    colors: Float32Array.from(outColors),
    width: line!.material.width,
    visible: line!.visible,
    segments: true,
  };
}

/** @internal Owned scalar-coloured mesh snapshot. */
export function scalarMesh(
  positions: ArrayLike<number>,
  values: ArrayLike<number>,
  map: Colormap,
  range: readonly [number, number],
  opacity: number,
  missing: readonly number[] = [0.6, 0.65, 0.7],
): VectorGeometry {
  const colors = new Float32Array((positions.length / 3) * 4);
  for (let i = 0; i < values.length; i++) {
    const c =
      map.encoding || Number.isFinite(values[i])
        ? map.sample((values[i] - range[0]) / (range[1] - range[0] || 1))
        : missing;
    colors.set([c[0], c[1], c[2], opacity], i * 4);
  }
  return { kind: 'triangles', positions: Float32Array.from(positions), colors };
}

/** @internal Read the exact committed GPU triangle buffer, with abort and owned cleanup. */
export async function isoSnapshot(
  device: GPUDevice,
  buffer: GPUBuffer | undefined,
  triangles: number,
  bounds: readonly number[],
  colour: readonly number[],
  signal?: AbortSignal,
): Promise<VectorGeometry> {
  signal?.throwIfAborted();
  if (!triangles) return { kind: 'triangles', positions: new Float32Array() };
  if (!buffer) throw fault('state', 'Isosurface has no committed GPU data; await its update before export', 'sciviz');
  const staging = device.createBuffer({ size: triangles * 96, usage: 9 });
  try {
    const encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(buffer, 0, staging, 0, triangles * 96);
    device.queue.submit([encoder.finish()]);
    await staging.mapAsync(1);
    signal?.throwIfAborted();
    const source = new Float32Array(staging.getMappedRange()),
      positions = new Float32Array(triangles * 9),
      colors = new Float32Array(triangles * 12);
    const c = colour.map(LinearToSRGB);
    for (let i = 0; i < triangles * 3; i++) {
      for (let k = 0; k < 3; k++)
        positions[i * 3 + k] = bounds[k * 2] + source[i * 8 + k] * (bounds[k * 2 + 1] - bounds[k * 2]);
      colors.set([c[0], c[1], c[2], 1], i * 4);
    }
    return { kind: 'triangles', positions, colors };
  } finally {
    staging.destroy();
  }
}
