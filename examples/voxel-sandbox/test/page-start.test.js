import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// The page's own start script, run as written with the gate and the game's import stubbed. A visitor without WebGPU has
// no navigator.gpu when the script starts and gets one from the WebGL2 layer during the gate: the game must still start.
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8'),
  script = /<script type="module">([\s\S]*?)<\/script>/.exec(html)[1];

async function runPage({ gpu, gate }) {
  const log = [],
    body = script
      .replace(/import \{ needsWebGPU \} from '[^']+';/, '')
      .replaceAll("import('./src/main.ts')", 'load()')
      .replace('needsWebGPU(', 'return needsWebGPU(');
  assert.match(body, /load\(\)/, 'the page imports the game');
  const load = () => {
    log.push('load');
    return Promise.resolve({ start: () => log.push('start') });
  };
  const needsWebGPU = async () => {
    log.push('gate');
    return gate;
  };
  await new Function('navigator', 'performance', 'needsWebGPU', 'load', body)(
    { gpu },
    { mark() {} },
    needsWebGPU,
    load,
  );
  return log;
}

test('with WebGPU the game downloads while the gate runs and starts once', async () => {
  assert.deepEqual(await runPage({ gpu: {}, gate: true }), ['load', 'gate', 'start']);
});

test('without WebGPU the game starts on the WebGL2 layer the gate installed', async () => {
  assert.deepEqual(await runPage({ gpu: undefined, gate: true }), ['gate', 'load', 'start']);
});

test('with neither WebGPU nor the layer the game never downloads', async () => {
  assert.deepEqual(await runPage({ gpu: undefined, gate: false }), ['gate']);
});
