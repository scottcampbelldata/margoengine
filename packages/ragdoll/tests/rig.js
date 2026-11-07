// A real rig for the ragdoll tests: a glTF file from the repository on a running Animator and a stepping solver world.
// Only the renderer is a stub; the skeleton, the skin data and the clips are the file's.
import { readFileSync } from 'node:fs';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { GLTFAsset, PBRModel } from '../../gltf-pro/dist/index.js';
import { Animation } from '../../animation/dist/index.js';
import { Animator } from '../../animator/dist/index.js';
import { Physics } from '@margoengine/physics';
import { GLB_BIN, GLB_JSON, glbChunks } from '../../shared/glb.js';

const warn = console.warn;
console.warn = () => {};
await Physics.load();
console.warn = warn;

/** The document and binary chunk of a GLB under examples/assets, without its images. */
export function glb(path) {
  const bytes = readFileSync(new URL(`../../../examples/assets/${path}`, import.meta.url)),
    chunks = glbChunks(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)),
    doc = JSON.parse(new TextDecoder().decode(chunks.find((chunk) => chunk.type === GLB_JSON).data)),
    bin = chunks.find((chunk) => chunk.type === GLB_BIN).data;
  delete doc.images;
  delete doc.textures;
  delete doc.samplers;
  delete doc.materials;
  for (const mesh of doc.meshes) for (const primitive of mesh.primitives) delete primitive.material;
  return { doc, bin };
}

/** The values of a float accessor of a GLB as one typed array, packed. */
export function accessor({ doc, bin }, index, Type = Float32Array) {
  const a = doc.accessors[index],
    view = doc.bufferViews[a.bufferView],
    size = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[a.type],
    bytes = Type.BYTES_PER_ELEMENT,
    stride = view.byteStride ?? size * bytes,
    start = bin.byteOffset + (view.byteOffset ?? 0) + (a.byteOffset ?? 0),
    out = new Type(a.count * size),
    data = new DataView(bin.buffer);
  const read = { 1: 'getUint8', 2: 'getUint16', 4: 'getFloat32' }[bytes];
  for (let i = 0; i < a.count; i++)
    for (let k = 0; k < size; k++) out[i * size + k] = data[read](start + i * stride + k * bytes, true);
  return out;
}

/**
 * An engine with Physics attached first, then the file's model, Animation and (with `states`) an Animator, the order a
 * game attaches them in. `floor` adds a fixed ground plane top at y = 0. `prepare` sees the Animation before the Animator.
 */
export async function realRig(path, { states, initial, gravity = [0, -9.81, 0], floor = true, edit, prepare } = {}) {
  const asset = glb(path);
  edit?.(asset);
  const store = await TransformStore.create(128),
    engine = new Engine({ width: 16, height: 16, clientWidth: 16, clientHeight: 16 }, store, {
      backend: 'webgl2',
      add() {},
      remove() {},
      render() {},
      dispose() {},
    }),
    physics = Physics.attach(engine, { gravity }),
    model = new PBRModel(engine, new GLTFAsset(asset.doc, [asset.bin])),
    animation = new Animation(model);
  engine.use({ name: animation.name, setup() {} });
  prepare?.(animation);
  const animator = states ? new Animator(animation, { initial: initial ?? Object.keys(states)[0], states }) : null;
  if (animator) engine.use(animator);
  if (floor)
    physics.addBody(null, {
      type: 'fixed',
      position: [0, -0.5, 0],
      colliders: { shape: 'box', halfExtents: [50, 0.5, 50] },
    });
  store.tick(false);
  const node = (name) => model.nodes.find((candidate) => candidate.name === name);
  return {
    asset,
    engine,
    physics,
    model,
    animation,
    animator,
    node,
    frames(count, delta = 1 / 60, each) {
      for (let i = 0; i < count; i++) {
        for (const plugin of engine.plugins.values()) plugin.onPreUpdate?.(delta);
        each?.(i);
      }
      store.tick(false);
    },
    dispose() {
      animator?.dispose();
      animation.dispose();
      model.dispose();
      physics.dispose();
      engine.dispose();
    },
  };
}
