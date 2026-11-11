// Browser side of surface-repeat-browser.mjs (KB5700f): one surface layer on a fresh figure, captured unchanged
// `frames` times with toPNG({overlays: false}); returns how many captures differ from the first and by how many bytes.
import { Figure } from '@margoengine/sciviz/spec';

const n = 96,
  canvas = document.getElementById('view');
// Heights: 'folded' are steep hills (the Aeroflow case: seen from the default camera the slopes cover pixels more than
// once in the one draw), 'flat' all zero, 'tilted' a plane rising along x.
const heights = (shape) => {
  const h = new Float32Array(n * n);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1,
        y = (j / (n - 1)) * 2 - 1;
      h[j * n + i] = shape === 'folded' ? 0.6 * Math.sin(5 * x) * Math.cos(4 * y) : shape === 'tilted' ? 0.5 * x : 0;
    }
  return h;
};
let figure;
window.repeat = async ({ shape, opacity, frames = 24 }) => {
  figure?.dispose?.();
  figure = await Figure.create(canvas, { axes: false, aspect: [1, 1, 0.6] });
  figure.engine.stop();
  figure.surface(heights(shape), { nx: n, ny: n, x: [-1, 1], y: [-1, 1], colormap: 'viridis', contours: 8, opacity });
  const bytes = async () => new Uint8Array(await (await figure.toPNG({ overlays: false })).arrayBuffer());
  const decode = async () => {
    const bitmap = await createImageBitmap(new Blob([await bytes()])),
      copy = new OffscreenCanvas(bitmap.width, bitmap.height),
      ctx = copy.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    return ctx.getImageData(0, 0, copy.width, copy.height).data;
  };
  const first = await decode();
  let differing = 0,
    mostBytes = 0,
    drawn = 0;
  for (let i = 0; i < first.length; i += 4) if (first[i] !== first[0] || first[i + 1] !== first[1]) drawn++;
  for (let f = 1; f < frames; f++) {
    const next = await decode();
    let count = 0;
    for (let i = 0; i < next.length; i++) if (next[i] !== first[i]) count++;
    if (count) differing++;
    mostBytes = Math.max(mostBytes, count);
  }
  return { shape, opacity, differing, of: frames - 1, mostBytes, drawn };
};
window.ready = true;
