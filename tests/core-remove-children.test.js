import { speedTest } from '../scripts/support/speed-test.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpuTimer } from '../scripts/support/cpu-budget.mjs';
import { Engine } from '../packages/core/dist/engine.js';
import { TransformStore } from '../packages/core/dist/kernel.js';

const create = async (capacity) =>
  new Engine(
    { width: 8, height: 8, clientWidth: 8, clientHeight: 8 },
    await TransformStore.create(capacity),
    { backend: 'webgpu', add() {}, remove() {}, dispose() {}, render() {}, pick: async () => -1 },
    undefined,
    null,
  );

test('removing a mesh unparents only its current children, also after reparenting and slot reuse', async () => {
  using engine = await create(16);
  const parents = () => engine.store.parents;
  const a = engine.createMesh(),
    b = engine.createMesh(),
    child = engine.createMesh(a),
    moved = engine.createMesh(a),
    grand = engine.createMesh(child);
  moved.setParent(b);
  a.dispose();
  assert.equal(parents()[child.id], -1, 'a child of the removed mesh keeps a dead parent');
  assert.equal(parents()[moved.id], b.id, 'a child moved away was unparented with its old parent');
  assert.equal(parents()[grand.id], child.id, 'a grandchild lost its living parent');
  // The freed slot is reused; removing the new mesh must not touch the old mesh's former children.
  const reused = engine.createMesh();
  assert.equal(reused.id, a.id);
  child.setParent(b);
  reused.dispose();
  assert.equal(parents()[child.id], b.id, 'a reused slot inherited the old mesh children');
  // A removed child leaves its parent's set: its reused slot is not unparented with the parent.
  const leaf = engine.createMesh(b);
  leaf.dispose();
  const other = engine.createMesh(child);
  assert.equal(other.id, leaf.id);
  b.dispose();
  assert.equal(parents()[other.id], child.id, 'a removed child stayed in its old parent set');
  assert.equal(parents()[child.id], -1);
});

speedTest('removing many meshes does not scan every slot per mesh', async () => {
  // Before: each remove scanned the whole parent column (capacity), 30,000 x 524,288 slots, about 3 s here.
  using engine = await create(1 << 19);
  const root = engine.createMesh(),
    meshes = Array.from({ length: 30_000 }, (_, i) => engine.createMesh(i % 2 ? root : undefined));
  const cpu = cpuTimer();
  for (const mesh of meshes) mesh.dispose();
  root.dispose();
  const ms = cpu();
  assert.ok(ms < 150, `removing 30,001 meshes took ${ms.toFixed(0)} ms of CPU`);
});
