import { Figure } from '@margoengine/sciviz';
import {
  createAMR,
  readAMReX,
  amrVolume,
  sliceAMR,
  contourAMR,
  amrLevelOutlines,
  type AMRBlock,
  type AMRData,
  type AMRVolume,
} from '@margoengine/sciviz/amr';
import { meshLayer } from '@margoengine/sciviz/grids';
import { element } from './sciviz-demo.js';

export const figures: Record<string, Figure> = {};
export let volume: AMRVolume;
export let native: AMRData;
export let licensed: AMRData;
const signal = AbortSignal.timeout(180000),
  root = new URL('../packages/sciviz/tests/fixtures/amr/expected.json', import.meta.url);
try {
  const manifest = await (await fetch(new URL('osc-cylinder/source.json', root), { signal })).json();
  const blocks: AMRBlock[] = await Promise.all(
    manifest.blocks.map(
      async (b: { file: string; level: number; dims: AMRBlock['dims']; bounds: AMRBlock['bounds'] }) => {
        const response = await fetch(new URL('osc-cylinder/' + b.file, root), { signal });
        if (!response.ok) throw new Error('AMR block fetch failed');
        const payload = await response.arrayBuffer(),
          magic = new Uint8Array(payload);
        const bytes =
          magic[0] === 31 && magic[1] === 139
            ? await new Response(
                new Blob([payload]).stream().pipeThrough(new DecompressionStream('gzip')),
              ).arrayBuffer()
            : payload;
        return { ...b, values: new Float64Array(bytes) };
      },
    ),
  );
  licensed = createAMR(blocks, { signal });
  const direct = (figures.volume = await Figure.create(element<HTMLCanvasElement>('volume'), {
    axes: false,
    controls: false,
  }));
  volume = amrVolume(direct, licensed, {
    range: [-1.5, 1.5],
    colormap: 'coolwarm',
    opacity: [
      [0, 0.04],
      [0.4, 0.005],
      [0.6, 0.005],
      [1, 0.04],
    ],
    density: 0.8,
    quality: 1,
    shading: false,
  });
  await direct.ready();
  direct.engine.render();
  direct.engine.stop();
  native = await readAMReX(new URL('nyx/Header', root), { scalar: 'density', signal });
  const sliced = (figures.slice = await Figure.create(element<HTMLCanvasElement>('slice'), {
    axes: false,
    controls: false,
  }));
  meshLayer(sliced, sliceAMR(native, { normal: [0, 0, 1], offset: 0.51 }, { signal }), {
    range: [0, 2.2],
    colormap: 'viridis',
  });
  await sliced.ready();
  sliced.engine.render();
  sliced.engine.stop();
  const contour = (figures.contour = await Figure.create(element<HTMLCanvasElement>('contour'), {
    axes: false,
    controls: false,
  }));
  const result = await contourAMR(native, [0.2], { dims: [65, 65, 65], signal });
  meshLayer(contour, result.triangles, { range: [0, 1], colormap: 'viridis' });
  await amrLevelOutlines(contour, native, { width: 1, signal });
  await contour.ready();
  contour.engine.render();
  contour.engine.stop();
  element('status').textContent =
    `Ready. ${licensed.blocks.length} licensed AMReX blocks, ${licensed.nodes.length} k-d nodes; ${native.blocks.length} Nyx blocks.`;
  element<HTMLCanvasElement>('volume').dataset.ready = 'true';
} catch (error) {
  element<HTMLCanvasElement>('volume').dataset.error = String(error);
  throw error;
}
window.addEventListener(
  'pagehide',
  () => {
    for (const f of Object.values(figures)) f.dispose();
  },
  { once: true },
);
