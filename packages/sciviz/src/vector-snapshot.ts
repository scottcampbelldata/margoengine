import { LinearToSRGB, SRGBToLinear } from '@margoengine/math/color';
import { fault } from '../../shared/errors.js';
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
  if (points)
    return {
      kind: 'points',
      positions,
      colors,
      visible: points.visible,
      width: points.material.size,
      shape: points.material.shape,
      sizes: Float32Array.from({ length: count }, (_, i) =>
        Math.min(
          points.material.maxPixelSize,
          Math.max(points.material.minPixelSize, points.material.size * (points.sizes?.[i] ?? 1)),
        ),
      ),
    };
  return {
    kind: 'line',
    positions,
    colors,
    width: line!.material.width,
    visible: line!.visible,
    segments: line!.mode === 'segments',
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
    const c = Number.isFinite(values[i]) ? map.sample((values[i] - range[0]) / (range[1] - range[0] || 1)) : missing;
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
