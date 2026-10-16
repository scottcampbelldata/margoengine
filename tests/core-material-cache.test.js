import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '../packages/core/dist/extension.js';
import { box, PbrMaterial } from '../packages/core/dist/index.js';

test('shared material snapshots preserve read order and every instance after in-place Float32 edits', async (t) => {
  const draws = [],
    reads = [],
    engine = new Engine({ width: 64, height: 64, clientWidth: 64, clientHeight: 64 }, await TransformStore.create(8), {
      backend: 'webgpu',
      add() {},
      remove() {},
      dispose() {},
      render(_camera, _lighting, batches) {
        draws.push([...batches].map((batch) => batch.instances.slice(0, batch.count * 24)));
      },
    });
  t.after(() => engine.dispose());
  const geometry = box(),
    shared = new PbrMaterial(),
    other = new PbrMaterial(),
    sharedData = shared.data,
    otherData = other.data;
  Object.defineProperty(shared, 'data', {
    get() {
      reads.push('shared');
      return sharedData;
    },
  });
  Object.defineProperty(other, 'data', {
    get() {
      reads.push('other');
      return otherData;
    },
  });
  const first = engine.createMesh().setGeometry(geometry).setMaterial(shared),
    second = engine.createMesh().setGeometry(geometry).setMaterial(shared),
    third = engine.createMesh().setGeometry(geometry).setMaterial(other),
    options = { culling: false };
  engine.render(options);
  reads.length = 0;
  engine.render(options);
  assert.deepEqual(
    reads,
    [...Array(8).fill('shared'), ...Array(8).fill('other')],
    'Each shared material keeps one ordered snapshot',
  );
  sharedData[0] = 1 / 3;
  otherData[2] = 1 / 7;
  engine.render(options);
  const values = draws.at(-1)[0];
  for (const mesh of [first, second, third]) {
    const offset = values.findIndex((value, index) => index % 24 === 23 && value === mesh.id) - 7;
    assert.deepEqual(values.slice(offset, offset + 7), (mesh === third ? otherData : sharedData).slice(0, 7));
  }
  reads.length = 0;
  engine.render(options);
  assert.deepEqual(reads, [...Array(8).fill('shared'), ...Array(8).fill('other')]);
  const count = draws.length;
  sharedData[4] = Infinity;
  assert.throws(() => engine.render(options), /Material: finite values/);
  assert.equal(draws.length, count, 'Invalid cached material data cannot reach the renderer');
});
