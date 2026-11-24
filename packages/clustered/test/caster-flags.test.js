// Which caster shader LocalShadows composes for a primitive: its flags alone pick the shader edits, never the letters of
// a displacement's own key, and a hashed cut-out (materials alphaHash) casts by the same noise as its colour pass.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Clustered } from '../dist/index.js';
import { LocalShadows } from '../dist/shadows.js';
import { DirectionalLights } from '../dist/directional.js';
import { Camera } from '../../core/dist/index.js';
import { wgsl } from '../../core/src/shaders.ts';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
// The caster edit materials alphaHash() hands a shadow pass through its record's castHashed.
import { hashedDepth } from '../../shared/alpha-hash.js';

function harness() {
  const h = optionalGPU(),
    gpu = h.engine.gpu,
    modules = [];
  globalThis.GPUShaderStage = { VERTEX: 1, FRAGMENT: 2 };
  globalThis.GPUTextureUsage = { ...globalThis.GPUTextureUsage, COPY_DST: 2, TEXTURE_BINDING: 4, RENDER_ATTACHMENT: 16 };
  Object.assign(gpu.limits, { maxTextureDimension2D: 8192, maxTextureArrayLayers: 256 });
  gpu.createBindGroupLayout = (d) => ({ ...d });
  gpu.createPipelineLayout = (d) => ({ ...d });
  const create = gpu.createShaderModule.bind(gpu);
  gpu.createShaderModule = (d) => {
    modules.push(d.code);
    return create(d);
  };
  const begin = h.context.encoder.beginRenderPass;
  h.context.encoder.beginRenderPass = (d) => ({ ...begin(d), setViewport() {} });
  const camera = new Camera({ position: [0, 6, 6], target: [0, 0, 0], fov: 50, near: 0.1, far: 100 });
  camera.update(1, true);
  h.context.camera = h.engine.camera = camera;
  const frame = () => {
    h.context.shader = wgsl;
    h.context.bindings.length = 0;
    h.engine.frameGraph.execute(h.context);
  };
  return { ...h, modules, frame };
}
/** The caster shaders a directional light's map draws `primitive` with. */
function casterCode(primitive) {
  const h = harness(),
    lights = Clustered.attach(h.engine, { grid: [2, 2, 2] }),
    local = LocalShadows.attach(h.engine, { lights, resolution: 64 }),
    sun = DirectionalLights.attach(h.engine, { lights }),
    node = { id: 0, engine: h.engine, matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), check() {} };
  local.add({ shadowPrimitives: [{ node, vertex: {}, index: {}, count: 36, stride: 80, ...primitive }] });
  sun.setLights([{ direction: [0, -1, 0], castShadow: true, shadow: { bounds: { min: [-2, 0, -2], max: [2, 2, 2] } } }]);
  const before = h.modules.length;
  h.frame();
  const out = h.modules.slice(before).filter((code) => code.includes('@vertex fn vertex'));
  for (const plugin of [local, sun, lights]) plugin.dispose();
  return out;
}

test("a displacement key's letters turn on no caster flag (materials fur's 'fur:1:map' kept vertex alpha out)", () => {
  const fur = (key) => ({
    key,
    cuts: true,
    depth: (code) => code,
    entries: () => [],
    layout: () => ({ entries: [] }),
  });
  for (const key of ['fur:1', 'fur:1:map', 'alto']) {
    const [code] = casterCode({ displacement: fur(key) });
    assert.ok(code.includes('o.alpha=i.color.a'), `${key}: vertex alpha stays in the cut-out`);
    assert.ok(!code.includes('margoAnimatedUV') && !code.includes('margoOpacityAt'), `${key}: no UV animation or opacity map`);
    assert.ok(!code.includes('i.m0'), `${key}: not instanced`);
  }
});

test('a hashed cut-out casts against the alpha hash, an unhashed or uncut one against the cutoff', () => {
  const [hashed] = casterCode({ cutoff: 0.5, hashed: hashedDepth });
  assert.ok(hashed.includes('fn margoAlphaHash('), 'the hash is declared');
  assert.ok(hashed.includes('let margoCut=margoAlphaHash(i.margoObject);'), 'the threshold comes first, in uniform flow');
  assert.ok(hashed.includes('<margoCut){discard;}'), 'alpha is compared with the hash');
  assert.ok(hashed.includes('o.margoObject=i.position.xyz;'), 'the hash follows the object-space position');
  const [plain] = casterCode({ cutoff: 0.5 });
  assert.ok(!plain.includes('margoAlphaHash') && plain.includes('<f.alpha.y){discard;}'));
  const [uncut] = casterCode({ cutoff: 0, hashed: hashedDepth });
  assert.ok(!uncut.includes('margoAlphaHash'), 'nothing to hash without a cut-out');
});
