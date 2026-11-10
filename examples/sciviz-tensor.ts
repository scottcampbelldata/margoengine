import { Figure } from '@margoengine/sciviz';
import { parseNIfTI } from '@margoengine/sciviz/formats';
import {
  fitDiffusionTensor,
  tensorGlyphs,
  trackTensorFibers,
  hyperstreamlines,
  type DiffusionFit,
  type TensorField,
  type TensorGlyphLayer,
} from '@margoengine/sciviz/tensor';
import { meshLayer } from '@margoengine/sciviz/grids';
import { element } from './sciviz-demo.js';

export const figures: Record<string, Figure> = {};
export const glyphs: Record<string, TensorGlyphLayer> = {};
export let fit: DiffusionFit;
export let field: TensorField;
export let fiberCounts: readonly number[];
const signal = AbortSignal.timeout(180000),
  root = new URL('../packages/sciviz/tests/fixtures/tensor/source.json', import.meta.url);
try {
  const [bytes, bval, bvec] = await Promise.all([
      fetch(new URL('dwi-crop.nii.gz', root), { signal }).then((r) => r.arrayBuffer()),
      fetch(new URL('dwi.bval', root), { signal }).then((r) => r.text()),
      fetch(new URL('dwi.bvec', root), { signal }).then((r) => r.text()),
    ]),
    image = await parseNIfTI(bytes, { signal }),
    bValues = bval.trim().split(/\s+/).map(Number),
    rows = bvec
      .trim()
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/).map(Number)),
    gradients = bValues.flatMap((_, i) => rows.map((row) => row[i]));
  fit = await fitDiffusionTensor({ signals: image.all, voxels: image.data.length, bValues, gradients }, { signal });
  const mask = Uint8Array.from(fit.valid, (v, i) => (v && !fit.nonPositive[i] ? 1 : 0));
  const spans = image.dims.map((n, k) => n * image.spacing[k]),
    aspect = spans.map((n) => n / Math.max(...spans)) as [number, number, number],
    voxelSize = Math.min(...image.spacing);
  field = {
    dims: image.dims,
    bounds: [0, spans[0], 0, spans[1], 0, spans[2]],
    tensors: fit.tensors,
    mask,
  };
  const glyphMask = Uint8Array.from(mask, (valid, i) =>
    valid &&
    (i % image.dims[0]) % 2 === 0 &&
    (Math.floor(i / image.dims[0]) % image.dims[1]) % 2 === 0 &&
    Math.floor(i / image.dims[0] / image.dims[1]) % 2 === 0
      ? 1
      : 0,
  );
  for (const shape of ['ellipsoid', 'superquadric'] as const) {
    const figure = (figures[shape] = await Figure.create(element<HTMLCanvasElement>(shape), {
      axes: false,
      controls: false,
      aspect,
      limits: field.bounds,
    }));
    glyphs[shape] = await tensorGlyphs(
      figure,
      { ...field, mask: glyphMask },
      {
        shape,
        size: 0.45 * voxelSize,
        color: shape === 'ellipsoid' ? 'fa' : 'direction-fa',
        signal,
      },
    );
    await figure.ready();
    figure.engine.render();
    figure.engine.stop();
  }
  const seeds: number[] = [];
  for (let y = 6; y < 28; y += 4)
    for (let x = 6; x < 28; x += 4)
      seeds.push((x + 0.5) * image.spacing[0], (y + 0.5) * image.spacing[1], 4.5 * image.spacing[2]);
  const euler = await trackTensorFibers(field, seeds, { method: 'euler', maxLength: 50, signal }),
    fact = await trackTensorFibers(field, seeds, { method: 'fact', maxLength: 50, signal }),
    hyper = await hyperstreamlines(field, seeds, { method: 'fact', radius: 0.35 * voxelSize, maxLength: 50, signal });
  fiberCounts = [euler.length, fact.length, hyper.fibers.length];
  const tracked = (figures.tracking = await Figure.create(element<HTMLCanvasElement>('tracking'), {
    axes: false,
    controls: false,
    aspect,
    limits: field.bounds,
  }));
  if (hyper.triangles.cells.length) meshLayer(tracked, hyper.triangles, { range: [0, 1], colormap: 'viridis' });
  for (const [paths, color] of [
    [euler, '#35c6d5'],
    [fact, '#f8a34e'],
  ] as const)
    for (const fiber of paths) {
      const n = fiber.positions.length / 3;
      await tracked.line(
        {
          x: Float64Array.from({ length: n }, (_, i) => fiber.positions[i * 3]),
          y: Float64Array.from({ length: n }, (_, i) => fiber.positions[i * 3 + 1]),
          z: Float64Array.from({ length: n }, (_, i) => fiber.positions[i * 3 + 2]),
        },
        { width: 1, color },
      );
    }
  await tracked.ready();
  tracked.engine.render();
  tracked.engine.stop();
  element('status').textContent =
    `Ready. Ordinary linear least squares, ${image.frames} measurements, ${image.data.length} voxels. ${euler.length} Euler and ${fact.length} FACT fibres.`;
  element<HTMLCanvasElement>('ellipsoid').dataset.ready = 'true';
} catch (error) {
  element<HTMLCanvasElement>('ellipsoid').dataset.error = String(error);
  throw error;
}
window.addEventListener(
  'pagehide',
  () => {
    for (const f of Object.values(figures)) f.dispose();
  },
  { once: true },
);
