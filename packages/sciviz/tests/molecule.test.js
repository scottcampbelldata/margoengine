import test from 'node:test';
import assert from 'node:assert/strict';
import { molecule } from '../dist/molecule.js';
const prior = [globalThis.GPUBufferUsage, globalThis.GPUShaderStage];
test.before(() => {
  globalThis.GPUBufferUsage = { UNIFORM: 64, STORAGE: 128, COPY_DST: 8 };
  globalThis.GPUShaderStage = { VERTEX: 1, FRAGMENT: 2 };
});
test.after(() => {
  for (const [i, k] of ['GPUBufferUsage', 'GPUShaderStage'].entries()) {
    if (prior[i] === undefined) delete globalThis[k];
    else globalThis[k] = prior[i];
  }
});
function make(input, options = {}, failAt = 0) {
  const writes = [],
    buffers = [];
  let calls = 0;
  const renderer = {
    device: {
      limits: { maxBufferSize: 1e8, maxStorageBufferBindingSize: 1e8 },
      createBuffer() {
        if (++calls === failAt) throw new Error('allocation failure');
        const b = {
          destroyed: false,
          destroy() {
            this.destroyed = true;
          },
        };
        buffers.push(b);
        return b;
      },
      queue: {
        writeBuffer(b, offset, data) {
          writes.push(data.slice());
        },
      },
      createBindGroupLayout() {
        if (++calls === failAt) throw new Error('allocation failure');
        return {};
      },
      createBindGroup() {
        if (++calls === failAt) throw new Error('allocation failure');
        return {};
      },
    },
    add() {},
    remove() {},
  };
  const figure = {
    renderer,
    addLayer(layer) {
      layer.setModel(new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]));
      return layer;
    },
    remove() {},
  };
  const layer = molecule(figure, input, options);
  return { layer, data: writes[0], buffers };
}
import { parsePDB } from '@margoengine/loaders/pdb';
import { readFileSync } from 'node:fs';
const structure = () => ({
  kind: 'points',
  positions: new Float32Array([-2, 0, 0, 2, 0, 0]),
  colors: new Float32Array([1, 0, 0, 0, 0, 1]),
  radii: new Float32Array([0.76, 0.76]),
  bonds: new Uint32Array([0, 1]),
  warnings: [],
  atoms: [
    { serial: 1, name: 'C', element: 'C', residue: 'ALA', chain: 'A', sequence: 7, insertionCode: 'A' },
    { serial: 2, name: 'O', element: 'O', residue: 'GLY', chain: 'A', sequence: 7, insertionCode: 'B' },
  ],
});
test('all representations use van der Waals balls or equal licorice radii with cylinder bonds', () => {
  const m = structure(),
    ball = make(m),
    space = make(m, { style: 'space-filling' }),
    licorice = make(m, { style: 'licorice' });
  assert.equal(ball.layer.primitiveCount, 3);
  assert.equal(space.layer.primitiveCount, 2);
  assert.equal(licorice.layer.primitiveCount, 3);
  assert.ok(Math.abs(ball.data[3] - 0.51) < 1e-7);
  assert.ok(Math.abs(space.data[3] - 1.7) < 1e-7);
  assert.equal(licorice.data[3], licorice.data[35]);
  assert.equal(ball.layer.residues.length, 2);
  assert.equal(ball.layer.residues[0].insertionCode, 'A');
  assert.equal(ball.layer.residues[1].insertionCode, 'B');
  assert.equal(make(m, { atomIndices: [] }).layer.primitiveCount, 0);
  assert.equal(make(m, { atomIndices: [1] }).layer.primitiveCount, 1);
});
test('analytic picking returns the nearest sphere, capped cylinder and the corresponding full residue identity', () => {
  const data = make(structure(), { style: 'licorice', bondRadius: 0.25 }),
    hit = data.layer.pickRay([-2, 0, 3], [0, 0, -2]);
  assert.equal(hit.atomIndex, 0);
  assert.equal(hit.distance, 2.75);
  assert.equal(hit.residue.insertionCode, 'A');
  const bond = data.layer.pickRay([1, 0, 3], [0, 0, -1]);
  assert.deepEqual(bond.bond, [0, 1]);
  assert.equal(bond.atomIndex, 1);
  assert.equal(bond.residue.insertionCode, 'B');
  assert.equal(bond.distance, 2.75);
  const capped = make(structure(), { atomScale: 0.0001, bondRadius: 0.25 }).layer;
  assert.equal(capped.pickRay([-5, 0.15, 0], [1, 0, 0]).distance, 3);
  assert.equal(capped.pickRay([0, 0.15, 0], [1, 0, 0]).distance, 2);
  assert.equal(capped.pickRay([0, 0.25, 3], [0, 0, -1]).distance, 3);
  assert.equal(data.layer.pickRay([0, 3, 3], [0, 0, -1]), null);
});
test('real 1CRN uses 664 impostors and snapshots are independent of input edits', () => {
  const input = parsePDB(readFileSync(new URL('fixtures/molecule/1crn.pdb', import.meta.url))),
    data = make(input);
  assert.equal(data.layer.primitiveCount, 664);
  assert.equal(data.layer.residues.length, 46);
  const p = data.data[0];
  input.positions[0] = 999;
  input.atoms[0].name = 'changed';
  assert.equal(data.data[0], p);
  assert.notEqual(data.layer.pickRay([p, 6.3, 100], [0, 0, -1])?.atom.name, 'changed');
});
test('invalid arrays, bonds, display options, selections and rays reject before GPU allocation', () => {
  for (const opts of [
    { style: 'oops' },
    { atomScale: 0 },
    { bondRadius: NaN },
    { atomIndices: [-1] },
    { atomIndices: [2] },
  ])
    assert.throws(() => make(structure(), opts));
  const m = structure();
  m.bonds[0] = 9;
  assert.throws(() => make(m));
  const d = make(structure());
  assert.throws(() => d.layer.pickRay([0, 0, 0], [0, 0, 0]));
});

test('construction failures release every earlier GPU allocation, restore and disposal are idempotent', () => {
  for (const failAt of [1, 2, 3, 4]) {
    let buffers = [],
      calls = 0;
    const device = {
      limits: { maxBufferSize: 1e8, maxStorageBufferBindingSize: 1e8 },
      queue: { writeBuffer() {} },
      createBuffer() {
        if (++calls === failAt) throw new Error('allocation failure');
        const b = {
          destroyed: false,
          destroy() {
            this.destroyed = true;
          },
        };
        buffers.push(b);
        return b;
      },
      createBindGroupLayout() {
        if (++calls === failAt) throw new Error('allocation failure');
        return {};
      },
      createBindGroup() {
        if (++calls === failAt) throw new Error('allocation failure');
        return {};
      },
    };
    assert.throws(() => molecule({ renderer: { device } }, structure()), /allocation failure/);
    assert.ok(buffers.every((b) => b.destroyed));
  }
  const r = make(structure());
  r.layer.restore();
  assert.ok(r.buffers.slice(0, 2).every((b) => b.destroyed));
  r.layer.dispose();
  r.layer.dispose();
  assert.ok(r.buffers.every((b) => b.destroyed));
  assert.equal(r.layer.pickRay([0, 0, 9], [0, 0, -1]), null);
});
