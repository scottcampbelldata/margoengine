import assert from 'node:assert/strict';
import test from 'node:test';
import { moduleHooks } from '../../../scripts/support/node-compat.mjs';

await moduleHooks([{ source: new URL('../src/', import.meta.url).href }]);
const { capsuleHydrostatics, capsuleInertiaAxes, capsuleVolume } = await import('../src/loads/capsule.ts');
const { compactDragGeometry, emergedSilhouette } = await import('../src/loads/compact-drag.ts');

const radius = 0.35;
const halfHeight = 0.8;
const dimensions = { radius, halfHeight };
const circle = Math.PI * radius ** 2;
const hemisphere = (2 * Math.PI * radius ** 3) / 3;
const total = capsuleVolume(radius, halfHeight);

function sample(axis, depth) {
  const centre = [0, 0, 0];
  return { volume: capsuleHydrostatics(dimensions, axis, depth, total, centre), centre };
}

function close(actual, expected, tolerance = 1e-12) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `got ${actual}, expected ${expected} ± ${tolerance}`);
}

test('SEA-12 capsule volume and moments match the vertical and level symmetry sections', () => {
  const vertical = sample([0, 1, 0], 0);
  const level = sample([1, 0, 0], 0);
  const wet = circle * halfHeight + hemisphere;
  close(total, 2 * wet);
  close(vertical.volume, wet);
  close(level.volume, wet);
  close(vertical.centre[1], ((-circle * halfHeight ** 2) / 2 - hemisphere * (halfHeight + (3 * radius) / 8)) / wet);
  close(level.centre[1], (-(4 * halfHeight * radius ** 3) / 3 - (Math.PI * radius ** 4) / 4) / wet);
  close(vertical.centre[0], 0);
  close(level.centre[0], 0);
});

test('SEA-12 oblique capsule cylinder matches the closed disk moments and end-for-end symmetry', () => {
  const axis = [0.6, 0.8, 0];
  const skew = axis[0] / axis[1];
  const second = (Math.PI * radius ** 4) / 4;
  const capMoment = -hemisphere * (halfHeight + (3 * radius) / 8);
  for (const depth of [-0.15, 0, 0.15]) {
    const cut = depth / axis[1];
    // Integrate along the cylinder axis over the entire circular disk using s_cut = cut - skew * x.
    const volume = hemisphere + circle * (halfHeight + cut);
    const axial = capMoment + (circle * (cut ** 2 - halfHeight ** 2) + skew ** 2 * second) / 2;
    const radial = -skew * second;
    const wet = sample(axis, depth);
    const reversed = sample(
      axis.map((x) => -x),
      depth,
    );
    close(wet.volume, volume);
    close(wet.centre[0], (axis[0] * axial - axis[1] * radial) / volume);
    close(wet.centre[1], (axis[1] * axial + axis[0] * radial) / volume);
    close(wet.centre[2], 0);
    close(reversed.volume, wet.volume);
    for (let i = 0; i < 3; i++) close(reversed.centre[i], wet.centre[i]);
  }
});

test('SEA-12 capsule sphere-cap tangency and complementary first moments are consistent', () => {
  const axis = [0.8, 0.6, 0];
  const extent = halfHeight * axis[1] + radius;
  assert.deepEqual(sample(axis, -extent), { volume: 0, centre: [0, 0, 0] });
  assert.deepEqual(sample(axis, extent), { volume: total, centre: [0, 0, 0] });
  for (const height of [1e-5, 0.03, 0.05]) {
    const depth = height - extent;
    const wet = sample(axis, depth);
    const complement = sample(axis, -depth);
    // Below the joining plane's lowest point, the wet solid is an ordinary spherical cap.
    const sphereCap = Math.PI * height ** 2 * (radius - height / 3);
    const sphereCapCentre = (-3 * (2 * radius - height) ** 2) / (4 * (3 * radius - height));
    close(wet.volume, sphereCap, Math.max(1e-20, 2e-11 * sphereCap));
    close(wet.centre[0], -halfHeight * axis[0], 3e-11);
    close(wet.centre[1], -halfHeight * axis[1] + sphereCapCentre, 3e-11);
    close(wet.volume + complement.volume, total);
    for (let i = 0; i < 3; i++) close(wet.centre[i] * wet.volume, complement.centre[i] * complement.volume);
  }
});

test('SEA-12 capsule drag uses actual stadium and circular principal projections', () => {
  const frame = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  const geometry = compactDragGeometry(
    total,
    capsuleInertiaAxes(radius, halfHeight),
    frame,
    undefined,
    undefined,
    dimensions,
  );
  close(geometry.areas[0], circle + 4 * halfHeight * radius);
  close(geometry.areas[1], circle);
  close(geometry.areas[2], geometry.areas[0]);
  close(geometry.surfaceArea, 4 * Math.PI * radius * (halfHeight + radius));
  assert.deepEqual(capsuleInertiaAxes(radius, 0), [radius, radius, radius]);
});

test('SEA-12 emerged capsule projects the actual stadium, or a disk seen end-on', () => {
  const frame = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  const geometry = compactDragGeometry(
    total,
    capsuleInertiaAxes(radius, halfHeight),
    frame,
    undefined,
    undefined,
    dimensions,
  );
  const z = [0, 0, 1];
  const q = [0, 0, 0, 1];
  const halfDisk = circle / 2;
  const halfStadium = halfDisk + 2 * radius * halfHeight;
  const vertical = emergedSilhouette(geometry, frame, q, 0, z);
  close(vertical.area, halfStadium);
  close(vertical.offset[1], (radius * halfHeight ** 2 + halfDisk * halfHeight + (2 * radius ** 3) / 3) / halfStadium);
  const horizontal = emergedSilhouette(geometry, [[0, 1, 0], [1, 0, 0], z], q, 0, z);
  close(horizontal.area, halfStadium);
  close(horizontal.offset[1], (halfHeight * radius ** 2 + (2 * radius ** 3) / 3) / halfStadium);
  const end = emergedSilhouette(geometry, [[1, 0, 0], z, [0, 1, 0]], q, 0, z);
  close(end.fullArea, circle);
  close(end.area, halfDisk);
  close(end.offset[1], (4 * radius) / (3 * Math.PI));

  const pitchedFrame = [[0.8, -0.6, 0], [0.6, 0.8, 0], z];
  const immersion = 0.2;
  const emerged = emergedSilhouette(geometry, pitchedFrame, q, immersion, z);
  const reflected = emergedSilhouette(geometry, pitchedFrame, q, -immersion, z);
  close(emerged.area + reflected.area, 2 * halfStadium);
  for (let i = 0; i < 3; i++) close(emerged.offset[i] * emerged.area, reflected.offset[i] * reflected.area);
  assert.ok(emerged.offset[0] > 0 && emerged.offset[1] > immersion);
});
