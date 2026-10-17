// A CAD file over one of machinery's caps (docs/limits.md) fails with a RangeError that names the cap and the way past
// it. The 2,500-part assembly of scripts/cad-scale-tests.js (1,133,200 OBJ vertices, all well formed) used to fail as
// "Invalid OBJ vertex", as if the file were broken, and a STEP over 64 MiB as "TypeError: Invalid CAD input".
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '../packages/core/dist/extension.js';
import { parseCAD, parseCADAsync } from '../packages/machinery/dist/index.js';

const glb = 'export it as GLB and load it with @margoengine/gltf-pro';

async function headless() {
  return new Engine(
    { width: 8, height: 8, clientWidth: 8, clientHeight: 8 },
    await TransformStore.create(8),
    { backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {} },
    undefined,
    null,
  );
}

test('an OBJ past 1,000,000 vertices names the vertex cap; a malformed vertex is still invalid', async () => {
  const engine = await headless();
  try {
    assert.throws(() => parseCAD(engine, 'v 0 0 0\n'.repeat(1_000_001), 'obj'), {
      name: 'RangeError',
      message: `OBJ vertex limit (over 1000000); ${glb}`,
    });
    assert.throws(() => parseCAD(engine, 'v 0 0\n', 'obj'), { name: 'RangeError', message: 'Invalid OBJ vertex' });
  } finally {
    engine.dispose();
  }
});

test('a binary STL past 1,000,000 triangles names the triangle cap', async () => {
  const engine = await headless(),
    count = 1_000_001,
    stl = new Uint8Array(84 + count * 50);
  new DataView(stl.buffer).setUint32(80, count, true);
  try {
    assert.throws(() => parseCAD(engine, stl, 'stl'), {
      name: 'RangeError',
      message: `STL triangle limit (1000001 > 1000000); ${glb}`,
    });
  } finally {
    engine.dispose();
  }
});

test('a STEP over 64 MiB names the size cap and margo-convert; an empty buffer is still invalid input', async () => {
  const engine = await headless();
  try {
    assert.throws(() => parseCADAsync(engine, new ArrayBuffer(64 * 1024 * 1024 + 1), 'step'), {
      name: 'RangeError',
      message:
        'CAD exceeds 64 MiB (67108865 > 67108864 bytes); convert it to GLB with margo-convert and load it with @margoengine/gltf-pro',
    });
    assert.throws(() => parseCADAsync(engine, new ArrayBuffer(0), 'step'), {
      name: 'TypeError',
      message: 'Invalid CAD input',
    });
  } finally {
    engine.dispose();
  }
});
