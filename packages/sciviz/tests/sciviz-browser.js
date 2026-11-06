// Real-GPU checks of @margoengine/sciviz: each layer draws without WebGPU errors and puts the right colours in the
// right places (read back from the canvas), the GPU isosurface has exactly the triangles the CPU table gives, scatter
// level of detail keeps to its budget, and axes, tick labels and the colour bar appear.
import { Figure, colormap } from '@margoengine/sciviz';
import { caseTriangles, CORNERS } from '@margoengine/sciviz/maths';
import { createCompute } from '@margoengine/compute';

const checks = [];
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const check = async (name, run) => {
  try {
    await run();
  } catch (error) {
    throw new Error(`${name}: ${error.message}`);
  }
  checks.push(name);
};
const errors = [];
const watch = (figure) => {
  const device = figure.renderer.device;
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  return device;
};

// The canvas's pixels after a rendered frame. The bitmap is taken in the same task as the render, while the frame
// is still the canvas's current image.
async function pixels(figure) {
  const engine = figure.engine;
  // A new drawing buffer: WebKit answers every read of one buffer in a task from the first read.
  engine.canvas.setAttribute('width', engine.canvas.width);
  engine.render();
  const bitmap = await createImageBitmap(engine.canvas),
    copy = new OffscreenCanvas(bitmap.width, bitmap.height),
    g = copy.getContext('2d', { willReadFrequently: true });
  g.drawImage(bitmap, 0, 0);
  const image = g.getImageData(0, 0, bitmap.width, bitmap.height);
  return {
    width: image.width,
    height: image.height,
    at: (x, y) => {
      const i = (Math.round(y) * image.width + Math.round(x)) * 4;
      return [image.data[i], image.data[i + 1], image.data[i + 2]];
    },
    lit(background) {
      let n = 0;
      for (let i = 0; i < image.data.length; i += 4)
        if (
          Math.abs(image.data[i] - background[0]) +
            Math.abs(image.data[i + 1] - background[1]) +
            Math.abs(image.data[i + 2] - background[2]) >
          24
        )
          n++;
      return n;
    },
  };
}
const BACKGROUND = [0x0f, 0x14, 0x1c];
const luminance = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

async function figureOn(canvas, options = {}) {
  const figure = await Figure.create(canvas, { controls: false, ...options });
  figure.engine.stop?.();
  watch(figure);
  // Straight down onto the plot box, so screen x follows data x and screen y follows data -y.
  // Close enough that the plot box ([-1, 1] across) fills the middle 60% of the view.
  figure.engine.camera.position = [0, 2.2, 0.0001];
  figure.engine.camera.target = [0, 0, 0];
  figure.engine.camera.up = [0, 0, -1];
  return figure;
}

window.runSciVizTests = async () => {
  const canvas = document.querySelector('#view');

  await check(
    'a surface plot colours by height through the colour map: the low edge dark, the high edge bright',
    async () => {
      const figure = await figureOn(canvas, { axes: false });
      const nx = 64,
        ny = 48,
        z = new Float32Array(nx * ny);
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) z[j * nx + i] = i / (nx - 1);
      figure.surface(z, { nx, colormap: 'gray', contours: 0 });
      const image = await pixels(figure);
      const left = image.at(image.width * 0.3, image.height / 2),
        right = image.at(image.width * 0.7, image.height / 2);
      assert(luminance(right) > luminance(left) + 40, `left ${left} right ${right}`);
      assert(image.lit(BACKGROUND) > image.width * image.height * 0.2, 'the surface covers the box');
      const corner = image.at(2, 2);
      assert(
        corner.every((c, k) => Math.abs(c - BACKGROUND[k]) <= 2),
        `the theme background fills the canvas: ${corner}`,
      );
      figure.dispose();
    },
  );

  await check('surface contours darken thin lines at even height steps; NaN heights leave holes', async () => {
    const figure = await figureOn(canvas, { axes: false });
    const nx = 64,
      z = new Float32Array(nx * nx);
    for (let j = 0; j < nx; j++) for (let i = 0; i < nx; i++) z[j * nx + i] = j < 8 ? NaN : i / (nx - 1);
    figure.surface(z, { nx, colormap: 'gray', contours: 4, range: [0, 1] });
    const image = await pixels(figure);
    // A contour sits at t = 0.25: darker than its neighbours a few pixels either side.
    let darkest = Infinity,
      across = [];
    for (let x = image.width * 0.3; x < image.width * 0.45; x++)
      across.push(luminance(image.at(x, image.height * 0.6)));
    darkest = Math.min(...across);
    assert(darkest < Math.max(...across) - 30, `a contour line darkens the row (${darkest} vs ${Math.max(...across)})`);
    const hole = image.at(image.width / 2, image.height * 0.08);
    assert(luminance(hole) < 40, `NaN rows are not drawn: ${hole}`);
    figure.dispose();
  });

  await check(
    'a volume ray-marches a sphere of density: bright inside, clear outside; mip and clip planes work',
    async () => {
      const figure = await figureOn(canvas, { axes: false });
      const n = 48,
        data = new Float32Array(n * n * n);
      for (let z = 0; z < n; z++)
        for (let y = 0; y < n; y++)
          for (let x = 0; x < n; x++)
            data[(z * n + y) * n + x] = Math.max(0, 1 - Math.hypot(x - 23.5, y - 23.5, z - 23.5) / 18);
      // Only the dense core (values above 0.5) is opaque: front-to-back compositing stops at the first opaque shell, so
      // an opacity curve rising from low values would show the dim outer shell instead of the bright core.
      const volume = figure.volume(data, {
        colormap: 'gray',
        opacity: [
          [0, 0],
          [0.5, 0],
          [1, 1],
        ],
        shading: false,
      });
      let image = await pixels(figure);
      const centre = image.at(image.width / 2, image.height / 2),
        corner = image.at(image.width * 0.08, image.height * 0.08);
      assert(luminance(centre) > 120, `centre ${centre}`);
      assert(luminance(corner) < 40, `corner ${corner}`);
      // Cut away everything with x > 0.5 (box coordinates): the right half goes dark.
      volume.clip = [{ normal: [-1, 0, 0], offset: 0.5 }];
      image = await pixels(figure);
      assert(luminance(image.at(image.width * 0.54, image.height / 2)) < 50, 'clipped half is clear');
      assert(luminance(image.at(image.width * 0.46, image.height / 2)) > 60, 'kept half still shows');
      volume.clip = [];
      volume.mode = 'mip';
      image = await pixels(figure);
      assert(luminance(image.at(image.width / 2, image.height / 2)) > 120, 'maximum intensity projection');
      figure.dispose();
    },
  );

  await check('a slice shows the data on its plane through the colour map', async () => {
    const figure = await figureOn(canvas, { axes: false });
    const n = 32,
      data = new Float32Array(n * n * n);
    for (let z = 0; z < n; z++)
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) data[(z * n + y) * n + x] = x / (n - 1);
    const volume = figure.volume(data, { colormap: 'gray', opacity: () => 0 });
    volume.slice('z', 0.5);
    const image = await pixels(figure);
    const a = luminance(image.at(image.width * 0.3, image.height / 2)),
      b = luminance(image.at(image.width * 0.7, image.height / 2));
    assert(b > a + 40, `slice ramps left to right: ${a} -> ${b}`);
    figure.dispose();
  });

  await check(
    'the GPU isosurface has exactly the triangles the CPU marching cubes table gives, and draws',
    async () => {
      const figure = await figureOn(canvas, { axes: false });
      const n = 40,
        field = new Float32Array(n * n * n);
      for (let z = 0; z < n; z++)
        for (let y = 0; y < n; y++)
          for (let x = 0; x < n; x++)
            field[(z * n + y) * n + x] =
              1 -
              Math.hypot((x - 19.3) / 15, (y - 20.1) / 12, (z - 19.7) / 9) +
              0.15 * Math.sin(x * 0.7) * Math.cos(y * 0.5);
      let expected = 0;
      const level = 0.2;
      for (let z = 0; z < n - 1; z++)
        for (let y = 0; y < n - 1; y++)
          for (let x = 0; x < n - 1; x++) {
            let mask = 0;
            CORNERS.forEach(([cx, cy, cz], c) => {
              if (field[((z + cz) * n + y + cy) * n + x + cx] > level) mask |= 1 << c;
            });
            expected += caseTriangles(mask).length;
          }
      const iso = await figure.isosurface(field, level, { color: '#e0e0e0' });
      assert(iso.triangles === expected, `GPU ${iso.triangles} triangles, CPU ${expected}`);
      const image = await pixels(figure);
      assert(luminance(image.at(image.width / 2, image.height / 2)) > 80, 'the surface is lit at the centre');
      const fewer = await iso.update(0.6);
      assert(fewer > 0 && fewer < expected, `a higher level gives a smaller surface (${fewer})`);
      figure.dispose();
    },
  );

  await check('an isosurface from a GpuArray on the engine device needs no CPU copy', async () => {
    const figure = await figureOn(canvas, { axes: false });
    const gpu = await createCompute({ engine: figure.engine });
    const n = 24;
    const i = gpu.arange(0, n * n * n, 1, 'f32');
    // A sphere field computed on the GPU: x, y, z from the flat index.
    const x = i.mod(n).sub(11.5),
      y = i.floorDiv(n).mod(n).sub(11.5),
      z = i.floorDiv(n * n).sub(11.5);
    const field = x.square().add(y.square()).add(z.square()).sqrt().neg().add(8).eval().reshape(n, n, n);
    const iso = await figure.isosurface(field, 0);
    assert(iso.triangles > 500, `triangles ${iso.triangles}`);
    gpu.dispose();
    figure.dispose();
  });

  await check('a million-point scatter keeps to the point budget and colours by data', async () => {
    const figure = await figureOn(canvas, { axes: false, pointBudget: 300_000 });
    const n = 1_000_000,
      x = new Float32Array(n),
      y = new Float32Array(n),
      z = new Float32Array(n),
      c = new Float32Array(n);
    let s = 1;
    const r = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    for (let k = 0; k < n; k++) {
      x[k] = r();
      y[k] = r();
      z[k] = r() * 0.2;
      c[k] = x[k];
    }
    const layer = await figure.scatter({ x, y, z, color: c }, { colormap: 'gray', size: 2 });
    assert(layer.count === n, 'all points registered');
    const image = await pixels(figure);
    const plugin = [...figure.engine.plugins.values()].find((p) => p.name === 'points');
    assert(
      plugin.stats.pointsDrawn > 100_000 && plugin.stats.pointsDrawn <= 300_000,
      `points drawn ${plugin.stats.pointsDrawn}`,
    );
    assert(
      luminance(image.at(image.width * 0.75, image.height / 2)) >
        luminance(image.at(image.width * 0.25, image.height / 2)),
      'colour follows x',
    );
    figure.dispose();
  });

  await check('axes, tick labels and the colour bar appear over the canvas', async () => {
    const figure = await figureOn(canvas, { titles: { x: 'Time', y: 'Depth', z: 'Value' } });
    await figure.line({ x: [0, 1, 2, 3], y: [0, 1, 0, 1], z: [0, 0.5, 1, 1.5] });
    // Axes load their packages asynchronously; ready() resolves when they are drawn (and rejects if they fail).
    await figure.ready();
    figure.engine.render();
    const texts = [...document.querySelectorAll('span')].map((s) => s.textContent);
    assert(
      texts.includes('Time') && texts.includes('Depth') && texts.includes('Value'),
      `titles in ${texts.slice(0, 12)}`,
    );
    assert(texts.includes('1.5') || texts.includes('1.0'), 'z tick labels');
    const bar = figure.colorbar('coolwarm', [-2, 2], { label: 'Anomaly' });
    assert(bar.element.isConnected && bar.element.textContent.includes('Anomaly'), 'colour bar');
    assert(bar.element.textContent.includes('−2'), 'colour bar ticks with a true minus');
    figure.dispose();
    assert(!bar.element.isConnected, 'disposing the figure removes the bar');
  });

  await check('picking finds the scatter point drawn under the pointer, and the tooltip shows its values', async () => {
    const figure = await figureOn(canvas, { axes: false, titles: { x: 'Time' } });
    // Three points; only the one at data (1, 0) is bright, so its drawn pixels can be found in the image.
    await figure.scatter({ x: [0, 1, 1], y: [0, 1, 0], z: [0, 0, 0], color: [0, 0, 1] }, { colormap: 'gray', size: 8 });
    const image = await pixels(figure);
    let sx = 0,
      sy = 0,
      n = 0;
    for (let y = 0; y < image.height; y++)
      for (let x = 0; x < image.width; x++)
        if (luminance(image.at(x, y)) > 200) {
          sx += x;
          sy += y;
          n++;
        }
    assert(n > 10, `the bright point is drawn (${n} pixels)`);
    const scale = canvas.clientWidth / image.width;
    const hit = figure.pick((sx / n) * scale, (sy / n) * scale);
    assert(
      hit && hit.index === 2 && hit.x === 1 && hit.y === 0 && hit.value === 1,
      `pick ${hit?.index} at ${hit?.x}, ${hit?.y} value ${hit?.value}`,
    );
    assert(figure.pick(2, 2) === null, 'nothing in the empty corner');
    const hovered = new Promise((resolve) =>
      figure.addEventListener('hover', (e) => resolve(e.detail), { once: true }),
    );
    const rect = canvas.getBoundingClientRect();
    canvas.dispatchEvent(
      new PointerEvent('pointermove', {
        clientX: rect.left + (sx / n) * scale,
        clientY: rect.top + (sy / n) * scale,
        bubbles: true,
      }),
    );
    const detail = await hovered;
    assert(detail?.index === 2, 'a hover event with the hit');
    const tip = document.querySelector('[data-sciviz-tooltip]');
    assert(
      tip && !tip.hidden && tip.textContent.includes('Time 1') && tip.textContent.includes('value 1'),
      `tooltip: ${tip?.textContent}`,
    );
    figure.dispose();
    assert(!tip.isConnected, 'disposing the figure removes the tooltip');
  });

  await check('picking a surface returns the point under the pointer and its height', async () => {
    const figure = await figureOn(canvas, { axes: false });
    const nx = 41,
      z = new Float32Array(nx * nx);
    for (let j = 0; j < nx; j++) for (let i = 0; i < nx; i++) z[j * nx + i] = i / (nx - 1);
    const surface = figure.surface(z, { nx, x: [0, 10], y: [0, 10], name: 'ramp' });
    figure.engine.render();
    const hit = figure.pick(canvas.clientWidth / 2, canvas.clientHeight / 2);
    assert(hit?.layer === surface, 'the surface is hit');
    assert(Math.abs(hit.x - 5) < 0.2 && Math.abs(hit.y - 5) < 0.2, `centre of the grid: ${hit.x}, ${hit.y}`);
    assert(Math.abs(hit.z - hit.x / 10) < 1e-3 && hit.value === hit.z, `height ${hit.z} at x ${hit.x}`);
    figure.dispose();
  });

  await check('select() takes the points inside a box or a lasso and sends a selection event', async () => {
    const figure = await figureOn(canvas, { axes: false });
    const x = [],
      y = [];
    for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) x.push(i), y.push(j);
    const layer = await figure.scatter({ x, y });
    figure.engine.render();
    let event;
    figure.addEventListener('selection', (e) => (event = e.detail));
    const w = canvas.clientWidth,
      h = canvas.clientHeight;
    const box = figure.select({ rect: [0, 0, w / 2, h] });
    assert(event === box && box.points[0].layer === layer, 'the event carries the selection');
    assert(
      [...box.points[0].indices].every((k) => x[k] < 1.5) && box.points[0].indices.length === 8,
      `left half: ${box.points[0].indices}`,
    );
    // A lasso around the top half of the screen (data y > 1.5).
    const lasso = figure.select({ polygon: [0, 0, w, 0, w, h / 2, 0, h / 2] });
    assert(
      [...lasso.points[0].indices].every((k) => y[k] > 1.5) && lasso.points[0].indices.length === 8,
      `top half: ${lasso.points[0].indices}`,
    );
    assert(figure.selection === lasso, 'figure.selection is the last one');
    figure.dispose();
  });

  // 2D charts: the plot area is the canvas inside the default margins (top 16, right 24, bottom 48, left 64 CSS px).
  const chartOn = async (options = {}) => {
    const figure = await Figure.create(canvas, { mode: '2d', ...options });
    figure.engine.stop?.();
    watch(figure);
    return figure;
  };
  // Canvas pixel of data (x, y) in a 2D chart, from its bounds and the default margins.
  const toPixel = (figure, image, x, y) => {
    const [x0, x1, y0, y1] = figure.bounds,
      sx = image.width / canvas.clientWidth,
      w = canvas.clientWidth - 64 - 24,
      h = canvas.clientHeight - 16 - 48;
    return [(64 + ((x - x0) / (x1 - x0)) * w) * sx, (16 + ((y1 - y) / (y1 - y0)) * h) * sx];
  };
  const chartPixels = async (figure) => {
    figure.engine.canvas.setAttribute('width', figure.engine.canvas.width);
    figure.render();
    const bitmap = await createImageBitmap(figure.engine.canvas),
      copy = new OffscreenCanvas(bitmap.width, bitmap.height),
      g = copy.getContext('2d', { willReadFrequently: true });
    g.drawImage(bitmap, 0, 0);
    const image = g.getImageData(0, 0, bitmap.width, bitmap.height);
    return {
      width: image.width,
      height: image.height,
      at: (x, y) => {
        const i = (Math.round(y) * image.width + Math.round(x)) * 4;
        return [image.data[i], image.data[i + 1], image.data[i + 2]];
      },
    };
  };

  await check('a 2D bar chart draws each bar from 0 to its height, and clips to the plot area', async () => {
    const figure = await chartOn({ axes: false });
    const bars = await figure.bar({ x: [0, 1, 2], y: [1, 2, 3] }, { color: '#ffffff', name: 'counts' });
    assert(bars.kind === 'bar' && bars.values.length === 3, 'a bar layer');
    let image = await chartPixels(figure);
    for (const [i, h] of [
      [0, 1],
      [1, 2],
    ]) {
      const inside = image.at(...toPixel(figure, image, i, h / 2)),
        above = image.at(...toPixel(figure, image, i, h + 0.4));
      assert(luminance(inside) > 200, `bar ${i} is drawn: ${inside}`);
      assert(luminance(above) < 40, `above bar ${i} is empty: ${above}`);
    }
    // Zoomed onto the middle bar: the left bar lies outside the window and must not spill into the margin.
    figure.setLimits([0.5, 1.5, 0, 1]);
    image = await chartPixels(figure);
    assert(luminance(image.at(20, image.height / 2)) < 40, 'nothing drawn in the left margin');
    assert(luminance(image.at(image.width / 2, image.height / 2)) > 200, 'the middle bar fills the window');
    // Picking a bar gives its height.
    const hit = figure.pick(canvas.clientWidth / 2, canvas.clientHeight / 2);
    assert(hit?.layer === bars && hit.index === 1 && hit.value === 2, `bar pick ${hit?.index} ${hit?.value}`);
    figure.setLimits();
    assert(figure.bounds[1] > 2.4, 'setLimits() goes back to the data');
    let threw = false;
    try {
      figure.surface([0, 1, 2, 3], { nx: 2 });
    } catch (error) {
      threw = error.code === 'unsupported';
    }
    assert(threw, 'a surface needs a 3D figure');
    figure.dispose();
  });

  await check('a histogram counts every value; a heatmap colours cells by value', async () => {
    const figure = await chartOn({ axes: false });
    const values = Array.from(
      { length: 500 },
      (_, i) => Math.sin(i * 12.9898) * 43758.5453 - Math.floor(Math.sin(i * 12.9898) * 43758.5453),
    );
    const hist = await figure.histogram(values, { bins: 10 });
    assert(hist.values.reduce((a, b) => a + b, 0) === 500, 'every value counted once');
    figure.remove(hist);
    const heat = await figure.heatmap([0, 1, 2, 3], { nx: 2, colormap: 'gray' });
    const image = await chartPixels(figure);
    const low = luminance(image.at(...toPixel(figure, image, 0, 0))),
      high = luminance(image.at(...toPixel(figure, image, 1, 1)));
    assert(high > low + 100, `cell (1, 1) brighter than (0, 0): ${low} -> ${high}`);
    const [px, py] = toPixel(figure, image, 1, 0);
    const scale = canvas.clientWidth / image.width;
    const hit = figure.pick(px * scale, py * scale);
    assert(hit?.layer === heat && hit.value === 1 && hit.x === 1 && hit.y === 0, `cell pick ${hit?.value}`);
    figure.dispose();
  });

  await check('a 2D chart zooms about the pointer with the wheel and resets on double-click', async () => {
    const figure = await chartOn({ axes: false });
    await figure.line({ x: [0, 10], y: [0, 10] });
    const before = figure.bounds,
      rect = canvas.getBoundingClientRect();
    // At the plot centre, a 400 px wheel-up halves the span about the centre.
    const cx = 64 + (canvas.clientWidth - 88) / 2,
      cy = 16 + (canvas.clientHeight - 64) / 2;
    canvas.dispatchEvent(
      new WheelEvent('wheel', {
        deltaY: -400,
        clientX: rect.left + cx,
        clientY: rect.top + cy,
        bubbles: true,
        cancelable: true,
      }),
    );
    const after = figure.bounds;
    const near = (a, b) => Math.abs(a - b) < 1e-6;
    assert(near(after[1] - after[0], (before[1] - before[0]) / 2), `x span halves: ${before} -> ${after}`);
    assert(near((after[0] + after[1]) / 2, (before[0] + before[1]) / 2), 'about the pointer');
    canvas.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    assert(
      figure.bounds.every((v, k) => near(v, before[k])),
      'double-click resets',
    );
    figure.dispose();
  });

  await check('2D axes put tick labels and titles outside the plot area', async () => {
    const figure = await chartOn({ titles: { x: 'Month', y: 'Sales' } });
    await figure.bar({ x: [1, 2, 3, 4], y: [5, 7, 3, 9] });
    await figure.ready();
    figure.render();
    // The innermost spans: the y title's text sits in a turned span inside its padded box.
    const spans = [...document.querySelectorAll('span')].filter((e) => !e.firstElementChild);
    const month = spans.find((s) => s.textContent === 'Month'),
      sales = spans.find((s) => s.textContent === 'Sales');
    assert(month && sales, 'both titles');
    const r = canvas.getBoundingClientRect(),
      m = month.getBoundingClientRect(),
      s = sales.getBoundingClientRect();
    assert(m.bottom > r.bottom - 48 + 20, `x title below the plot: ${m.bottom} vs ${r.bottom - 48}`);
    assert(s.right < r.left + 64 - 20, `y title left of the plot: ${s.right} vs ${r.left + 64}`);
    assert(
      spans.some((e) => e.textContent === '8'),
      'y tick labels',
    );
    figure.dispose();
  });

  await check('toPNG paints the frame with the tick labels and titles over it', async () => {
    const figure = await Figure.create(canvas, { mode: '2d', titles: { x: 'Month', y: 'Sales' } });
    figure.engine.stop?.();
    watch(figure);
    await figure.bar({ x: [1, 2, 3], y: [3, 1, 2] }, { color: '#ffffff' });
    const level = figure.colorbar('gray', [0, 1], { label: 'Level' });
    const blob = await figure.toPNG();
    assert(blob.type === 'image/png', `a PNG: ${blob.type}`);
    const bitmap = await createImageBitmap(blob);
    assert(bitmap.width === canvas.width && bitmap.height === canvas.height, 'at the canvas resolution');
    const copy = new OffscreenCanvas(bitmap.width, bitmap.height),
      g = copy.getContext('2d', { willReadFrequently: true });
    g.drawImage(bitmap, 0, 0);
    // The x title sits below the plot, where the GPU frame has only background: painted text makes it brighter.
    const title = [...document.querySelectorAll('span')].find((s) => !s.firstElementChild && s.textContent === 'Month'),
      r = title.getBoundingClientRect(),
      c = canvas.getBoundingClientRect(),
      scale = bitmap.width / c.width;
    const box = g.getImageData((r.left - c.left) * scale, (r.top - c.top) * scale, r.width * scale, r.height * scale);
    let brightest = 0;
    for (let i = 0; i < box.data.length; i += 4)
      brightest = Math.max(brightest, luminance([box.data[i], box.data[i + 1], box.data[i + 2]]));
    assert(brightest > 120, `the title is painted (${brightest})`);
    // The colour bar's gradient is painted too: white near its top, dark near its bottom in the gray map.
    const bar = level.bar.getBoundingClientRect(),
      px = (bar.left - c.left + bar.width / 2) * scale,
      top = g.getImageData(px, (bar.top - c.top + 4) * scale, 1, 1).data,
      bottom = g.getImageData(px, (bar.bottom - c.top - 4) * scale, 1, 1).data;
    assert(luminance([...top]) > 200 && luminance([...bottom]) < 60, `bar gradient ${top} .. ${bottom}`);
    figure.dispose();
  });

  await check('toSVG writes a 2D chart as vector shapes and text, and a 3D figure as an image under text', async () => {
    const chart = await Figure.create(canvas, { mode: '2d', titles: { x: 'Month', y: 'Sales' } });
    chart.engine.stop?.();
    watch(chart);
    await chart.bar({ x: [1, 2, 3], y: [3, 1, 2] }, { color: '#ff0000' });
    await chart.line({ x: [1, 2, 3], y: [2, 2.5, 1] }, { color: '#00ff00' });
    const svg = new DOMParser().parseFromString(await chart.toSVG(), 'image/svg+xml');
    assert(!svg.querySelector('parsererror'), 'well-formed SVG');
    assert(svg.querySelectorAll('rect[fill="#ff0000"]').length === 3, 'three red bars');
    assert(svg.querySelector('polyline[stroke="#00ff00"]'), 'the line as a polyline');
    assert(!svg.querySelector('image'), 'no raster');
    const texts = [...svg.querySelectorAll('text')].map((t) => t.textContent);
    assert(texts.includes('Month') && texts.includes('Sales'), `titles in ${texts.slice(0, 10)}`);
    // The tallest bar (3) reaches higher on the page than the shortest (1).
    const bars = [...svg.querySelectorAll('rect[fill="#ff0000"]')].map((e) => Number(e.getAttribute('y')));
    assert(bars[0] < bars[1], `bar tops ${bars}`);
    chart.dispose();
    const figure = await figureOn(canvas, { axes: true });
    figure.surface([0, 1, 1, 0], { nx: 2 });
    const raster = new DOMParser().parseFromString(await figure.toSVG(), 'image/svg+xml');
    assert(raster.querySelector('image')?.getAttribute('href').startsWith('data:image/png;base64,'), 'an embedded PNG');
    assert(raster.querySelectorAll('text').length > 3, 'tick labels as text');
    figure.dispose();
  });

  await check('a log axis ticks decades and picks report data values', async () => {
    const figure = await Figure.create(canvas, { mode: '2d', scale: { y: 'log' } });
    figure.engine.stop?.();
    watch(figure);
    const layer = await figure.scatter({ x: [1, 2, 3, 4], y: [1, 10, 100, 1000] }, { size: 6 });
    await figure.ready();
    figure.render();
    const texts = [...document.querySelectorAll('span')].map((s) => s.textContent);
    assert(
      ['10', '100', '1000'].every((t) => texts.includes(t)),
      `decade labels in ${texts.slice(0, 16)}`,
    );
    // On a log axis the points lie on a straight line: equal steps on screen.
    const near = (a, b, tol) => Math.abs(a - b) <= tol;
    const p = layer.positions;
    assert(near(p[4] - p[1], p[7] - p[4], 1e-6), 'equal plot steps per decade');
    const w = canvas.clientWidth - 88,
      h = canvas.clientHeight - 64,
      [x0, x1, y0, y1] = figure.bounds;
    const sx = 64 + ((3 - x0) / (x1 - x0)) * w,
      sy = 16 + ((y1 - Math.log10(100)) / (y1 - y0)) * h;
    const hit = figure.pick(sx, sy);
    assert(hit?.index === 2 && near(hit.y, 100, 1e-3) && hit.x === 3, `pick ${hit?.index} ${hit?.y}`);
    let threw = false;
    figure.dispose();
    const flat = await Figure.create(canvas, { scale: { z: 'log' }, controls: false });
    try {
      flat.surface([1, 2, 3, 4], { nx: 2 });
    } catch (error) {
      threw = error.code === 'unsupported';
    }
    flat.dispose();
    assert(threw, 'a surface needs linear axes');
  });

  await check('a date axis ticks whole hours and keeps millisecond-scale precision', async () => {
    const figure = await Figure.create(canvas, { mode: '2d', scale: { x: 'date' } });
    figure.engine.stop?.();
    watch(figure);
    const start = Date.UTC(2026, 9, 25, 0, 30);
    const x = Array.from({ length: 7 }, (_, i) => start + i * 3_600_000 + 123);
    await figure.line({ x, y: [1, 3, 2, 5, 4, 6, 5] });
    await figure.ready();
    figure.render();
    const texts = [...document.querySelectorAll('span')].map((s) => s.textContent);
    assert(texts.includes('02:00') && texts.includes('04:00'), `hour labels in ${texts.slice(0, 16)}`);
    const w = canvas.clientWidth - 88,
      h = canvas.clientHeight - 64,
      [x0, x1, y0, y1] = figure.bounds;
    // Plot x is milliseconds from the first data's UTC midnight.
    const px = x[3] - Date.UTC(2026, 9, 25);
    const hit = figure.pick(64 + ((px - x0) / (x1 - x0)) * w, 16 + ((y1 - 5) / (y1 - y0)) * h);
    assert(hit?.index === 3 && Math.abs(hit.x - x[3]) < 8, `date pick ${hit?.index} ${hit?.x - x[3]} ms`);
    figure.dispose();
  });

  await check('named series get distinct palette colours and a legend', async () => {
    const figure = await Figure.create(canvas, { mode: '2d' });
    figure.engine.stop?.();
    watch(figure);
    const a = await figure.line({ x: [0, 1], y: [0, 1] }, { name: 'Alpha' });
    assert(!figure.legend || figure.legend.element.hidden, 'no legend for one named series');
    await figure.line({ x: [0, 1], y: [1, 0] }, { name: 'Beta' });
    const legend = figure.legend?.element;
    assert(legend && !legend.hidden && legend.textContent === 'AlphaBeta', `legend: ${legend?.textContent}`);
    const colours = [...legend.querySelectorAll('[data-sciviz-swatch]')].map(
      (s) => getComputedStyle(s).backgroundColor,
    );
    assert(colours.length === 2 && colours[0] !== colours[1], `distinct colours ${colours}`);
    // The legend sits inside the plot area's top-right corner.
    const r = legend.getBoundingClientRect(),
      c = canvas.getBoundingClientRect();
    assert(r.right <= c.right - 24 && r.top >= c.top + 16, 'inside the plot area');
    figure.remove(a);
    assert(legend.hidden, 'one named series left: the legend hides');
    figure.dispose();
    assert(!legend.isConnected, 'disposing the figure removes the legend');
  });

  await check('a quiver plot draws an arrow per sample, scaled so the longest is 6% of the extent', async () => {
    const figure = await Figure.create(canvas, { mode: '2d', axes: false });
    figure.engine.stop?.();
    watch(figure);
    const x = [],
      y = [],
      u = [],
      v = [];
    for (let j = 0; j < 5; j++) for (let i = 0; i < 5; i++) x.push(i), y.push(j), u.push(1 + i), v.push(0);
    const arrows = await figure.quiver({ x, y, u, v }, { color: '#ffffff' });
    assert(arrows.positions.length === 25 * 3 * 2 * 3, `three segments per arrow: ${arrows.positions.length / 6}`);
    // The longest vector (5) is 6% of the extent (hypot(4, 4)).
    const p = arrows.positions,
      last = 24 * 18;
    const length = Math.hypot(p[last + 3] - p[last], p[last + 4] - p[last + 1]);
    assert(Math.abs(length - 0.06 * Math.hypot(4, 4)) < 1e-5, `longest arrow ${length}`);
    const image = await chartPixels(figure);
    let lit = 0;
    for (let yy = 0; yy < image.height; yy += 2)
      for (let xx = 0; xx < image.width; xx += 2) if (luminance(image.at(xx, yy)) > 150) lit++;
    assert(lit > 20, `arrows are drawn (${lit})`);
    figure.dispose();
  });

  await check('streamlines of a rotating field circle the centre, coloured by speed', async () => {
    const figure = await Figure.create(canvas, { mode: '2d', axes: false });
    figure.engine.stop?.();
    watch(figure);
    const n = 21,
      u = new Float32Array(n * n),
      v = new Float32Array(n * n);
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        u[j * n + i] = -(j - 10) / 10;
        v[j * n + i] = (i - 10) / 10;
      }
    const lines = await figure.streamlines(
      { u, v, dims: [n, n], bounds: [-1, 1, -1, 1] },
      {
        seeds: [
          [0.5, 0, 0],
          [0.25, 0, 0],
        ],
        step: 0.02,
        maxSteps: 400,
      },
    );
    const p = lines.positions;
    let worst = 0;
    for (let i = 0; i < p.length; i += 3) {
      const r = Math.hypot(p[i], p[i + 1]);
      worst = Math.max(worst, Math.min(Math.abs(r - 0.5), Math.abs(r - 0.25)));
    }
    assert(p.length > 600 && worst < 1e-3, `on their circles: ${p.length / 3} points, drift ${worst}`);
    assert(Math.abs(Math.max(...lines.values) - 0.5) < 1e-3, 'speed is the radius');
    const image = await chartPixels(figure);
    let lit = 0;
    for (let yy = 0; yy < image.height; yy += 2)
      for (let xx = 0; xx < image.width; xx += 2) if (luminance(image.at(xx, yy)) > 60) lit++;
    assert(lit > 50, `streamlines are drawn (${lit})`);
    let threw = false;
    try {
      await figure.streamlines({ u, v, dims: [n, n] }, { seeds: [[99, 99, 0]] });
    } catch (error) {
      threw = error instanceof RangeError;
    }
    assert(threw, 'seeds outside the field are an error');
    figure.dispose();
  });

  await check('a timeline plays every frame in order, never overlapping slow frames, and stops on abort', async () => {
    const figure = await figureOn(canvas, { axes: false });
    const nx = 16,
      surface = figure.surface(new Float32Array(nx * nx), { nx, range: [0, 1] });
    const shown = [];
    let active = 0,
      overlapped = false,
      events = 0;
    const timeline = figure.timeline([0, 0.25, 0.5, 0.75, 1], async (index, time) => {
      active++;
      overlapped ||= active > 1;
      surface.setHeights(new Float32Array(nx * nx).fill(time));
      await new Promise((r) => setTimeout(r, 15));
      shown.push(index);
      active--;
    });
    timeline.addEventListener('time', () => events++);
    await figure.play({ fps: 1000 });
    assert(shown.join() === '0,1,2,3,4' && !overlapped, `frames ${shown}, overlap ${overlapped}`);
    assert(events === 5 && timeline.index === 4 && timeline.time === 1, `events ${events}, index ${timeline.index}`);
    const slider = timeline.element.querySelector('input[type=range]');
    assert(slider.value === '4' && timeline.element.textContent.includes('1'), 'the slider follows');
    // Dragging the slider shows that frame.
    slider.value = '2';
    slider.dispatchEvent(new Event('input'));
    await timeline.seek(2);
    assert(timeline.index === 2 && shown.at(-1) === 2, `slider seek ${timeline.index}`);
    // Looping playback stops with the signal's reason.
    const controller = new AbortController();
    const looping = figure.play({ fps: 200, loop: true, signal: controller.signal });
    await new Promise((r) => setTimeout(r, 200));
    const before = shown.length;
    controller.abort(new DOMException('stop', 'AbortError'));
    let reason;
    try {
      await looping;
    } catch (error) {
      reason = error;
    }
    assert(reason?.name === 'AbortError' && !timeline.playing, `aborted: ${reason}`);
    assert(before > 6, `it looped past the last frame (${before} frames shown)`);
    // pause() resolves play().
    const paused = figure.play({ fps: 5, loop: true });
    figure.pause();
    await paused;
    figure.dispose();
    assert(!timeline.element.isConnected, 'disposing the figure removes the controls');
  });

  await check('colour maps the page can use as CSS', async () => {
    assert(colormap('aurora').css().startsWith('linear-gradient('), 'css');
  });

  await check(
    'figure.controls are the orbit controls Figure.create attached, and a selecting drag mode turns them off',
    async () => {
      const figure = await Figure.create(canvas, { axes: false });
      figure.engine.stop?.();
      const controls = figure.controls;
      assert(
        controls && typeof controls.addEventListener === 'function' && controls.enabled,
        'Figure.create attaches controls',
      );
      let changed = 0;
      controls.addEventListener('change', () => changed++);
      controls.rotateLeft(0.3);
      controls.update(1 / 60);
      assert(changed > 0, 'their change event follows the camera');
      figure.dragMode = 'lasso';
      assert(!controls.enabled, 'lasso mode turns orbiting off');
      figure.dragMode = 'orbit';
      assert(controls.enabled, 'orbit mode turns it back on');
      figure.dispose();
      const bare = await figureOn(canvas, { axes: false });
      assert(bare.controls === undefined, 'controls: false leaves none');
      bare.dispose();
    },
  );

  assert(errors.length === 0, `WebGPU errors: ${errors.join('; ')}`);
  return { checks };
};

// A box drag driven by the runner's real mouse (trusted pointer events, so pointer capture works): set up a grid of
// points in box mode, then report what the drag selected.
let dragFigure, dragSelection;
window.setupDragTest = async () => {
  const canvas = document.querySelector('#view');
  dragFigure = await figureOn(canvas, { axes: false });
  const x = [],
    y = [];
  for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) x.push(i), y.push(j);
  await dragFigure.scatter({ x, y });
  dragFigure.engine.render();
  dragFigure.dragMode = 'box';
  dragFigure.addEventListener('selection', (e) => (dragSelection = e.detail));
  const rect = canvas.getBoundingClientRect();
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
};
let panFigure, panBefore;
window.setupPanTest = async () => {
  const canvas = document.querySelector('#view');
  panFigure = await Figure.create(canvas, { mode: '2d', axes: false });
  panFigure.engine.stop?.();
  await panFigure.line({ x: [0, 10], y: [0, 5] });
  panFigure.render();
  panBefore = panFigure.bounds;
  const rect = canvas.getBoundingClientRect();
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
};
window.finishPanTest = () => {
  const after = panFigure.bounds,
    canvas = document.querySelector('#view'),
    perPixel = (panBefore[1] - panBefore[0]) / (canvas.clientWidth - 64 - 24),
    result = { shift: after[0] - panBefore[0], perPixel, mode: panFigure.dragMode };
  panFigure.dispose();
  return result;
};
window.finishDragTest = () => {
  const indices = dragSelection ? [...dragSelection.points[0].indices] : null;
  const mode = dragFigure.dragMode;
  dragFigure.dispose();
  return { indices, mode };
};
