import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { Engine, TransformStore } from '../packages/core/dist/extension.js';
import { parseGLTF } from '../packages/gltf-pro/dist/index.js';
import { animatedTriangle } from './support/gltf-pro-fixture.js';
import { optionalGPU } from './support/optional-gpu.js';

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
  device.queue.writeBuffer = function (buffer, offset, values) {
    assert.equal(this, originalQueue);
    uploads.push({ buffer, offset, bits: new Uint32Array(values.buffer, values.byteOffset, values.length).slice() });
    return write.call(this, buffer, offset, values);
  };
  const pass = {
    setPipeline() {},
    setBindGroup() {},
    setVertexBuffer() {},
    setIndexBuffer() {},
    drawIndexed() {
      const resource = model.resources[0];
      draws.push(new Uint32Array(resource.uniform.data).slice());
    },
    end() {},
  };
  const context = { ...h.context, camera: engine.camera, encoder: { beginRenderPass: () => pass } };
  const frame = (mode = 'beauty', target = context) => model.draw(target, mode, target.color, target.depth);
  return { h, engine, model, device, context, uploads, draws, pass, frame };
}

test('custom-device PBR uploads, draws and lighting callbacks still execute on every main pass', async (t) => {
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
  assert.equal(f.uploads.length, 303);
  assert.equal(f.draws.length, 303);
  assert.equal(shaderCalls, 202);
  assert.equal(bindingCalls, 101);
  for (const draw of f.draws) assert.deepEqual(draw, f.uploads[0].bits);
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

test('custom-device PBR uploads preserve Float32 bits after camera, material, light and node changes', async (t) => {
  const f = await fixture();
  t.after(() => f.engine.dispose());
  const resource = f.model.resources[0],
    material = f.model.primitives[0].material;
  const change = (edit) => {
    const before = f.uploads.length;
    edit();
    f.frame();
    assert.equal(f.uploads.length, before + 1);
    assert.deepEqual(
      f.draws.at(-1),
      new Uint32Array(resource.values.buffer, resource.values.byteOffset, resource.values.length),
    );
    f.frame('gbuffer');
    f.frame('ambient');
    assert.equal(f.uploads.length, before + 3);
  };
  f.frame();
  change(() => {
    material.base[0] = 0;
  });
  change(() => {
    material.base[0] = -0;
  });
  change(() => {
    material.base[0] = +0;
  });
  change(() => {
    material.factors[0] = 0.125;
  });
  change(() => {
    material.uvt[5] = 0.25;
  });
  change(() => {
    f.engine.lighting.radiance[0] = 0.75;
  });
  change(() => {
    f.engine.camera.position[0] += 0.1;
    f.engine.camera.update(4 / 3, true);
  });
  change(() => {
    f.model.nodes[0].position.x += 0.2;
    f.engine.store.tick(false);
  });
  change(() => {
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
  assert.equal(calls, 3);
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
  f.frame();
  assert.equal(calls, 2);
  assert.equal(f.uploads.length, 2);
});

test('replacing a custom queue or writeBuffer preserves unconditional upload calls', async (t) => {
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
  f.frame();
  f.frame();
  assert.equal(calls, 2);
  queue.writeBuffer = write;
  f.frame();
  assert.equal(f.uploads.length, 4);
  const next = { ...queue };
  next.writeBuffer = function (buffer, offset, values) {
    assert.equal(this, next);
    calls++;
    return write.call(queue, buffer, offset, values);
  };
  f.device.queue = next;
  f.frame();
  f.frame();
  assert.equal(calls, 4);
  assert.equal(f.uploads.length, 6);
});

test('reentrant or data-mutating queue hooks retain unconditional PBR upload behavior', async (t) => {
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
  assert.equal(f.uploads.length, 2);
  f.frame();
  assert.equal(f.uploads.length, 3);
  f.frame();
  assert.equal(f.uploads.length, 4);
  let mutate = true;
  queue.writeBuffer = function (...args) {
    const result = write.apply(this, args);
    if (mutate) {
      args[2][0] = 0.123;
      mutate = false;
    }
    return result;
  };
  f.frame();
  f.frame();
  assert.deepEqual(
    f.draws.at(-1),
    new Uint32Array(resource.values.buffer, resource.values.byteOffset, resource.values.length),
  );
});

test('a custom writer that temporarily changes and restores input bytes runs again on the next draw', async (t) => {
  const f = await fixture();
  t.after(() => f.engine.dispose());
  const queue = f.device.queue,
    write = queue.writeBuffer;
  let first = true;
  queue.writeBuffer = function (buffer, offset, values) {
    const original = values[76];
    if (first) values[76] = 0.37;
    try {
      return write.call(this, buffer, offset, values);
    } finally {
      values[76] = original;
      first = false;
    }
  };
  f.frame();
  assert.equal(new Float32Array(f.model.resources[0].uniform.data)[76], Math.fround(0.37));
  f.frame();
  assert.equal(f.uploads.length, 2, 'the custom writer must be called on every draw');
  assert.equal(
    new Float32Array(f.model.resources[0].uniform.data)[76],
    Math.fround(f.model.primitives[0].material.base[0]),
  );
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
    const { optionalGPU } = await import(${JSON.stringify(new URL('./support/optional-gpu.js', import.meta.url).href)});
    ${fixture.toString()}
    const f = await fixture();
    try {
      copy = f.device.queue.writeBuffer;
      Object.setPrototypeOf(f.device.queue, Queue.prototype);
      delete f.device.queue.writeBuffer;
      f.frame(); f.frame();
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
  assert.equal(f.uploads.length, 2);
  f.model.onDeviceRestored(f.engine);
  const before = f.uploads.length;
  f.frame();
  assert.notEqual(f.model.resources[0].uniform, resource.uniform);
  assert.equal(f.uploads.length, before + 1);
  f.frame();
  assert.equal(f.uploads.length, before + 2);
});

test('capture and transparency hooks retain unconditional uploads for custom devices', async (t) => {
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
  assert.equal(f.uploads.length, 2);
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
  assert.equal(f.uploads.length, 4);
});
