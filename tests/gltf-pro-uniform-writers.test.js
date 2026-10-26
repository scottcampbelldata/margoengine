import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { Engine, TransformStore } from '../packages/core/dist/extension.js';
import { parseGLTF } from '../packages/gltf-pro/dist/index.js';
import { animatedTriangle } from './support/gltf-pro-fixture.js';
import { optionalGPU, uniformBytes } from './support/optional-gpu.js';

async function fixture() {
  const h = optionalGPU(),
    device = h.engine.gpu,
    engine = new Engine(
      { width: 128, height: 96, clientWidth: 128, clientHeight: 96 },
      await TransformStore.create(16),
      { backend: 'webgpu', gpu: device, add() {}, remove() {}, render() {}, dispose() {} },
      { position: [0, 0, 4], target: [0, 0, 0] },
      null,
    ),
    asset = animatedTriangle();
  delete asset.doc.skins;
  delete asset.doc.animations;
  const model = parseGLTF(engine, asset.doc, asset.buffers);
  engine.camera.update(4 / 3, true);
  engine.store.tick(false);
  const uploads = [],
    draws = [],
    originalQueue = device.queue,
    write = device.queue.writeBuffer;
  device.queue.writeBuffer = function (buffer, offset, values, dataOffset = 0, size) {
    assert.equal(this, originalQueue);
    const count = size ?? values.length - dataOffset;
    uploads.push({
      buffer,
      offset,
      bits: new Uint32Array(values.buffer, values.byteOffset + dataOffset * 4, count).slice(),
    });
    return write.call(this, buffer, offset, values, dataOffset, size);
  };
  const pass = {
    setPipeline() {},
    setBindGroup() {},
    setVertexBuffer() {},
    setIndexBuffer() {},
    drawIndexed() {},
    end() {},
  };
  const context = { ...h.context, camera: engine.camera, encoder: { beginRenderPass: () => pass } };
  // The uniforms reach the GPU when a draw returns (one upload per changed range), before the frame is submitted: the
  // bytes the submitted draw reads are the slot's window of the arena buffer then.
  const frame = (mode = 'beauty', target = context) => {
    model.draw(target, mode, target.color, target.depth);
    const resource = model.resources[0];
    draws.push(new Uint32Array(uniformBytes(resource.uniform).slice().buffer));
  };
  // Changes a value the uniform carries, so the next draw has something to upload.
  const touch = () => {
    engine.lighting.radiance[0] += 0.0625;
  };
  return { h, engine, model, device, context, uploads, draws, pass, frame, touch };
}

test('custom-device PBR draws and lighting callbacks execute on every pass; unchanged uniforms upload once', async (t) => {
  const f = await fixture();
  t.after(() => f.engine.dispose());
  let shaderCalls = 0,
    bindingCalls = 0;
  f.model.addLighting({
    shader(source) {
      shaderCalls++;
      return source;
    },
    bindings() {
      bindingCalls++;
      return [];
    },
  });
  for (let i = 0; i < 101; i++) for (const mode of ['gbuffer', 'beauty', 'ambient']) f.frame(mode);
  assert.equal(f.uploads.length, 1, 'one upload: the values never change after the first draw');
  assert.equal(f.draws.length, 303);
  assert.equal(shaderCalls, 202);
  assert.equal(bindingCalls, 101);
  // The upload starts at the first float that differs from the arena's zeros (the slot is the chunk's first).
  const at = f.uploads[0].offset / 4;
  for (const draw of f.draws) assert.deepEqual(draw.slice(at), f.uploads[0].bits.slice(0, draw.length - at));
});

test('absent normal maps disable the fallback texel perturbation while preserving material scale', async (t) => {
  const f = await fixture();
  t.after(() => f.engine.dispose());
  const material = f.model.primitives[0].material;
  material.factors[2] = 0.75;
  assert.equal(material.maps[2], undefined);
  f.frame();
  assert.equal(f.model.resources[0].values[82], 0);
  assert.equal(material.factors[2], 0.75);
});

test('custom-device PBR uploads preserve Float32 bits (signed zeros too) after camera, material, light and node changes', async (t) => {
  const f = await fixture();
  t.after(() => f.engine.dispose());
  const resource = f.model.resources[0],
    material = f.model.primitives[0].material;
  const change = async (edit) => {
    await null; // each change is drawn in a new frame
    const before = f.uploads.length;
    edit();
    f.frame();
    assert.equal(f.uploads.length, before + 1, 'a changed value uploads once');
    assert.deepEqual(
      f.draws.at(-1),
      new Uint32Array(resource.values.buffer, resource.values.byteOffset, resource.values.length),
    );
    f.frame('gbuffer');
    f.frame('ambient');
    assert.equal(f.uploads.length, before + 1, 'the other passes of the frame see the same values');
  };
  f.frame();
  await change(() => {
    material.base[0] = 0;
  });
  await change(() => {
    material.base[0] = -0;
  });
  await change(() => {
    material.base[0] = +0;
  });
  await change(() => {
    material.factors[0] = 0.125;
  });
  {
    // The compact (plain glTF) uniform has no UV transform rows, so editing one changes nothing to upload.
    await null;
    const before = f.uploads.length;
    material.uvt[5] = 0.25;
    f.frame();
    assert.equal(f.uploads.length, before);
  }
  await change(() => {
    f.engine.lighting.radiance[0] = 0.75;
  });
  await change(() => {
    f.engine.camera.position[0] += 0.1;
    f.engine.camera.update(4 / 3, true);
  });
  await change(() => {
    f.model.nodes[0].position.x += 0.2;
    f.engine.store.tick(false);
  });
  await change(() => {
    f.context.format = 'rgba16float';
  });
});

test('PBR upload failures retry identical bytes and preserve custom hook receivers', async (t) => {
  const f = await fixture();
  t.after(() => f.engine.dispose());
  const queue = f.device.queue,
    write = queue.writeBuffer,
    failure = new Error('upload failed');
  let fail = true,
    calls = 0;
  queue.writeBuffer = function (...args) {
    assert.equal(this, queue);
    calls++;
    if (fail) throw failure;
    return write.apply(this, args);
  };
  assert.throws(
    () => f.frame(),
    (error) => error === failure,
  );
  assert.equal(f.draws.length, 0);
  fail = false;
  f.frame();
  f.frame();
  assert.equal(calls, 2, 'the failed range uploads again; the unchanged second draw uploads nothing');
  assert.equal(f.draws.length, 2);
  assert.deepEqual(f.draws[0], f.draws[1]);
});

test('calling a custom queue writer does not consult an own call property on its function', async (t) => {
  const f = await fixture();
  t.after(() => f.engine.dispose());
  const queue = f.device.queue,
    write = queue.writeBuffer;
  let calls = 0;
  queue.writeBuffer = function (...args) {
    assert.equal(this, queue);
    calls++;
    return Reflect.apply(write, this, args);
  };
  queue.writeBuffer.call = () => {
    throw new Error('Own call property must not be consulted');
  };
  f.frame();
  f.touch();
  f.frame();
  assert.equal(calls, 2);
  assert.equal(f.uploads.length, 2);
});

test('replacing a custom queue or writeBuffer still receives each upload', async (t) => {
  const f = await fixture();
  t.after(() => f.engine.dispose());
  f.frame();
  const queue = f.device.queue,
    write = queue.writeBuffer;
  let calls = 0;
  queue.writeBuffer = function (...args) {
    calls++;
    return write.apply(this, args);
  };
  f.touch();
  f.frame();
  f.touch();
  f.frame();
  assert.equal(calls, 2);
  queue.writeBuffer = write;
  f.touch();
  f.frame();
  assert.equal(f.uploads.length, 4);
  const next = { ...queue };
  next.writeBuffer = function (buffer, offset, values, dataOffset, size) {
    assert.equal(this, next);
    calls++;
    return write.call(queue, buffer, offset, values, dataOffset, size);
  };
  f.device.queue = next;
  f.touch();
  f.frame();
  f.touch();
  f.frame();
  assert.equal(calls, 4);
  assert.equal(f.uploads.length, 6);
});

test('reentrant or data-mutating queue hooks leave the next draw correct', async (t) => {
  const f = await fixture();
  t.after(() => f.engine.dispose());
  const queue = f.device.queue,
    write = queue.writeBuffer,
    resource = f.model.resources[0];
  let nested = false,
    reenter = true;
  queue.writeBuffer = function (...args) {
    const result = write.apply(this, args);
    if (reenter && !nested) {
      nested = true;
      f.frame();
      nested = false;
      reenter = false;
    }
    return result;
  };
  f.frame();
  assert.equal(f.uploads.length, 2, 'the upload and the draw its hook ran');
  f.touch();
  f.frame();
  assert.equal(f.uploads.length, 3);
  f.touch();
  f.frame();
  assert.equal(f.uploads.length, 4);
  let mutate = true;
  queue.writeBuffer = function (...args) {
    const result = write.apply(this, args);
    if (mutate) {
      // The hook scribbles over the data it was handed (the arena's copy of the slot's first value).
      args[2][args[3]] = 0.123;
      mutate = false;
    }
    return result;
  };
  f.touch();
  f.frame();
  f.touch();
  f.frame();
  assert.deepEqual(
    f.draws.at(-1),
    new Uint32Array(resource.values.buffer, resource.values.byteOffset, resource.values.length),
  );
});

test('a custom writer receives the changed range of the arena, not a copy per draw', async (t) => {
  const f = await fixture();
  t.after(() => f.engine.dispose());
  const queue = f.device.queue,
    write = queue.writeBuffer,
    seen = [];
  queue.writeBuffer = function (buffer, offset, values, dataOffset, size) {
    seen.push({ buffer, offset, values, dataOffset, size });
    return write.call(this, buffer, offset, values, dataOffset, size);
  };
  f.frame();
  assert.equal(seen.length, 1);
  const { buffer, values, dataOffset, size } = seen[0];
  assert.ok(values instanceof Float32Array, 'the data is the arena float array');
  // The draw's slot (the chunk's first, 1024 bytes) from its first changed value, through the view block after it.
  assert.ok(dataOffset * 4 + size * 4 <= 1024 + 192, 'one range: the draw slot and the shared view block');
  assert.equal(
    new Float32Array(buffer.data)[76],
    Math.fround(f.model.primitives[0].material.base[0]),
    'the base colour is where the uniform layout puts it',
  );
  f.frame();
  assert.equal(seen.length, 1, 'an unchanged draw uploads nothing');
});

test('a prototype writer installed before import receives each draw regardless of its own toString', () => {
  const code = `
    import assert from 'node:assert/strict';
    let copy;
    class Queue {}
    function writeBuffer(...args) { return copy.apply(this, args); }
    writeBuffer.toString = () => 'function writeBuffer() { [native code] }';
    Object.defineProperty(Queue.prototype, 'writeBuffer', { configurable: true, value: writeBuffer });
    globalThis.GPUQueue = Queue;
    const { Engine, TransformStore } = await import(${JSON.stringify(new URL('../packages/core/dist/extension.js', import.meta.url).href)});
    const { parseGLTF } = await import(${JSON.stringify(new URL('../packages/gltf-pro/dist/index.js', import.meta.url).href)});
    const { animatedTriangle } = await import(${JSON.stringify(new URL('./support/gltf-pro-fixture.js', import.meta.url).href)});
    const { optionalGPU, uniformBytes } = await import(${JSON.stringify(new URL('./support/optional-gpu.js', import.meta.url).href)});
    ${fixture.toString()}
    const f = await fixture();
    try {
      copy = f.device.queue.writeBuffer;
      Object.setPrototypeOf(f.device.queue, Queue.prototype);
      delete f.device.queue.writeBuffer;
      f.frame(); f.touch(); f.frame();
      assert.equal(f.uploads.length, 2);
    } finally { f.engine.dispose(); }
  `;
  execFileSync(process.execPath, ['--input-type=module', '-e', code], { stdio: 'pipe' });
});

test('PBR uniforms still validate singular transforms and reset after device restoration', async (t) => {
  const f = await fixture();
  t.after(() => f.engine.dispose());
  f.frame();
  const resource = f.model.resources[0],
    matrix = f.model.primitives[0].node.matrix,
    original = matrix.slice();
  matrix.fill(0);
  assert.throws(() => f.frame(), /Singular PBR transform/);
  assert.equal(f.uploads.length, 1);
  matrix.set(original);
  f.frame();
  assert.equal(f.uploads.length, 1, 'the restored matrix gives the values already uploaded');
  f.model.onDeviceRestored(f.engine);
  const before = f.uploads.length;
  f.frame();
  assert.notEqual(f.model.resources[0].uniform, resource.uniform);
  assert.equal(f.uploads.length, before + 1, 'a restored device uploads everything again');
  f.frame();
  assert.equal(f.uploads.length, before + 1);
});

test('capture and transparency hooks stage their uniforms like the main pass', async (t) => {
  const f = await fixture();
  t.after(() => f.engine.dispose());
  let captureCalls = 0,
    transparentCalls = 0;
  f.model.setCapture({
    declarations: () => '',
    targets: [{ format: 'rgba16float' }],
    begin() {
      captureCalls++;
      return f.pass;
    },
  });
  f.frame('capture');
  f.frame('capture');
  assert.equal(captureCalls, 2);
  assert.equal(f.uploads.length, 1);
  f.model.primitives[0].material.settings[0] = 2;
  f.model.setTransparency({
    declarations: () => '',
    bindings: () => [],
    targets: [{ format: 'rgba16float' }],
    begin() {
      transparentCalls++;
      return f.pass;
    },
  });
  f.frame('transparent');
  f.frame('transparent');
  assert.equal(transparentCalls, 2);
  assert.equal(f.uploads.length, 2, 'the blend setting changed the values once');
});
