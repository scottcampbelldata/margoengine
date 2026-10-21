import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('disposing shader storage releases CPU arrays while the GPU device remains alive', () => {
  // The real StorageBuffer is exercised in a fresh GC-enabled process. The device double has only the
  // allocation/upload/loss boundary; a never-settling lost promise deliberately outlives the disposed buffers.
  const source = `
    import assert from 'node:assert/strict';
    import { setImmediate } from 'node:timers/promises';
    import { storage } from ${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)};
    globalThis.GPUBufferUsage = { STORAGE: 128, COPY_DST: 8, COPY_SRC: 4, VERTEX: 32 };
    const device = {
      lost: new Promise(() => {}),
      createBuffer() { return { destroy() {} }; },
      queue: { writeBuffer() {} },
    };
    let weakBuffer, weakData;
    function allocateAndDispose() {
      const field = storage(new Uint32Array(262144), 'u32');
      field.buffer(device);
      field.dispose();
      weakBuffer = new WeakRef(field);
      weakData = new WeakRef(field.data);
    }
    allocateAndDispose();
    for (let i = 0; i < 5; i++) { await setImmediate(); globalThis.gc(); }
    assert.equal(weakBuffer.deref() === undefined, true, 'unresolved device.lost retained disposed StorageBuffer');
    assert.equal(weakData.deref() === undefined, true, 'unresolved device.lost retained disposed CPU storage');
    assert.ok(device.lost instanceof Promise, 'device must remain alive through the assertion');
  `;
  const result = spawnSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', source], {
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr ?? result.stdout);
});
