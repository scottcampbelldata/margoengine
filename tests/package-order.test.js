import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { sep } from 'node:path';
import test from 'node:test';
import { buildInDependencyOrder, packageDependencies, packageOrder } from '../scripts/package-order.js';

const manifest = (name, peers = [], deps = [], dev = []) => ({
  name,
  peerDependencies: Object.fromEntries(peers.map((peer) => [peer, '*'])),
  dependencies: Object.fromEntries(deps.map((dep) => [dep, '*'])),
  devDependencies: Object.fromEntries(dev.map((dep) => [dep, '*'])),
});

// Regression (2026-11-05): staging's bundle takes packages/shared/caster.js, which imports @margoengine/math, without
// declaring math, so a parallel build started it while math's dist was being rewritten and failed now and then.
test('a package declares every package its packages/shared imports reach', async () => {
  const root = new URL('../', import.meta.url),
    shared = new URL('packages/shared/', root),
    reached = new Map();
  const reach = async (file) => {
    if (reached.has(file)) return reached.get(file);
    const names = new Set();
    reached.set(file, names);
    const text = await readFile(new URL(file, shared), 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    for (const [, name] of text.matchAll(/from '(@margoengine\/[\w-]+)/g)) names.add(name);
    for (const [, next] of text.matchAll(/from '\.\/([\w.-]+\.js)'/g)) for (const name of await reach(next)) names.add(name);
    return names;
  };
  const missing = [];
  for (const dir of await readdir(new URL('packages/', root))) {
    const manifest = await readFile(new URL(`packages/${dir}/package.json`, root), 'utf8').catch(() => null);
    if (!manifest) continue;
    const { name, dependencies, peerDependencies, devDependencies } = JSON.parse(manifest),
      declared = { ...dependencies, ...peerDependencies, ...devDependencies };
    const sources = await readdir(new URL(`packages/${dir}/src/`, root), { recursive: true }).catch(() => []);
    for (const source of sources.filter((file) => /\.tsx?$/.test(file))) {
      const text = await readFile(new URL(`packages/${dir}/src/${source.split(sep).join('/')}`, root), 'utf8');
      for (const [, file] of text.matchAll(/'(?:\.\.\/)+shared\/([\w.-]+\.js)'/g))
        for (const needed of await reach(file))
          if (needed !== name && !(needed in declared)) missing.push(`${name} needs ${needed} through shared/${file}`);
    }
  }
  assert.deepEqual([...new Set(missing)], []);
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
  assert.ok(position.get('bvh') < position.get('controls') && position.get('geometry') < position.get('terrain'));
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

test('the parallel build starts a package only after its dependencies, never exceeds the job limit and builds each once', async () => {
  const manifests = new Map(),
    root = new URL('../', import.meta.url);
  for (const dir of JSON.parse(await readFile(new URL('package.json', root), 'utf8')).workspaces.filter((dir) =>
    dir.startsWith('packages/'),
  ))
    manifests.set(
      dir.slice('packages/'.length),
      JSON.parse(await readFile(new URL(`${dir}/package.json`, root), 'utf8')),
    );
  const dependencies = packageDependencies(manifests),
    names = packageOrder(manifests);
  for (const jobs of [1, 3, 8]) {
    const started = [],
      finished = new Set();
    let active = 0,
      peak = 0;
    await buildInDependencyOrder(names, dependencies, jobs, async (name) => {
      for (const dep of dependencies.get(name)) assert.ok(finished.has(dep), `${name} started before ${dep} finished`);
      started.push(name);
      active++;
      peak = Math.max(peak, active);
      await new Promise((done) => setTimeout(done, Math.random() * 3));
      active--;
      finished.add(name);
    });
    assert.deepEqual([...started].sort(), [...names].sort(), `jobs=${jobs}: every package builds exactly once`);
    assert.ok(peak <= jobs, `jobs=${jobs}: peak ${peak}`);
    if (jobs > 1) assert.ok(peak > 1, 'independent packages should overlap');
  }
});

test('a narrowed build retains dependency paths through unselected packages', async () => {
  const dependencies = new Map([
    ['consumer', new Set(['bridge'])],
    ['bridge', new Set(['provider'])],
    ['provider', new Set()],
    ['independent', new Set(['prebuilt'])],
  ]);
  for (const jobs of [1, 3]) {
    const finished = new Set();
    await buildInDependencyOrder(['consumer', 'provider', 'independent'], dependencies, jobs, async (name) => {
      if (name === 'consumer') assert.ok(finished.has('provider'), 'provider declarations must exist first');
      await Promise.resolve();
      finished.add(name);
    });
    assert.deepEqual([...finished].sort(), ['consumer', 'independent', 'provider']);
  }
});

test('a failed package build rejects and starts nothing new', async () => {
  const dependencies = new Map([
      ['a', new Set()],
      ['b', new Set(['a'])],
      ['c', new Set()],
    ]),
    started = [];
  await assert.rejects(
    buildInDependencyOrder(['a', 'b', 'c'], dependencies, 1, async (name) => {
      started.push(name);
      if (name === 'a') throw new Error('a failed');
    }),
    /a failed/,
  );
  assert.deepEqual(started, ['a']);
});
