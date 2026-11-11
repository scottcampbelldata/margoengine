// Pixel-only black-box comparison. No rival implementation files are read or copied.
// Installs must live outside Margo; this script is not a timing benchmark or a correctness gate.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { openBrowser } from './browser.js';
import { build } from 'vite';
const rivalRoot =
  process.env.MARGO_DENSITY_RIVALS ?? fileURLToPath(new URL('../../engine-bench/batch-181-density', import.meta.url));
const names = ['regl-scatterplot', '@deck.gl/core', '@deck.gl/layers'];
const manifests = await Promise.all(
  names.map((name) => readFile(resolve(rivalRoot, 'node_modules', name, 'package.json'), 'utf8').then(JSON.parse)),
);
const paths = names.map((name, i) =>
  resolve(rivalRoot, 'node_modules', name, manifests[i].module ?? manifests[i].main).replaceAll('\\', '/'),
);
const plugin = {
  name: 'density-blackbox',
  config() {
    return { server: { fs: { allow: [process.cwd(), rivalRoot] } } };
  },
  resolveId(id) {
    if (id.endsWith('/density-rivals.js')) return '\0density-rivals';
  },
  load(id) {
    if (id === '\0density-rivals')
      return `export { default as createScatterplot } from ${JSON.stringify(paths[0])};export {Deck,OrthographicView,COORDINATE_SYSTEM} from ${JSON.stringify(paths[1])};export {ScatterplotLayer} from ${JSON.stringify(paths[2])};`;
  },
};
// Execute packaged libraries as a black box; only the bundler resolves implementation files.
const entry = resolve('test-results/batch181-j4-rivals-entry.js');
if (!process.argv.includes('--prepared')) {
  await writeFile(entry, plugin.load('\0density-rivals'));
  await build({
    configFile: false,
    root: rivalRoot,
    logLevel: 'error',
    plugins: [plugin],
    build: {
      outDir: resolve(rivalRoot, 'margo-density-output'),
      emptyOutDir: false,
      lib: { entry, formats: ['es'], fileName: () => 'density-rivals.js' },
    },
  });
}
if (process.argv.includes('--prepare')) process.exit(0);
const bundle = resolve(rivalRoot, 'margo-density-output/density-rivals.js').replaceAll('\\', '/');
const browser = await openBrowser({
  startPath: '/packages/sciviz/tests/volume-quality.html',
  port: 'free',
  plugins: [plugin],
});
browser.page.setDefaultTimeout(180000);
try {
  const results = await browser.page.evaluate(async (bundle) => {
    const { createScatterplot, Deck, OrthographicView, COORDINATE_SYSTEM, ScatterplotLayer } = await import(
      '/@fs/' + bundle
    );
    const { Figure } = await import('/packages/sciviz/dist/index.js');
    const { densityScatter } = await import('/packages/sciviz/dist/density.js');
    const { readCSV } = await import('/packages/sciviz/dist/table.js');
    const width = 256,
      height = 256,
      opacity = 0.08,
      results = [];
    const capture = (canvas) => {
      const c = new OffscreenCanvas(width, height),
        ctx = c.getContext('2d');
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(canvas, 0, 0);
      return ctx.getImageData(0, 0, width, height).data;
    };
    const canvas = () => {
      const c = document.createElement('canvas');
      c.width = width;
      c.height = height;
      c.style.cssText = `width:${width}px;height:${height}px`;
      document.body.append(c);
      return c;
    };
    const values = new Float32Array(
      await new Response(
        (await fetch('/examples/assets/sciviz/stars.bin')).body.pipeThrough(new DecompressionStream('gzip')),
      ).arrayBuffer(),
    );
    const taxi = readCSV(await (await fetch('/examples/assets/sciviz/limits/taxi.csv')).text());
    for (const [rival, n] of [
      ['regl-scatterplot', 20000000],
      ['deck.gl', 10000000],
    ]) {
      const positions = new Float32Array(n * 3),
        x = new Float32Array(n),
        y = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const a = rival === 'regl-scatterplot' ? i % 1000000 : i % taxi.length;
        x[i] =
          rival === 'regl-scatterplot'
            ? values[a] / 180 - 1
            : (Number(taxi.value('pickup_longitude', a)) + 75) / 1.5 - 1;
        y[i] =
          rival === 'regl-scatterplot' ? values[1000000 + a] / 90 : Number(taxi.value('pickup_latitude', a)) - 40 - 1;
        positions[i * 3] = x[i];
        positions[i * 3 + 1] = y[i];
      }
      const a = canvas(),
        b = canvas(),
        fig = await Figure.create(a, {
          mode: '2d',
          axes: false,
          controls: false,
          theme: 'dark',
          limits: [-1, 1, -1, 1],
          margin: { top: 0, bottom: 0, left: 0, right: 0 },
        });
      fig.engine.stop();
      fig.engine.scene.background = '#000000';
      const density = densityScatter(fig, positions, { opacity, color: '#ffffff' });
      await fig.ready();
      fig.render();
      await fig.renderer.device.queue.onSubmittedWorkDone();
      // Compare actual composited images, with a separate analytical-opacity error for Margo.
      const bitmap = await createImageBitmap(await fig.toPNG({ overlays: false }));
      const actual = capture(bitmap),
        counts = await density.readCounts();
      bitmap.close();
      const expected = Uint8Array.from(counts, (c) => Math.round(255 * (1 - (1 - opacity) ** c)));
      let other, destroy;
      if (rival === 'regl-scatterplot') {
        other = createScatterplot({
          canvas: b,
          width,
          height,
          pointSize: 1,
          pointColor: '#ffffff',
          backgroundColor: '#000000',
          opacity,
          renderPointsAsSquares: true,
          disableAlphaBlending: false,
          pointScaleMode: 'constant',
          cameraIsFixed: true,
        });
        destroy = () => other.destroy();
        await other.draw({ x, y });
      } else {
        const deckPositions = new Float32Array(positions.length);
        for (let i = 0; i < n; i++) {
          deckPositions[i * 3] = (x[i] * width) / 2;
          deckPositions[i * 3 + 1] = (y[i] * height) / 2;
        }
        let done, fail;
        const ready = new Promise((resolve, reject) => {
          done = resolve;
          fail = reject;
        });
        other = new Deck({
          canvas: b,
          width,
          height,
          useDevicePixels: false,
          views: new OrthographicView({ flipY: false }),
          initialViewState: { target: [0, 0, 0], zoom: 0 },
          controller: false,
          deviceProps: { type: 'webgl', webgl: { preserveDrawingBuffer: true, antialias: false } },
          onAfterRender: () => done(),
          onError: fail,
          layers: [
            new ScatterplotLayer({
              id: 'all-points',
              data: { length: n, attributes: { getPosition: { value: deckPositions, size: 3 } } },
              coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
              getRadius: 0.5,
              radiusUnits: 'pixels',
              getFillColor: [255, 255, 255, Math.round(opacity * 255)],
              stroked: false,
              antialiasing: false,
              parameters: { depthWriteEnabled: false, depthCompare: 'always' },
            }),
          ],
        });
        destroy = () => other.finalize();
        await ready;
        other.redraw(true);
        await new Promise(requestAnimationFrame);
      }
      try {
        const bytes = capture(b);
        let difference = 0,
          max = 0,
          far2 = 0,
          ink = 0,
          expectedInk = 0,
          actualInk = 0,
          analyticError = 0;
        for (let i = 0; i < counts.length; i++) {
          const d = Math.abs(actual[i * 4] - bytes[i * 4]);
          analyticError += Math.abs(actual[i * 4] - expected[i]);
          difference += d;
          max = Math.max(max, d);
          if (d > 2) far2++;
          if (bytes[i * 4]) ink++;
          if (expected[i]) expectedInk++;
          if (actual[i * 4] > 0) actualInk++;
        }
        if (ink === 0) throw new Error(`${rival} did not render`);
        if (actualInk === 0 || analyticError / counts.length > 1)
          throw new Error(
            'Margo capture must contain density and match independent count opacity within one mean output byte',
          );
        results.push({
          rival,
          points: n,
          width,
          height,
          opacity,
          projection: 'same float32 normalized XY; y up; orthographic full window',
          pointPolicy:
            rival === 'regl-scatterplot'
              ? 'one-pixel squares, alpha blending enabled, no performance mode'
              : 'one-pixel circles, no antialiasing; alpha quantized to u8',
          margoVotes: counts.reduce((a, b) => a + b, 0),
          meanAbsRed: difference / counts.length,
          maxRed: max,
          shareAbove2: far2 / counts.length,
          rivalInk: ink,
          margoInk: expectedInk,
          actualCompositedInk: actualInk,
          margoAnalyticMeanAbsRed: analyticError / counts.length,
        });
        a.id = `margo-${results.length}`;
        b.id = `rival-${results.length}`;
        for (const [label, pixels] of [
          ['Margo', actual],
          [rival, bytes],
        ]) {
          const title = document.createElement('h2');
          title.textContent = `${label}, ${n.toLocaleString()} points`;
          const frozen = canvas();
          frozen.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), 0, 0);
          document.body.append(title, frozen);
        }
      } finally {
        destroy();
        fig.dispose();
        a.remove();
        b.remove();
      }
    }
    return results;
  }, bundle);
  const report = {
    date: '2026-11-10',
    kind: 'pixel-only, no timing',
    versions: Object.fromEntries(manifests.map((m) => [m.name, m.version])),
    hardware: browser.hardware,
    results,
  };
  await writeFile('test-results/batch181-j4-rival-pixels.json', JSON.stringify(report, null, 2) + '\n');
  await browser.page.screenshot({ path: 'test-results/batch181-j4-rival-pixels.png' });
  console.log(JSON.stringify(report));
} finally {
  await browser.close();
}
