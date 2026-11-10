// Correctness preflight for tonight's matrix. No timing samples or speed-phase override.
// node scripts/gpu-lock.mjs run --owner=parity-smoke --max=30 -- node scripts/parity-smoke-browser.mjs --runs=1
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { buildPages, browserSession, externalEngines, serve } from '../bench/lib/browser.mjs';
import { root } from '../bench/lib/env.mjs';
import { SCENES, caseId, sceneParams } from '../bench/scenes/catalog.js';
import { parityCases } from '../bench/scenes/parity.js';
import { browserLabel } from './lib/browser.mjs';

const { values: o } = parseArgs({
  options: {
    runs: { type: 'string', default: '1' },
    engines: { type: 'string', default: 'margo,three-webgpu-parity,three-webgl-parity' },
    'engine-bench': { type: 'string', default: resolve(root, '../engine-bench') },
    cases: { type: 'string' },
    out: { type: 'string', default: 'test-results/bp-159-smoke.json' },
  },
});
if (o.runs !== '1') throw new RangeError('Correctness preflight requires --runs=1; use bench/cli.mjs for timing');
if (!process.env.MARGO_GPU_LOCK_NESTED) throw new Error('Run through scripts/gpu-lock.mjs run');
const engines = o.engines.split(',');
if (engines.some((e) => !['margo', 'three-webgpu-parity', 'three-webgl-parity'].includes(e)))
  throw new RangeError('Unknown parity engine');
const external = externalEngines(resolve(o['engine-bench']));
const filters = o.cases?.split(',');
const cases = parityCases(SCENES).filter((c) => !filters || filters.includes(caseId(c.scene, c.params)));
if (!cases.length) throw new RangeError('No parity cases selected');
const out = resolve(root, o.out);
mkdirSync(resolve(out, '..'), { recursive: true });
const record = { schema: 1, kind: 'correctness-smoke', runs: 1, engines, cases: [] };
const save = () => writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);
let server, session;
try {
  await buildPages({ engines, external, log: console.error });
  server = await serve({ port: 0, external });
  session = browserSession({ channel: browserLabel(), base: server.url, log: console.error });
  for (const c of cases) {
    for (const engine of engines) {
      const id = caseId(c.scene, c.params);
      let entry;
      try {
        const r = await session.run({
          engine,
          scene: c.scene,
          params: sceneParams(c.scene, c.params),
          harness: { smoke: 1 },
        });
        entry = {
          id,
          engine,
          status: r.unsupported ? 'unsupported' : r.error || r.errors?.length || r.pageErrors?.length ? 'error' : 'ok',
          calls: r.calls ?? 0,
          work: r.work,
          output: r.output,
          info: r.info,
          errors: [r.error, ...(r.errors ?? []), ...(r.pageErrors ?? [])].filter(Boolean),
        };
      } catch (error) {
        entry = { id, engine, status: 'error', errors: [String(error.stack ?? error)] };
      }
      record.cases.push(entry);
      save();
      console.log(`${id}@${engine}: ${entry.status}${entry.errors.length ? ` ${entry.errors[0].split('\n')[0]}` : ''}`);
    }
  }
} finally {
  await session?.close();
  await server?.close();
}
if (record.cases.some((c) => c.status === 'error')) process.exitCode = 1;
