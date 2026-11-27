import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { Material, createMesh } from '../dist/index.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

test('Material raster controls default to the original pipeline and validate inactive options', () => {
  const m = new Material();
  assert.equal(m.customState, false);
  assert.equal(m.colorWrite, true);
  assert.equal(m.polygonOffset, false);
  assert.equal(m.stencilWrite, false);
  assert.equal(m.stencilRef, 0);
  assert.equal(m.stencilReadMask, 255);
  assert.equal(m.stencilWriteMask, 255);
  for (const options of [
    { colorWrite: 1 },
    { polygonOffset: 1 },
    { stencilWrite: 1 },
    { polygonOffsetFactor: Infinity },
    { polygonOffsetFactor: null },
    { polygonOffsetClamp: 1e50 },
    { polygonOffsetUnits: 0.25 },
    { polygonOffsetUnits: -2147483648 },
    { stencilRef: -1 },
    { stencilRef: null },
    { stencilReadMask: 1.5 },
    { stencilWriteMask: 0x100000000 },
    { stencilFunc: 'lesser' },
    { stencilFail: 'increment' },
    { stencilZFail: null },
    { stencilZPass: 'replace-with-reference' },
  ])
    assert.throws(() => new Material(options), /material/i);
  const inactive = new Material({ polygonOffsetFactor: 2, stencilFunc: 'equal', stencilRef: 3 });
  assert.equal(inactive.customState, false);
});

test('raster argument errors distinguish types from numeric ranges and name the fix', () => {
  for (const key of [
    'polygonOffsetFactor',
    'polygonOffsetClamp',
    'polygonOffsetUnits',
    'stencilRef',
    'stencilReadMask',
    'stencilWriteMask',
  ]) {
    for (const value of [null, '1', true])
      assert.throws(() => new Material({ [key]: value }), { name: 'TypeError', message: new RegExp(key + '.*; set') });
    assert.throws(() => new Material({ [key]: Infinity }), {
      name: 'RangeError',
      message: new RegExp(key + '.*; set'),
    });
  }
  for (const key of ['colorWrite', 'polygonOffset', 'stencilWrite'])
    assert.throws(() => new Material({ [key]: 1 }), { name: 'TypeError', message: new RegExp(key + '.*; set') });
});

test('constructed meshes map forward-Z polygon offset values to reverse-Z and preserve stencil semantics', async () => {
  const h = optionalGPU(),
    engine = new Engine(
      { width: 64, height: 64 },
      await TransformStore.create(32),
      { backend: 'webgpu', gpu: h.engine.gpu, add() {}, remove() {}, render() {}, dispose() {} },
      { position: [0, 0, 4], target: [0, 0, 0] },
      null,
    );
  try {
    const material = new Material({
      colorWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: 2,
      polygonOffsetUnits: -3,
      polygonOffsetClamp: 0.1,
      stencilWrite: true,
      stencilFunc: 'equal',
      stencilRef: 7,
      stencilReadMask: 15,
      stencilWriteMask: 3,
      stencilFail: 'invert',
      stencilZFail: 'increment-wrap',
      stencilZPass: 'replace',
    });
    const model = createMesh(
      engine,
      { positions: [-1, -1, 0, 1, -1, 0, 0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1] },
      material,
    );
    assert.equal(material.customState, true);
    // A native state on the primitive wins and undefined gives the material's back. This threw once the record went live.
    const own = { depthBias: 9 };
    model.primitives[0].material.renderState = own;
    assert.equal(model.primitives[0].material.renderState, own);
    model.primitives[0].material.renderState = undefined;
    const state = model.primitives[0].material.renderState;
    assert.equal(state.colorWrite, false);
    assert.equal(state.depthBiasMode, 'away');
    assert.equal(state.depthBias, -3);
    assert.equal(state.depthBiasSlopeScale, 2);
    assert.equal(state.depthBiasClamp, 0.1);
    assert.equal(state.stencilReference, 7);
    assert.equal(state.stencilReadMask, 15);
    assert.equal(state.stencilWriteMask, 3);
    assert.deepEqual(state.stencilFront, {
      compare: 'equal',
      failOp: 'invert',
      depthFailOp: 'increment-wrap',
      passOp: 'replace',
    });
    assert.deepEqual(state.stencilBack, state.stencilFront);
    model.dispose();
  } finally {
    engine.dispose();
    h.cleanup();
  }
});

// KB3148b: blendSpace is opt-in render state; the gltf/pbr record carries it only when linear.
test('Material blendSpace defaults to display, validates, and reaches the PBR render state when linear', async () => {
  const { linearBlendShader } = await import('../src/native-glass.js');
  const m = new Material({ transparent: true });
  assert.equal(m.blendSpace, 'display');
  assert.equal(m.customState, false);
  assert.throws(() => new Material({ blendSpace: 'srgb' }), /blendSpace is invalid; set 'display' or 'linear'/);
  assert.throws(() => (m.blendSpace = 'Linear'), /blendSpace is invalid/);
  m.blendSpace = 'linear';
  assert.equal(m.customState, true);
  assert.equal(new Material({ blendSpace: 'linear' }).blendSpace, 'linear');
  assert.equal(m.clone().blendSpace, 'linear');
  m.blendSpace = 'display';
  assert.equal(m.customState, false);
  // The main fragment entry becomes a plain function wrapped by a new entry, so every return is mixed in linear light,
  // an unlit material's early return included (the GPU run drew it unblended at 188 of 255 before); other entries keep
  // theirs, and a shader without the entry is refused, not drawn wrong.
  const code =
    '@fragment fn gbuffer(i:Out)->@location(0) vec4f {return vec4f(color,1.0);}\n' +
    '@fragment fn fragment(i:Out,@builtin(front_facing) front:bool)->@location(0) vec4f {\n' +
    '  let alpha=0.5;\n  if(f.coordsB.w<0.5){return vec4f(vec3f(0.5),alpha);}\n' +
    '  var color=vec3f(1);\n  return vec4f(color,select(1.0,s.base.a,f.settings.x>1.5));\n}';
  const out = linearBlendShader(code);
  assert.ok(out.startsWith('@fragment fn gbuffer(i:Out)->@location(0) vec4f {return vec4f(color,1.0);}'));
  assert.ok(
    out.includes(
      'fn margoBlendSurface(i:Out,front:bool)->vec4f {\n  let alpha=0.5;\n  if(f.coordsB.w<0.5){return vec4f(vec3f(0.5),alpha);}',
    ),
  );
  assert.equal(out.match(/@fragment fn fragment\(/g).length, 1);
  assert.ok(
    out.includes(
      '@fragment fn fragment(i:Out,@builtin(front_facing) front:bool)->@location(0) vec4f {\n' +
        '  let margoBlendSrc=margoBlendSurface(i,front);let margoBlendA=clamp(margoBlendSrc.a,0.0,1.0);',
    ),
  );
  assert.match(out, /margoGlassLinear\(margoBlendDst\.rgb\)\*\(1\.0-margoBlendA\)/);
  assert.ok(out.includes('textureLoad(margoGlassScene,vec2i(i.clip.xy),0)'));
  assert.match(out, /var margoGlassScene:texture_2d<f32>;/);
  assert.throws(() => linearBlendShader(code + '\n' + code), /exactly one/);
  assert.throws(
    () => linearBlendShader('@fragment fn other()->@location(0) vec4f {return vec4f(1);}'),
    /blendSpace 'linear'/,
  );
});

test('a linear blendSpace material gives the PBR record blendSpace linear and nothing else changes', async () => {
  const h = optionalGPU(),
    engine = new Engine(
      { width: 64, height: 64 },
      await TransformStore.create(32),
      { backend: 'webgpu', gpu: h.engine.gpu, add() {}, remove() {}, render() {}, dispose() {} },
      { position: [0, 0, 4], target: [0, 0, 0] },
      null,
    );
  try {
    const material = new Material({ transparent: true, opacity: 0.5 });
    const model = createMesh(
      engine,
      { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1] },
      material,
    );
    assert.equal(model.primitives[0].material.renderState, undefined);
    material.blendSpace = 'linear';
    const state = model.primitives[0].material.renderState;
    assert.equal(state.blendSpace, 'linear');
    assert.equal(state.blend, undefined);
    material.blendSpace = 'display';
    assert.equal(model.primitives[0].material.renderState, undefined);
    model.dispose();
  } finally {
    engine.dispose();
    h.cleanup();
  }
});

test('Material transmissionBlend defaults to auto, validates, and reaches the PBR render state only when set', async () => {
  const m = new Material({ transmission: 0.8 });
  assert.equal(m.transmissionBlend, 'auto');
  assert.equal(m.customState, false);
  assert.throws(
    () => new Material({ transmissionBlend: 'dual' }),
    /transmissionBlend is invalid; set 'auto', 'two-draw' or 'dual-source'/,
  );
  assert.equal(new Material({ transmissionBlend: 'dual-source' }).transmissionBlend, 'dual-source');
  const h = optionalGPU(),
    engine = new Engine(
      { width: 64, height: 64 },
      await TransformStore.create(32),
      { backend: 'webgpu', gpu: h.engine.gpu, add() {}, remove() {}, render() {}, dispose() {} },
      { position: [0, 0, 4], target: [0, 0, 0] },
      null,
    );
  try {
    const model = createMesh(
      engine,
      { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1] },
      m,
    );
    assert.equal(model.primitives[0].material.renderState, undefined);
    for (const value of ['two-draw', 'dual-source']) {
      m.transmissionBlend = value;
      assert.equal(m.customState, true);
      assert.equal(model.primitives[0].material.renderState.transmissionBlend, value);
      assert.equal(m.clone().transmissionBlend, value);
    }
    m.transmissionBlend = 'auto';
    assert.equal(model.primitives[0].material.renderState, undefined);
    model.dispose();
  } finally {
    engine.dispose();
    h.cleanup();
  }
});
