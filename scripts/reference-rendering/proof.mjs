// Complete frozen reference scenes, exact repeats across three fresh browser processes; GPU lock required.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openBrowser } from '../browser.js';
import { runSuite } from '../support/shutdown.mjs';
import { prepareScene } from './scene.mjs';
import { referenceCase } from './cases.mjs';
import { decodePNG } from '../../tests/support/png.js';
import { pictureError } from './compare.mjs';
import { assertReferenceProof } from './proof-contract.mjs';

const family = process.argv.find((arg) => arg.startsWith('--case='))?.slice(7) ?? 'volume';
const entry = referenceCase(family);
const root = join(process.env.MARGO_ENGINE_BENCH ?? 'C:/Development/Projects/engine-bench', 'batch-160');
const out = join(
  root,
  family,
  `proof-${process.argv.includes('--compat') ? 'compat' : 'native'}-${Date.now()}-${process.pid}`,
);
mkdirSync(out, { recursive: true });
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const input = readFileSync(join(root, entry.model, `${entry.model}.glb`));
assert.equal(sha(input), entry.sourceSha256);
const scene = prepareScene(input, entry);
const baseline = JSON.parse(readFileSync(`docs/whitepaper/results/batch-160-${family}.json`));
const compat = process.argv.includes('--compat');
assert.equal(sha(scene.bytes), baseline.sceneSha256);
const references = [];
const add = async (name, path, hash, budget) => {
  const bytes = readFileSync(path);
  assert.equal(sha(bytes), hash);
  references.push({ name, hash, budget, image: await decodePNG(bytes) });
};
await add(
  'viewer',
  join(root, family, 'sample-viewer.png'),
  baseline.referenceSha256,
  compat ? baseline.compat.metrics : baseline.metrics,
);
if (family === 'volume' || family === 'transmission') {
  const transport = JSON.parse(readFileSync(`docs/whitepaper/results/batch-160-${family}-transport.json`));
  for (const [mode, row] of Object.entries(transport.rows)) {
    await add(
      mode,
      join(root, family, mode === 'full' ? 'cycles.png' : 'cycles-direct.png'),
      row.referenceSha256,
      compat ? row.compat.metrics : row.metrics,
    );
  }
}
const runs = [];
for (let processIndex = 0; processIndex < 3; processIndex++) {
  const context = await openBrowser({ startPath: '/scripts/reference-rendering/proof.html', port: 'free' });
  await runSuite(
    async () => {
      await context.page.waitForFunction(() => window.repeatReference, null, { timeout: 30000 });
      let timer;
      let shots;
      try {
        shots = await Promise.race([
          context.page.evaluate(({ bytes, settings }) => window.repeatReference(bytes, settings), {
            bytes: Array.from(scene.bytes),
            settings: { ...entry.settings, powerPreference: process.env.GPU_POWER },
          }),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Reference proof exceeded 120-second deadline')), 120000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      const rows = [];
      for (const shot of shots) {
        const png = Buffer.from(shot.png.split(',')[1], 'base64');
        const actual = await decodePNG(png);
        writeFileSync(join(out, `${processIndex}-${shot.device}-${shot.frame}.png`), png);
        rows.push({
          device: shot.device,
          frame: shot.frame,
          primitives: shot.primitives,
          adapter: shot.adapter,
          width: actual.width,
          height: actual.height,
          sha256: sha(actual.data),
          metrics: Object.fromEntries(references.map((ref) => [ref.name, pictureError(actual, ref.image)])),
        });
      }
      runs.push({ processIndex, hardware: context.hardware, rows });
    },
    () => context.close(),
  );
}
const report = {
  family,
  compat,
  out,
  sourceSha256: sha(input),
  sceneSha256: sha(scene.bytes),
  references: references.map(({ name, hash, budget }) => ({ name, hash, budget })),
  runs,
};
writeFileSync(join(out, 'proof.json'), JSON.stringify(report, null, 2) + '\n');
console.log(
  'RESULT',
  JSON.stringify({
    family,
    compat,
    out,
    variants: new Set(runs.flatMap((run) => run.rows.map((row) => row.sha256))).size,
    runs: runs.map((run) => ({ hardware: run.hardware, first: run.rows[0] })),
  }),
);
assertReferenceProof(report, baseline, references, process.env.MARGO_GPU);
