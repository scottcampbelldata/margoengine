import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { exerciseLifetime, lifecycleCases } from '../tests/support/owner-lifetime.js';
import { nodeLifetimeAdapter } from '../tests/support/owner-lifetime-node.js';
import { OWNER_FIXTURES, pendingLine, selectOwnerPackages } from './support/owner-lifetime-registry.mjs';
import { exitOnHelp } from './support/help.mjs';

const root = resolve(import.meta.dirname, '..');
export async function runOwners({ packages, moduleRoots = {}, adapter, report = console.log }) {
  const results = [], failures = [], { selected, pending } = selectOwnerPackages(packages);
  for (const name of selected) {
    const file = pathToFileURL(resolve(root, OWNER_FIXTURES[name]));
    const { fixtures } = await import(file.href);
    const load = (entry) => import(new URL(entry.replace('../dist/', moduleRoots[name] ?? '../dist/'), file).href);
    const entries = await fixtures(load);
    if (!entries.length) throw new Error(`OWNER_FIXTURE_EMPTY: ${name}`);
    for (const fixture of entries) for (const target of ['default', 'secondary']) for (const mode of lifecycleCases) {
      if (target === 'default' && mode === 'scene') continue;
      try {
        results.push({ package: name, ...await exerciseLifetime(fixture, adapter, { target, mode }) });
      } catch (error) {
        const failure = { package: name, fixture: fixture.name, target, mode, error: error.stack };
        failures.push(failure);
        report(`FAIL ${name}/${fixture.name}/${target}/${mode}: ${error.message}`);
      }
    }
  }
  return { results, failures, pending };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  exitOnHelp('usage: node scripts/check-owner-lifetime.mjs [--packages=a,b] [--module-root=package:absolute-url/]');
  const selected = process.argv.find((a) => a.startsWith('--packages='))?.slice(11);
  const packages = selected?.split(',') ?? JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).workspaces
      .filter((p) => p.startsWith('packages/')).map((p) => p.slice(9));
  const moduleRoots = Object.fromEntries(process.argv.filter((a) => a.startsWith('--module-root=')).map((a) => {
    const value = a.slice(14), colon = value.indexOf(':');
    return [value.slice(0, colon), value.slice(colon + 1)];
  }));
  const adapter = await nodeLifetimeAdapter();
  const timer = setTimeout(() => { console.error('OWNER_LIFETIME_TIMEOUT: 120 seconds'); process.exit(1); }, 120_000);
  try {
    const receipt = await runOwners({ packages, moduleRoots, adapter });
    mkdirSync(resolve(root, 'test-results'), { recursive: true });
    writeFileSync(resolve(root, 'test-results/owner-lifetime.json'), JSON.stringify(receipt, null, 2) + '\n');
    console.log(`Owner/lifetime: ${receipt.results.length} passed, ${receipt.failures.length} failed`);
    if (receipt.pending.length) console.log(pendingLine(receipt.pending));
    process.exitCode = receipt.failures.length ? 1 : 0;
  } finally { clearTimeout(timer); adapter.close(); }
}
