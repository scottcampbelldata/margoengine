import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { writeFile, mkdir } from 'node:fs/promises';
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));

const names = (
  process.env.SPEC_DEMOS ??
  'head,stars,wind,moving-flow,lic,tubes,derive,aeroflow,astrometrics,medical,formats,pipeline,contour,clip,glyph,calc,probe,transfer,labels,cinematic,atmosphere,surface,volume,points'
).split(',');
const reports = [];
const backends = process.env.SPEC_BACKENDS === 'webgl2' ? [true] : process.env.SPEC_BACKENDS === 'webgpu' ? [false] : [false,true];
for (const compat of backends) {
  const browser = await openBrowser({ startPath: '/packages/sciviz/tests/sciviz.html', port: 'free', compat });
  browser.page.setDefaultTimeout(120000);
  await browser.page.emulateMedia({ reducedMotion: 'reduce' });
  // Exact byte comparisons use the engine's documented pixel-exact mode. MSAA blending can differ
  // by one output byte even between two captures of the same unchanged transparent source scene.
  await browser.page.route('**/sciviz-*.ts*', async (route) => {
    const response = await route.fetch();
    const setup = `import { Engine as SpecCaptureEngine } from '/packages/core/dist/index.js';
      if (!SpecCaptureEngine.specCapture) {
        const create = SpecCaptureEngine.create.bind(SpecCaptureEngine);
        SpecCaptureEngine.create = (canvas, options = {}) => create(canvas, { exactSize: [Math.round(canvas.clientWidth * devicePixelRatio), Math.round(canvas.clientHeight * devicePixelRatio)], ...options });
        SpecCaptureEngine.specCapture = true;
      }\n`;
    await route.fulfill({ response, body: setup + (await response.text()) });
  });
  try {
    for (const name of names) {
      const fixture = ['aeroflow', 'astrometrics', 'medical'].includes(name);
      await browser.page.goto(
        new URL(`/${fixture ? 'packages/sciviz/tests/pages' : 'examples'}/sciviz-${name}.html`, browser.page.url())
          .href,
      );
      if (fixture)
        await browser.page.waitForFunction(() => document.querySelector('canvas[data-ready],canvas[data-error]'));
      else
        await browser.page.evaluate(async (path) => {
          const module = await import(path);
          await module.settled;
          await module.work;
        }, `/examples/sciviz-${name}.ts`);
      await browser.page.evaluate(async () => {
        globalThis.specTestLookup = (await import('/packages/sciviz/dist/spec.js')).recordedFigure;
      });
      await browser.page.waitForFunction(() =>
        [...document.querySelectorAll('canvas')].some((canvas) => globalThis.specTestLookup(canvas)?.layers.length),
      );
      assert.equal(await browser.page.locator('canvas[data-error]').count(), 0, name);
      const report = await browser.page.evaluate(async (name) => {
        const { Figure, recordedFigure } = await import('/packages/sciviz/dist/spec.js');
        const pixels = async (fig) => {
          await fig.ready();
          fig.engine.stop();
          const bitmap = await createImageBitmap(await fig.toPNG({ overlays: false }));
          const canvas = new OffscreenCanvas(bitmap.width, bitmap.height),
            ctx = canvas.getContext('2d');
          ctx.drawImage(bitmap, 0, 0);
          bitmap.close();
          return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        };
        const results = [];
        for (const source of [...document.querySelectorAll('canvas')]) {
          const fig = recordedFigure(source);
          if (!fig) continue;
          fig.engine.stop();
          const spec = await fig.toJSON({ signal: AbortSignal.timeout(90000) });
          const before = await pixels(fig),
            canvas = document.createElement('canvas');
          canvas.width = source.width;
          canvas.height = source.height;
          canvas.style.cssText = `width:${source.clientWidth}px;height:${source.clientHeight}px`;
          // A reload retires the old figure before creating its replacement, as an application does.
          const repeated = await pixels(fig);
          let sameSourceDiff = 0;
          for (let i = 0; i < before.length; i++) if (before[i] !== repeated[i]) sameSourceDiff++;
          fig.dispose();
          document.body.append(canvas);
          const copy = await Figure.fromJSON(JSON.parse(JSON.stringify(spec)), canvas, {
            signal: AbortSignal.timeout(90000),
          });
          const after = await pixels(copy);
          let different = 0;
          for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) different++;
          let diagnostic;
          if (different) {
            const copySpec = await copy.toJSON({ timeline: false });
            diagnostic = {
              sameSourceDiff,
              camera: spec.camera,
              afterSource: { position: [...fig.engine.camera.position], target: [...fig.engine.camera.target] },
              afterCopy: copySpec.camera,
              sourceLimits: spec.limits,
              copyLimits: copySpec.limits,
              specEqual: JSON.stringify(spec.resources) === JSON.stringify(copySpec.resources),
              firstDifferences: [...before.keys()]
                .filter((i) => before[i] !== after[i])
                .slice(0, 12)
                .map((i) => [i, before[i], after[i]]),
            };
          }
          results.push({
            canvas: source.id,
            different,
            diagnostic,
            length: before.length,
            copyLength: after.length,
            kinds: [...new Set(spec.resources.map((r) => r.kind))],
          });
          copy.dispose();
          canvas.remove();
        }
        return {
          name,
          results,
          ...(results.length
            ? {}
            : {
                debug: {
                  canvases: [...document.querySelectorAll('canvas')].map((c) => [
                    c.id,
                    !!recordedFigure(c),
                    c.dataset.ready,
                  ]),
                  status: document.querySelector('#status')?.textContent,
                  ready: document.readyState,
                },
              }),
        };
      }, name);
      assert.ok(report.results.length, `No recorded figure: ${JSON.stringify(report)}`);
      for (const result of report.results) {
        assert.equal(result.copyLength, result.length, JSON.stringify(result));
        assert.equal(result.different, 0, `${name}: ${JSON.stringify(result)}`);
      }
      reports.push({ backend: compat ? 'webgl2-compat' : 'webgpu', ...report });
      console.log(JSON.stringify(reports.at(-1)));
    }
  } finally {
    await browser.close();
  }
}
await mkdir('test-results', { recursive: true });
await writeFile('test-results/sciviz-spec-demos.json', JSON.stringify(reports, null, 2) + '\n');
