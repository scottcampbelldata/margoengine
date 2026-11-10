// Registry publication is performed only by the separately approved release workflow.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { packageOrder, packageDependencies } from './package-order.js';
import { isInstallKit } from './umbrella.mjs';

/** Leaf implementations, then install profiles, then the install-everything facade. */
export function publishOrder(manifests) {
  const sorted = packageOrder(manifests);
  const kits = (name) => isInstallKit(manifests.get(name).name);
  const order = [
    ...sorted.filter((name) => name !== 'margoengine' && !kits(name)),
    ...sorted.filter(kits),
    ...sorted.filter((name) => name === 'margoengine'),
  ];
  for (const [name, needs] of packageDependencies(manifests))
    for (const dependency of needs)
      assert.ok(order.indexOf(dependency) < order.indexOf(name), `${dependency} must publish before ${name}`);
  return order;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = new URL('../', import.meta.url);
  const directories = JSON.parse(readFileSync(new URL('package.json', root))).workspaces.filter((p) =>
    p.startsWith('packages/'),
  );
  const manifests = new Map(
    directories.map((path) => [
      path.slice('packages/'.length),
      JSON.parse(readFileSync(new URL(path + '/package.json', root))),
    ]),
  );
  process.stdout.write(
    publishOrder(manifests)
      .map((name) => `packages/${name}`)
      .join('\n') + '\n',
  );
}
