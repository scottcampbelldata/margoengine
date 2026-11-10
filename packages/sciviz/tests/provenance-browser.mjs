import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';

const names = (
  process.env.PROVENANCE_DEMOS ??
  'head,stars,wind,moving-flow,lic,tubes,derive,aeroflow,astrometrics,medical,formats,pipeline,contour,clip,glyph,calc,probe,transfer,labels,cinematic,atmosphere,surface,volume,points'
).split(',');
await mkdir('test-results/sciviz-provenance', { recursive: true });
const backends =
  process.env.PROVENANCE_BACKENDS === 'webgpu'
    ? [false]
    : process.env.PROVENANCE_BACKENDS === 'webgl2'
      ? [true]
      : [false, true];
for (const compat of backends) {
  const context = await openBrowser({ startPath: '/packages/sciviz/tests/sciviz.html', port: 'free', compat });
  context.page.setDefaultTimeout(120000);
  const errors = [];
  context.page.on('pageerror', (error) => errors.push(error.message));
  const reports = [];
  try {
    for (const name of names) {
      const fixture = ['aeroflow', 'astrometrics', 'medical'].includes(name);
      await context.page.goto(
        new URL(`/${fixture ? 'packages/sciviz/tests/pages' : 'examples'}/sciviz-${name}.html`, context.page.url())
          .href,
      );
      if (fixture)
        await context.page.waitForFunction(() => document.querySelector('canvas[data-ready],canvas[data-error]'));
      else
        await context.page.evaluate(async (path) => {
          const m = await import(path);
          await m.settled;
          await m.work;
        }, `/examples/sciviz-${name}.ts`);
      await context.page.evaluate(async () => {
        window.provenanceLookup = (await import('/packages/sciviz/dist/spec.js')).recordedFigure;
      });
      await context.page.waitForFunction(() =>
        [...document.querySelectorAll('canvas')].some((canvas) => window.provenanceLookup(canvas)?.layers.length),
      );
      const report = await context.page.evaluate(
        async ({ name, artifacts }) => {
          const { recordedFigure } = await import('/packages/sciviz/dist/spec.js');
          const { withProvenance, readPNGProvenance, readSVGProvenance, validateProvenance, exportProvenancePDF } =
            await import('/packages/sciviz/dist/provenance.js');
          const results = [];
          for (const canvas of [...document.querySelectorAll('canvas')]) {
            const portable = recordedFigure(canvas);
            if (!portable?.layers.length) continue;
            portable.engine.stop();
            const figure = await withProvenance(portable);
            if (name === 'head') {
              const marker = await figure.scatter({ x: [0], y: [0], z: [0] }, { size: 1 });
              figure.remove(marker);
            }
            const png = await figure.toPNG({ overlays: false }),
              record = await readPNGProvenance(png);
            await validateProvenance(record);
            if (
              !record.spec.layers.length ||
              !record.packages['@margoengine/core'] ||
              !record.browser.userAgent ||
              !record.gpu.backend
            )
              throw Error('Missing PNG provenance');
            const svg = await figure.toSVG(),
              vector = readSVGProvenance(svg);
            await validateProvenance(vector);
            if (vector.spec.layers.length !== record.spec.layers.length) throw Error('SVG spec lost layers');
            const spec = await figure.toJSON();
            figure.setLimits(spec.limits);
            const trace = await figure.trace();
            if (!trace.includes('["setLimits"]')) throw Error('Trace lost an API call');
            let pdfBytes = 0,
              pdf;
            if (['head', 'wind', 'surface'].includes(name)) {
              const { parseTTF } = await import('/packages/loaders/dist/font.js');
              const font = parseTTF(
                await (await fetch('/examples/assets/sciviz/publication/DejaVuSerif.ttf')).arrayBuffer(),
              );
              pdf = await exportProvenancePDF(figure, { font, title: name });
              pdfBytes = pdf.size;
              const text = new TextDecoder('latin1').decode(await pdf.arrayBuffer());
              if (!text.includes('/MargoProvenance <FEFF')) throw Error('PDF info lost provenance');
            }
            if (name === 'head') {
              figure.dispose();
              const imports = document.createElement('script');
              imports.type = 'importmap';
              imports.textContent = JSON.stringify({
                imports: {
                  '@margoengine/sciviz/spec': location.origin + '/packages/sciviz/dist/spec.js',
                  '@margoengine/sciviz/provenance': location.origin + '/packages/sciviz/dist/provenance.js',
                },
              });
              document.head.append(imports);
              const url = URL.createObjectURL(new Blob([trace], { type: 'text/javascript' }));
              try {
                const module = await import(url),
                  copy = await module.default(canvas);
                const round = await copy.toJSON();
                if (
                  round.layers.length !== spec.layers.length ||
                  round.camera.position.join() !== spec.camera.position.join()
                )
                  throw Error('Trace replay changed state');
                await copy.ready();
                await copy.toPNG();
                copy.dispose();
              } finally {
                URL.revokeObjectURL(url);
              }
            } else figure.dispose();
            const fileData = {};
            if (name === 'head' && artifacts) {
              const encode = (blob) =>
                new Promise((resolve, reject) => {
                  const reader = new FileReader();
                  reader.onload = () => resolve(String(reader.result).split(',')[1]);
                  reader.onerror = () => reject(reader.error);
                  reader.readAsDataURL(blob);
                });
              fileData.png = await encode(png);
              fileData.svg = svg;
              fileData.pdf = await encode(pdf);
              fileData.trace = trace;
            }
            results.push({
              name,
              png: png.size,
              svg: svg.length,
              pdf: pdfBytes,
              trace: trace.length,
              layers: record.spec.layers.length,
              hashes: record.data.length,
              gpu: record.gpu,
              fileData,
            });
          }
          if (!results.length) throw Error('No recorded figure in ' + name);
          return results;
        },
        { name, artifacts: process.env.PROVENANCE_ARTIFACTS === '1' },
      );
      for (const item of report) {
        const prefix = `test-results/sciviz-provenance/${item.name}-${compat ? 'webgl2' : 'webgpu'}`;
        for (const [kind, data] of Object.entries(item.fileData ?? {})) {
          await writeFile(
            prefix + '.' + (kind === 'trace' ? 'mjs' : kind),
            ['png', 'pdf'].includes(kind) ? Buffer.from(data, 'base64') : data,
          );
        }
        delete item.fileData;
      }
      reports.push(...report);
      console.log(JSON.stringify({ backend: compat ? 'webgl2' : 'webgpu', report }));
    }
    assert.deepEqual(errors, []);
    await writeFile(
      `test-results/sciviz-provenance/${compat ? 'webgl2' : 'webgpu'}.json`,
      JSON.stringify(reports, null, 2),
    );
  } finally {
    await context.close();
  }
}
