// Optional material features (`Material.features`) on a mock device: the shader text a feature adds, that a material
// without one keeps its text, and the list's own rules. features-browser.mjs checks the rendered values on a real adapter.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mockGPU, context } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { wgsl } from '../../core/dist/shaders.js';
import { LambertMaterial, Material, PbrMaterial, Texture, createInstancedMesh, createMesh } from '../dist/index.js';
import { alphaHash } from '../dist/alpha-hash.js';
import { objectNormal } from '../dist/object-normal.js';

async function scene() {
  const gpu = mockGPU(),
    store = await TransformStore.create(64),
    renderer = { backend: 'webgpu', gpu: gpu.device, add() {}, remove() {}, render() {}, dispose() {} };
  const engine = new Engine(
    { width: 128, height: 96, clientWidth: 128, clientHeight: 96 },
    store,
    renderer,
    { position: [0, 0, 6], target: [0, 0, 0] },
    null,
  );
  engine.camera.update(4 / 3, true);
  const view = context(gpu, { samples: 1, format: 'bgra8unorm', depthFormat: 'depth32float', shader: wgsl });
  let n = 0;
  const frame = () =>
    gpu.record(() => {
      store.tick(false);
      view.begin(n++);
      engine.frameGraph.execute(view.c);
    });
  return { gpu, engine, frame };
}
const quad = {
  positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
  normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
  uvs: [0, 0, 1, 0, 1, 1, 0, 1],
  indices: [0, 1, 2, 0, 2, 3],
};
/** The WGSL modules compiled in frame log `log`. */
const modules = (log) => log.filter((e) => e[0] === 'module').map((e) => e[2].code);

test('alphaHash compiles into a material only while it is listed', async () => {
  const { engine, frame } = await scene(),
    material = new PbrMaterial();
  createMesh(engine, quad, material);
  const plain = modules(frame()).filter((c) => c.includes('fn surface('));
  assert.ok(plain.length);
  assert.ok(plain.every((c) => !c.includes('margoAlphaHash')));
  assert.equal(material.alphaTest, 0);
  material.features = [alphaHash()];
  assert.equal(material.alphaTest, 0.5, 'the passes without the colour shader cut at the default');
  const code = modules(frame()).find((c) => c.includes('fn surface('));
  assert.match(code, /let margoCut=margoAlphaHash\(i\.margoObject\);/);
  assert.match(code, /s\.base\.a<margoCut\)\{discard;\}/);
  assert.doesNotMatch(code, /s\.base\.a<f\.settings\.y/);
  assert.match(code, /o\.margoObject=i\.position\.xyz;/);
  material.features = [];
  assert.equal(material.alphaTest, 0);
  assert.ok(modules(frame()).every((c) => !c.includes('margoAlphaHash')));
});

test('alphaHash follows the instanced vertex stage and every lit shading', async () => {
  const { engine, frame } = await scene();
  createInstancedMesh(engine, quad, new LambertMaterial({ features: [alphaHash({ scale: 2 })] }), 4);
  const code = modules(frame()).find((c) => c.includes('margoAlphaHash'));
  assert.match(code, /let p=margoI\*vec4f\(i\.position\.xyz,1\);o\.margoObject=i\.position\.xyz;/);
  assert.match(code, /log2\(2e\+0\//);
});

test('a material keeps an alphaTest of its own, and clone and copy carry the list', () => {
  const hash = alphaHash({ cutoff: 0.3 }),
    set = new PbrMaterial({ alphaTest: 0.7, features: [hash] }),
    raised = new PbrMaterial({ features: [hash] });
  assert.equal(set.alphaTest, 0.7);
  assert.equal(raised.alphaTest, 0.3);
  assert.deepEqual(raised.clone().features, [hash]);
  assert.deepEqual(new PbrMaterial().copy(raised).features, [hash]);
  set.features = [];
  assert.equal(set.alphaTest, 0.7);
});

test('the feature list is checked', () => {
  const material = new Material();
  assert.throws(() => (material.features = 'alphaHash'), TypeError);
  assert.throws(() => (material.features = [{}]), TypeError);
  assert.throws(() => (material.features = [alphaHash(), alphaHash()]), /different names/);
  assert.throws(() => alphaHash({ scale: 0 }), RangeError);
  assert.throws(() => alphaHash({ cutoff: 0 }), RangeError);
  assert.throws(() => alphaHash({ cutoff: 1.5 }), RangeError);
  assert.ok(Object.isFrozen(new Material({ features: [alphaHash()] }).features));
});

const flat = () =>
  new Texture({ data: new Uint8Array(16).fill(128), width: 2, height: 2 }, { colorSpace: 'linear', mipmaps: false });

test('objectNormal replaces the tangent frame only while a normalMap is set, and follows instances', async () => {
  const { engine, frame } = await scene(),
    material = new PbrMaterial({ features: [objectNormal()] });
  createMesh(engine, quad, material);
  assert.ok(modules(frame()).every((c) => !c.includes('margoObjectX')));
  material.normalMap = flat();
  const code = modules(frame()).find((c) => c.includes('fn surface('));
  assert.match(code, /mat3x3f\(i\.margoObjectX,i\.margoObjectY,i\.margoObjectZ\)\*\(sampledNormal\)/);
  assert.doesNotMatch(code, /s\.n=normalize\(t\*sampledNormal/);
  const other = await scene();
  createInstancedMesh(other.engine, quad, new PbrMaterial({ normalMap: flat(), features: [objectNormal({ up: 'z' })] }), 2);
  const instanced = modules(other.frame()).find((c) => c.includes('margoObjectX'));
  assert.match(instanced, /let margoObjectModel=margoI;/);
  assert.match(instanced, /sampledNormal\.xzy\*vec3f\(1,1,-1\)/);
  assert.throws(() => objectNormal({ up: 'x' }), TypeError);
});
