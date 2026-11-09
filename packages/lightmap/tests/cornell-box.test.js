import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findPython } from '../../../scripts/support/find-python.mjs';
import { bakeGlobalLightmap } from '../dist/global.js';
import {
  albedoOf,
  bandRgb,
  calibrationIrradiance,
  cornellScene,
  EMISSION_KNOTS,
  positionsOf,
  publishedQuads,
  rectangleOf,
  spectrumRows,
} from '../scripts/cornell-box.mjs';

const cross = (u, v) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
const sub = (a, b) => a.map((value, i) => value - b[i]);
const add = (a, b) => a.map((value, i) => value + b[i]);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const length = (v) => Math.hypot(v[0], v[1], v[2]);

test('Cycles retains all receivers during every bake', () => {
  // macOS has python3 and no python: findPython picks what the machine has (a bare 'python' spawn failed with ENOENT).
  const python = findPython();
  assert.ok(python, 'no Python found; install Python 3 so python3 or python runs');
  const run = spawnSync(python, [fileURLToPath(new URL('./cornell-cycles-lifecycle.py', import.meta.url))], {
    encoding: 'utf8',
    timeout: 20_000,
  });
  assert.equal(run.status, 0, run.stderr || String(run.error));
});

test('calibration is independent physical quadrature with a converged grid', () => {
  const calibration = cornellScene().calibration;
  const coarse = calibrationIrradiance(calibration, 64);
  const fine = calibrationIrradiance(calibration);
  assert.ok(fine[0] > 0.2 && fine[0] < 0.25);
  fine.forEach((value, c) => assert.ok(Math.abs(value - coarse[c]) < 0.00001));
});

function normal(corners) {
  return cross(sub(corners[1], corners[0]), sub(corners[3], corners[0]));
}

/** Irradiance at one point from a constant-radiance rectangle. No occlusion. */
function integrate(point, normal, rect, steps = 48) {
  const area = length(cross(rect.u, rect.v)),
    sum = [0, 0, 0];
  for (let y = 0; y < steps; y++)
    for (let x = 0; x < steps; x++) {
      const target = add(
          rect.corner,
          add(
            rect.u.map((v) => v * ((x + 0.5) / steps)),
            rect.v.map((v) => v * ((y + 0.5) / steps)),
          ),
        ),
        toward = sub(target, point),
        distance = length(toward),
        direction = toward.map((v) => v / distance),
        lambert = dot(normal, direction),
        facing = -dot(rect.normal, direction);
      if (!(lambert > 0 && facing > 0)) continue;
      const weight = (lambert * facing * area) / (distance * distance * steps * steps);
      for (let channel = 0; channel < 3; channel++) sum[channel] += rect.radiance[channel] * weight;
    }
  return sum;
}

const mean = (out, chart = 0) => {
  const box = out.charts[chart],
    sum = [0, 0, 0];
  for (let y = 0; y < box.height; y++)
    for (let x = 0; x < box.width; x++)
      for (let channel = 0; channel < 3; channel++)
        sum[channel] += out.textures.lightmap[((box.y + y) * out.width + box.x + x) * 4 + channel];
  return sum.map((value) => (value / 255 / (box.width * box.height)) * out.lightmapScale);
};

test('the published Cornell faces become parallelograms with the short top snapped', () => {
  const rows = spectrumRows();
  assert.equal(rows.find((row) => row.w === 400).white, 0.343);
  assert.equal(rows.find((row) => row.w === 520).green, 0.472);
  assert.equal(rows.find((row) => row.w === 700).red, 0.642);
  assert.deepEqual(EMISSION_KNOTS[2], [600, 15.6]);
  const rgb = bandRgb();
  assert.ok(rgb.red[0] > rgb.red[2], 'red wall is redder than it is blue');
  assert.ok(rgb.green[1] > rgb.green[0], 'green wall is greener than it is red');
  assert.ok(rgb.white.every((channel) => channel > 0.6 && channel < 0.85));
  const quads = publishedQuads(),
    top = quads.find((quad) => quad.name === 'short-top');
  assert.deepEqual(top.publishedP2, [240, 165, 272]);
  assert.deepEqual(
    top.snappedP2.map((value) => Math.round(value)),
    [242, 165, 274],
  );
  const positions = positionsOf(cornellScene().quads);
  for (let q = 0; q < positions.length / 12; q++) {
    const o = q * 12;
    for (let axis = 0; axis < 3; axis++) {
      const stored = new Float32Array([positions[o + 3 + axis] + positions[o + 9 + axis] - positions[o + axis]]);
      assert.equal(positions[o + 6 + axis], stored[0]);
    }
  }
  const byName = Object.fromEntries(quads.map((quad) => [quad.name, normal(quad.corners)]));
  assert.ok(byName.floor[1] > 0);
  assert.ok(byName.ceiling[1] < 0);
  assert.ok(byName.back[2] < 0);
  assert.ok(byName.right[0] > 0);
  assert.ok(byName.left[0] < 0);
  assert.ok(byName['short-top'][1] > 0);
  assert.ok(byName['tall-top'][1] > 0);
});

test('the ceiling rectangle matches a direct integral and the box receives light', async () => {
  const scene = cornellScene(),
    light = scene.light,
    y = light.position[1] - 2,
    half = 0.05,
    positions = new Float32Array([
      light.position[0] - half,
      y,
      light.position[2] - half,
      light.position[0] - half,
      y,
      light.position[2] + half,
      light.position[0] + half,
      y,
      light.position[2] + half,
      light.position[0] + half,
      y,
      light.position[2] - half,
    ]),
    baked = await bakeGlobalLightmap(
      { positions },
      {
        radiometry: 'physical',
        texelsPerUnit: 16,
        padding: 1,
        aoRays: 1,
        seed: 1,
        areaLights: [light],
        areaSamples: 16,
        bounces: 0,
      },
    ),
    expected = integrate([light.position[0], y, light.position[2]], [0, 1, 0], rectangleOf(light));
  mean(baked).forEach((value, channel) => {
    assert.ok(
      Math.abs(value - expected[channel]) <= 0.03 * expected[channel],
      `channel ${channel} ${value} vs ${expected[channel]}`,
    );
  });
  const box = await bakeGlobalLightmap(
    { positions: positionsOf(scene.quads), albedo: albedoOf(scene.quads) },
    {
      radiometry: 'physical',
      texelsPerUnit: 2,
      padding: 1,
      aoRays: 1,
      seed: 1,
      areaLights: [light],
      areaSamples: 4,
      bounces: 0,
    },
  );
  assert.equal(box.radiometry, 'physical');
  for (const name of ['floor', 'short-top', 'tall-top', 'left', 'right']) {
    const index = scene.quads.findIndex((quad) => quad.name === name);
    assert.ok(mean(box, index)[0] > 0, name);
  }
});
