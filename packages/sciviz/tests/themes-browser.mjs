import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
await mkdir('test-results/sciviz-themes', { recursive: true });
const reports = [];
for (const compat of [false, true]) {
  const browser = await openBrowser({
      startPath: '/examples/sciviz-chart-polish.html?theme=print',
      port: 'free',
      compat,
    }),
    errors = [];
  browser.page.on('pageerror', (e) => errors.push(e.message));
  browser.page.setDefaultTimeout(120000);
  try {
    await browser.page.waitForFunction(
      () =>
        document.querySelector('#primary')?.dataset.themeReady === 'print' &&
        document.querySelector('#status')?.textContent.startsWith('Ready:'),
    );
    await browser.page.waitForFunction(async () => {
      const { figureForCanvas } = await import('/packages/sciviz/dist/a11y.js');
      return [...document.querySelectorAll('canvas')]
        .filter((c) => figureForCanvas(c)?.layers.length)
        .every((c) => c.dataset.themeReady === 'print');
    });
    const report = await browser.page.evaluate(async () => {
      const { applyTheme, createTheme, THEME_PRESETS, journalPreset, PRINT_PALETTES } = await import(
        '/packages/sciviz/dist/themes.js'
      );
      const { Figure } = await import('/packages/sciviz/dist/spec.js');
      const { multiplyMatrices, projectPoint } = await import('/packages/math/dist/mat4.js');
      const { exportImage, mediaDimensions } = await import('/packages/sciviz/dist/export-media.js');
      const { svgToPDF } = await import('/packages/sciviz/dist/pdf.js');
      const { parseTTF } = await import('/packages/loaders/dist/font.js');
      const check = (v, m) => {
        if (!v) throw Error(m);
      };
      const d = window.chartPolishDemo;
      check(
        d.figure.theme.fontSize === 11 && d.existing.line.material.width === 4 / 3,
        'Existing chart line width not themed',
      );
      check(d.existing.line.material.color[0] > 0, 'Authored data colour was erased');
      const chartSVG = await d.chart.toSVG();
      check(
        chartSVG.includes('font-family="Arial, Helvetica, sans-serif"') && chartSVG.includes('font-size="11"'),
        'Chart controller typography differs from export',
      );
      check(
        [...document.querySelectorAll('[data-sciviz-polish] text')].every((e) =>
          getComputedStyle(e).fontFamily.includes('Arial'),
        ),
        'HTML/SVG chart fonts differ: ' +
          [...document.querySelectorAll('[data-sciviz-polish] text')].map((e) => getComputedStyle(e).fontFamily),
      );
      const make = async (mode) => {
        const host = document.createElement('div');
        host.style.cssText = 'position:relative;width:300px;height:220px';
        const c = document.createElement('canvas');
        c.style.cssText = 'display:block;width:300px;height:220px';
        host.append(c);
        document.querySelector('main').append(host);
        const f = await Figure.create(c, { mode, theme: THEME_PRESETS.print, controls: false, legend: true });
        f.engine.stop();
        return { f, c, host };
      };
      const two = await make('2d');
      const line = await two.f.line({ x: [0, 0.5, 1], y: [0, 1, 0] }, { name: 'Observed' });
      check(line.line.material.width === 4 / 3, 'New line does not inherit theme width');
      const authored = await two.f.line(
        { x: [0, 1], y: [0.2, 0.8] },
        { color: '#123456', width: 4, name: 'Author width' },
      );
      const svg = await two.f.toSVG();
      check(
        PRINT_PALETTES.color.some((c) => svg.includes(c.toLowerCase()) || svg.includes(c)),
        'New categorical line ignores print palette',
      );
      check(svg.includes('stroke-width="0.6666666666666666"'), 'Frame width absent from SVG');
      check(svg.includes('v-3') && svg.includes('h3'), 'Inward tick strokes absent from SVG');
      const tickLengths = (figure, base) => {
        figure.render();
        const frame = figure.vectorAxes().find((l) => l.material.width === figure.theme.axisWidth);
        check(frame, 'No themed frame');
        const m = multiplyMatrices(figure.engine.camera.matrix, figure.model),
          c = figure.engine.canvas,
          out = [];
        for (let i = base; i < frame.count; i += 2) {
          const a = projectPoint(
              m,
              frame.points[i * 4],
              frame.points[i * 4 + 1],
              frame.points[i * 4 + 2],
              c.clientWidth,
              c.clientHeight,
              'webgpu',
            ),
            b = projectPoint(
              m,
              frame.points[(i + 1) * 4],
              frame.points[(i + 1) * 4 + 1],
              frame.points[(i + 1) * 4 + 2],
              c.clientWidth,
              c.clientHeight,
              'webgpu',
            );
          out.push(Math.hypot(a.x - b.x, a.y - b.y));
        }
        check(out.length > 0 && out.every((n) => Math.abs(n - 3) < 0.002), 'Tick geometry is not 3 CSS pixels: ' + out);
        return out.length;
      };
      const ticks2 = tickLengths(two.f, 8);
      two.c.style.width = '260px';
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      tickLengths(two.f, 8);
      const handle = await applyTheme(two.f, 'print');
      two.c.style.setProperty('--margo-font-size', '14px');
      two.c.style.setProperty('--margo-line-width', '2.5');
      await handle.refresh();
      check(two.f.theme.fontSize === 14 && line.line.material.width === 2.5, 'CSS variables did not reach GPU styles');
      check(authored.line.material.width === 4, 'Theme changed an authored width');
      const refreshed = await two.f.toSVG();
      check(
        refreshed.includes('stroke-width="2.5"') && refreshed.includes('font-size="14"'),
        'CSS variables did not reach vector export',
      );
      await two.f.updateData(line, { x: [0, 0.5, 1], y: [1, 0, 1] });
      check(line.line.material.width === 2.5, 'Live update lost resolved theme width');
      await applyTheme(two.f, 'print-mono');
      check(two.f.vectorAxes().length === 1, 'Hidden grid still draws');
      const mono = await two.f.toSVG();
      check(!mono.includes('stroke="#bbbbbb"'), 'Hidden grid still exports');
      const three = await make('3d'),
        z = new Float32Array(16).map((_, i) => i / 15),
        v = new Float32Array(64).map((_, i) => i / 63);
      const surface = three.f.surface(z, { nx: 4, ny: 4 }),
        volume = three.f.volume(v, { dims: [4, 4, 4], range: [0, 1] }),
        explicit = three.f.volume(v, { dims: [4, 4, 4], range: [0, 1], colormap: 'phase' });
      check(
        surface.colormap.name === 'cividis' && volume.colormap.name === 'cividis' && explicit.colormap.name === 'phase',
        'Theme scalar defaults changed an explicit encoding',
      );
      three.f.colorbar(surface.colormap, [0, 1], { label: 'Measured scalar' });
      await three.f.ready();
      const ticks3 = tickLengths(three.f, 24);
      three.f.engine.camera.position = [3, 2, 4];
      tickLengths(three.f, 24);
      const saved = await three.f.toJSON();
      const decoded = (await import('/packages/sciviz/dist/spec.js')).decodeFigureValue;
      check(
        (await decoded(saved.options)).theme.fontFamily === THEME_PRESETS.print.fontFamily,
        'Portable theme missing',
      );
      const replayHost = document.createElement('div'),
        replayCanvas = document.createElement('canvas');
      replayHost.style.cssText = three.host.style.cssText;
      replayCanvas.style.cssText = three.c.style.cssText;
      replayHost.append(replayCanvas);
      document.querySelector('main').append(replayHost);
      const replay = await Figure.fromJSON(saved, replayCanvas);
      await replay.ready();
      check(
        replay.theme.lineWidth === three.f.theme.lineWidth && replay.theme.fontSize === 11,
        'Portable theme did not restore',
      );
      replay.dispose();
      replayHost.remove();
      const png3 = await three.f.toPNG();
      check(png3.size > 1000, 'Themed 3D raster is empty');
      const journal = journalPreset('nature', 1, { heightMM: 30, dpi: 96 });
      await applyTheme(two.f, journal.theme);
      await two.f.ready();
      const png = await exportImage(two.f, journal.raster),
        bytes = new Uint8Array(await png.arrayBuffer()),
        view = new DataView(bytes.buffer),
        dimensions = mediaDimensions(1, 1, journal.raster);
      check(
        view.getUint32(16) === dimensions.width && view.getUint32(20) === dimensions.height,
        'Physical PNG dimensions differ',
      );
      const font = parseTTF(
        await fetch('/examples/assets/sciviz/publication/DejaVuSerif.ttf').then((r) => r.arrayBuffer()),
      );
      const pdf = await svgToPDF(await two.f.toSVG(), { font, ...journal.pdf }),
        pdfText = new TextDecoder('latin1').decode(await pdf.arrayBuffer());
      const box = /\/MediaBox\s*\[0 0 ([\d.]+) ([\d.]+)\]/.exec(pdfText);
      check(box && Math.abs(Number(box[1]) - (89 / 25.4) * 72) < 0.00001, 'Physical PDF column width differs');
      const snapshot = {
        ticks2,
        ticks3,
        png: [dimensions.width, dimensions.height],
        pdfWidth: Number(box[1]),
        newPalette: line.line.material.color.length,
        chartFont: d.figure.theme.fontSize,
        sourceMaps: [surface.colormap.name, volume.colormap.name, explicit.colormap.name],
      };
      two.f.dispose();
      three.f.dispose();
      two.host.remove();
      three.host.remove();
      return snapshot;
    });
    assert.deepEqual(errors, []);
    reports.push({ backend: compat ? 'webgl2' : 'webgpu', ...report });
    console.log(JSON.stringify(reports.at(-1)));
    await browser.page.screenshot({
      path: `test-results/sciviz-themes/${compat ? 'webgl2' : 'webgpu'}.png`,
      fullPage: true,
    });
    await browser.page.goto(new URL('/examples/sciviz-publication.html?theme=print', browser.page.url()).href);
    await browser.page.waitForFunction(
      () =>
        document.querySelector('#viewport')?.dataset.themeReady === 'print' &&
        document.querySelector('#status')?.textContent.includes('observed samples'),
    );
    const ligo = await browser.page.evaluate(async () => {
      const { figure, pdf, title } = await import('/examples/sciviz-publication.ts');
      const launcher = document.querySelector('[data-margo-a11y] summary').getBoundingClientRect(),
        formula = title.element.getBoundingClientRect();
      if (
        launcher.left < formula.right &&
        launcher.right > formula.left &&
        launcher.top < formula.bottom &&
        launcher.bottom > formula.top
      )
        throw Error('Accessible menu obscures the formula title');
      const svg = await figure.toSVG();
      if (!svg.includes('font-size="11"') || !title.element.querySelector('mfrac'))
        throw Error('LIGO print theme lost text or math');
      return { pdfBytes: (await pdf()).size, pngBytes: (await figure.toPNG()).size };
    });
    assert.ok(ligo.pdfBytes > 1000 && ligo.pngBytes > 1000);
    reports.at(-1).ligo = ligo;
    await browser.page.screenshot({
      path: `test-results/sciviz-themes/ligo-${compat ? 'webgl2' : 'webgpu'}.png`,
      fullPage: true,
    });
  } finally {
    await browser.close();
  }
}
await writeFile('test-results/sciviz-themes/results.json', JSON.stringify(reports, null, 2));
