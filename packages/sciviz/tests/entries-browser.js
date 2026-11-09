// Real-GPU checks of the sciviz entries that draw with layers of their own (grids, graph, geo). Each case draws one
// figure and returns its pixels; entries-browser.mjs runs the page natively and on the WebGL2 compatibility layer
// (?compat=1) and compares the two. The checks here read the pixels of one run: the layer drew, in the colours its
// colour map gives, where its geometry is.
import { install } from '/packages/webgl2-compat/dist/index.js';
import { cases } from './entries-cases.js';

const params = new URLSearchParams(location.search);
const errors = [];
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

async function pixels(figure) {
  const canvas = figure.engine.canvas;
  canvas.setAttribute('width', canvas.width);
  figure.engine.render();
  const bitmap = await createImageBitmap(canvas),
    copy = new OffscreenCanvas(bitmap.width, bitmap.height),
    g = copy.getContext('2d', { willReadFrequently: true });
  g.drawImage(bitmap, 0, 0);
  return g.getImageData(0, 0, bitmap.width, bitmap.height);
}

const at = (image, x, y) => {
  const i = (Math.round(y) * image.width + Math.round(x)) * 4;
  return [image.data[i], image.data[i + 1], image.data[i + 2]];
};
// Pixels that differ from the background by more than 24 in some channel.
const lit = (image) => {
  const b = at(image, 1, 1);
  let n = 0;
  for (let p = 0; p < image.data.length; p += 4)
    if (
      Math.max(Math.abs(image.data[p] - b[0]), Math.abs(image.data[p + 1] - b[1]), Math.abs(image.data[p + 2] - b[2])) >
      24
    )
      n++;
  return n;
};
const encode = (image) => {
  let s = '';
  for (let i = 0; i < image.data.length; i += 8192) s += String.fromCharCode(...image.data.subarray(i, i + 8192));
  return btoa(s);
};

window.runEntryChecks = async () => {
  if (params.get('compat') === '1') {
    const result = await install({ force: true });
    if (!result.installed) throw new Error('install() did not install: ' + result.reason);
  }
  const { Figure } = await import('@margoengine/sciviz');
  const canvas = document.querySelector('#view');
  const report = { checks: [], images: {} };
  const selected = cases.filter(({ name }) => !params.has('only') || name === params.get('only'));
  assert(selected.length > 0, 'at least one drawing case selected');
  for (const { name, run, mode } of selected) {
    const figure = await Figure.create(canvas, { mode, axes: false, controls: false });
    figure.renderer.device.addEventListener('uncapturederror', (event) =>
      errors.push(`${name}: ${event.error.message}`),
    );
    try {
      const facts = await run(figure, { pixels: () => pixels(figure), at, lit, assert });
      const image = await pixels(figure);
      figure.engine.stop();
      await figure.engine.rebootDevice();
      figure.renderer.device.addEventListener('uncapturederror', (event) =>
        errors.push(`${name} restored: ${event.error.message}`),
      );
      await figure.ready();
      const restored = await pixels(figure);
      assert(encode(restored) === encode(image), 'actual device replacement preserves every rendered pixel');
      report.images[name] = { width: image.width, height: image.height, data: encode(image), lit: lit(image) };
      report.checks.push({ name, ...facts });
    } catch (error) {
      throw new Error(`${name}: ${error.message}`);
    } finally {
      figure.dispose();
    }
  }
  assert(!errors.length, errors.join('; '));
  return report;
};

window.entriesReady = true;
