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

// The canvas's pixels after a rendered frame.
async function pixels(figure) {
  const engine = figure.engine;
  engine.render();
  await figure.renderer.device.queue.onSubmittedWorkDone();
  const canvas = engine.canvas,
    bitmap = await createImageBitmap(canvas),
    copy = new OffscreenCanvas(bitmap.width, bitmap.height),
    g = copy.getContext('2d');
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
  figure.engine.camera.position = [0, 4, 0.0001];
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
      const volume = figure.volume(data, {
        colormap: 'gray',
        opacity: [
          [0, 0],
          [0.2, 0.3],
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
      assert(luminance(image.at(image.width * 0.6, image.height / 2)) < 50, 'clipped half is clear');
      assert(luminance(image.at(image.width * 0.4, image.height / 2)) > 60, 'kept half still shows');
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
    // Axes load their packages asynchronously; give them a frame.
    await new Promise((resolve) => setTimeout(resolve, 100));
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

  await check('colour maps the page can use as CSS', async () => {
    assert(colormap('aurora').css().startsWith('linear-gradient('), 'css');
  });

  assert(errors.length === 0, `WebGPU errors: ${errors.join('; ')}`);
  return { checks };
};
