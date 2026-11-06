// Weight transfer: a sleeve over a tube, sides that look close but do not face alike, loose parts, influences as input,
// and real avatars: the file's own weights copied onto a remeshed copy and onto its own other meshes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WeightMap } from '../dist/index.js';
import { transferWeights } from '../dist/transfer.js';
import { merge, tube } from './fixtures.js';
import { compare, realSkin } from './real-skin.js';

/** Weights of a tube up the y axis: two bones, blended by height. */
function source(mesh = tube({ rings: 24 })) {
  const n = mesh.positions.length / 3,
    weights = new WeightMap(n, 2);
  for (let v = 0; v < n; v++) {
    const up = Math.min(1, Math.max(0, mesh.positions[v * 3 + 1] / 2));
    weights.set(v, 0, 1 - up).set(v, 1, up);
  }
  return { ...mesh, weights };
}
const near = (a, b, tolerance) => assert.ok(Math.abs(a - b) <= tolerance, `${a} is not ${b}`);
const sums = (weights) => {
  for (let v = 0; v < weights.vertexCount; v++) {
    let sum = 0;
    for (let b = 0; b < weights.boneCount; b++) sum += weights.get(v, b);
    assert.ok(Math.abs(sum - 1) < 1e-5, `vertex ${v} sums to ${sum}`);
  }
};

test('a sleeve just outside a tube takes the weights at its closest points', async () => {
  const body = source(),
    sleeve = tube({ radius: 0.22, y0: 0.5, y1: 1.5, rings: 7, sides: 9 }),
    { weights, matched, filled } = await transferWeights(body, sleeve);
  sums(weights);
  assert.equal(filled, 2, 'the cap centres, on the axis, are too far');
  assert.equal(matched + filled, sleeve.positions.length / 3);
  for (let v = 0; v < weights.vertexCount; v++) {
    const up = sleeve.positions[v * 3 + 1] / 2;
    assert.ok(Math.abs(weights.get(v, 1) - up) < 0.03, `height ${up} took ${weights.get(v, 1)}`);
  }
});

test('a vertex too far is filled from its neighbours over the target', async () => {
  const body = source(),
    // A sleeve whose top flares out from the tube.
    skirt = tube({ radius: 0.21, y0: 0.9, y1: 1.3, rings: 4, sides: 12 }),
    sides = 12;
  for (let v = 3 * sides; v < 5 * sides; v++) {
    skirt.positions[v * 3] *= 3;
    skirt.positions[v * 3 + 2] *= 3;
  }
  const { weights, filled } = await transferWeights(body, skirt, { maxDistance: 0.05 });
  sums(weights);
  assert.ok(filled >= 2 * sides, `filled ${filled}`);
  const edge = weights.get(sides, 1); // the last ring on the tube: the flare tilts the next one away
  near(edge, 0.5, 0.03);
  for (let v = 3 * sides; v < 5 * sides; v++) near(weights.get(v, 1), edge, 0.02);
});

/** `mesh` lying along x: x and y swapped, faces turned to match. */
function sideways(mesh) {
  const positions = Float32Array.from(mesh.positions);
  for (let v = 0; v < positions.length; v += 3) [positions[v], positions[v + 1]] = [positions[v + 1], positions[v]];
  const indices = Uint32Array.from(mesh.indices);
  for (let t = 0; t < indices.length; t += 3) [indices[t + 1], indices[t + 2]] = [indices[t + 2], indices[t + 1]];
  return { positions, indices };
}

test('a sleeve vertex that lies nearest the wrong part keeps its own through the fill', async () => {
  // A torso and an arm out from it. The sleeve's first ring is nearer the torso's wall, which faces the other way.
  const torso = tube({ radius: 0.2, y0: 0, y1: 2, rings: 12 }),
    arm = sideways(tube({ cx: 1, radius: 0.1, y0: 0.25, y1: 1.5, rings: 12 })),
    body = merge(torso, arm),
    n = body.positions.length / 3,
    weights = new WeightMap(n, 2);
  for (let v = 0; v < n; v++) weights.set(v, v < torso.positions.length / 3 ? 0 : 1, 1);
  const whole = sideways(tube({ cx: 1, radius: 0.13, y0: 0.22, y1: 1.5, rings: 12, sides: 12 })),
    sleeve = { positions: whole.positions, indices: whole.indices.subarray(0, 12 * 12 * 6) },
    { weights: out, filled } = await transferWeights({ ...body, weights }, sleeve);
  sums(out);
  assert.ok(filled > 0, 'the first ring is filled');
  for (let v = 0; v < 13 * 12; v++) assert.ok(out.get(v, 1) > 0.99, `vertex ${v}: ${out.get(v, 1)}`);
  // With every angle allowed the same ring takes the torso.
  const { weights: careless } = await transferWeights({ ...body, weights }, sleeve, { maxAngle: 90 });
  assert.ok(careless.get(0, 0) > 0.5, `${careless.get(0, 0)}`);
});

test('a part with no match takes what is closest as it is', async () => {
  const body = source(),
    hat = tube({ radius: 0.1, y0: 3, y1: 3.2, rings: 2, sides: 6 }),
    { weights, matched, filled } = await transferWeights(body, hat);
  sums(weights);
  assert.equal(filled, 0);
  assert.ok(matched > 0);
  for (let v = 0; v < weights.vertexCount; v++) assert.ok(weights.get(v, 1) > 0.9);
});

test('influences as input, boneCount, split vertices, and bad input', async () => {
  const mesh = tube({ rings: 4 }),
    n = mesh.positions.length / 3,
    joints = new Uint16Array(n * 4),
    influences = new Float32Array(n * 4);
  for (let v = 0; v < n; v++) {
    joints[v * 4] = 3;
    influences[v * 4] = 1;
  }
  const { weights } = await transferWeights({ ...mesh, weights: { joints, weights: influences } }, tube({ radius: 0.21 }), {
    boneCount: 6,
  });
  assert.equal(weights.boneCount, 6);
  assert.equal(weights.get(0, 3), 1);
  const body = source();
  await assert.rejects(transferWeights(body, mesh, { maxDistance: 0 }), RangeError);
  await assert.rejects(transferWeights(body, mesh, { maxAngle: 100 }), RangeError);
  await assert.rejects(transferWeights(body, mesh, { iterations: -1 }), RangeError);
  await assert.rejects(transferWeights(body, mesh, { threshold: 0.6 }), RangeError);
  await assert.rejects(transferWeights(body, mesh, { boneCount: 1 }), RangeError);
  await assert.rejects(transferWeights({ ...body, positions: mesh.positions }, mesh), RangeError);
  await assert.rejects(transferWeights({ positions: body.positions, weights: body.weights, indices: [] }, mesh), RangeError);
  await assert.rejects(transferWeights(body, mesh, { signal: AbortSignal.abort(new Error('stop')) }), /stop/);
});

const asset = (path) => new URL(`../../../examples/assets/${path}`, import.meta.url);
/** One primitive of a real mesh as the target, every other one as the source, against its authored weights. */
async function fromTheRest({ joints, mesh, authored, parts }, part) {
  const dense = new WeightMap(authored.length, joints.length);
  authored.forEach((row, v) => row.forEach((w, b) => dense.set(v, b, w)));
  const indices = parts.flatMap((other) => (other === part ? [] : Array.from(other.indices, (i) => other.first + i))),
    target = { positions: mesh.positions.subarray(part.first * 3, (part.first + part.count) * 3), indices: part.indices },
    { weights } = await transferWeights({ positions: mesh.positions, indices, weights: dense }, target);
  return compare(authored.slice(part.first, part.first + part.count), weights, joints);
}

test("Seed-san's clothes: each part copied from the rest of the outfit comes back as authored", async () => {
  const skin = realSkin(asset('vrm/Seed-san.vrm'), (n) => n.name === 'wear'),
    largest = Math.max(...skin.parts.map((p) => p.count));
  let vertices = 0,
    gap = 0,
    near = 0;
  // Not the largest part: it is the suit under everything, with nothing around it to copy from.
  for (const part of skin.parts.filter((p) => p.count < largest)) {
    const result = await fromTheRest(skin, part);
    vertices += part.count;
    gap += result.gap * part.count;
    near += result.near * part.count;
  }
  assert.ok(near / vertices > 0.9, `strongest bone agrees on ${near / vertices}`);
  assert.ok(gap / vertices < 0.15, `row gap ${gap / vertices}`);
});

test('the Twist sample: parts that lie on the body come back as authored, and a copy to itself changes nothing', async () => {
  const skin = realSkin(asset('vrm/VRM1_Constraint_Twist_Sample.vrm'), (n) => n.name === 'Body'),
    { joints, mesh, authored, parts } = skin;
  for (const count of [883, 600]) {
    const result = await fromTheRest(skin, parts.find((p) => p.count === count));
    assert.ok(result.near > 0.99 && result.gap < 0.05, `${count} vertices: ${JSON.stringify(result)}`);
  }
  const dense = new WeightMap(authored.length, joints.length);
  authored.forEach((row, v) => row.forEach((w, b) => dense.set(v, b, w)));
  const { weights } = await transferWeights({ ...mesh, weights: dense }, mesh),
    same = compare(authored, weights, joints);
  assert.ok(same.gap < 0.01, JSON.stringify(same));
});
