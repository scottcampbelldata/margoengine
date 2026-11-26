import assert from 'node:assert/strict';
import test from 'node:test';
import { PhysicsWorld, regionWords, worldMemory } from '@margoengine/physics/world';
import { growEcosystem } from '../dist/ecosystem.js';
import { forestOrientation, ForestEcosystemSolver } from '../dist/forest.js';

const rate = { num: 60, den: 1 };
const plot = {
  bounds: [-10, -10, 10, 10],
  limit: 512,
  seed: 7,
  ticksPerYear: 1,
  species: [
    { id: 'spruce', radius: 3, age: 70, shade: 0.8, seeds: 6, dispersal: 2 },
    { id: 'birch', radius: 2, age: 18, shade: 0.1, seeds: 3, dispersal: 2 },
  ],
  plants: [
    { species: 'spruce', radius: 2.3, x: -1.5, z: -0.5 },
    { species: 'spruce', radius: 1.7, x: -3.1, z: 1.1 },
    { species: 'spruce', radius: 2.9, x: 1.5, z: 0.5 },
    { species: 'birch', radius: 1.2, x: -1.5, z: -0.5, age: 15 },
    { species: 'birch', radius: 1.2, x: 7.5, z: 6.5 },
  ],
};

test('native forest competition gives the exact offline succession, outside and across zero, for both memories', async () => {
  const years = 24;
  const expected = growEcosystem({ ...plot, years, snags: 3 });
  assert.ok(expected.history.some((v) => v.born > 0));
  assert.ok(expected.history.some((v) => v.died > 0));
  for (const memory of [worldMemory(false), worldMemory(true)]) {
    const solver = await ForestEcosystemSolver.load();
    const world = new PhysicsWorld({ rate, memory }).add(solver, { ...plot, snags: 3 });
    for (let year = 1; year <= years; year++) {
      world.advance(year);
      const { crowded, ...current } = solver.year;
      assert.deepEqual(current, expected.history[year - 1]);
      if (year === years) assert.equal(crowded, expected.crowded);
    }
    assert.deepEqual(
      solver.trees().map(({ id, lean, ...tree }) => tree),
      expected.plants,
    );
    assert.equal(new Set(solver.trees().map(({ id }) => id)).size, solver.trees().length);
  }
});

test('isolated patch outputs agree with crown area times measured Pa and fuel loading', async () => {
  const forest = await ForestEcosystemSolver.load();
  const world = new PhysicsWorld({ rate }).add(forest, {
    bounds: [0, 0, 10, 5],
    cells: [2, 1],
    limit: 8,
    species: [{ id: 'fir', radius: 1, rootCohesion: 500, canopyFuel: 2 }],
    plants: [{ species: 'fir', x: 2, z: 2, radius: 1 }],
  });
  const get = (field) => Array.from(regionWords(world.memory, world.fields.port(field.name).region));
  assert.deepEqual(get(forest.coverField), [Math.PI / 25, 0]);
  assert.deepEqual(get(forest.rootCohesionField), [(Math.PI / 25) * 500, 0]);
  assert.deepEqual(get(forest.fuelField), [(Math.PI / 25) * 2, 0]);
  assert.deepEqual(
    forestOrientation({ lean: [0, 0] }).map((v) => v + 0),
    [0, 0, 0, 1],
  );
});

test('malformed geometry rejects and cancelling kernel loading preserves the caller’s reason', async () => {
  const forest = await ForestEcosystemSolver.load();
  const world = new PhysicsWorld({ rate });
  assert.throws(() => world.add(forest, { ...plot, cells: [2001, 1] }), /centimetre/);
  assert.throws(() => world.add(forest, { ...plot, limit: 1 }), /capacity/);
  const reason = new Error('forest asset cancelled');
  await assert.rejects(ForestEcosystemSolver.load({ signal: AbortSignal.abort(reason) }), (e) => e === reason);
});

test('a production web consumer retains the two exact lazy Wasm assets', { timeout: 30_000 }, async () => {
  const { mkdirSync, readFileSync, readdirSync, writeFileSync } = await import('node:fs');
  const { join, resolve } = await import('node:path');
  const { build } = await import('vite');
  const root = resolve(import.meta.dirname, '../../../test-results/biomes-forest-consumer', String(process.pid));
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'index.html'), '<script type="module" src="./main.js"></script>');
  writeFileSync(
    join(root, 'main.js'),
    [
      'import { ForestEcosystemSolver } from "@margoengine/biomes/forest";',
      'window.loadForest = () => ForestEcosystemSolver.load();',
    ].join('\n'),
  );
  await build({ root, configFile: false, publicDir: false, logLevel: 'warn', build: { target: 'es2022' } });
  const assets = join(root, 'dist/assets');
  const files = readdirSync(assets);
  const js = files
    .filter((file) => file.endsWith('.js'))
    .map((file) => readFileSync(join(assets, file), 'utf8'))
    .join('\n');
  for (const base of ['forest-kernel', 'forest-kernel-shared']) {
    const names = files.filter(
      (name) =>
        name.startsWith(base + '-') &&
        name.endsWith('.wasm') &&
        (base.endsWith('shared') || !name.startsWith('forest-kernel-shared-')),
    );
    assert.equal(names.length, 1, `separate ${base} asset`);
    assert.deepEqual(
      readFileSync(join(assets, names[0])),
      readFileSync(new URL(`../dist/${base}.wasm`, import.meta.url)),
    );
    assert.ok(js.includes(names[0]), `bundle resolves ${base}`);
  }
});
