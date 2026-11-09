import { deferSpeed, isSpeedEntry } from '../../../scripts/support/speed-phase.mjs';
if (
  isSpeedEntry(import.meta.url) &&
  !process.argv.some((arg) => ['--help', '-h', '--list'].includes(arg)) &&
  deferSpeed('packages/sky/scripts/rival-bench.mjs')
)
  process.exit(0);
// GPU Preetham radiance against a black-box Mitsuba sunsky evaluation outside the repo.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { skyCases, radianceError } from './sunsky-scene.mjs';

const root = process.env.MARGO_ENGINE_BENCH ?? 'C:\\Development\\Projects\\engine-bench';
const external = join(root, 'batch-168');
const python = process.env.MARGO_MITSUBA_PYTHON ?? join(external, 'mitsuba-venv', 'Scripts', 'python.exe');
const out = join(external, 'data', 'sunsky');
mkdirSync(out, { recursive: true });
const cases = skyCases();
writeFileSync(join(out, 'cases.json'), JSON.stringify(cases));
execFileSync(
  python,
  [fileURLToPath(new URL('./mitsuba-sunsky.py', import.meta.url)), join(out, 'cases.json'), join(out, 'mitsuba.json')],
  { cwd: external, timeout: 120_000, stdio: 'inherit', windowsHide: true },
);
const reference = JSON.parse(readFileSync(join(out, 'mitsuba.json'), 'utf8'));
const context = await openBrowser({ startPath: '/packages/sky/scripts/sunsky.html', port: 'free' });
try {
  await context.page.waitForFunction(() => window.skyRadiance, null, { timeout: 30_000 });
  const ours = await context.page.evaluate((cases) => window.skyRadiance(cases), cases);
  const rows = cases.map((c, i) => ({
    elevation: c.elevation,
    turbidity: c.turbidity,
    samples: c.directions.length,
    ...radianceError(ours[i], reference.radiance[i]),
  }));
  const result = {
    version: reference.version,
    variant: reference.variant,
    normalization: 'each sky zenith luminance',
    rows,
    mae: rows.reduce((s, r) => s + r.mae, 0) / rows.length,
    max: Math.max(...rows.map((r) => r.max)),
  };
  writeFileSync(
    join(out, 'comparison.json'),
    JSON.stringify({ ...result, cases, margo: ours, reference: reference.radiance }, null, 2),
  );
  console.log(`RESULT ${JSON.stringify(result)}`);
} finally {
  await context.close();
}
