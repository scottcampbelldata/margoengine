import { Engine, TransformStore } from '../../core/dist/extension.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { GLTFAsset, PBRModel } from '../../gltf-pro/dist/index.js';
import { skinnedStrip } from '../test/fixture.js';
import { animatedTriangle } from '../../../tests/support/gltf-pro-fixture.js';

export async function fixtures(load = (entry) => import(entry)) {
  const { Animation, AnimationGroup, Skin, Skeleton } = await load('../dist/index.js');
  const { AnimationLOD } = await load('../dist/lod.js');
  const { MorphWeightPlayer } = await load('../dist/morph-gpu.js');
  const { GLTFInteractivity } = await load('../dist/interactivity.js');
  const { VATCrowd, bakeVAT } = await load('../dist/vat.js');
  const { SkinnedCrowd, bakeBones } = await load('../dist/instanced-skin.js');
  const { GeometryCachePlayer, encodeGeometryCache } = await load('../dist/geometry-cache.js');
  const model = (engine, data = skinnedStrip()) => new PBRModel(engine, new GLTFAsset(data.doc, data.buffers));
  const morphData = () => {
    const data = animatedTriangle(), { doc, buffers } = data, values = new Float32Array([0, 1]);
    const buffer = buffers.push(values) - 1;
    doc.buffers.push({ byteLength: values.byteLength });
    const bufferView = doc.bufferViews.push({ buffer, byteLength: values.byteLength }) - 1;
    const output = doc.accessors.push({ bufferView, componentType: 5126, count: 2, type: 'SCALAR' }) - 1;
    doc.animations[0].samplers.push({ input: doc.animations[0].samplers[0].input, output });
    doc.animations[0].channels.push({ sampler: 1, target: { node: 0, path: 'weights' } });
    return data;
  };
  const entries = [];
  for (const factory of [false, true]) {
    const suffix = factory ? '.attach' : '';
    entries.push({ name: 'Animation' + suffix, create({ engine }) {
      const mesh = model(engine), plugin = factory ? Animation.attach(mesh) : new Animation(mesh);
      return { plugin, dispose: () => plugin.dispose(), cleanup: () => mesh.dispose() };
    } });
    for (const [name, Plugin] of Object.entries({ AnimationGroup, AnimationLOD })) entries.push({ name: name + suffix,
      create({ engine }) {
        const mesh = model(engine), member = new Animation(mesh);
        const plugin = factory
          ? (name === 'AnimationGroup' ? Plugin.attach(engine, 'bend') : Plugin.attach(engine))
          : (name === 'AnimationGroup' ? new Plugin('bend') : new Plugin());
        plugin.add(member);
        return { plugin, dispose: () => plugin.dispose(), cleanup() { member.dispose(); mesh.dispose(); } };
      } });
    entries.push({ name: 'GLTFInteractivity' + suffix, create({ engine }) {
      const mesh = model(engine), plugin = factory ? GLTFInteractivity.attach(mesh) : new GLTFInteractivity(mesh);
      return { plugin, dispose: () => plugin.dispose(), cleanup: () => mesh.dispose() };
    } });
    entries.push({ name: 'MorphWeightPlayer' + suffix, create({ engine, scene, dependency }) {
      const mesh = model(engine, morphData()), animation = new Animation(mesh);
      dependency(() => scene.use(animation));
      const plugin = factory ? MorphWeightPlayer.attach(engine) : new MorphWeightPlayer();
      plugin.add(animation);
      return { plugin, dependencies: [animation], dispose: () => plugin.dispose(),
        cleanup() { animation.dispose(); mesh.dispose(); } };
    } });
    for (const kind of ['VATCrowd', 'SkinnedCrowd']) entries.push({ name: kind + suffix, create({ engine }) {
      const mesh = model(engine), animation = new Animation(mesh);
      const data = kind === 'VATCrowd' ? bakeVAT(animation, { fps: 2 }) : bakeBones(animation, { fps: 2 });
      const Plugin = kind === 'VATCrowd' ? VATCrowd : SkinnedCrowd;
      const plugin = factory ? Plugin.attach(engine, data) : new Plugin(data);
      plugin.add();
      return { plugin, dispose: () => plugin.dispose(), cleanup() { animation.dispose(); mesh.dispose(); } };
    } });
  }
  entries.push({ name: 'Skin.attach', create({ engine }) {
    const mesh = model(engine, animatedTriangle()), skeleton = new Skeleton([{ name: 'root', parent: -1 }]);
    const count = mesh.primitives[0].vertices.length / 20, joints = new Uint32Array(count * 4);
    const weights = Float32Array.from(joints, (_, i) => +(i % 4 === 0));
    const plugin = Skin.attach(mesh, skeleton, joints, weights);
    return { plugin, dispose: () => plugin.dispose(), cleanup: () => mesh.dispose() };
  } });
  entries.push({ name: 'GeometryCachePlayer.attach', async create({ engine }) {
    const bytes = encodeGeometryCache(2, [{ frameCount: 2,
      positions: new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0, -1, -1, 1, 1, -1, 1, 0, 1, 1]),
      indices: new Uint32Array([0, 1, 2]) }]);
    const controller = new AbortController();
    const plugin = await GeometryCachePlayer.attach(engine, bytes, { signal: controller.signal });
    await plugin.done;
    return { plugin, dispose: () => plugin.dispose() };
  } });
  return entries;
}

// Package-local real scene routing with the existing fake GPU, independent of the audit harness.
export async function ownerEngine(t) {
  const gpu = optionalGPU();
  const engine = new Engine(
    { width: 8, height: 8, clientWidth: 8, clientHeight: 8 },
    await TransformStore.create(64),
    { backend: 'webgpu', gpu: gpu.engine.gpu, add() {}, remove() {}, render() {}, dispose() {} },
    undefined, null,
  );
  t.after(() => { engine.dispose(); gpu.cleanup(); });
  return engine;
}
