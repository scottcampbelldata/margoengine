import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { build, preview } from 'vite';
import { openBrowser } from '../../../scripts/browser.js';

const output = resolve('test-results');
await mkdir(output, { recursive: true });
const root = await mkdtemp(join(output, 'mann-fft-consumer-'));
try {
  await writeFile(join(root, 'index.html'), '<script type="module" src="./index.js"></script>');
  await writeFile(
    join(root, 'index.js'),
    `
      import { MannBox } from '@margoengine/weather/turbulence';
      const options = { cells: [45, 20, 9], size: [1024, 256, 128], seed: 420 };
      const NativeWorker = globalThis.Worker;
      let starts = 0;
      globalThis.Worker = class extends NativeWorker {
        constructor(url, options) { super(url, options); starts++; }
      };
      function equalWords(left, right) {
        const a = new Uint8Array(left.buffer, left.byteOffset, left.byteLength);
        const b = new Uint8Array(right.buffer, right.byteOffset, right.byteLength);
        return a.length === b.length && a.every((value, i) => value === b[i]);
      }
      async function verify() {
        const reference = new MannBox(options);
        const built = await MannBox.create({ ...options, threads: 3 });
        const participants = starts;
        const sample = [-12.125, 31.75, -88.375];
        globalThis.Worker = class extends NativeWorker {
          postMessage(message, transfer) {
            if ('buffer' in message) {
              queueMicrotask(() => this.dispatchEvent(new ErrorEvent('error', { message: 'Fail one running FFT helper.' })));
              return;
            }
            super.postMessage(message, transfer);
          }
        };
        const failure = await MannBox.create({ ...options, threads: 2 }).then(
          () => null,
          (error) => ({ code: error.code, message: error.message }),
        );
        return {
          participants,
          work: built.fftWork,
          allBytesExact: ['u','v','w'].every((component) => equalWords(built[component], reference[component])),
          signedSampleExact: built.sample(...sample).every((value, i) => Object.is(value, reference.sample(...sample)[i])),
          failure,
        };
      }
      window.mannFftProof = verify().finally(() => { globalThis.Worker = NativeWorker; });
    `,
  );
  await build({ root, configFile: false, publicDir: false, logLevel: 'warn', build: { target: 'es2022' } });
  const assets = join(root, 'dist/assets');
  const files = await readdir(assets);
  for (const [extension, packaged] of [
    ['wasm', 'mann-fft.wasm'],
    ['js', 'workers/mann-fft.js'],
  ]) {
    const match = files.filter((name) => name.startsWith('mann-fft-') && name.endsWith('.' + extension));
    assert.equal(match.length, 1, `Expected one built Mann FFT ${extension} asset.`);
    assert.deepEqual(
      await readFile(join(assets, match[0])),
      await readFile(new URL(`../dist/${packaged}`, import.meta.url)),
    );
  }
  // Vite's library mode inlines even large assets unless the published URL keeps no-inline.
  const library = await build({
    root,
    configFile: false,
    publicDir: false,
    logLevel: 'warn',
    build: { write: false, lib: { entry: join(root, 'index.js'), formats: ['es'], fileName: 'mann-consumer' } },
  });
  const libraryFiles = [library].flat().flatMap(({ output }) => output);
  const libraryWasm = libraryFiles.find((file) => file.type === 'asset' && /mann-fft.*\.wasm$/.test(file.fileName));
  assert.ok(libraryWasm, 'The built library must keep Mann Wasm in a separate asset.');
  assert.deepEqual(Buffer.from(libraryWasm.source), await readFile(new URL('../dist/mann-fft.wasm', import.meta.url)));
  const app = await preview({ root, configFile: false, logLevel: 'warn', preview: { host: '127.0.0.1', port: 0 } });
  try {
    const { page, close } = await openBrowser({
      startPath: '/tools/shot/blank.html',
      port: 'free',
      softwareAdapterOk: true,
    });
    try {
      const address = app.httpServer.address();
      assert.ok(address && typeof address === 'object');
      await page.goto('http://127.0.0.1:' + address.port + '/');
      const result = await page.evaluate(() =>
        Promise.race([
          window.mannFftProof,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('The packaged Mann FFT helpers did not finish.')), 20_000),
          ),
        ]),
      );
      assert.ok(result.allBytesExact && result.signedSampleExact);
      assert.equal(result.participants, 2);
      assert.equal(result.work.workers, 2);
      assert.equal(result.work.transforms, 6);
      assert.equal(result.work.complexValues, 48_600);
      assert.equal(result.work.simdTwiddleProducts, 1_652_400);
      assert.deepEqual(
        result.work.participants.map(({ transforms }) => transforms),
        [2, 2, 2],
      );
      assert.equal(result.failure?.code, 'failed');
      assert.match(result.failure.message, /bundled Mann FFT worker.*threads: 1/);
      console.log('ATMO-02 built Chromium Mann FFT work', result.work);
    } finally {
      await close();
    }
  } finally {
    await app.close();
  }
} finally {
  // mkdtemp created this exact child of the ignored test-results directory.
  await rm(root, { recursive: true, force: true });
}
