import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { packageOrder } from '../scripts/package-order.js';

const manifest = (name, peers = [], deps = [], dev = []) => ({
  name,
  peerDependencies: Object.fromEntries(peers.map((peer) => [peer, '*'])),
  dependencies: Object.fromEntries(deps.map((dep) => [dep, '*'])),
  devDependencies: Object.fromEntries(dev.map((dep) => [dep, '*'])),
});

test('every workspace package builds after the packages it declares', async () => {
  const root = new URL('../', import.meta.url),
    manifests = new Map();
  for (const dir of JSON.parse(await readFile(new URL('package.json', root), 'utf8')).workspaces.filter((dir) =>
    dir.startsWith('packages/'),
  ))
    manifests.set(
      dir.slice('packages/'.length),
      JSON.parse(await readFile(new URL(`${dir}/package.json`, root), 'utf8')),
    );
  const order = packageOrder(manifests),
    position = new Map(order.map((dir, index) => [dir, index]));
  assert.equal(order.length, manifests.size);
  const byName = new Map([...manifests].map(([dir, { name }]) => [name, dir]));
  for (const [dir, { dependencies, peerDependencies, devDependencies }] of manifests)
    for (const name of Object.keys({ ...dependencies, ...peerDependencies, ...devDependencies }))
      if (byName.has(name))
        assert.ok(position.get(byName.get(name)) < position.get(dir), `${dir} must build after ${name}`);
  assert.ok(position.get('bvh') < position.get('controls') && position.get('geometry') < position.get('machinery'));
});

test('dev and runtime dependencies order too; unrelated packages keep workspace order', () => {
  const order = packageOrder(
    new Map([
      ['b', manifest('@margoengine/b', [], ['margoengine'])],
      ['c', manifest('@margoengine/c')],
      ['stage', manifest('margoengine', [], [], ['@margoengine/a'])],
      ['a', manifest('@margoengine/a', ['three'])],
    ]),
  );
  assert.deepEqual(order, ['a', 'stage', 'b', 'c']);
});

test('a cycle fails and names its members', () => {
  assert.throws(
    () =>
      packageOrder(
        new Map([
          ['x', manifest('@margoengine/x')],
          ['a', manifest('@margoengine/a', ['@margoengine/b'])],
          ['b', manifest('@margoengine/b', [], ['@margoengine/c'])],
          ['c', manifest('@margoengine/c', [], [], ['@margoengine/a'])],
        ]),
      ),
    /cycle: a -> b -> c -> a/,
  );
});
