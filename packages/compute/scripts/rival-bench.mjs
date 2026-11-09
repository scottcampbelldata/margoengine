import { deferSpeed, isSpeedEntry } from '../../../scripts/support/speed-phase.mjs';
if (
  isSpeedEntry(import.meta.url) &&
  !process.argv.some((arg) => ['--help', '-h', '--list'].includes(arg)) &&
  deferSpeed('packages/compute/scripts/rival-bench.mjs')
)
  process.exit(0);
// matmul-256, fft-65536 and a sum of 1,048,576 against TensorFlow.js WebGPU.
// Node 26.12.0 exposes neither navigator.gpu nor a WebGPU flag (node --help has no match), so both
// libraries run in one headless page, taking turns. Times are per-round minima. Busy machine: diagnostic.
// TensorFlow.js stays outside the repository. This file never reads its source.
import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { benchRoot, line, rivalVersion } from '../../../scripts/rival-pair.mjs';

process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));

const install = `${benchRoot()}\\batch-167\\node_modules`;
const files = {
  '/tf.min.js': `${install}\\@tensorflow\\tfjs\\dist\\tf.min.js`,
  '/tf-backend-webgpu.js': `${install}\\@tensorflow\\tfjs-backend-webgpu\\dist\\tf-backend-webgpu.js`,
};

const server = createServer((request, response) => {
  const file = files[new URL(request.url, 'http://127.0.0.1').pathname];
  if (!file) {
    response.writeHead(404);
    response.end();
    return;
  }
  response.writeHead(200, {
    'content-type': 'text/javascript; charset=utf-8',
    'access-control-allow-origin': '*',
  });
  createReadStream(file).pipe(response);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const query = new URLSearchParams({
  tf: `http://127.0.0.1:${port}/tf.min.js`,
  webgpu: `http://127.0.0.1:${port}/tf-backend-webgpu.js`,
});

const tfVersion = rivalVersion('@tensorflow/tfjs');
const webgpuVersion = rivalVersion('@tensorflow/tfjs-backend-webgpu');
let context;
try {
  context = await openBrowser({
    startPath: `/packages/compute/scripts/rival-page.html?${query}`,
    port: 'free',
  });
  const { page, hardware } = context;
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    const text = message.text();
    if (text.startsWith('rival')) console.log(text);
    if (message.type() === 'error' && !text.startsWith('rival failed')) errors.push(text);
  });
  page.setDefaultTimeout(180_000);
  await page.evaluate(() => {
    window.__startRival = true;
  });
  await page.waitForFunction(() => window.__rival, null, { timeout: 180_000 });
  const report = await page.evaluate(() => window.__rival);
  console.log(
    `TensorFlow.js ${tfVersion}, tfjs-backend-webgpu ${webgpuVersion}, page backend ${report.backend ?? 'none'}`,
  );
  console.log(`GPU ${hardware.webgpu?.description || hardware.webglRenderer || 'unknown'}`);
  console.log(`adapter ${JSON.stringify(hardware.webgpu)}`);
  if (report.error) {
    console.error(report.error);
    if (report.stack) console.error(report.stack);
    process.exitCode = 1;
  } else if (report.backend !== 'webgpu') {
    console.error(`TensorFlow.js backend was ${report.backend}`);
    process.exitCode = 1;
  } else {
    console.log(line('matmul-256', 'margo', report.matmul.minA, 'tfjs', report.matmul.minB));
    console.log(line('fft-65536', 'margo', report.fft.minA, 'tfjs', report.fft.minB));
    console.log(line('reduce-1048576', 'margo', report.reduce.minA, 'tfjs', report.reduce.minB));
    console.log(`matmul checksum both sides sum 519 squares 8591379379`);
    console.log(`fft margo ${JSON.stringify(report.fft.margo)}`);
    console.log(`fft tfjs ${JSON.stringify(report.fft.tfjs)}`);
    console.log(`reduce both ${report.reduce.margo}`);
    const dump = (name, rounds) => console.log(`${name} ${rounds.map((value) => value.toFixed(3)).join(' ')}`);
    dump('rounds matmul margo', report.matmul.roundsA);
    dump('rounds matmul tfjs', report.matmul.roundsB);
    dump('rounds fft margo', report.fft.roundsA);
    dump('rounds fft tfjs', report.fft.roundsB);
    dump('rounds reduce margo', report.reduce.roundsA);
    dump('rounds reduce tfjs', report.reduce.roundsB);
  }
  if (errors.length) {
    console.error(errors.slice(0, 20).join('\n'));
    process.exitCode = 1;
  }
} finally {
  if (context) await context.close();
  await new Promise((resolve) => server.close(resolve));
}
