// node test-results/mv-vox.mjs <out-dir> <samples> <file.vox>... : renders each .vox with the tracer's MagicaVoxel
// mapping at 960 x 800 into <out-dir>/<name>-ours.png (run under the GPU lock).
import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { openBrowser } from '../scripts/browser.js';
const [out, samples, ...files] = process.argv.slice(2);
const path = '/test-results/mv-vox.html',
  port = 5264,
  context = await openBrowser({ startPath: path, port }),
  { page } = context;
try {
  for (const f of files) {
    await page.goto(`http://127.0.0.1:${port}${path}`);
    await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
    const b64 = (await readFile(f)).toString('base64');
    // HDR=<file.hdr>: the decoded image sky for files with `_env _mode 2`.
    const hdr =
      process.env.HDR &&
      (await import('node:module'))
        .createRequire(import.meta.url)(process.env.HDR_READER)
        .readHdr(process.env.HDR);
    const r = await page.evaluate(
      ([b, s, t, e, o, h]) =>
        window.render(b, {
          width: 960,
          height: 800,
          samples: s,
          tweak: t,
          environment: e,
          options: o,
          hdr: h,
          viewport: !!(o && o.__viewport),
          paced: o && o.__paced,
          orbit: o && o.__orbit,
        }),
      [
        b64,
        Number(samples),
        process.env.TWEAK,
        process.env.ENV && JSON.parse(process.env.ENV),
        process.env.OPT && JSON.parse(process.env.OPT),
        hdr && { width: hdr.width, height: hdr.height, data: [...hdr.data] },
      ],
    );
    const name = basename(f, '.vox');
    if (r.png) await writeFile(`${out}/${name}-ours${process.env.SUFFIX ?? ''}.png`, Buffer.from(r.png, 'base64'));
    if (r.ref) await writeFile(`${out}/${name}-orbitref${process.env.SUFFIX ?? ''}.png`, Buffer.from(r.ref, 'base64'));
    console.log(
      name,
      `${Math.round(r.ms)} ms`,
      r.gpuMiB !== undefined ? `GPU ${r.gpuMiB} MiB` : '',
      `ready ${Math.round(r.readyMs)} ms`,
      r.first !== undefined ? `first lit frame ${Math.round(r.first)} ms` : '',
      r.paced ? JSON.stringify(r.paced) : '',
      r.debug ? JSON.stringify(r.debug) : '',
      JSON.stringify(r.times),
      'errors',
      JSON.stringify(r.errors),
      'unsupported',
      JSON.stringify(r.unsupported),
      r.camera ? `camera ${JSON.stringify(r.camera)}` : '',
    );
  }
} finally {
  await context.close();
}
