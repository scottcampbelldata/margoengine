// One full CPU-only catalog task each. Sample counts diagnose code; they are not speed results.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { profileTask } from '../bench/lib/profile-task.mjs';
import { SCENES, sceneParams } from '../bench/scenes/catalog.js';

const areas = {
  'p-math': 'core',
  'p-primitives': 'geometry',
  'p-extrude': 'geometry',
  'p-geometry-utils': 'geometry',
  'p-geometry-misc': 'geometry',
  'p-cube-lut': 'loaders',
  'p-mtl': 'loaders',
  'p-export-mesh': 'exporters',
};
const { values: o } = parseArgs({
  options: {
    cases: { type: 'string', default: Object.keys(areas).join(',') },
    out: { type: 'string', default: 'test-results/bp-159-task-profiles.json' },
  },
});
const selected = o.cases.split(',');
if (selected.some((s) => !areas[s])) throw new RangeError('Select a supported CPU-only task from this script');
const records = [];
const rootURL = pathToFileURL(`${resolve('.')}${sep}`).href;
const target = resolve(o.out);
mkdirSync(resolve(target, '..'), { recursive: true });
for (const scene of selected) {
  const data = await SCENES[scene].data(sceneParams(scene), { assets: '/examples/assets/' });
  const { builders } = await import(`../bench/scenes/parity/margo-${areas[scene]}.js`);
  const app = await builders[scene](null, data, {});
  const samples = (await profileTask((i) => app.task(i))).map((s) => ({ ...s, url: s.url.replace(rootURL, '') }));
  records.push({ scene, calls: 1, output: await app.output?.(), samples });
  writeFileSync(target, `${JSON.stringify({ kind: 'diagnostic-cpu-samples', records }, null, 2)}\n`);
  console.log(`${scene}: one call profiled`);
}
