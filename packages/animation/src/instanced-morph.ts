// Live morph weights per crowd member. A bone-texture crowd (instanced-skin.ts) bakes its morph targets in at the
// weights the model had; here the targets' offsets ride in the same texture after the bone rows, each member's weights
// ride in its instance row, and the vertex stage adds the weighted offsets before it skins. Skinning, drawing, lighting
// and shadows stay SkinnedCrowd's.
import type { EngineKernel } from '@margoengine/core';
import type { Animation } from './index.js';
import { vertexValues } from '../../shared/vertex-map.js';
import { VAT_WIDTH, type VATBakeOptions, type VATCrowdOptions } from './vat.js';
import {
  SKINNED_CROWD_STRIDE,
  SkinnedCrowd,
  bakeBones,
  poseBones,
  skinnedCrowdLayout,
  skinnedCrowdVertex,
  type BoneBake,
  type SkinnedCrowdInstance,
} from './instanced-skin.js';

/** Most morph targets one bake carries live: 16 four-weight vectors in each instance row. */
export const MORPH_TARGET_LIMIT = 64;

/** Options for {@link bakeMorphBones}: `bakeBones`'s, and which targets stay live. */
export interface MorphBakeOptions extends VATBakeOptions {
  /**
   * The targets each member sets live, by name or by index into the model's targets (every primitive's, joined by
   * name in first-seen order). Default: all of them. A target left out is baked in at the weight it has now.
   */
  morphs?: readonly (string | number)[];
}

/** A {@link bakeBones} bake whose vertices are the unmorphed shape, with its live targets after the bone rows. */
export interface MorphBake extends BoneBake {
  morphs: {
    /** Live target names; a member's weight `i` moves target `names[i]`. */
    names: string[];
    /** The weights the model had when baked: what a new member starts with. */
    weights: Float32Array;
    /** Per vertex: the texel of its first block entry, its number of blocks, its index in its primitive, 0. */
    vertices: Uint32Array;
    /** Blocks: one per live target of each primitive, an entry texel `[first offset texel, weight index, 0, 0]`. */
    blocks: number;
  };
}

/**
 * Bakes like {@link bakeBones}, but keeps morph targets live: the vertices are baked with the live targets at zero,
 * and each target's position and normal offsets go into the bone texture after the bone rows (two texels per vertex of
 * each primitive that has the target, so an unmorphed body costs nothing for its head's targets).
 * @throws RangeError for a model with no morph targets, an unknown or repeated target, more than
 * {@link MORPH_TARGET_LIMIT} live targets, data past 8192 texture rows, or anything `bakeBones` rejects.
 */
export function bakeMorphBones(animation: Animation, options: MorphBakeOptions = {}): MorphBake {
  const model = animation.model,
    asset = model.asset,
    all: string[] = [],
    parts = model.primitives.map((p) => {
      const targets: Record<string, number>[] = p.definition.targets ?? [],
        names = targets.map((_, t) => p.targetNames[t] ?? 'Target ' + t);
      for (const name of names) if (!all.includes(name)) all.push(name);
      return { p, targets, names, count: p.vertices.length / 20 };
    }),
    names = (options.morphs ?? all).map((m) => (typeof m === 'string' ? m : all[m]));
  if (!all.length) throw new RangeError('The model has no morph targets; bake it with bakeBones');
  if (!names.length || names.some((name, i) => !all.includes(name) || names.indexOf(name) !== i))
    throw new RangeError(
      'Unknown or repeated morph target; pass target names, or indices below the number of targets, once each',
    );
  if (names.length > MORPH_TARGET_LIMIT)
    throw new RangeError(
      `${names.length} live morph targets exceed ${MORPH_TARGET_LIMIT}; name the ones members set in the morphs option`,
    );
  const weights = new Float32Array(names.length),
    saved = parts.map(({ p }) => p.weights.slice()),
    seen = new Set<number>();
  let bake: BoneBake;
  try {
    for (const { p, names: own } of parts)
      own.forEach((name, t) => {
        const slot = names.indexOf(name);
        if (slot < 0) return;
        if (!seen.has(slot)) weights[slot] = p.weights[t];
        seen.add(slot);
        p.weights[t] = 0;
      });
    bake = bakeBones(animation, options);
  } finally {
    parts.forEach(({ p }, i) => p.weights.set(saved[i]));
  }
  const live = parts.map((part) => part.names.map((name) => names.indexOf(name)).filter((slot) => slot >= 0).length),
    blocks = live.reduce((n, x) => n + x, 0),
    table = bake.rows * bake.bones * 3,
    total = table + blocks + parts.reduce((n, part, i) => n + live[i] * part.count * 2, 0),
    height = Math.ceil(total / VAT_WIDTH);
  if (height > 8192)
    throw new RangeError('Morph data exceeds 8192 texture rows; keep fewer targets live, or bake fewer clips');
  const texels = new Float32Array(VAT_WIDTH * height * 4),
    vertices = new Uint32Array(bake.vertexCount * 4);
  texels.set(bake.texels.subarray(0, table * 4));
  let entry = table,
    at = table + blocks,
    base = 0;
  parts.forEach(({ p, targets, names: own, count }, k) => {
    for (let i = 0; i < count; i++) vertices.set([entry, live[k], i, 0], (base + i) * 4);
    base += count;
    targets.forEach((target, t) => {
      const slot = names.indexOf(own[t]);
      if (slot < 0) return;
      texels[entry * 4] = at;
      texels[entry++ * 4 + 1] = slot;
      [target.POSITION, target.NORMAL].forEach((accessor, part) => {
        if (accessor === undefined) return;
        const data = vertexValues(asset.accessor(accessor, 'VEC3'), 3, p.part?.vertexMap);
        for (let i = 0; i < count; i++) texels.set(data.subarray(i * 3, i * 3 + 3), (at + i * 2 + part) * 4);
      });
      at += count * 2;
    });
  });
  return { ...bake, texels, morphs: { names, weights, vertices, blocks } };
}

const morphFunctions = /* wgsl */ `fn morphTexel(i:u32)->vec4f {let w=u32(f.vat.y);return textureLoad(vat,vec2u(i%w,i/w),0);}
fn morphed(s:Instance,position:vec3f,normal:vec3f,morph:vec4u)->SkinnedVertex {
 var p=position;var n=normal;
 for(var i=0u;i<morph.y;i++) {
  let e=morphTexel(morph.x+i);let slot=u32(e.y);let w=s.w[slot>>2u][slot&3u];
  if(w!=0.0) {let at=u32(e.x)+morph.z*2u;p+=morphTexel(at).xyz*w;n+=morphTexel(at+1u).xyz*w;}
 }
 return SkinnedVertex(p,n);
}
`;

/**
 * The vertex stage of a {@link MorphedCrowd} whose instance rows end in `vectors` four-weight vectors: SkinnedCrowd's
 * own text, with the weights in the instance, the per-vertex block record at location 7 and the morph before the skin.
 * Exposed for tooling and tests.
 */
export function morphedCrowdVertex(vectors: number): string {
  return skinnedCrowdVertex
    .replace('q:vec4f}', `q:vec4f,w:array<vec4f,${vectors}>}`)
    .replace('@vertex fn vertex(', morphFunctions + '@vertex fn vertex(')
    .replace('@location(6) w1:vec4f,', '@location(6) w1:vec4f,@location(7) morph:vec4u,')
    .replace(
      'let k=skinned(s,position,normal,',
      'let b=morphed(s,position,normal,morph);let k=skinned(s,b.position,b.normal,',
    );
}

/** Morph weights for a member: an array in `bake.morphs.names` order (a shorter one sets the first ones), or weights by name. */
export type MorphWeights = ArrayLike<number> | Readonly<Record<string, number>>;

/** One crowd member for {@link MorphedCrowd.add} and {@link MorphedCrowd.set}. */
export interface MorphedCrowdInstance extends SkinnedCrowdInstance {
  /** Weights to change; the others keep their value (for a new member, the bake's `morphs.weights`). Any finite number. */
  morphs?: MorphWeights;
}

function slotOf(bake: MorphBake, target: number | string): number {
  const slot = typeof target === 'string' ? bake.morphs.names.indexOf(target) : target;
  if (!(Number.isInteger(slot) && slot >= 0 && slot < bake.morphs.names.length))
    throw new RangeError(
      `Unknown morph target ${target}; use a name from bake.morphs.names or an index below ${bake.morphs.names.length}`,
    );
  return slot;
}
// Writes `morphs` over `out` (a full set of weights) after checking all of it.
function writeWeights(bake: MorphBake, morphs: MorphWeights, out: Float32Array, at: number): void {
  const list = (
    ArrayBuffer.isView(morphs) || Array.isArray(morphs)
      ? Array.from(morphs as ArrayLike<number>, (w, i) => [i, w])
      : Object.entries(morphs)
  ) as [number | string, number][];
  const slots = list.map(([target]) => slotOf(bake, target));
  if (list.some(([, w]) => typeof w !== 'number' || !Number.isFinite(w)))
    throw new RangeError('Invalid morph weight; pass finite numbers');
  slots.forEach((slot, i) => (out[at + slot] = list[i][1]));
}

/**
 * The bake's vertices with `weights` applied, as `bake.vertices` holds them (position and normal, 6 floats each): the
 * CPU twin of the shader's morph step.
 * @throws RangeError for weights that do not fit the bake's targets or are not finite.
 */
export function morphVertices(
  bake: MorphBake,
  weights: MorphWeights = bake.morphs.weights,
  out = new Float32Array(bake.vertices.length),
): Float32Array {
  const w = bake.morphs.weights.slice(),
    { vertices, texels } = { vertices: bake.morphs.vertices, texels: bake.texels };
  writeWeights(bake, weights, w, 0);
  if (out.length < bake.vertices.length) throw new RangeError('Morph output needs 6 floats per vertex');
  out.set(bake.vertices);
  for (let v = 0; v < bake.vertexCount; v++)
    for (let i = 0; i < vertices[v * 4 + 1]; i++) {
      const entry = (vertices[v * 4] + i) * 4,
        weight = w[texels[entry + 1]],
        at = (texels[entry] + vertices[v * 4 + 2] * 2) * 4;
      if (weight)
        for (let c = 0; c < 3; c++) {
          out[v * 6 + c] += texels[at + c] * weight;
          out[v * 6 + 3 + c] += texels[at + 4 + c] * weight;
        }
    }
  return out;
}

/**
 * Where a member's vertices are at `time` (the crowd's clock), morphed by its weights and then skinned, in the model
 * root's space before its matrix: `poseBones` on the morphed shape, for checks, picking and bounds.
 */
export function poseMorphedBones(
  bake: MorphBake,
  member: MorphedCrowdInstance,
  time: number,
  out?: Float32Array<ArrayBuffer>,
): Float32Array {
  return poseBones({ ...bake, vertices: morphVertices(bake, member.morphs ?? bake.morphs.weights) }, member, time, out);
}

/**
 * A {@link SkinnedCrowd} whose members each have their own morph weights, set from JavaScript at any time: one
 * instanced draw, the weighted target offsets added in the vertex shader before the bones. Everything else is as
 * `SkinnedCrowd`: two clips and a blend per member, `shadows.add(crowd)`, `lighting.add(crowd)`.
 * @example
 * const crowd = MorphedCrowd.attach(engine, bakeMorphBones(animation));
 * const face = crowd.add({ morphs: { Smile: 1 } });
 * crowd.setMorph(face, 'Smile', 0.25);
 */
export class MorphedCrowd extends SkinnedCrowd {
  declare readonly bake: MorphBake;
  /** Same as `engine.use(new MorphedCrowd(...))`; returns the crowd. */
  static override attach(engine: EngineKernel, bake: MorphBake, options?: VATCrowdOptions): MorphedCrowd {
    const value = new MorphedCrowd(bake, options);
    engine.use(value);
    return value;
  }
  constructor(bake: MorphBake, options?: VATCrowdOptions) {
    const targets = bake?.morphs?.names?.length;
    if (!(bake?.morphs?.vertices instanceof Uint32Array) || !(targets >= 1 && targets <= MORPH_TARGET_LIMIT))
      throw new TypeError('Invalid morphed crowd; pass the result of bakeMorphBones');
    const vectors = Math.ceil(targets / 4),
      base = skinnedCrowdLayout(bake);
    super(bake, options, {
      ...base,
      vertex: morphedCrowdVertex(vectors),
      stride: SKINNED_CROWD_STRIDE + vectors * 4,
      vertices: [...base.vertices, bake.morphs.vertices],
      attributes: [
        ...base.attributes,
        { arrayStride: 16, attributes: [{ shaderLocation: 7, offset: 0, format: 'uint32x4' }] },
      ],
    });
  }
  /** Adds a member at the bake's weights, changed by `instance.morphs`; returns its index. */
  override add(instance: MorphedCrowdInstance = {}): number {
    const weights = this.bake.morphs.weights.slice();
    if (instance.morphs !== undefined) writeWeights(this.bake, instance.morphs, weights, 0);
    return super.add({ ...instance, morphs: weights } as MorphedCrowdInstance);
  }
  /** Changes the given fields of one member; `morphs` changes the weights it names and keeps the rest. */
  override set(index: number, instance: MorphedCrowdInstance): this {
    const { morphs } = instance,
      weights = new Float32Array(this.bake.morphs.names.length);
    // Checked before anything is written, so a bad weight leaves the member as it was.
    if (morphs !== undefined) writeWeights(this.bake, morphs, weights, 0);
    super.set(index, instance);
    if (morphs !== undefined) writeWeights(this.bake, morphs, this.rows, index * this.stride + SKINNED_CROWD_STRIDE);
    return this;
  }
  /** Sets one weight of one member (any finite number; 0 costs nothing in the shader). Uploads with the next frame. */
  setMorph(index: number, target: number | string, weight: number): this {
    return this.set(index, { morphs: { [this.bake.morphs.names[slotOf(this.bake, target)]]: weight } });
  }
  /** One weight of one member. */
  getMorph(index: number, target: number | string): number {
    const slot = slotOf(this.bake, target);
    if (!(Number.isInteger(index) && index >= 0 && index < this.count))
      throw new RangeError('Invalid crowd member; use an index below the member count');
    return this.rows[index * this.stride + SKINNED_CROWD_STRIDE + slot];
  }
}
