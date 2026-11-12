// check:owners. CPU work never holds a GPU slot. Each browser leaf takes one shared slot, released between leaves.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runLimited } from './support/run-limited.mjs';
import { OWNER_FIXTURES, ownerLeaves, pendingLine, selectOwnerPackages } from './support/owner-lifetime-registry.mjs';
import { exitOnHelp } from './support/help.mjs';

exitOnHelp('usage: node scripts/check-owner-lifetime-gate.mjs [--packages=a,b] [--cpu-only]\n' +
  'Runs the owner/lifetime fixtures of the selected packages (all workspaces by default): the CPU model, then a real\n' +
  'WebGPU device and the WebGL2 compatibility layer per package. Packages with no fixture are printed as pending.');
const root = fileURLToPath(new URL('..', import.meta.url));
// Plain literals: the check:merge footprint follows them to the harness files these leaves import.
const CPU_ENTRY = 'scripts/check-owner-lifetime.mjs';
const GPU_ENTRY = 'scripts/check-owner-lifetime-browser.mjs';
const given = process.argv.find((a) => a.startsWith('--packages='))?.slice(11);
const { selected, pending } = selectOwnerPackages(given === undefined
  ? JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).workspaces
    .filter((p) => p.startsWith('packages/')).map((p) => p.slice(9))
  : given.split(',').filter(Boolean));
if (pending.length) console.log(pendingLine(pending));
if (selected.length) {
  const selection = `--packages=${selected.join(',')}`;
  const cpu = await runLimited(`node ${CPU_ENTRY} ${selection}`,
    { cwd: root, limitMs: 130000, label: 'owner/lifetime CPU' });
  if (!cpu.ok) { console.error(cpu.message ?? 'Owner/lifetime CPU failed'); process.exitCode = 1; }
  else if (!process.argv.includes('--cpu-only')) {
    // A fixture with leafPerEntry runs one leaf per entry (post: all 31 entries took 208 s on the WebGL2 layer of a
    // Radeon 680M, past the 180 s limit), so each leaf fits the limit and the slot is shared between entries.
    const leaves = {};
    for (const name of selected) leaves[name] = await ownerLeaves(await import(pathToFileURL(join(root, OWNER_FIXTURES[name])).href));
    gpu: for (const name of selected) for (const compat of [false, true]) for (const entry of leaves[name]) {
      const which = entry === undefined ? name : `${name}/${entry}`;
      const label = `owner/lifetime GPU ${which}${compat ? ' (WebGL2 compatibility)' : ''}`;
      const gpu = await runLimited('node scripts/gpu-lock.mjs run --owner=check-owner-lifetime --wait-max=60 ' +
        // Measured 2026-11-10 (busy dev PC): animation, the largest, 45 s native and 69 s on the WebGL2 layer. The
        // leaf ends itself at 180 s, so the slot is held for 3 minutes at most.
        '--max=3 --gpu=owner-lifetime-real-render-device-loss -- ' +
        `node ${GPU_ENTRY} --packages=${name}${entry === undefined ? '' : ` --entry=${JSON.stringify(entry)}`}`,
        { cwd: root, limitMs: 62 * 60000, label, env: compat ? { ...process.env, MARGO_COMPAT: '1' } : process.env });
      if (!gpu.ok) {
        console.error(gpu.message ?? `${label} failed`);
        process.exitCode = 1;
        break gpu;
      }
    }
  }
} else console.log('Owner/lifetime: no selected package has a fixture');
