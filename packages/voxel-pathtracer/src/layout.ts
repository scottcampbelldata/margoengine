// GPU layout of a SceneSnapshot: the word arrays the WGSL in shaders.ts reads (the scene buffer: scene records, then the
// lights; voxels) and the frame uniform. Offsets here and in the shader's constants must agree.
import {
  BRICK_WORDS,
  INSTANCE_WORDS,
  MODEL_WORDS,
  MOTION_WORDS,
  NODE_WORDS,
  type PackedModel,
  type SceneSnapshot,
  sceneRecordWords,
  UNIFORM,
} from './scene.js';

export { INSTANCE_WORDS, MODEL_WORDS };
/** Bytes of the frame uniform. */
export const FRAME_BYTES = 800;
/** Frame uniform flag bits (config.z). */
export const FLAG_SUN = 1,
  FLAG_GROUND = 2,
  FLAG_ENV = 4,
  FLAG_MOTION = 8,
  FLAG_JITTER = 16,
  FLAG_CLAMP = 32,
  FLAG_SPLIT = 64,
  FLAG_AREA = 128,
  FLAG_CAMERA_MOTION = 256,
  FLAG_CLEAR_GLASS = 512,
  FLAG_OPAQUE_SHADOWS = 1024,
  FLAG_SUN_DIFFUSE = 2048,
  FLAG_NO_SUN_MEDIA = 4096,
  FLAG_HIDE_SUN = 8192,
  FLAG_NO_COMPENSATION = 16384;

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

/**
 * The lights, after the scene records in the scene buffer (every offset absolute in it): emissive instance table,
 * emissive faces per model, area lights, environment tables.
 */
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
  const env = s.environment.map,
    start = sceneRecordWords(s);
  let size = start + 4;
  const deflectorBase = size;
  size += s.deflectors.length;
  const emissiveBase = size;
  size += s.emissiveInstances.length * 2;
  // Emissive faces, three words each: x | y << 16, z | face << 16, cumulative pick probability.
  const emitters = s.emitters.map((e) => {
    const first = size;
    size += e.cdf.length * 3;
    return { first, count: e.cdf.length, total: e.total };
  });
  const areaBase = size;
  size += s.lightCount * 16;
  const marginalBase = size;
  size += env ? env.height : 0;
  const conditionalBase = size;
  size += env ? env.width * env.height : 0;
  // The scene buffer's words: the records (sceneLayout fills them in), then these.
  const words = new Uint32Array(size),
    floats = new Float32Array(words.buffer);
  // Header (scene word 1 points at it): where the light-sampled glass and mirror instances are and how many (pairs of
  // GPU index and IOR, 0 for a mirror).
  words[1] = start;
  words[start] = deflectorBase;
  words[start + 1] = s.deflectors.length / 2;
  for (let k = 0; k < s.deflectors.length; k += 2) {
    words[deflectorBase + k] = s.deflectors[k];
    floats[deflectorBase + k + 1] = s.deflectors[k + 1];
  }
  for (let k = 0; k < s.emissiveInstances.length; k++) {
    words[emissiveBase + k * 2] = s.emissiveInstances[k];
    floats[emissiveBase + k * 2 + 1] = s.emissiveCdf[k];
  }
  for (const [m, e] of s.emitters.entries())
    for (let k = 0; k < e.cdf.length; k++) {
      words[emitters[m].first + k * 3] = e.faces[k * 2];
      words[emitters[m].first + k * 3 + 1] = e.faces[k * 2 + 1];
      floats[emitters[m].first + k * 3 + 2] = e.cdf[k];
    }
  floats.set(s.lights, areaBase);
  if (env) {
    floats.set(env.marginal, marginalBase);
    floats.set(env.conditional, conditionalBase);
  }
  return { words, emissiveBase, areaBase, marginalBase, conditionalBase, emitters };
}

/** The scene buffer: models, instances, hierarchy nodes, block textures, then the lights (`lightLayout`). */
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
    // TRS motion packets after the nodes, then the block textures: word 0 holds the texture table's start; per
    // texture first texel word, width, height.
    motionBase = nodeBase + s.nodes.length,
    textureBase = motionBase + s.instances.reduce((n, v) => n + (v.motion ? MOTION_WORDS : 0), 0),
    words = lights.words,
    floats = new Float32Array(words.buffer);
  let packet = motionBase;
  words[0] = s.textures.length ? textureBase : 0;
  let texel = textureBase + 4 * s.textures.length;
  for (const [k, t] of s.textures.entries()) {
    words.set([texel, t.width, t.height, 0], textureBase + 4 * k);
    words.set(t.texels, texel);
    texel += t.texels.length;
  }
  for (const [i, m] of s.models.entries()) {
    const b = modelBase + i * MODEL_WORDS,
      e = lights.emitters[i];
    // Word 7: the model's material table, as the slot bits above the palette index (table << 8).
    words.set(
      [m.size[0], m.size[1], m.size[2], gridOffsets[i], m.bricks[0], m.bricks[1], m.bricks[2], s.modelTables[i] << 8],
      b,
    );
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
    words[b + 37] = (v.previous ? 1 : 0) | (v.prism ? 2 : 0) | (v.mirror ? 4 : 0) | (v.motion ? 8 : 0);
    floats[b + 38] = v.lightPick;
    if (v.motion) {
      words[b + 39] = packet;
      floats.set(v.motion, packet);
      packet += MOTION_WORDS;
    }
  }
  words.set(s.nodes, nodeBase);
  return { words, modelBase, instanceBase, nodeBase, nodeCount };
}
