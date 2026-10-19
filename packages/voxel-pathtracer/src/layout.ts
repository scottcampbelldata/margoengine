// GPU layout of a SceneSnapshot: the word arrays the WGSL in shaders.ts reads (scene, lights, voxels) and the frame
// uniform. Offsets here and in the shader's constants must agree; tests/layout.test.js checks them from the outside.
import { BRICK_WORDS, type PackedModel, type SceneSnapshot, UNIFORM } from './scene.js';

/** Words per model record: size xyz, grid offset, bricks xyz, 0, first emitter word, emitters, emitter total, 0. */
export const MODEL_WORDS = 12;
/** Words per instance record: to-local rows, to-world rows, previous to-world rows, model, flags, light pick, 0. */
export const INSTANCE_WORDS = 40;
/** Words per hierarchy node. */
const NODE_WORDS = 8;
/** Bytes of the frame uniform. */
export const FRAME_BYTES = 368;
/** Frame uniform flag bits (config.z). */
export const FLAG_SUN = 1,
  FLAG_GROUND = 2,
  FLAG_ENV = 4,
  FLAG_MOTION = 8,
  FLAG_JITTER = 16,
  FLAG_CLAMP = 32,
  FLAG_SPLIT = 64,
  FLAG_AREA = 128;

const f32 = new Float32Array(1),
  u32 = new Uint32Array(f32.buffer);
const bits = (v: number) => {
  f32[0] = v;
  return u32[0];
};

/** Words of a model's region in the voxel buffer: its grid (payload entries made absolute), then its payload. */
export function modelWords(m: PackedModel, offset: number): Uint32Array {
  const out = new Uint32Array(m.grid.length + m.payload.length),
    payload = offset + m.grid.length;
  for (let i = 0; i < m.grid.length; i++) {
    const e = m.grid[i];
    out[i] = e === 0 || e >= UNIFORM ? e : payload + (e - 1) * BRICK_WORDS;
  }
  out.set(m.payload, m.grid.length);
  return out;
}

/** The lights buffer: emissive instance table, emissive faces per model, area lights, environment tables. */
export interface LightLayout {
  words: Uint32Array;
  emissiveBase: number;
  areaBase: number;
  marginalBase: number;
  conditionalBase: number;
  /** Per model: first face word, face count, emitted total. */
  emitters: { first: number; count: number; total: number }[];
}

export function lightLayout(s: SceneSnapshot): LightLayout {
  const env = s.environment.map;
  let size = 4;
  const deflectorBase = size;
  size += s.deflectors.length;
  const emissiveBase = size;
  size += s.emissiveInstances.length * 2;
  const emitters = s.emitters.map((e) => {
    const first = size;
    size += e.faces.length * 2;
    return { first, count: e.faces.length, total: e.total };
  });
  const areaBase = size;
  size += s.lightCount * 16;
  const marginalBase = size;
  size += env ? env.height : 0;
  const conditionalBase = size;
  size += env ? env.width * env.height : 0;
  const words = new Uint32Array(size),
    floats = new Float32Array(words.buffer);
  // Header: where the light-sampled glass and mirror instances are and how many (pairs of GPU index and IOR, 0 for a
  // mirror).
  words[0] = deflectorBase;
  words[1] = s.deflectors.length / 2;
  for (let k = 0; k < s.deflectors.length; k += 2) {
    words[deflectorBase + k] = s.deflectors[k];
    floats[deflectorBase + k + 1] = s.deflectors[k + 1];
  }
  for (let k = 0; k < s.emissiveInstances.length; k++) {
    words[emissiveBase + k * 2] = s.emissiveInstances[k];
    floats[emissiveBase + k * 2 + 1] = s.emissiveCdf[k];
  }
  for (const [m, e] of s.emitters.entries())
    for (let k = 0; k < e.faces.length; k++) {
      words[emitters[m].first + k * 2] = e.faces[k];
      floats[emitters[m].first + k * 2 + 1] = e.cdf[k];
    }
  floats.set(s.lights, areaBase);
  if (env) {
    floats.set(env.marginal, marginalBase);
    floats.set(env.conditional, conditionalBase);
  }
  return { words, emissiveBase, areaBase, marginalBase, conditionalBase, emitters };
}

/** The scene buffer: models, instances, hierarchy nodes. */
export interface SceneLayout {
  words: Uint32Array;
  modelBase: number;
  instanceBase: number;
  nodeBase: number;
  nodeCount: number;
}

export function sceneLayout(s: SceneSnapshot, gridOffsets: ArrayLike<number>, lights: LightLayout): SceneLayout {
  const modelBase = 4,
    instanceBase = modelBase + s.models.length * MODEL_WORDS,
    nodeBase = instanceBase + s.instances.length * INSTANCE_WORDS,
    nodeCount = s.nodes.length / NODE_WORDS,
    words = new Uint32Array(nodeBase + s.nodes.length),
    floats = new Float32Array(words.buffer);
  for (const [i, m] of s.models.entries()) {
    const b = modelBase + i * MODEL_WORDS,
      e = lights.emitters[i];
    words.set([m.size[0], m.size[1], m.size[2], gridOffsets[i], m.bricks[0], m.bricks[1], m.bricks[2], 0], b);
    words[b + 8] = e.first;
    words[b + 9] = e.count;
    words[b + 10] = bits(e.total);
  }
  for (const [i, v] of s.instances.entries()) {
    const b = instanceBase + i * INSTANCE_WORDS;
    floats.set(v.toLocal, b);
    floats.set(v.toWorld, b + 12);
    floats.set(v.previous ?? v.toWorld, b + 24);
    words[b + 36] = v.model;
    words[b + 37] = (v.previous ? 1 : 0) | (v.prism ? 2 : 0) | (v.mirror ? 4 : 0);
    floats[b + 38] = v.lightPick;
  }
  words.set(s.nodes, nodeBase);
  return { words, modelBase, instanceBase, nodeBase, nodeCount };
}
