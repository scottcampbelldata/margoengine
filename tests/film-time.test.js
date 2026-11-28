// GAP-FILM-TIME class check (scripts/check-film-time.mjs): package code that adds up frame deltas outside
// `advanceTime`, or draws from the wall clock or an unseeded random, fails here unless the reviewed list gives the
// reason (since the sweep of GAP-FILM-TIME commit 7); the reviewed list must stay true.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { REVIEWED, scanPackages, scanSource } from '../scripts/check-film-time.mjs';

const root = resolve(import.meta.dirname, '..');

test('a field that adds up deltas is found unless its file has advanceTime', () => {
  const clock =
    'class A {\n  onPreUpdate(delta) {\n    this.time += delta;\n    this.drift[0] = (this.drift[0] + w * delta) % s;\n  }\n}';
  assert.deepEqual(scanSource(clock).delta, [3, 4]);
  assert.deepEqual(scanSource(`${clock}\nclass B { advanceTime(delta) {} }`).delta, []);
  // A local sum, a comment and a block comment are not fields.
  assert.deepEqual(
    scanSource('let t = 0;\nt += delta;\n// this.t += delta\n/* this.t += delta\n this.u += dt */').delta,
    [],
  );
  assert.deepEqual(scanSource('this.#age += dt * 2;\nthis.state.timer += frameDelta;').delta, [1, 2]);
});

test('a field set from an expression that reads it and a delta is found in every form (KB-FILM-SCANGAP1)', () => {
  const forms = [
    'this.elapsed = Math.min(1e7, this.elapsed + delta);', // a clamp around the sum
    'this.focus = goal + (this.focus - goal) * Math.exp(-rate * delta);', // an ease toward a goal
    'this.hold = Math.max(0, this.hold - dt);', // a countdown
    'this.progress = blend(this.progress, desired, delta, damping);', // a helper call
    'this.#time = Math.min(this.#time + dt, 0.25);', // a private field
    'this.acc = Math.max(0, this.acc - steps * dt) % dt;',
    'this.v[1] = this.v[1] * Math.exp(-k * frameDelta);', // an element of a field
  ];
  for (const line of forms) assert.deepEqual(scanSource(line).delta, [1], line);
  // Not clocks: another field, a comparison, a local, a longer field name and a plain set.
  for (const line of [
    'this.a = this.b + delta;',
    'if (this.t == this.t + dt) return;',
    'const t = Math.min(1, t0 + delta);',
    'this.pos = this.posBase + delta;',
    'this.fov = fov;',
  ])
    assert.deepEqual(scanSource(line).delta, [], line);
  // The old form still hits, and a file with advanceTime still has no delta hits.
  assert.deepEqual(scanSource('this.x = (this.x + w * dt) % s;').delta, [1]);
  assert.deepEqual(scanSource(`${forms.join('\n')}\nadvanceTime(delta) {}`).delta, []);
});

test('the wall clock and unseeded random are found in code, not in comments', () => {
  assert.deepEqual(
    scanSource('const t = performance.now();\nconst r = Math.random ();\nx = Date.now();').wall,
    [1, 2, 3],
  );
  assert.deepEqual(scanSource('// performance.now() is not used\nconst rng = mulberry(seed);').wall, []);
});

test('the reviewed list names real files and hits, each with a reason', () => {
  assert.ok(existsSync(REVIEWED));
  const reviewed = JSON.parse(readFileSync(REVIEWED, 'utf8')),
    { found } = scanPackages(root);
  for (const [file, rules] of Object.entries(reviewed)) {
    assert.ok(existsSync(join(root, file)), `${file} on the reviewed list does not exist`);
    for (const [rule, reason] of Object.entries(rules)) {
      assert.ok(rule === 'delta' || rule === 'wall', `${file}: unknown rule ${rule}`);
      assert.ok(typeof reason === 'string' && reason.length >= 12, `${file} ${rule}: give the reason`);
      assert.ok(
        found.some((hit) => hit.file === file && hit.rule === rule),
        `${file} ${rule} no longer hits: remove it`,
      );
    }
  }
});

test('the seekable clocks of GAP-FILM-TIME stay seekable', () => {
  const { found } = scanPackages(root),
    // Each lands with advanceTime in its GAP-FILM-TIME commit; a later edit that drops it fails here.
    seekable = [
      'packages/cutscene/src/seek.ts',
      'packages/sky/src/base.ts',
      'packages/sky/src/volumetric-clouds.ts',
      'packages/sky/src/astro.ts',
      'packages/sky/src/hillaire.ts',
      'packages/sky/src/weather.ts',
      'packages/weather/src/machine.ts',
      'packages/weather/src/hail.ts',
      'packages/weather/src/puddles.ts',
      'packages/weather/src/lens.ts',
      'packages/weather/src/regions.ts',
      'packages/scatter/src/index.ts',
      'packages/scatter/src/instances.ts',
      'packages/water/src/index.ts',
      'packages/water/src/flow.ts',
      'packages/water/src/rain.ts',
      'packages/water/src/ships.ts',
      'packages/water/src/ice.ts',
      'packages/animation/src/index.ts',
      'packages/animation/src/playback.ts',
      'packages/animation/src/group.ts',
      'packages/animation/src/mixer.ts',
      'packages/animation/src/lod.ts',
      'packages/animation/src/morph-gpu.ts',
      'packages/animation/src/vat.ts',
      'packages/animation/src/geometry-cache.ts',
      'packages/shadows/src/index.ts',
      'packages/shadows/src/virtual.ts',
      'packages/shadows/src/light-function.ts',
      'packages/dof/src/autofocus.ts',
      'packages/vfx/src/flocking.ts', // KB-FILM-FLOCK1
      // The sweep, GAP-FILM-TIME commit 7.
      'packages/cinematic/src/index.ts',
      'packages/cinematic/src/noise.ts',
      'packages/creative/src/post.ts',
      'packages/environment/src/planar.ts',
      'packages/environment/src/volumetric.ts',
      'packages/lines/src/lines.ts',
      'packages/lines/src/trail.ts',
      'packages/lod/src/index.ts',
      'packages/pixel/src/follow.ts',
      'packages/rigging/src/mtoon.ts',
      'packages/selection/src/xray.ts',
      'packages/shader/src/shadertoy.ts',
      'packages/shader/src/clock.ts',
      'packages/sky/src/aurora.ts',
      'packages/splats/src/animate.ts',
      'packages/splats/src/modify.ts',
      'packages/sprites/src/animation.ts',
      'packages/sprites/src/index.ts',
      'packages/tilemap/src/iso.ts',
      'packages/tilemap/src/objects.ts',
      'packages/tilemap/src/renderer.ts',
      'packages/ui/src/renderer.ts',
      'packages/voxel/src/render.ts',
      // Sheet row 5: the fire and the storm and snow events (vfx flame and smoke, weather avalanche and snow drift).
      'packages/vfx/src/flame.ts',
      'packages/vfx/src/smoke.ts',
      'packages/weather/src/avalanche.ts',
      'packages/weather/src/snow-drift.ts',
      // Sheet row 26: cannon fire (vfx gunfire) and shot splashes (water splash).
      'packages/vfx/src/gunfire.ts',
      'packages/water/src/splash.ts',
      // KB-CHECKS-WAITS-FILMTIME1: the heat haze over a flame (its clock moved from its draw to its update).
      'packages/post/src/heat-haze.ts',
      // KB-FILM-SCANGAP1: the Stylize wave clock (`this.elapsed = Math.min(1e7, this.elapsed + delta)`).
      'packages/post/src/stylize.ts',
    ],
    // Each moved from the wall clock to frame time in its GAP-FILM-TIME commit.
    frameTimed = [
      'packages/shadows/src/light-function.ts',
      'packages/dof/src/autofocus.ts',
      'packages/shader/src/node.ts',
      'packages/shader/src/raw.ts',
    ];
  for (const file of seekable) assert.ok(!found.some((hit) => hit.file === file && hit.rule === 'delta'), file);
  for (const file of frameTimed) assert.ok(!found.some((hit) => hit.file === file && hit.rule === 'wall'), file);
  // Film-time events whose state is worked from their clock (no delta sum the scan sees), so the scan alone cannot
  // tell a dropped clock: each must keep `advanceTime`, or `seek` refuses it in `extra` and the cut restarts it.
  for (const file of [
    'packages/weather/src/eruption.ts',
    'packages/weather/src/avalanche.ts',
    'packages/weather/src/snow-drift.ts',
    'packages/sky/src/tornado.ts',
    'packages/terrain/src/ground-change.ts',
    'packages/water/src/flood.ts',
    'packages/vfx/src/flame.ts',
    'packages/vfx/src/smoke.ts',
    'packages/vfx/src/gunfire.ts',
    'packages/water/src/splash.ts',
    'packages/post/src/heat-haze.ts',
    'packages/post/src/stylize.ts',
  ])
    assert.match(readFileSync(join(root, file), 'utf8'), /\badvanceTime\s*\(delta/, file);
});

test('no package source has an unreviewed hit: the gate fails on a new clock a seek cannot move', () => {
  const open = scanPackages(root).found.filter((hit) => !hit.reason);
  assert.deepEqual(
    open.map((hit) => `${hit.rule} ${hit.file}:${hit.lines.join(',')}`),
    [],
    'give the clock advanceTime (a seek test with it), move a drawn value off the wall clock, or add a reviewed reason in scripts/film-time-reviewed.json',
  );
});

test('the script fails on an unreviewed hit', () => {
  const run = spawnSync(process.execPath, [join(root, 'scripts/check-film-time.mjs')], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.doesNotMatch(run.stdout, /report mode/);
});
