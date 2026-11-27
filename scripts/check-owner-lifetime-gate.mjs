// check:owners.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { failureLine, runLimited } from './support/run-limited.mjs';
import {
  CPU_LIMIT_MS,
  OWNER_FIXTURES,
  cpuRuns,
  ownerLeaves,
  pendingLine,
  selectOwnerPackages,
} from './support/owner-lifetime-registry.mjs';
import { showHelp } from './support/help.mjs';

if (
  !showHelp(
    'usage: node scripts/check-owner-lifetime-gate.mjs [--packages=a,b] [--cpu-only]\n' +
      'Runs the owner/lifetime fixtures of the selected packages (all workspaces by default): the CPU model, then a real\n' +
      'WebGPU device and the WebGL2 compatibility layer per package. Packages with no fixture are printed as pending.',
  )
) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  // Plain literals: the check:merge footprint follows them to the harness files these leaves import.
  const CPU_ENTRY = 'scripts/check-owner-lifetime.mjs';
  const GPU_ENTRY = 'scripts/check-owner-lifetime-browser.mjs';
  const given = process.argv.find((a) => a.startsWith('--packages='))?.slice(11);
  const { selected, pending } = selectOwnerPackages(
    given === undefined
      ? JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
          .workspaces.filter((p) => p.startsWith('packages/'))
          .map((p) => p.slice(9))
      : given.split(',').filter(Boolean),
  );
  if (pending.length) console.log(pendingLine(pending));
  if (selected.length) {
    // One CPU run per package, each under its own limit (cpuRuns); the outer limit is 10 s past the run's own timer.
    let cpuOk = true;
    for (const run of cpuRuns(selected)) {
      const cpu = await runLimited(`node ${CPU_ENTRY} --packages=${run.join(',')}`, {
        cwd: root,
        limitMs: CPU_LIMIT_MS + 10000,
        label: `owner/lifetime CPU ${run.join(',')}`,
      });
      if (!cpu.ok) {
        console.error(failureLine(`Owner/lifetime CPU ${run.join(',')}`, cpu));
        process.exitCode = 1;
        cpuOk = false;
        break;
      }
    }
    // The GPU leaves run only once every CPU run has passed.
    if (cpuOk && !process.argv.includes('--cpu-only')) {
      // A fixture with leafPerEntry or leafCases runs several leaves (post: all 31 entries took 208 s on the WebGL2 layer
      // of a Radeon 680M, past the 180 s limit), so each leaf fits the limit. leafCases packs several entries into one
      // leaf, so a large fixture does not start a dev server and browser per entry (water's 35 entries, one leaf each,
      // ran past the gate's 10 minutes on 2026-11-18).
      const leaves = {};
      for (const name of selected)
        leaves[name] = await ownerLeaves(await import(pathToFileURL(join(root, OWNER_FIXTURES[name])).href));
      gpu: for (const name of selected)
        for (const compat of [false, true])
          for (const entry of leaves[name]) {
            const which =
              entry === undefined
                ? name
                : `${name}/${entry.length === 1 ? entry[0] : `${entry[0]} +${entry.length - 1}`}`;
            const label = `owner/lifetime GPU ${which}${compat ? ' (WebGL2 compatibility)' : ''}`;
            const gpu = await runLimited(
              'node scripts/run-with-timeout.mjs ' +
                // Measured 2026-11-10 (busy workstation): animation, the largest, 45 s native and 69 s on the WebGL2 layer. The
                // leaf ends itself at 180 s.
                '--max=3 -- ' +
                `node ${GPU_ENTRY} --packages=${name}${entry === undefined ? '' : entry.map((e) => ` --entry=${JSON.stringify(e)}`).join('')}`,
              {
                cwd: root,
                limitMs: 14 * 60000,
                label,
                env: compat ? { ...process.env, MARGO_COMPAT: '1' } : process.env,
              },
            );
            if (!gpu.ok) {
              console.error(failureLine(label, gpu));
              process.exitCode = 1;
              break gpu;
            }
          }
    }
  } else console.log('Owner/lifetime: no selected package has a fixture');
}
