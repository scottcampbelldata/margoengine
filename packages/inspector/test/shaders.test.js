// Live shader editing on a real @margoengine/materials WgslMaterial mesh drawn through gltf-pro's real draw code,
// over the recording fake WebGPU device (no GPU): the fake device's compiler is a stand-in that reports an error on
// the token `bad_token`, at its real line and column in the module text, so the test checks where the editor places
// messages. That a real compiler (Metal here) accepts and rejects the same text is the browser check's job.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { Engine, TransformStore } from '@margoengine/core/extension';
import { PbrMaterial, WgslMaterial, createMesh } from '@margoengine/materials';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { EditHistory } from '../dist/history.js';
import { ShaderEditor, isWgslMaterial, recompileShader } from '../dist/shaders.js';

const good =
  'fn shade(i: Out, s: Surface) -> Surface {\n  var o = s;\n  o.base = vec4f(uniforms.tint, 1.0);\n  return o;\n}';
const red = good.replace('uniforms.tint', 'vec3f(1.0, 0.0, 0.0)');
// `bad_token` on line 3, column 12 of the edited text.
const broken = 'fn shade(i: Out, s: Surface) -> Surface {\n  var o = s;\n  o.base = bad_token;\n  return o;\n}';
const triangle = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1] };

async function world() {
  const harness = optionalGPU(),
    store = await TransformStore.create(16),
    device = harness.engine.gpu;
  device.limits.maxTextureDimension2D = 8192;
  device.limits.maxUniformBufferBindingSize = 65536;
  device.queue.writeTexture = () => {};
  const compiled = [];
  // Stand-in compiler: an error at each `bad_token`, with WebGPU's 1-based line and column in the module text.
  const create = device.createShaderModule;
  device.createShaderModule = function (descriptor) {
    const module = create.call(this, descriptor) ?? {},
      code = descriptor.code;
    compiled.push({ code, label: descriptor.label ?? '' });
    const messages = [];
    let at = code.indexOf('bad_token');
    while (at >= 0) {
      const before = code.slice(0, at).split('\n');
      messages.push({
        type: 'error',
        message: "unresolved value 'bad_token'",
        lineNum: before.length,
        linePos: before.at(-1).length + 1,
      });
      at = code.indexOf('bad_token', at + 1);
    }
    return Object.assign(Object.create(module), { getCompilationInfo: async () => ({ messages }) });
  };
  const engine = new Engine(
    { width: 64, height: 64, clientWidth: 64, clientHeight: 64 },
    store,
    { backend: 'webgpu', gpu: device, add() {}, remove() {}, render() {}, dispose() {} },
    { position: [0, 0, 4], target: [0, 0, 0] },
    null,
  );
  engine.camera.update(1, true);
  const pass = {
    setPipeline() {},
    setBindGroup() {},
    setVertexBuffer() {},
    setIndexBuffer() {},
    setStencilReference() {},
    setViewport() {},
    setScissorRect() {},
    drawIndexed() {},
    end() {},
  };
  const context = { ...harness.context, camera: engine.camera, draw() {}, encoder: { beginRenderPass: () => pass } };
  // Draws a frame every 5 ms, as the engine's loop would, until stopped.
  const loop = setInterval(() => {
    store.tick(false);
    engine.frameGraph.execute(context);
  }, 5);
  return {
    engine,
    device,
    compiled,
    destroy() {
      clearInterval(loop);
      engine.dispose();
    },
  };
}

test('an edit recompiles the mesh in place, keeps uniforms, textures and other values, and undoes', async () => {
  const w = await world();
  try {
    const material = new WgslMaterial({ wgsl: good, uniforms: { tint: [0.2, 0.4, 0.6] }, roughness: 0.3 }),
      mesh = createMesh(w.engine, triangle, material),
      history = new EditHistory();
    assert.equal(isWgslMaterial(material), true);
    const result = await recompileShader(mesh, red, { device: w.device, history });
    assert.equal(result.ok, true);
    assert.ok(result.modules >= 1, 'the device built a module from the edited text');
    assert.deepEqual(result.diagnostics, []);
    assert.ok(w.compiled.some((c) => c.code.includes(red) && !c.label));
    const next = mesh.material;
    assert.notEqual(next, material);
    assert.ok(next instanceof WgslMaterial);
    assert.equal(next.wgsl, red);
    assert.deepEqual(
      [...next.uniforms.tint].map((v) => +v.toFixed(5)),
      [0.2, 0.4, 0.6],
    );
    assert.equal(+next.roughness.toFixed(5), 0.3);
    assert.equal(material.wgsl, good, 'the old material is untouched');
    assert.equal(history.undoCount, 1);
    history.undo();
    assert.equal(mesh.material, material);
    history.redo();
    assert.equal(mesh.material, next);
  } finally {
    w.destroy();
  }
});

test('a compile error keeps the last good shader and is placed at its line and column in the edited WGSL', async () => {
  const w = await world();
  try {
    const material = new WgslMaterial({ wgsl: good, uniforms: { tint: [1, 1, 1] } }),
      mesh = createMesh(w.engine, triangle, material),
      history = new EditHistory();
    const result = await recompileShader(mesh, broken, { device: w.device, history });
    assert.equal(result.ok, false);
    assert.ok(result.modules >= 1);
    assert.deepEqual(result.diagnostics, [
      { type: 'error', message: "unresolved value 'bad_token'", line: 3, column: 12 },
    ]);
    assert.equal(mesh.material, material, 'the mesh draws its last good material');
    // Regression: a broken edit drawn even once invalidates the frame's commands (the device reported the engine's
    // gpu-lost error on Metal). Only the labelled check module may hold the broken text.
    const holding = w.compiled.filter((c) => c.code.includes(broken));
    assert.ok(holding.length >= 1);
    assert.ok(holding.every((c) => c.label === 'check-wgsl:inspector-shaders'), 'the broken edit is never drawn');
    assert.equal(history.undoCount, 0, 'a refused edit records nothing');
  } finally {
    w.destroy();
  }
});

test('WGSL the material refuses is reported without swapping; wrong meshes and options throw with a fix', async () => {
  const w = await world();
  try {
    const material = new WgslMaterial({ wgsl: good, uniforms: { tint: [1, 1, 1] } }),
      mesh = createMesh(w.engine, triangle, material);
    const result = await recompileShader(mesh, 'fn other() {}', { device: w.device });
    assert.equal(result.ok, false);
    assert.equal(result.modules, 0);
    assert.match(result.diagnostics[0].message, /fn shade/);
    assert.equal(mesh.material, material);
    const same = await recompileShader(mesh, good, { device: w.device });
    assert.deepEqual(same, { ok: true, modules: 0, diagnostics: [] });
    const pbr = createMesh(w.engine, triangle, new PbrMaterial({}));
    await assert.rejects(recompileShader(pbr, good), /WgslMaterial; pass/);
    await assert.rejects(recompileShader(mesh, good, { timeoutMs: -1 }), /timeoutMs must be 0 to 60000/);
    // Without a device the edit is swapped in unchecked.
    const unchecked = await recompileShader(mesh, red);
    assert.deepEqual(unchecked, { ok: true, modules: 0, diagnostics: [] });
    assert.equal(mesh.material.wgsl, red);
  } finally {
    w.destroy();
  }
});

test('two edits on one device at once each see their own modules', async () => {
  const w = await world();
  try {
    const a = createMesh(w.engine, triangle, new WgslMaterial({ wgsl: good, uniforms: { tint: [1, 0, 0] } })),
      b = createMesh(w.engine, triangle, new WgslMaterial({ wgsl: good, uniforms: { tint: [0, 1, 0] } }));
    const own = w.device.createShaderModule;
    const [ra, rb] = await Promise.all([
      recompileShader(a, red, { device: w.device }),
      recompileShader(b, broken, { device: w.device }),
    ]);
    assert.equal(ra.ok, true);
    assert.equal(rb.ok, false);
    assert.equal(rb.diagnostics[0].line, 3);
    assert.equal(w.device.createShaderModule, own, 'the last watch restores the device');
  } finally {
    w.destroy();
  }
});

test('the panel lists WgslMaterial meshes, applies typed WGSL after a pause, lists errors and follows undo', async (t) => {
  const w = await world();
  const dom = new JSDOM('<body></body>');
  t.after(() => w.destroy());
  const material = new WgslMaterial({ wgsl: good, uniforms: { tint: [1, 1, 1] } }),
    mesh = createMesh(w.engine, triangle, material),
    pbr = createMesh(w.engine, triangle, new PbrMaterial({}));
  const editor = ShaderEditor.attach(w.engine, {
    meshes: [pbr, mesh],
    parent: dom.window.document.body,
    delayMs: 10,
  });
  const root = editor.element.shadowRoot,
    textarea = root.querySelector('textarea');
  assert.equal(editor.meshes.length, 1, 'only the WgslMaterial mesh is listed');
  assert.equal(textarea.value, good);
  textarea.value = red;
  textarea.dispatchEvent(new dom.window.Event('input'));
  await new Promise((resolve) => setTimeout(resolve, 30));
  const ok = await editor.apply(red);
  assert.equal(ok.ok, true);
  assert.equal(mesh.material.wgsl, red);
  textarea.value = broken;
  const failed = await editor.apply();
  assert.equal(failed.ok, false);
  assert.equal(root.querySelector('.status').dataset.state, 'error');
  assert.match(root.querySelector('ol li').textContent, /^3:12 error: unresolved value/);
  assert.equal(textarea.value, broken, 'the text being edited stays');
  assert.equal(mesh.material.wgsl, red);
  editor.history.undo();
  assert.equal(mesh.material, material);
  assert.equal(textarea.value, good, 'undo shows the WGSL the mesh draws');
  editor[Symbol.dispose]();
  assert.equal(editor.element.isConnected, false);
});
