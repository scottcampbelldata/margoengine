// A small glTF character for animator tests, in plain data: a named joint tree and clips written as functions of time,
// sampled into glTF channels. `animatorRig` runs it on a stub engine with no GPU. Stand-in data: real files are loaded
// with `animatorGLB`.
import { readFileSync } from 'node:fs';
import { Engine, TransformStore } from '../../packages/core/dist/extension.js';
import { GLTFAsset, PBRModel } from '../../packages/gltf-pro/dist/index.js';
import { Animation } from '../../packages/animation/dist/index.js';
import { Animator } from '../../packages/animator/dist/index.js';

/** Fox.glb, a real file with real Walk, Run and Survey clips. */
export const FOX = new URL('../../examples/assets/khronos/Fox/Fox.glb', import.meta.url);

/** A biped: names to [parent, x, y, z] in metres, facing +Z, its left side at +X, 1 m hips. */
export const BIPED = {
  Root: [null, 0, 0, 0],
  Hips: ['Root', 0, 1, 0],
  Spine: ['Hips', 0, 0.2, 0],
  Chest: ['Spine', 0, 0.25, 0],
  Neck: ['Chest', 0, 0.2, 0],
  Head: ['Neck', 0, 0.12, 0],
  LeftArm: ['Chest', 0.2, 0.15, 0],
  LeftForeArm: ['LeftArm', 0.28, 0, 0],
  LeftHand: ['LeftForeArm', 0.26, 0, 0],
  RightArm: ['Chest', -0.2, 0.15, 0],
  RightForeArm: ['RightArm', -0.28, 0, 0],
  RightHand: ['RightForeArm', -0.26, 0, 0],
  LeftUpLeg: ['Hips', 0.1, -0.05, 0],
  LeftLeg: ['LeftUpLeg', 0, -0.45, 0.02],
  LeftFoot: ['LeftLeg', 0, -0.44, -0.02],
  RightUpLeg: ['Hips', -0.1, -0.05, 0],
  RightLeg: ['RightUpLeg', 0, -0.45, 0.02],
  RightFoot: ['RightLeg', 0, -0.44, -0.02],
};

/**
 * Builds a glTF document. `joints` is a table like {@link BIPED}; `clips` maps a clip name to
 * `{duration, fps?, tracks: {'Joint.rotation': (t) => [x, y, z, w], 'Joint.translation': (t) => [x, y, z]}}`.
 * A node's name is its joint's. Every joint table needs one root.
 */
export function animatorDocument(joints, clips) {
  const names = Object.keys(joints),
    index = new Map(names.map((name, i) => [name, i])),
    buffers = [],
    bufferViews = [],
    accessors = [];
  const add = (values, type, min, max) => {
    const data = new Float32Array(values);
    buffers.push(data);
    bufferViews.push({ buffer: buffers.length - 1, byteLength: data.byteLength });
    accessors.push({
      bufferView: bufferViews.length - 1,
      componentType: 5126,
      count: data.length / { SCALAR: 1, VEC3: 3, VEC4: 4 }[type],
      type,
      ...(min ? { min, max } : {}),
    });
    return accessors.length - 1;
  };
  const position = add([-0.1, 0, 0, 0.1, 0, 0, 0, 0.1, 0], 'VEC3', [-0.1, 0, 0], [0.1, 0.1, 0]);
  const nodes = names.map((name) => {
    const [, x, y, z] = joints[name],
      children = names.filter((other) => joints[other][0] === name).map((other) => index.get(other));
    return { name, translation: [x, y, z], ...(children.length ? { children } : {}) };
  });
  // A mesh on the root keeps the model valid; the tests read joints, not triangles.
  nodes[0].mesh = 0;
  const animations = Object.entries(clips).map(([name, clip]) => {
    const fps = clip.fps ?? 60,
      count = Math.max(2, Math.round(clip.duration * fps) + 1),
      stamps = Array.from({ length: count }, (_, i) => (i / (count - 1)) * clip.duration),
      times = add(stamps, 'SCALAR', [0], [clip.duration]),
      samplers = [],
      channels = [];
    for (const [key, curve] of Object.entries(clip.tracks)) {
      const [joint, path] = key.split('.'),
        output = add(stamps.flatMap(curve), path === 'rotation' ? 'VEC4' : 'VEC3');
      if (!index.has(joint)) throw new Error(`No joint ${joint}`);
      channels.push({ sampler: samplers.length, target: { node: index.get(joint), path } });
      samplers.push({ input: times, output });
    }
    return { name, channels, samplers };
  });
  return {
    doc: {
      asset: { version: '2.0' },
      buffers: buffers.map((data) => ({ byteLength: data.byteLength })),
      bufferViews,
      accessors,
      meshes: [{ primitives: [{ attributes: { POSITION: position } }] }],
      nodes,
      scenes: [{ nodes: [0] }],
      scene: 0,
      animations,
    },
    buffers,
    index,
  };
}

/** A GLB file as `{doc, buffers}`, the shape {@link animatorRun} takes. */
export function animatorGLB(path) {
  const file = readFileSync(path),
    length = file.readUInt32LE(12),
    doc = JSON.parse(file.toString('utf8', 20, 20 + length)),
    binary = file.subarray(20 + length + 8);
  return {
    doc,
    buffers: [binary],
    index: new Map((doc.nodes ?? []).map((node, i) => [node.name, i])),
  };
}

/** Runs a document on a stub engine with no GPU; `options` go to the Animator. */
export async function animatorRun({ doc, buffers, index }, options) {
  const store = await TransformStore.create(Math.max(64, doc.nodes.length * 2)),
    engine = new Engine({ width: 16, height: 16, clientWidth: 16, clientHeight: 16 }, store, {
      backend: 'webgl2',
      add() {},
      remove() {},
      render() {},
      dispose() {},
    }),
    model = new PBRModel(engine, new GLTFAsset(doc, buffers)),
    animation = new Animation(model),
    animator = new Animator(animation, options);
  engine.use({ name: animation.name, setup() {} });
  engine.use(animator);
  const t = store.transforms,
    node = (name) => model.nodes[typeof name === 'number' ? name : index.get(name)];
  return {
    store,
    engine,
    model,
    animation,
    animator,
    index,
    node,
    /** Local rotation, x y z w, as stored now. */
    rotation: (name) => {
      const id = node(name).id;
      return [t.qx[id], t.qy[id], t.qz[id], t.qw[id]];
    },
    /** Local translation as stored now. */
    translation: (name) => {
      const id = node(name).id;
      return [t.x[id], t.y[id], t.z[id]];
    },
    /** World position after the store's transforms are current. */
    world: (name) => {
      store.tick(false);
      const m = node(name).matrix;
      return [m[12], m[13], m[14]];
    },
    step(delta = 1 / 60, count = 1) {
      for (let i = 0; i < count; i++) animator.onPreUpdate(delta);
    },
    release() {
      animator.dispose();
      animation.dispose();
      model.dispose();
      engine.dispose();
    },
  };
}

/** The unit quaternion of `angle` radians about a unit `axis`. */
export const axisAngle = (axis, angle) => {
  const s = Math.sin(angle / 2);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)];
};
/** Largest distance between two same-length lists of vectors. */
export const largestGap = (a, b) => {
  let gap = 0;
  for (let i = 0; i < a.length; i++) gap = Math.max(gap, Math.hypot(...a[i].map((v, c) => v - b[i][c])));
  return gap;
};
export { Animator };
