import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { openBrowser } from './browser.js';
import { acquire } from './gpu-lock.mjs';
import { runScene } from './support/composition-run.mjs';

const scenes = ['game', 'sciviz', 'engineering'];
const given = process.argv.find((arg) => arg.startsWith('--scene='))?.slice(8);
assert.ok(!given || scenes.includes(given), `unknown integration scene ${given}`);
const results = [];
const release = await acquire({ owner: 'integration-everything', waitMax: 1 });
try {
  for (const id of given ? [given] : scenes) {
    for (const compat of [false, true]) {
      const browser = await openBrowser({
        startPath: `/examples/test-pages/integration-${id}.html`,
        port: 'free',
        compat,
      });
      const errors = [];
      browser.page.on('pageerror', (error) => errors.push(error.message));
      try {
        await browser.page.waitForFunction(() => !!window.integration, null, { timeout: 60_000 });
        const result = await runScene(() => browser.page.evaluate(() => window.integration.run()), {
          label: `${id} ${compat ? 'webgl2' : 'webgpu'}`,
        });
        assert.deepEqual(errors, [], `${id}: browser errors`);
        assert.deepEqual(result.errors, []);
        if (compat) assert.deepEqual(result.before, results.at(-1).before, `${id}: backend probe parity`);
        results.push({ backend: compat ? 'webgl2-compat' : 'webgpu', ...result });
        console.log(`PASS ${id} ${compat ? 'webgl2-compat' : 'webgpu'} ${JSON.stringify(result)}`);
      } finally {
        await browser.close();
      }
    }
  }
  mkdirSync('test-results', { recursive: true });
  writeFileSync(`test-results/integration-${given ?? 'all'}.json`, `${JSON.stringify(results, null, 2)}\n`);
} finally {
  await release();
}
