import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import { mapArmControl } from '../examples/skinning-ik/arm-controls.ts';

mkdirSync(resolve('test-results'), { recursive: true });
const temporary = mkdtempSync(resolve('test-results/control-route-')),
  path = join(temporary, 'route.mjs');
const bundle = await build({
  configFile: false,
  publicDir: false,
  logLevel: 'silent',
  build: {
    write: false,
    target: 'es2022',
    minify: false,
    lib: { entry: resolve('examples/skinning-ik/arm-control-route.ts'), formats: ['es'] },
  },
});
writeFileSync(path, bundle[0].output[0].code);
const { ArmControlRoute } = await import(pathToFileURL(path).href);
unlinkSync(path);
rmdirSync(temporary);
const home = mapArmControl('side', 0.5),
  copied = (route) => [...route.position];

function remaining(route) {
  const points = [];
  for (let step = 0; step < 8 && !route.settled; step++) {
    points.push(copied(route));
    assert.equal(route.update(copied(route), 1 / 60), route.position);
  }
  assert.equal(route.settled, true);
  return points;
}

test('conditioned waypoint arrival advances a raw route without replacing or prematurely consuming it', () => {
  const route = new ArmControlRoute();
  route.request('side', 0.97, home);
  while (route.position[0] < 0.12) route.update([...route.position], 1 / 60);
  const raw = [...route.position],
    conditioned = [raw[0], raw[1], raw[2] - 0.02];
  route.update(conditioned, 0, conditioned);
  assert.deepEqual(route.position, raw);
  assert.equal(route.settled, false);
  route.update(conditioned, 1 / 60, conditioned);
  assert.notDeepEqual(route.position, raw);
  const finalRaw = [...route.position],
    finalConditioned = [finalRaw[0], finalRaw[1], finalRaw[2] - 0.02];
  route.update(finalConditioned, 1 / 60);
  assert.equal(route.settled, false, 'raw residual remains visible without a workspace-aware arrival point');
  route.update(finalConditioned, 1 / 60, finalConditioned);
  assert.equal(route.settled, true);
  assert.deepEqual(route.position, finalRaw);
});

test('control routing preserves every authored bend and uses shared Home when changing tracks', () => {
  const route = new ArmControlRoute(),
    output = route.position;
  route.request('side', 1, home);
  assert.deepEqual(
    remaining(route),
    [0.75, 0.88, 1].map((t) => mapArmControl('side', t)),
  );
  route.request('height', 1, mapArmControl('side', 1));
  assert.deepEqual(
    remaining(route),
    [0.88, 0.75, 0.5].map((t) => mapArmControl('side', t)).concat([0.82, 1].map((t) => mapArmControl('height', t))),
  );
  route.request('height', 0, mapArmControl('height', 1));
  assert.deepEqual(
    remaining(route),
    [0.82, 0.5, 0].map((t) => mapArmControl('height', t)),
  );
  assert.equal(route.position, output);
});

test('mid-route control changes return along the current leg and zero-delta renders never consume waypoints', () => {
  const route = new ArmControlRoute();
  route.request('side', 1, home);
  route.request('height', 1, mapArmControl('side', 0.9));
  assert.deepEqual(route.position, mapArmControl('side', 0.88));
  route.request('nearFar', 0, mapArmControl('side', 0.86));
  assert.deepEqual(route.position, mapArmControl('side', 0.75));
  const held = copied(route);
  for (let i = 0; i < 100; i++) route.update(held, 0);
  assert.deepEqual(route.position, held);
  assert.equal(route.settled, false);
  assert.deepEqual(remaining(route), [
    mapArmControl('side', 0.75),
    home,
    mapArmControl('nearFar', 0.25),
    mapArmControl('nearFar', 0),
  ]);
});

test('release removes the old path, reacquisition starts from the actual accepted pose, and guards are atomic', () => {
  const route = new ArmControlRoute();
  route.request('height', 1, home);
  route.release();
  assert.equal(route.active, false);
  const held = copied(route);
  route.update(mapArmControl('height', 1), 1);
  assert.deepEqual(route.position, held);
  route.request('side', 1, mapArmControl('nearFar', 0));
  assert.deepEqual(route.position, mapArmControl('nearFar', 0.25));
  const before = copied(route);
  for (const invalid of [
    [NaN, 0, 0],
    [0, Infinity, 0],
    [1e40, 0, 0],
    ['1', 0, 0],
    [0, 0],
  ]) {
    assert.throws(() => route.request('side', 1, invalid), /finite/);
    assert.throws(() => route.update(invalid, 1 / 60), /finite/);
  }
  assert.throws(() => route.request('missing', 0, home), /Unknown/);
  assert.throws(() => route.request('side', NaN, home), /finite/);
  for (const dt of [-1, NaN, Infinity]) assert.throws(() => route.update(home, dt), /dt/);
  assert.deepEqual(route.position, before);
  assert.equal(route.active, true);
  assert.equal(route.settled, false);
});
