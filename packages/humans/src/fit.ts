/// <reference lib="esnext.disposable" preserve="true" />
// Period clothes on any rigged person: the cast kit's garments (@margoengine/humans/cast) cut to a loaded, skinned body
// (a Character Creator export, a Mixamo character, any humanoid rig) in its own rest pose, then skinned to its skeleton
// so they move with every clip the person plays.
//
// The body is measured where it stands: its skin vertices are split into trunk, head, arms, hands, legs and feet by the
// bone that carries most of their weight, and each garment tube is cut ring by ring around that part's axis (the trunk's
// own centre line, the hip-knee-ankle and shoulder-elbow-wrist joint lines) to the convex hull of the body's slice there,
// which is what a tape measure reads as a girth and what cloth under tension bridges. Layers stack from the skin out as
// the cast kit stacks them: each garment's inner face sits its ease outside everything beneath it on the same ring.
// Skin weights come from the body: each part gets a weight lattice (a row every centimetre along its axis, a node per
// ring angle) whose nodes take the weights at the closest body point under the cloth where that match is near and faces
// the same way; the rest are inpainted by a harmonic solve over the lattice. Every garment vertex reads the lattice at
// its place and angle, so all layers of one place carry the same weights and keep their order in any pose.
//
// Sources (docs/clean-room.md, "humans/fit"):
// - Garment transfer that keeps a garment's design (proportions and fit, the gap to the body) while moving it to a new
//   body, with collisions resolved against the body: R. Brouet, A. Sheffer, L. Boissieux, M.-P. Cani, "Design Preserving
//   Garment Transfer", ACM TOG 31(4):36, SIGGRAPH 2012, https://doi.org/10.1145/2185520.2185532. Here the design is the
//   cast kit's spec (hem, sleeve length, ease, thickness) and the fit is kept as the ease over the measured body.
// - Skin weight transfer by closest-point matching with a distance and normal test, the rest inpainted by minimising
//   the Dirichlet energy with the matched weights fixed: R. Abdrashitov, K. Raichstat, J. Monsen, D. Hill, "Robust Skin
//   Weights Transfer via Weight Inpainting", SIGGRAPH Asia 2023 Technical Communications,
//   https://doi.org/10.1145/3610543.3626180 (the paper's 30 degree normal test; its distance threshold, 0.05 of the
//   bounding box diagonal, is 15 mm here, tighter, because the lattice nodes sit on the body). The Laplacian is the
//   uniform graph one of the lattice (a regular grid, where it matches the cotangent one up to scale), solved by
//   successive over-relaxation.
// - Girth as the convex hull of a body slice: ISO 8559-1:2017, "Size designation of clothes, Part 1: Anthropometric
//   definitions for body measurement" (girths taken with a tape held taut around the body, which spans hollows).
// - Closest point on a triangle: C. Ericson, "Real-Time Collision Detection", Morgan Kaufmann 2005, section 5.1.5.
// - Convex hull: A. M. Andrew, "Another efficient algorithm for convex hulls in two dimensions", Information Processing
//   Letters 9(5):216-219, 1979.
// - Linear blend skinning for the penetration measure: N. Magnenat-Thalmann, R. Laperriere, D. Thalmann, "Joint-dependent
//   local deformations for hand animation and object grasping", Graphics Interface 1988.
import type { Engine } from '@margoengine/core';
import type { Engine as EngineKernel } from '@margoengine/core/extension';
import type { PBRModel } from '@margoengine/gltf/pbr-model';
import type { Animation } from '@margoengine/animation';
import { detectSkeleton, humanoidBones, type HumanoidBone } from '@margoengine/rigging/retarget';
import { invertMatrix, multiplyMatrices, composeMatrix } from '@margoengine/math/mat4';
import { GLB_BIN, GLB_JSON, GLB_MAGIC } from '../../shared/glb.js';
import { sceneScope } from '../../shared/scene-scope.js';
import { applySettings, checkSettings, numberSetting, settingDefaults, type SettingRow } from '../../shared/settings.js';
import { crownRows, crownTaper } from './crown.js';
import { OUTFITS, RING_STEPS, garmentMaterial, type CastBody, type GarmentSpec, type Outfit, type OutfitName } from './cast.js';

type V3 = [number, number, number];

// ---------------------------------------------------------------------------------------------------------------------
// The body.
// ---------------------------------------------------------------------------------------------------------------------

/** One bone of a {@link RiggedBody}: its name, its parent bone (-1 for none) and its rest (bind) matrix. */
export interface RiggedBone {
  readonly name: string;
  readonly parent: number;
  /** The bone's bind matrix in the body's space, 16 numbers column-major: the inverse of its inverse bind matrix. */
  readonly bind: ArrayLike<number>;
}
/**
 * A skinned body in its rest pose, as {@link fitOutfit} reads it: triangles with four bone influences a vertex. Make
 * one from a loaded model with {@link riggedBody}, or build it in code.
 */
export interface RiggedBody {
  /** Rest positions, 3 numbers a vertex, in the body's space. */
  readonly positions: ArrayLike<number>;
  /** Unit normals, 3 a vertex. */
  readonly normals: ArrayLike<number>;
  /** Triangle vertex indices. */
  readonly indices: ArrayLike<number>;
  /** Four bone indices a vertex (into `bones`). */
  readonly joints: ArrayLike<number>;
  /** Four weights a vertex. */
  readonly weights: ArrayLike<number>;
  readonly bones: readonly RiggedBone[];
  /**
   * The body's space to model space (y up), 16 numbers column-major. Default identity. A loaded model's skinned mesh
   * lives in its node's space, which can be centimetres or z up; this matrix takes it to the model's.
   */
  readonly toModel?: ArrayLike<number>;
  /**
   * Which closed surface each triangle belongs to, for the penetration measure of a body built from separate closed
   * parts (one id a triangle). Default one surface.
   */
  readonly surfaces?: ArrayLike<number>;
  /** Positions (3 a point, body space) a hat must clear as well as the head: hair. */
  readonly hair?: ArrayLike<number>;
}

const PRIMITIVE_STRIDE = 20;
/**
 * The skin of `model` (a `@margoengine/gltf/pbr` model, loaded from glTF or FBX) as a {@link RiggedBody}: the primitives
 * whose material, node or mesh is named in `materials` (default the skin names {@link addPerson} uses plus underwear:
 * `Skin`, `Body`, `Std_Skin_Body`, `Std_Skin_Arm`, `Std_Skin_Leg`, `Std_Skin_Head`, `Boxers` ...; a rig whose skin has no
 * material is found by its mesh named `Body`), in the space of the first one's skinned node, with its skin's bones. Hair
 * primitives (a material name with "hair" in it) become `hair`.
 * @example
 * const body = riggedBody(model);
 * const fit = fitOutfit(body, OUTFITS['townsman-1910']);
 * @throws TypeError when no named primitive is skinned.
 */
export function riggedBody(model: PBRModel, materials: readonly string[] = BODY_MATERIALS): RiggedBody {
  if (!model || !Array.isArray(model.primitives) || !model.asset) throw new TypeError('riggedBody needs a loaded gltf/pbr model');
  if (!Array.isArray(materials) || materials.some((m) => typeof m !== 'string')) throw new TypeError('riggedBody materials must be an array of material names');
  const doc = model.asset.doc as unknown as Doc,
    nameOf = (p: Primitive) => (p.material as { name?: string } | undefined)?.name ?? '',
    skinned = (p: Primitive) => doc.nodes[p.nodeIndex]?.skin,
    picked = model.primitives.filter((p) => isBody(doc, p, materials) && skinned(p) !== undefined && !p.topology);
  if (!picked.length)
    throw new TypeError(`riggedBody found no skinned primitive with a material, node or mesh named ${materials.slice(0, 6).join(', ')} ...; pass the body's names`);
  const skeleton = bodySkeleton(model, picked),
    bones: RiggedBone[] = skeleton.nodes.map((node, i) => {
      let up = skeleton.parentOf.get(node);
      while (up !== undefined && !skeleton.index.has(up)) up = skeleton.parentOf.get(up);
      return { name: doc.nodes[node]?.name ?? `bone${i}`, parent: up === undefined ? -1 : skeleton.index.get(up)!, bind: skeleton.binds[i] };
    });
  const pos: number[] = [],
    nor: number[] = [],
    ix: number[] = [],
    jo: number[] = [],
    we: number[] = [],
    hair: number[] = [];
  for (const p of picked) {
    const a = p.definition.attributes as Record<string, number | undefined>,
      remap = skeleton.remap.get(skinned(p)!)!;
    if (a.JOINTS_0 === undefined || a.WEIGHTS_0 === undefined) continue;
    const ids = model.asset.accessor(a.JOINTS_0, 'VEC4'),
      ws = model.asset.accessor(a.WEIGHTS_0, 'VEC4'),
      map = p.part?.vertexMap,
      v = p.vertices,
      count = v.length / PRIMITIVE_STRIDE,
      first = pos.length / 3;
    for (let k = 0; k < count; k++) {
      const o = k * PRIMITIVE_STRIDE,
        at = (map ? map[k] : k) * 4;
      pos.push(v[o], v[o + 1], v[o + 2]);
      nor.push(v[o + 4], v[o + 5], v[o + 6]);
      for (let i = 0; i < 4; i++) {
        jo.push(remap[ids[at + i]] ?? 0);
        we.push(ws[at + i]);
      }
    }
    for (const i of p.indices) ix.push(first + i);
  }
  for (const p of model.primitives)
    if (/hair/i.test(nameOf(p)) && !/brow|lash/i.test(nameOf(p)) && skeleton.remap.has(skinned(p)!))
      for (let k = 0; k < p.vertices.length; k += PRIMITIVE_STRIDE) hair.push(p.vertices[k], p.vertices[k + 1], p.vertices[k + 2]);
  if (!ix.length) throw new TypeError('riggedBody: the body primitives carry no JOINTS_0 and WEIGHTS_0; export the body with its skin weights');
  return {
    positions: new Float32Array(pos),
    normals: new Float32Array(nor),
    indices: new Uint32Array(ix),
    joints: new Uint32Array(jo),
    weights: new Float32Array(we),
    bones,
    toModel: nodeToRoot(doc, skeleton.host),
    ...(hair.length ? { hair: new Float32Array(hair) } : {}),
  };
}
/** The body's skeleton: every bone node, its bind matrix and inverse, and each skin's joint index -> bone index. */
interface BodySkeleton {
  host: number;
  nodes: number[];
  index: Map<number, number>;
  binds: Float64Array[];
  inverseBinds: Float32Array;
  remap: Map<number, number[]>;
  parentOf: Map<number, number>;
}
/**
 * One skeleton for the body primitives, which an FBX conversion gives one skin each (Character Creator: head, body, arm
 * and leg skins with the same joints): the joints of every picked skin in first-seen order (a single skin keeps its own
 * order), then the joints' unweighted ancestors that are not above the mesh node (Character Creator's `CC_Base_Hip`
 * carries no weight, so no skin lists it, yet it is the rig's hips). An ancestor's bind is its child's bind times the
 * inverse of the child's rest transform.
 */
function bodySkeleton(model: PBRModel, picked: readonly Primitive[]): BodySkeleton {
  const doc = model.asset.doc as unknown as Doc,
    host = picked[0].nodeIndex,
    parentOf = new Map<number, number>(),
    nodes: number[] = [],
    index = new Map<number, number>(),
    binds: Float64Array[] = [],
    remap = new Map<number, number[]>(),
    identity = () => new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  doc.nodes.forEach((n, i) => n.children?.forEach((c) => parentOf.set(c, i)));
  const inverses: ArrayLike<number>[] = [],
    add = (node: number, bind: Float64Array, inverse?: ArrayLike<number>) => {
      index.set(node, nodes.length);
      nodes.push(node);
      binds.push(bind);
      inverses.push(inverse ?? invertMatrix(bind) ?? identity());
      return nodes.length - 1;
    };
  for (const p of picked) {
    const id = doc.nodes[p.nodeIndex].skin!;
    if (remap.has(id)) continue;
    const skin = doc.skins![id],
      ibm = skin.inverseBindMatrices === undefined ? undefined : model.asset.accessor(skin.inverseBindMatrices, 'MAT4');
    remap.set(
      id,
      skin.joints.map((node, i) => {
        const known = index.get(node);
        if (known !== undefined) return known;
        const inverse = ibm ? ibm.subarray(i * 16, i * 16 + 16) : identity(),
          bind = invertMatrix(inverse);
        if (!bind) throw new RangeError(`riggedBody: bone ${doc.nodes[node]?.name ?? node} has a singular inverse bind matrix; export the skin with invertible bind matrices`);
        return add(node, bind, inverse);
      }),
    );
  }
  const above = new Set<number>();
  for (let at: number | undefined = host; at !== undefined && !above.has(at); at = parentOf.get(at)) above.add(at);
  for (let i = 0; i < nodes.length; i++) {
    const up = parentOf.get(nodes[i]);
    if (up === undefined || index.has(up) || above.has(up)) continue;
    const local = invertMatrix(localMatrix(doc.nodes[nodes[i]]));
    if (local) add(up, multiplyMatrices(binds[i], local));
  }
  const inverseBinds = new Float32Array(nodes.length * 16);
  inverses.forEach((inverse, i) => inverseBinds.set(inverse, i * 16));
  return { host, nodes, index, binds, inverseBinds, remap, parentOf };
}
/** The material names {@link riggedBody} reads as the body by default: skin and underwear. */
export const BODY_MATERIALS: readonly string[] = [
  'Skin',
  'Body',
  'Face',
  'Std_Skin_Head',
  'Std_Skin_Body',
  'Std_Skin_Arm',
  'Std_Skin_Leg',
  'Boxers',
  'Briefs',
  'Underwear',
];
type Doc = {
  nodes: { name?: string; children?: number[]; mesh?: number; skin?: number; translation?: number[]; rotation?: number[]; scale?: number[]; matrix?: number[] }[];
  skins?: { joints: number[]; inverseBindMatrices?: number; skeleton?: number }[];
  meshes?: { name?: string }[];
  scenes?: { nodes?: number[] }[];
  scene?: number;
};
type Primitive = PBRModel['primitives'][number];
/** True when the primitive's material, node or mesh carries one of the body names. */
function isBody(doc: Doc, p: Primitive, names: readonly string[]): boolean {
  const node = doc.nodes[p.nodeIndex],
    material = (p.material as { name?: string } | undefined)?.name;
  return [material, node?.name, node?.mesh === undefined ? undefined : doc.meshes?.[node.mesh]?.name].some((n) => n !== undefined && names.includes(n));
}
/** The matrix from node `node`'s space to the scene root's, from the file's rest transforms. */
function nodeToRoot(doc: Doc, node: number): Float64Array {
  const parentOf = new Map<number, number>();
  doc.nodes.forEach((n, i) => n.children?.forEach((c) => parentOf.set(c, i)));
  let m = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  for (let at: number | undefined = node, guard = 0; at !== undefined && guard < 1024; at = parentOf.get(at), guard++) m = multiplyMatrices(localMatrix(doc.nodes[at]), m);
  return m;
}
function localMatrix(n: Doc['nodes'][number]): Float64Array {
  if (n.matrix) return new Float64Array(n.matrix);
  const q = n.rotation ?? [0, 0, 0, 1],
    l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return composeMatrix(n.translation ?? [0, 0, 0], q.map((c) => c / l), n.scale ?? [1, 1, 1], new Float64Array(16));
}

// ---------------------------------------------------------------------------------------------------------------------
// Analysis: the fit frame, body parts, joint lines and slices.
// ---------------------------------------------------------------------------------------------------------------------

const TRUNK = 0,
  HEAD = 1,
  ARM = 2, // + side (0 left, 1 right)
  HAND = 4,
  LEG = 6,
  FOOT = 8;
/** The body part a humanoid bone moves. */
function segmentOf(h: HumanoidBone): number {
  if (h === 'head' || h === 'jaw' || h === 'leftEye' || h === 'rightEye') return HEAD;
  const side = h.startsWith('left') ? 0 : h.startsWith('right') ? 1 : -1;
  if (side < 0) return TRUNK;
  const bone = h.slice(side ? 5 : 4);
  if (bone === 'Shoulder') return TRUNK;
  if (bone === 'UpperArm' || bone === 'LowerArm') return ARM + side;
  if (bone === 'UpperLeg' || bone === 'LowerLeg') return LEG + side;
  if (bone === 'Foot' || bone === 'Toes') return FOOT + side;
  return HAND + side;
}
/** A rest pose by how far the upper arms stand out from hanging straight down. */
export type RestPose = 'T' | 'A' | 'down';
/** Slice spacing along every part, metres: the cast kit's ring spacing. */
const STEP = 0.02;
const R = RING_STEPS;
const COS = Float64Array.from({ length: R }, (_, k) => Math.cos((2 * Math.PI * k) / R));
const SIN = Float64Array.from({ length: R }, (_, k) => Math.sin((2 * Math.PI * k) / R));
/** The points of one body part, each with its place along the part's axis and its offset across it. */
interface PartPoints {
  at: Float64Array;
  u: Float64Array;
  v: Float64Array;
}
/** An axis the rings of a part sit on: the centre and the across directions at a place along it. */
interface Axis {
  centre(at: number): V3;
  side(at: number): V3;
  front(at: number): V3;
  /** The place along the axis of a point (default its height). */
  project?(p: ArrayLike<number>, o: number): number;
}
interface Analysis {
  unit: number;
  /** Fit frame: x the body's left, y up from the floor, z forward, metres. */
  toFit(p: ArrayLike<number>, o: number, out: Float64Array, w: number): void;
  fromFit(p: ArrayLike<number>, out: Float32Array, o: number): void;
  normalFromFit(n: ArrayLike<number>, out: Float32Array, o: number): void;
  pos: Float64Array;
  seg: Uint8Array;
  pose: RestPose;
  armAngle: number;
  joint: (h: HumanoidBone) => V3;
  heights: { stature: number; crotch: number; hip: number; waist: number; chest: number; axilla: number; shoulder: number; neck: number; knee: number; ankle: number; top: number };
  axes: Record<string, Axis>;
  points: Record<string, PartPoints>;
  neck: NeckFrame;
  armLength: [number, number];
  diagonal: number;
  boneSegment: Uint8Array;
}

function analyse(body: RiggedBody, unitOption: number | undefined): Analysis {
  checkBody(body);
  const names = body.bones.map((b) => b.name),
    match = detectSkeleton(names);
  if (!match) throw new TypeError(`fitOutfit needs a humanoid skeleton (Character Creator, Mixamo, Godot, Roblox ...); bones ${names.slice(0, 8).join(', ')} ... name no hips and head`);
  const map = humanoidBones(names, match.preset),
    boneSegment = new Uint8Array(body.bones.length);
  body.bones.forEach((_, i) => {
    let at = i,
      guard = 0;
    while (at >= 0 && guard++ < 512) {
      const h = [...map].find(([, index]) => index === at)?.[0];
      if (h) {
        boneSegment[i] = segmentOf(h);
        return;
      }
      at = body.bones[at].parent;
    }
    boneSegment[i] = TRUNK;
  });
  const toModel = body.toModel ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    model = (p: ArrayLike<number>, o: number): V3 => [
      toModel[0] * p[o] + toModel[4] * p[o + 1] + toModel[8] * p[o + 2] + toModel[12],
      toModel[1] * p[o] + toModel[5] * p[o + 1] + toModel[9] * p[o + 2] + toModel[13],
      toModel[2] * p[o] + toModel[6] * p[o + 1] + toModel[10] * p[o + 2] + toModel[14],
    ];
  const required: HumanoidBone[] = ['hips', 'head'];
  for (const s of ['left', 'right']) for (const b of ['UpperArm', 'LowerArm', 'Hand', 'UpperLeg', 'LowerLeg', 'Foot']) required.push(`${s}${b}` as HumanoidBone);
  const missing = required.filter((h) => !map.has(h));
  if (missing.length) throw new TypeError(`fitOutfit needs these bones in the ${match.preset} rig: ${missing.join(', ')}`);
  const jointModel = (h: HumanoidBone) => model(body.bones[map.get(h)!].bind, 12);
  // Vertex parts by the part whose bones carry most of each vertex's weight.
  const n = body.positions.length / 3,
    seg = new Uint8Array(n),
    raw = new Float64Array(n * 3),
    share = new Float64Array(10),
    // Each vertex's weight on its arm (the upper and lower arm and the hand), and which arm.
    armShare = new Float64Array(n),
    armSide = new Uint8Array(n);
  let low = Infinity,
    high = -Infinity;
  for (let k = 0; k < n; k++) {
    share.fill(0);
    for (let i = 0; i < 4; i++) share[boneSegment[body.joints[k * 4 + i]]] += body.weights[k * 4 + i];
    let best = 0;
    for (let s = 1; s < 10; s++) if (share[s] > share[best]) best = s;
    seg[k] = best;
    for (const s of [0, 1]) {
      const w = share[ARM + s] + share[HAND + s];
      if (w > armShare[k]) [armShare[k], armSide[k]] = [w, s];
    }
    const p = model(body.positions, k * 3);
    raw.set(p, k * 3);
    low = Math.min(low, p[1]);
    high = Math.max(high, p[1]);
  }
  const height = high - low,
    unit = unitOption ?? (height > 0.3 && height < 3 ? 1 : height > 30 && height < 300 ? 0.01 : height > 300 && height < 3000 ? 0.001 : NaN);
  if (!(unit > 0)) throw new RangeError(`fitOutfit could not tell the body's unit from its height ${height}; pass unit (metres per body unit)`);
  // Forward is where the feet point: from each ankle to the middle of its foot's vertices.
  let fx = 0,
    fz = 0;
  for (const side of [0, 1]) {
    const ankle = jointModel(side ? 'rightFoot' : 'leftFoot');
    let cx = 0,
      cz = 0,
      c = 0;
    for (let k = 0; k < n; k++)
      if (seg[k] === FOOT + side) {
        cx += raw[k * 3];
        cz += raw[k * 3 + 2];
        c++;
      }
    if (c) {
      fx += cx / c - ankle[0];
      fz += cz / c - ankle[2];
    }
  }
  const yaw = fx || fz ? Math.atan2(fx, fz) : 0,
    cy = Math.cos(yaw),
    sy = Math.sin(yaw),
    hips = jointModel('hips'),
    ox = hips[0],
    oz = hips[2],
    inverse = invertMatrix(toModel) ?? new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const toFitModel = (p: ArrayLike<number>, o: number, out: Float64Array, w: number) => {
    const dx = p[o] - ox,
      dz = p[o + 2] - oz;
    out[w] = (dx * cy - dz * sy) * unit;
    out[w + 1] = (p[o + 1] - low) * unit;
    out[w + 2] = (dx * sy + dz * cy) * unit;
  };
  const pos = new Float64Array(n * 3);
  for (let k = 0; k < n; k++) toFitModel(raw, k * 3, pos, k * 3);
  const fitJoint = (h: HumanoidBone): V3 => {
    const out = new Float64Array(3);
    toFitModel(jointModel(h), 0, out, 0);
    return [out[0], out[1], out[2]];
  };
  const toFit = (p: ArrayLike<number>, o: number, out: Float64Array, w: number) => toFitModel(model(p, o), 0, out, w);
  const fromFit = (p: ArrayLike<number>, out: Float32Array, o: number) => {
    const x = p[0] / unit,
      z = p[2] / unit,
      mx = x * cy + z * sy + ox,
      my = p[1] / unit + low,
      mz = -x * sy + z * cy + oz;
    out[o] = inverse[0] * mx + inverse[4] * my + inverse[8] * mz + inverse[12];
    out[o + 1] = inverse[1] * mx + inverse[5] * my + inverse[9] * mz + inverse[13];
    out[o + 2] = inverse[2] * mx + inverse[6] * my + inverse[10] * mz + inverse[14];
  };
  // Normals go back by the inverse transpose of the frame's linear part: rotation and uniform scale give the rotation.
  const normalFromFit = (nn: ArrayLike<number>, out: Float32Array, o: number) => {
    const mx = nn[0] * cy + nn[2] * sy,
      my = nn[1],
      mz = -nn[0] * sy + nn[2] * cy,
      x = toModel[0] * mx + toModel[1] * my + toModel[2] * mz,
      y = toModel[4] * mx + toModel[5] * my + toModel[6] * mz,
      z = toModel[8] * mx + toModel[9] * my + toModel[10] * mz,
      l = Math.hypot(x, y, z) || 1;
    out[o] = x / l;
    out[o + 1] = y / l;
    out[o + 2] = z / l;
  };
  // Joint lines.
  const J = (h: HumanoidBone) => fitJoint(h),
    legLine = [0, 1].map((s) => [J(s ? 'rightUpperLeg' : 'leftUpperLeg'), J(s ? 'rightLowerLeg' : 'leftLowerLeg'), J(s ? 'rightFoot' : 'leftFoot')]),
    armLine = [0, 1].map((s) => [J(s ? 'rightUpperArm' : 'leftUpperArm'), J(s ? 'rightLowerArm' : 'leftLowerArm'), J(s ? 'rightHand' : 'leftHand')]);
  const knee = (legLine[0][1][1] + legLine[1][1][1]) / 2,
    ankle = (legLine[0][2][1] + legLine[1][2][1]) / 2,
    hipJoint = (legLine[0][0][1] + legLine[1][0][1]) / 2;
  let stature = 0,
    crotch = Infinity;
  for (let k = 0; k < n; k++) {
    const x = pos[k * 3],
      y = pos[k * 3 + 1];
    stature = Math.max(stature, y);
    if (Math.abs(x) < 0.012 && y > knee && y < hipJoint + 0.1 && seg[k] !== ARM && seg[k] !== ARM + 1 && seg[k] !== HAND && seg[k] !== HAND + 1) crotch = Math.min(crotch, y);
  }
  if (!Number.isFinite(crotch)) crotch = hipJoint - 0.08 * (stature / 1.72);
  const armDir = [0, 1].map((s) => {
      const a = armLine[s][0],
        b = armLine[s][1],
        l = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) || 1;
      return Math.acos(Math.max(-1, Math.min(1, -(b[1] - a[1]) / l)));
    }),
    armAngle = (armDir[0] + armDir[1]) / 2,
    pose: RestPose = armAngle > (65 * Math.PI) / 180 ? 'T' : armAngle > (20 * Math.PI) / 180 ? 'A' : 'down';
  // Axes. The trunk's centre line follows the middle of its slices (smoothed); the limbs follow their joint lines.
  const trunkSet = (k: number) => seg[k] === TRUNK || ((seg[k] === LEG || seg[k] === LEG + 1) && pos[k * 3 + 1] >= crotch);
  const neckY = map.has('neck') ? J('neck')[1] : J('head')[1] - 0.06 * (stature / 1.72);
  const samples = Math.ceil((neckY + 0.1) / 0.01) + 1,
    cxs = new Float64Array(samples),
    czs = new Float64Array(samples),
    has = new Uint8Array(samples);
  {
    const lo = new Float64Array(samples * 2).fill(Infinity),
      hi = new Float64Array(samples * 2).fill(-Infinity);
    for (let k = 0; k < n; k++) {
      if (!trunkSet(k)) continue;
      const i = Math.round(pos[k * 3 + 1] / 0.01);
      if (i < 0 || i >= samples) continue;
      lo[i * 2] = Math.min(lo[i * 2], pos[k * 3]);
      hi[i * 2] = Math.max(hi[i * 2], pos[k * 3]);
      lo[i * 2 + 1] = Math.min(lo[i * 2 + 1], pos[k * 3 + 2]);
      hi[i * 2 + 1] = Math.max(hi[i * 2 + 1], pos[k * 3 + 2]);
    }
    for (let i = 0; i < samples; i++)
      if (Number.isFinite(lo[i * 2])) {
        cxs[i] = (lo[i * 2] + hi[i * 2]) / 2;
        czs[i] = (lo[i * 2 + 1] + hi[i * 2 + 1]) / 2;
        has[i] = 1;
      }
    // Gaps take the nearest sample; then a moving average over 7 cm keeps the line smooth.
    const fill = (a: Float64Array) => {
      const first = has.indexOf(1);
      if (first < 0) return a.fill(0);
      for (let i = 0; i < samples; i++)
        if (!has[i]) {
          let j = 1;
          while (!(i - j >= 0 && has[i - j]) && !(i + j < samples && has[i + j])) j++;
          a[i] = i - j >= 0 && has[i - j] ? a[i - j] : a[i + j];
        }
      const copy = a.slice();
      for (let i = 0; i < samples; i++) {
        let s = 0,
          c = 0;
        for (let j = Math.max(0, i - 3); j <= Math.min(samples - 1, i + 3); j++) {
          s += copy[j];
          c++;
        }
        a[i] = s / c;
      }
      return a;
    };
    fill(cxs);
    fill(czs);
  }
  const sampleAt = (a: Float64Array, y: number) => {
    const f = Math.max(0, Math.min(samples - 1, y / 0.01)),
      i = Math.min(samples - 2, Math.floor(f)),
      t = f - i;
    return a[i] * (1 - t) + a[i + 1] * t;
  };
  const X: V3 = [1, 0, 0],
    Z: V3 = [0, 0, 1];
  const trunkAxis: Axis = { centre: (y) => [sampleAt(cxs, y), y, sampleAt(czs, y)], side: () => X, front: () => Z };
  const polylineAtY = (line: V3[], y: number): V3 => {
    if (y >= line[0][1]) return [line[0][0], y, line[0][2]];
    for (let i = 1; i < line.length; i++)
      if (y >= line[i][1]) {
        const t = (line[i - 1][1] - y) / Math.max(line[i - 1][1] - line[i][1], 1e-9);
        return [line[i - 1][0] + (line[i][0] - line[i - 1][0]) * t, y, line[i - 1][2] + (line[i][2] - line[i - 1][2]) * t];
      }
    const e = line[line.length - 1];
    return [e[0], y, e[2]];
  };
  const legAxis = [0, 1].map((s): Axis => ({ centre: (y) => polylineAtY(legLine[s], y), side: () => X, front: () => Z }));
  // Arms: distance along shoulder, elbow, wrist; before the shoulder the first segment runs on.
  const armAxis = [0, 1].map((s): Axis & { length: number; project(p: ArrayLike<number>, o: number): number } => {
    const line = armLine[s],
      seg1 = sub(line[1], line[0]),
      seg2 = sub(line[2], line[1]),
      l1 = norm(seg1),
      l2 = norm(seg2),
      d1 = scale(seg1, 1 / (l1 || 1)),
      d2 = scale(seg2, 1 / (l2 || 1));
    const along = (d: number) => (d < l1 ? d1 : d2);
    const frontOf = (d: number): V3 => {
      const a = along(d),
        f = sub(Z, scale(a, a[2]));
      return norm(f) > 1e-3 ? scale(f, 1 / norm(f)) : [0, 1, 0];
    };
    return {
      length: l1 + l2,
      centre: (d) => (d < l1 ? add(line[0], scale(d1, d)) : add(line[1], scale(d2, d - l1))),
      front: frontOf,
      side: (d) => {
        const c = cross(frontOf(d), along(d));
        return scale(c, 1 / (norm(c) || 1));
      },
      project(p, o) {
        const q: V3 = [p[o], p[o + 1], p[o + 2]],
          t1 = dot3(sub(q, line[0]), d1),
          t2 = Math.max(0, dot3(sub(q, line[1]), d2));
        if (t1 <= l1) {
          const e1 = norm(sub(q, add(line[0], scale(d1, t1)))),
            e2 = norm(sub(q, add(line[1], scale(d2, t2))));
          return e1 <= e2 ? t1 : l1 + t2;
        }
        return l1 + t2;
      },
    };
  });
  const headJoint = J('head');
  const hairFit: number[] = [];
  if (body.hair) {
    const tmp = new Float64Array(3);
    for (let k = 0; k + 2 < body.hair.length; k += 3) {
      toFit(body.hair, k, tmp, 0);
      hairFit.push(tmp[0], tmp[1], tmp[2]);
    }
  }
  let top = stature;
  for (let k = 1; k < hairFit.length; k += 3) top = Math.max(top, hairFit[k]);
  // Part points.
  const collect = (keep: (k: number) => boolean, axis: (k: number) => number, centre: Axis, extra?: number[], src: Float64Array = pos) => {
    const at: number[] = [],
      u: number[] = [],
      v: number[] = [];
    const add1 = (x: number, y: number, z: number, a: number) => {
      const c = centre.centre(a),
        s = centre.side(a),
        f = centre.front(a),
        d: V3 = [x - c[0], y - c[1], z - c[2]];
      at.push(a);
      u.push(dot3(d, s));
      v.push(dot3(d, f));
    };
    for (let k = 0; k < n; k++) if (keep(k)) add1(src[k * 3], src[k * 3 + 1], src[k * 3 + 2], axis(k));
    if (extra) for (let k = 0; k < extra.length; k += 3) add1(extra[k], extra[k + 1], extra[k + 2], extra[k + 1]);
    const order = at.map((_, i) => i).sort((a, b) => at[a] - at[b]);
    return { at: Float64Array.from(order, (i) => at[i]), u: Float64Array.from(order, (i) => u[i]), v: Float64Array.from(order, (i) => v[i]) };
  };
  const headCentre: V3 = [headJoint[0], 0, headJoint[2]];
  {
    // The head's centre: the middle of its vertices' horizontal extent above the head joint.
    let x0 = Infinity,
      x1 = -Infinity,
      z0 = Infinity,
      z1 = -Infinity;
    for (let k = 0; k < n; k++)
      if (seg[k] === HEAD && pos[k * 3 + 1] > headJoint[1]) {
        x0 = Math.min(x0, pos[k * 3]);
        x1 = Math.max(x1, pos[k * 3]);
        z0 = Math.min(z0, pos[k * 3 + 2]);
        z1 = Math.max(z1, pos[k * 3 + 2]);
      }
    if (Number.isFinite(x0)) {
      headCentre[0] = (x0 + x1) / 2;
      headCentre[2] = (z0 + z1) / 2;
    }
  }
  const headAxis: Axis = { centre: (y) => [headCentre[0], y, headCentre[2]], side: () => X, front: () => Z };
  const y = (k: number) => pos[k * 3 + 1];
  // The trunk as it stands with the arms hanging: each vertex moved by its arm's share of the turn that brings the upper
  // arm straight down about the shoulder joint (linear blend skinning, the way the body is posed when drawn). In an A or
  // T rest pose the armpit and the roots of the lats and deltoids stand out at the sides and partly follow the arm: a
  // coat hung plumb from that ring hangs wide of the body once the arms come down (dressed Wilbur, 2026-11-18: 2.5 cm
  // either side at the chest, 8 cm at the waist).
  const lowered = pos.slice();
  for (const s of [0, 1]) {
    const pivot = armLine[s][0],
      d = sub(armLine[s][1], pivot),
      l = norm(d) || 1,
      cosA = -d[1] / l,
      axis = cross(scale(d, 1 / l), [0, -1, 0]),
      sinA = norm(axis);
    if (sinA < 1e-6) continue;
    const u = scale(axis, 1 / sinA);
    for (let k = 0; k < n; k++) {
      const w = armShare[k];
      if (!(w > 0) || armSide[k] !== s) continue;
      const v: V3 = [pos[k * 3] - pivot[0], pos[k * 3 + 1] - pivot[1], pos[k * 3 + 2] - pivot[2]],
        c = cross(u, v),
        along = dot3(u, v) * (1 - cosA);
      for (let i = 0; i < 3; i++) lowered[k * 3 + i] += w * (v[i] * cosA + c[i] * sinA + u[i] * along - v[i]);
    }
  }
  const points: Record<string, PartPoints> = {
    trunk: collect(trunkSet, y, trunkAxis),
    trunkDown: collect(trunkSet, (k) => lowered[k * 3 + 1], trunkAxis, undefined, lowered),
    head: collect((k) => seg[k] === HEAD, y, headAxis, hairFit),
  };
  for (const s of [0, 1]) {
    const name = s ? 'R' : 'L',
      sign = s ? -1 : 1;
    points[`leg${name}`] = collect(
      (k) => seg[k] === LEG + s || seg[k] === FOOT + s || (seg[k] === TRUNK && pos[k * 3] * sign > 0 && pos[k * 3 + 1] < crotch + 0.03),
      y,
      legAxis[s],
    );
    points[`arm${name}`] = collect((k) => seg[k] === ARM + s, (k) => armAxis[s].project(pos, k * 3), armAxis[s]);
  }
  const axes: Record<string, Axis> = { trunk: trunkAxis, head: headAxis, legL: legAxis[0], legR: legAxis[1], armL: armAxis[0], armR: armAxis[1] };
  // Heights.
  const shoulder = (armLine[0][0][1] + armLine[1][0][1]) / 2;
  const girthAt = (yy: number) => perimeterOf(profileOf(points.trunk, yy));
  let waist = (hipJoint + shoulder) / 2,
    least = Infinity;
  const chestJoint = map.has('chest') ? J('chest')[1] : (hipJoint + shoulder) / 2;
  for (let yy = hipJoint + 0.04; yy <= Math.max(hipJoint + 0.05, chestJoint); yy += 0.01) {
    const g = girthAt(yy);
    if (g > 0 && g < least) [least, waist] = [g, yy];
  }
  let chest = (waist + shoulder) / 2,
    most = 0;
  for (let yy = waist + 0.04; yy <= shoulder - 0.06; yy += 0.01) {
    const g = girthAt(yy);
    if (g > most) [most, chest] = [g, yy];
  }
  const neck = neckFrame(map.has('neck') ? J('neck') : [headJoint[0], neckY, headJoint[2]], headJoint, shoulder, (k) => seg[k] === TRUNK || seg[k] === HEAD, pos, collect);
  const upperArmRadius = Math.max(0.02, perimeterOf(profileOf(points.armL, 0.1 * armAxis[0].length)) / (2 * Math.PI));
  let diagonal = 0;
  {
    const lo = [Infinity, Infinity, Infinity],
      hi = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < n; k++)
      for (let i = 0; i < 3; i++) {
        lo[i] = Math.min(lo[i], pos[k * 3 + i]);
        hi[i] = Math.max(hi[i], pos[k * 3 + i]);
      }
    diagonal = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  }
  return {
    unit,
    toFit,
    fromFit,
    normalFromFit,
    pos,
    seg,
    pose,
    armAngle,
    joint: J,
    heights: {
      stature,
      crotch,
      hip: hipJoint,
      waist,
      chest,
      axilla: shoulder - 1.4 * upperArmRadius,
      shoulder,
      neck: neckY,
      knee,
      ankle,
      top,
    },
    axes,
    points,
    neck,
    armLength: [armAxis[0].length, armAxis[1].length],
    diagonal,
    boneSegment,
  };
}
function checkBody(b: RiggedBody) {
  if (!b || typeof b !== 'object') throw new TypeError('fitOutfit needs a RiggedBody; make one with riggedBody(model)');
  const n = b.positions?.length / 3;
  if (!(n >= 3) || !Number.isInteger(n)) throw new TypeError('RiggedBody positions need 3 numbers a vertex');
  if (b.normals?.length !== n * 3 || b.joints?.length !== n * 4 || b.weights?.length !== n * 4)
    throw new TypeError('RiggedBody needs normals (3 a vertex), joints and weights (4 a vertex) for every position');
  if (!(b.indices?.length >= 3) || b.indices.length % 3) throw new TypeError('RiggedBody indices need 3 a triangle');
  if (!Array.isArray(b.bones) || !b.bones.length) throw new TypeError('RiggedBody needs its bones');
  for (let i = 0; i < b.joints.length; i++)
    if (!(b.joints[i] >= 0 && b.joints[i] < b.bones.length) || !(b.weights[i] >= 0)) throw new RangeError('RiggedBody joints must index its bones and weights must be 0 or more');
}

/**
 * The neck in its own frame: slices square to the neck's axis (neck joint to head joint), as ISO 8559-1:2017 takes the
 * neck girth (a tape round the neck square to its axis, just below the larynx) and the neck base girth (round the base
 * of the neck over the cervicale, the side neck points and the jugular notch).
 */
interface NeckFrame {
  readonly axis: V3;
  readonly side: V3;
  readonly front: V3;
  /** The neck girth: the narrowest slice between the clavicle line and the jaw, metres. */
  readonly girth: number;
  /** Places along the axis from the neck joint, metres: the neck base, the narrowest slice, and the top before the jaw. */
  readonly tBase: number;
  readonly tMin: number;
  readonly tTop: number;
  /** The middle of the slice at `t`. */
  centre(t: number): V3;
  /** The body's radius per ring angle round {@link centre} at `t` (side the body's left, front forward). */
  radii(t: number): Float64Array;
}
/** Slice spacing along the neck and half the slab each slice takes, metres. */
const NECK_STEP = 0.005,
  NECK_HALF = 0.01,
  /** A slice within this share of the narrowest still counts as neck: the neck base and the top under the jaw. */
  NECK_SPREAD = 1.12;
/**
 * Measures the neck of the points `keep` picks (trunk and head, no arms) square to the line from `neckJoint` to
 * `headJoint`, between the clavicle line (`clavicleY`, the shoulder joints' height) and the head joint. The neck girth is
 * the narrowest slice's convex hull perimeter (a taut tape); going down from it, the neck base is the last slice
 * within {@link NECK_SPREAD} of it before the shoulders widen the slice, and going up, the top is the last before the jaw.
 * A horizontal slice at the neck joint's height reads the trapezius and the clavicles as neck (Character Creator's
 * neck joint sits 7 cm above its shoulder joints): Wilbur measured 0.77 m that way against 0.38 m for a real neck.
 */
function neckFrame(
  neckJoint: V3,
  headJoint: V3,
  clavicleY: number,
  keep: (k: number) => boolean,
  pos: Float64Array,
  collect: (keep: (k: number) => boolean, axis: (k: number) => number, centre: Axis) => PartPoints,
): NeckFrame {
  let axis = sub(headJoint, neckJoint);
  axis = norm(axis) > 0.01 && axis[1] > 0.5 * norm(axis) ? scale(axis, 1 / norm(axis)) : [0, 1, 0];
  const across = sub([1, 0, 0], scale(axis, axis[0])),
    side = scale(across, 1 / (norm(across) || 1)),
    front = cross(side, axis),
    along = (k: number) => (pos[k * 3] - neckJoint[0]) * axis[0] + (pos[k * 3 + 1] - neckJoint[1]) * axis[1] + (pos[k * 3 + 2] - neckJoint[2]) * axis[2],
    tLo = Math.min(0, (clavicleY - neckJoint[1]) / axis[1]),
    tHi = Math.max(tLo + 0.04, dot3(sub(headJoint, neckJoint), axis)),
    line: Axis = { centre: (t) => add(neckJoint, scale(axis, t)), side: () => side, front: () => front },
    pts = collect((k) => keep(k) && along(k) > tLo - 0.05 && along(k) < tHi + 0.05, along, line);
  const ts: number[] = [],
    girths: number[] = [],
    cu: number[] = [],
    cv: number[] = [];
  for (let i = 0, t = tLo; t <= tHi + 1e-9; i++, t = tLo + i * NECK_STEP) {
    const i0 = lowerBound(pts.at, t - NECK_HALF),
      i1 = lowerBound(pts.at, t + NECK_HALF);
    ts.push(t);
    if (i1 - i0 < 6) {
      girths.push(NaN);
      cu.push(NaN);
      cv.push(NaN);
      continue;
    }
    const h = hull(pts.u.subarray(i0, i1), pts.v.subarray(i0, i1)),
      m = h.length / 2;
    let p = 0,
      u0 = Infinity,
      u1 = -Infinity,
      v0 = Infinity,
      v1 = -Infinity;
    for (let j = 0; j < m; j++) {
      const n = (j + 1) % m;
      p += Math.hypot(h[n * 2] - h[j * 2], h[n * 2 + 1] - h[j * 2 + 1]);
      u0 = Math.min(u0, h[j * 2]);
      u1 = Math.max(u1, h[j * 2]);
      v0 = Math.min(v0, h[j * 2 + 1]);
      v1 = Math.max(v1, h[j * 2 + 1]);
    }
    girths.push(p);
    cu.push((u0 + u1) / 2);
    cv.push((v0 + v1) / 2);
  }
  let low = -1;
  girths.forEach((g, i) => {
    if (g > 0 && (low < 0 || g < girths[low])) low = i;
  });
  if (low < 0) throw new RangeError('fitOutfit found no neck between the shoulder joints and the head joint; the body needs a neck under its head');
  let base = low,
    top = low;
  while (base > 0 && girths[base - 1] <= NECK_SPREAD * girths[low]) base--;
  while (top < ts.length - 1 && girths[top + 1] <= NECK_SPREAD * girths[low]) top++;
  const offsetAt = (a: number[], t: number) => {
    const f = Math.max(base, Math.min(top, (t - tLo) / NECK_STEP)),
      i = Math.min(top - 1, Math.floor(f));
    if (i < base) return a[base];
    const g = f - i;
    return a[i] * (1 - g) + a[i + 1] * g;
  };
  const centre = (t: number) => add(line.centre(t), add(scale(side, offsetAt(cu, t)), scale(front, offsetAt(cv, t))));
  return {
    axis,
    side,
    front,
    girth: girths[low],
    tBase: ts[base],
    tMin: ts[low],
    tTop: ts[top],
    centre,
    radii(t) {
      const du = offsetAt(cu, t),
        dv = offsetAt(cv, t);
      for (let half = NECK_HALF; half < 0.1; half += NECK_HALF) {
        const i0 = lowerBound(pts.at, t - half),
          i1 = lowerBound(pts.at, t + half);
        if (i1 - i0 < 6) continue;
        return hullRadii(hull(Float64Array.from(pts.u.subarray(i0, i1), (u) => u - du), Float64Array.from(pts.v.subarray(i0, i1), (v) => v - dv)));
      }
      return new Float64Array(R);
    },
  };
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot3 = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** The convex hull of 2D points (Andrew 1979), counter-clockwise, as flat x, y pairs. */
function hull(xs: ArrayLike<number>, ys: ArrayLike<number>, count = xs.length): number[] {
  const order = Array.from({ length: count }, (_, i) => i).sort((a, b) => xs[a] - xs[b] || ys[a] - ys[b]);
  if (count < 3) return order.flatMap((i) => [xs[i], ys[i]]);
  const turn = (o: number, a: number, b: number) => (xs[a] - xs[o]) * (ys[b] - ys[o]) - (ys[a] - ys[o]) * (xs[b] - xs[o]);
  const lower: number[] = [],
    upper: number[] = [];
  for (const i of order) {
    while (lower.length >= 2 && turn(lower[lower.length - 2], lower[lower.length - 1], i) <= 0) lower.pop();
    lower.push(i);
  }
  for (let j = order.length - 1; j >= 0; j--) {
    const i = order[j];
    while (upper.length >= 2 && turn(upper[upper.length - 2], upper[upper.length - 1], i) <= 0) upper.pop();
    upper.push(i);
  }
  return lower
    .slice(0, -1)
    .concat(upper.slice(0, -1))
    .flatMap((i) => [xs[i], ys[i]]);
}
/** Distance from the origin to the hull along each ring angle (the farthest crossing; the farthest point if none). */
function hullRadii(h: number[]): Float64Array {
  const out = new Float64Array(R),
    m = h.length / 2;
  for (let k = 0; k < R; k++) {
    const dx = COS[k],
      dy = SIN[k];
    let best = 0,
      support = 0;
    for (let i = 0; i < m; i++) {
      const ax = h[i * 2],
        ay = h[i * 2 + 1],
        bx = h[((i + 1) % m) * 2],
        by = h[((i + 1) % m) * 2 + 1],
        ex = bx - ax,
        ey = by - ay,
        den = dx * ey - dy * ex;
      support = Math.max(support, ax * dx + ay * dy);
      if (Math.abs(den) < 1e-15) continue;
      const t = (ax * ey - ay * ex) / den,
        s = (ax * dy - ay * dx) / den;
      if (t > 0 && s >= -1e-9 && s <= 1 + 1e-9) best = Math.max(best, t);
    }
    // The ray's crossing; a centre outside the hull (no crossing) takes the farthest point along the ray instead.
    out[k] = best > 0 ? best : support;
  }
  return out;
}
/**
 * A station's ring as radii round another centre `to` (in the station's plane, along its side and front): each ring
 * angle seen from `to` takes the ring's reach there, the farthest where the ring passes that angle more than once.
 * Moving only each radius by the
 * centre's shift along its own angle (the old way) slid every point sideways by the shift's other part, so a ring
 * re-centred a centimetre back read narrower at the front corners and a coat hung plumb that way bellied out over the
 * waist and came back in below it (dressed Wilbur, 2026-11-18).
 */
function recentre(s: { c: V3; side: V3; front: V3; r: Float64Array }, to: V3): Float64Array {
  const d = sub(s.c, to),
    dx = dot3(d, s.side),
    dz = dot3(d, s.front),
    angle = new Float64Array(R),
    reach = new Float64Array(R),
    out = new Float64Array(R),
    step = (2 * Math.PI) / R;
  for (let k = 0; k < R; k++) {
    const x = dx + s.r[k] * COS[k],
      z = dz + s.r[k] * SIN[k];
    angle[k] = Math.atan2(z, x);
    reach[k] = Math.hypot(x, z);
  }
  // Between two neighbouring points the radius runs linearly with the angle (as it does round the ring's own centre),
  // so a ring that does not move comes back unchanged, with no chord cut across each step.
  for (let j = 0; j < R; j++) {
    const a0 = angle[j],
      span = Math.atan2(Math.sin(angle[(j + 1) % R] - a0), Math.cos(angle[(j + 1) % R] - a0));
    if (Math.abs(span) < 1e-12) continue;
    for (let k = 0; k < R; k++) {
      const t = Math.atan2(Math.sin(k * step - a0), Math.cos(k * step - a0)) / span;
      if (t >= -1e-9 && t <= 1 + 1e-9) out[k] = Math.max(out[k], reach[j] + (reach[(j + 1) % R] - reach[j]) * t);
    }
  }
  return out;
}
/** A ring's perimeter from its radii. */
function perimeterOf(r: Float64Array | null): number {
  if (!r) return 0;
  let p = 0;
  for (let k = 0; k < R; k++) {
    const j = (k + 1) % R;
    p += Math.hypot(r[j] * COS[j] - r[k] * COS[k], r[j] * SIN[j] - r[k] * SIN[k]);
  }
  return p;
}
/** First index with at >= value. */
function lowerBound(a: Float64Array, value: number): number {
  let lo = 0,
    hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
/**
 * The part's body radius at `at` along each ring angle: the convex hull of its points within one ring spacing either
 * side, so the straight run of cloth between two rings stays outside every point between them. Null for no points.
 */
function profileOf(p: PartPoints, at: number, half = STEP): Float64Array | null {
  const i0 = lowerBound(p.at, at - half),
    i1 = lowerBound(p.at, at + half + 1e-12);
  if (i1 - i0 < 3) return null;
  return hullRadii(hull(p.u.subarray(i0, i1), p.v.subarray(i0, i1)));
}

// ---------------------------------------------------------------------------------------------------------------------
// Garments cut to the body.
// ---------------------------------------------------------------------------------------------------------------------

/** Options of {@link fitOutfit}: the {@link FIT_SETTINGS} rows. */
export interface FitOptions {
  /** Every garment's ease times this. Default 1. */
  readonly fit?: number;
  /** Metres added to every garment's ease over the body (covers the body's triangles and skinning). Default 0.003. */
  readonly ease?: number;
  /** Metres added between a garment and the garment under it. Default 0.002. */
  readonly layerGap?: number;
  /** Metres per body unit. Default from the body's height (metres, centimetres or millimetres). */
  readonly unit?: number;
}
/** What each triangle of a fitted garment is, for checks: its outer face, inner face, a hem band, or trim. */
export const FACE = { outer: 0, inner: 1, band: 2, trim: 3 } as const;
/** A garment cut to a body and skinned to its bones. Positions and normals are in the body's space. */
export interface FittedGarment {
  readonly spec: GarmentSpec;
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly uvs: Float32Array;
  readonly indices: Uint32Array;
  /** Four body bone indices a vertex. */
  readonly joints: Uint16Array;
  /** Four weights a vertex, summing to 1. */
  readonly weights: Float32Array;
  /** {@link FACE} of each triangle. */
  readonly faces: Uint8Array;
  /**
   * 1 for a vertex at a seam where a sleeve or a leg joins its trunk tube (the armscye and the crotch): there the two
   * tubes of one outfit cross by design, inside the sleeve or under the seat, as a sewn seam joins them.
   */
  readonly seams: Uint8Array;
  /** The body part each vertex covers: 0 trunk, 1 head, 2 and 3 the left and right arm, 6 and 7 the left and right leg. */
  readonly parts: Uint8Array;
  /** Share of vertices whose weights were matched on the body; the rest were inpainted. */
  readonly matched: number;
  /** Cloth thickness, metres. */
  readonly thickness: number;
}
/** {@link fitOutfit}'s result. */
export interface FittedOutfit {
  readonly outfit: Outfit;
  /** The body's rest pose, from its upper arms: T (above 65 degrees from hanging), A (20 to 65) or arms down. */
  readonly pose: RestPose;
  /** The upper arms' angle from hanging straight down, radians. */
  readonly armAngle: number;
  /** Metres per body unit. */
  readonly unit: number;
  /** The body's measurements as the cast kit names them, metres. */
  readonly measures: CastBody;
  readonly garments: readonly FittedGarment[];
}
interface Station {
  at: number;
  c: V3;
  side: V3;
  front: V3;
  /** Inner radius of the cloth per ring angle. */
  r: Float64Array;
  /** The body's radius under it per ring angle: where the ring's skin weights are read. */
  b: Float64Array;
  /**
   * A row that is no horizontal ring (over the shoulders): per ring angle the inner face's point, the way the cloth's
   * thickness runs and the body point under it. Such a row is no floor for later layers.
   */
  pts?: V3[];
  dirs?: V3[];
  anchors?: V3[];
  /** Per ring angle, 1 where the row lies at a seam (in place of the tube's seam zone). */
  seamK?: Uint8Array;
  /** A hung row's own radius before it hung: the room a fold may take back between it and `r`. */
  need?: Float64Array;
}
interface Ring {
  part: string;
  at: number;
  /** The ring's centre: radii of rings at other places are moved to this ring's centre before they are compared. */
  c: V3;
  inner: Float64Array;
  outer: Float64Array;
}
class Mesh {
  p: number[] = [];
  n: number[] = [];
  uv: number[] = [];
  ix: number[] = [];
  face: number[] = [];
  seam: number[] = [];
  part: number[] = [];
  /** Where each vertex reads its skin weights: the body point under it on its ring (every layer reads the same one). */
  anchor: number[] = [];
  /**
   * 1 where a vertex takes its skin weights at its anchor on the body (the rows over the shoulders, where the cloth
   * spans the trunk, the deltoid and the neck), 0 where it reads its part's lattice.
   */
  direct: number[] = [];
  /** The body part the next vertices cover (TRUNK, HEAD, ARM + side, LEG + side). */
  current = TRUNK;
  /** Whether the next vertices take their weights at their anchors. */
  anchored = false;
  vert(p: V3, n: V3, u: number, v: number, seam = 0, anchor: V3 = p) {
    this.part.push(this.current);
    this.direct.push(this.anchored ? 1 : 0);
    this.anchor.push(anchor[0], anchor[1], anchor[2]);
    this.p.push(p[0], p[1], p[2]);
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    this.n.push(n[0] / l, n[1] / l, n[2] / l);
    this.uv.push(u, v);
    this.seam.push(seam);
    return this.p.length / 3 - 1;
  }
  /** A triangle wound to face its vertices' normals. */
  tri(a: number, b: number, c: number, face: number) {
    const P = this.p,
      e1: V3 = [P[b * 3] - P[a * 3], P[b * 3 + 1] - P[a * 3 + 1], P[b * 3 + 2] - P[a * 3 + 2]],
      e2: V3 = [P[c * 3] - P[a * 3], P[c * 3 + 1] - P[a * 3 + 1], P[c * 3 + 2] - P[a * 3 + 2]],
      g = cross(e1, e2),
      N = this.n,
      m: V3 = [N[a * 3] + N[b * 3] + N[c * 3], N[a * 3 + 1] + N[b * 3 + 1] + N[c * 3 + 1], N[a * 3 + 2] + N[b * 3 + 2] + N[c * 3 + 2]];
    if (dot3(g, m) < 0) this.ix.push(a, c, b);
    else this.ix.push(a, b, c);
    this.face.push(face);
  }
}
const SEAM_DIP = 0.0008;

/** A column of a top this far round from the centre front or back (|cos| of its angle from the side above this) is at the armscye. */
const ARMSCYE = 0.5;
/** Where a sleeve's first ring sits along the arm from the shoulder joint, metres (just inside the joint). */
const SLEEVE_START = -0.02;
/**
 * How much further in each sleeve starts than the sleeve beneath it, metres (a sleeve's ring spacing): a coat's sleeve
 * set in at the same place as the shirt's left the shirt sleeve's raw top edge level with the coat's, standing above
 * the coat's yoke over the shoulder point, a white sliver at the shoulder seam (dressed Wilbur, 2026-11-18).
 */
const SLEEVE_LAP = 0.012;
/** Rows over the shoulders, from under the arms to the neck base. */
const YOKE_ROWS = 12;
/** A V neckline meets the neck base this far round from the centre front, radians: the gorge, where collar and lapel meet. */
const GORGE = (70 * Math.PI) / 180;
/**
 * The turn of a lapel, metres. A lapel is the coat's forepart folded back along the roll line from the top button to the
 * gorge (S. S. Gordon 1895, the sack coat draft; F. T. Croonborg, "The Blue Book of Men's Tailoring", 1907): at the break
 * it lies flat, toward the gorge it rolls over the collar stand and stands off the chest, its folded edge two cloth
 * layers thick. `roll` is that stand-off at the gorge, falling to the lapel's outer edge (an estimate: two cloth layers
 * and the canvas over a 1 1/4 inch stand); `point` how far the lapel's top edge falls outward per unit across, so the
 * lapel's point sits under the collar's end and leaves the notch between them.
 */
const LAPEL = { roll: 0.011, point: 0.3 } as const;
/**
 * A wing collar's fronts (`GarmentSpec.points`): they meet at the stud at the base and part toward the top, half the
 * gap at the top this share of the points' length; each top corner is turned down and out on the diagonal, its tip
 * standing `stand` off the collar (an estimate: a starched point springs off the band).
 */
const POINTS = { gap: 0.4, stand: 0.002 } as const;
/**
 * A necktie, metres. The four-in-hand knot (T. Fink and Y. Mao, "Designing tie knots by random walks", Nature 398,
 * 31-32, 1999, https://doi.org/10.1038/18122: the sequence Li Ro Li Co T, the smallest knot, a tapered wedge wider at
 * the top) sits at the collar's front over the stud, its back `gap` off the collar (clear of the turned points); the
 * blade leaves it `bladeTop` wide, widens to `blade` over `flare` down the shirt and ends `end` above the waist under
 * the waistcoat. A bow spans `bowSpan` with wings `bowHeight` tall. The widths are estimates in proportion to a 2 1/4
 * inch collar, as the Wright brothers' ties read in the Library of Congress photographs of 1903 to 1910.
 */
const TIE = {
  gap: 0.0025,
  knotTop: 0.034,
  knotBottom: 0.022,
  depthTop: 0.015,
  depthBottom: 0.009,
  bladeTop: 0.024,
  blade: 0.052,
  flare: 0.2,
  end: 0.04,
  bowSpan: 0.1,
  bowHeight: 0.04,
} as const;
/** An earlier layer holds an outer garment off the body this far past its own hem or top, metres: cloth drapes over a hem. */
const OVERHANG = 2 * STEP;
/** The widest ring spacing of any tube (sleeves, 3 cm): a ring clears the cloth beneath within this of it. */
const FLOOR_REACH = 0.03;
/**
 * Trouser proportions from S. S. Gordon, "The American Coat, Vest and Trousers System" (John J. Mitchell, New York 1895),
 * diagram XXXIII: a 37 inch seat cut to a 19 inch knee and an 18 inch bottom (finished widths). The knee is that share
 * of the seat; the bottom one inch under the knee.
 */
const TROUSER_KNEE = 19 / 37,
  TROUSER_TAPER = 0.0254;

/**
 * Drape and folds, metres: the outer garment of each part stands out in soft folds where real cloth has length or
 * girth to spare (D. Rohmer, T. Popa, M.-P. Cani, S. Hahmann and A. Sheffer, "Animation Wrinkling: Augmenting Coarse
 * Cloth Simulations with Realistic-Looking Wrinkles", ACM TOG 29(6), SIGGRAPH Asia 2010, https://doi.org/10.1145/1882261.1866183: folds run across the direction
 * the cloth is compressed, their height from the spare length). A sack coat hangs plumb wider than the body below the
 * chest, so its spare girth falls in vertical flutes at the back and sides (the front panels lie flat on their
 * canvas); trousers longer than the leg break in rings over the boot and crease across the back of the knee; a sleeve
 * creases across the inside of the elbow and gathers over the cuff. The folds are cut into the cloth at rest and move
 * with the skin. Sized for the screen: a soft fold's steepest slope is pi x height / spacing, about 30 degrees for the
 * creases and the break and 15 for the flutes here; at half these heights the dressed Wilbur frames of 2026-11-18
 * showed no fold at all at a medium shot.
 */
const FOLD = {
  /** Vertical flutes round a sack coat below the chest: how many round the body (odd, so one falls on the back seam). */
  flutes: 7,
  flute: 0.018,
  /** How far round from the front (radians) the flutes begin: the canvassed front panels lie flat. */
  fluteFrom: 1.0,
  /** Trouser break over the boot: crest height, spacing, and how far up from the hem it reaches. */
  break: 0.01,
  breakPeriod: 0.05,
  breakReach: 0.13,
  /** Creases across the inside of the elbow and the back of the knee: height, spacing, reach either side of the joint. */
  crease: 0.007,
  creasePeriod: 0.04,
  creaseReach: 0.08,
  /** A sleeve gathering over the cuff: height, spacing, reach up from the cuff. */
  cuff: 0.005,
  cuffPeriod: 0.03,
  cuffReach: 0.08,
} as const;
/** A soft fold's profile along `x`: 0 in the trough, 1 on the crest, `period` apart. */
const crest = (x: number, period: number) => 0.5 - 0.5 * Math.cos((2 * Math.PI * x) / period);
/** A window 1 at `c` falling to 0 at `w` either side. */
const near = (x: number, c: number, w: number) => Math.max(0, 1 - ((x - c) / w) ** 2);
const smoothstep = (e0: number, e1: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
/** Where `s` falls along a polyline of cumulative lengths: the segment and the share of it. */
function locate(lengths: readonly number[], s: number): [number, number] {
  if (lengths.length < 2) return [0, 0];
  let i = 0;
  while (i < lengths.length - 2 && lengths[i + 1] < s) i++;
  const span = lengths[i + 1] - lengths[i];
  return [i, span > 0 ? Math.max(0, Math.min(1, (s - lengths[i]) / span)) : 1];
}
function lerp2(line: readonly (readonly [number, number])[], i: number, f: number): [number, number] {
  const p = line[i],
    q = line[Math.min(line.length - 1, i + 1)];
  return [p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f];
}
/** The angle of ring angle `k` from the centre front, radians, 0 to pi. */
function fromFront(k: number): number {
  const x = (2 * Math.PI * k) / R - Math.PI / 2;
  return Math.abs(((((x % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI)) - Math.PI));
}
/** The height of a station's inner face at ring angle `k`. */
function rowY(s: Station, k: number): number {
  return s.pts ? s.pts[k][1] : s.c[1] + (s.side[1] * COS[k] + s.front[1] * SIN[k]) * s.r[k];
}
/**
 * Closest points on a tube's outer face, lifted along its normal: where lapels, a collar fall, buttons and a tie lie.
 * Each also carries where the cloth under it reads its skin weights (its anchor, and whether it takes them there), so
 * what lies on the cloth moves with it, not with the lattice under a yoke row.
 */
function surfaceOf(mesh: Mesh, from: number, to: number) {
  const list = Uint32Array.from({ length: to - from }, (_, i) => from + i),
    grid = new TriangleGrid(mesh.p, mesh.ix, list, 0.03),
    bary = new Float64Array(3);
  return (q: V3, lift: number): { p: V3; n: V3; anchor: V3; direct: boolean } => {
    const hit = grid.closest(q, 0.15, bary);
    if (hit.tri < 0) return { p: q, n: [0, 0, 1], anchor: q, direct: false };
    const p: V3 = [0, 0, 0],
      n: V3 = [0, 0, 0],
      anchor: V3 = [0, 0, 0];
    let direct = 0;
    for (let c = 0; c < 3; c++) {
      const v = mesh.ix[hit.tri * 3 + c];
      direct += mesh.direct[v] * bary[c];
      for (let d = 0; d < 3; d++) {
        p[d] += mesh.p[v * 3 + d] * bary[c];
        n[d] += mesh.n[v * 3 + d] * bary[c];
        anchor[d] += mesh.anchor[v * 3 + d] * bary[c];
      }
    }
    const nn = scale(n, 1 / (norm(n) || 1));
    return { p: add(p, scale(nn, lift)), n: nn, anchor, direct: direct >= 0.5 };
  };
}

function fitGarments(a: Analysis, outfit: Outfit, o: Required<Omit<FitOptions, 'unit'>>) {
  const H = a.heights,
    N = a.neck,
    rings: (Ring & { garment: number })[] = [],
    collars: { ts: number[]; outer: Float64Array[] }[] = [],
    out: { spec: GarmentSpec; mesh: Mesh; offset: number }[] = [],
    sorted = [...outfit.garments].sort((x, y) => x.layer - y.layer),
    // The outer garment of the arms and of the legs: only it shows its folds.
    lastTop = sorted.reduce((m, g, i) => (g.cut === 'top' && (g.sleeves ?? 0) > 0 ? i : m), -1),
    lastLegs = sorted.reduce((m, g, i) => (g.cut === 'legs' || g.cut === 'skirt' ? i : m), -1);
  const body = (part: string, at: number) => {
    const pts = a.points[part];
    let r = profileOf(pts, at);
    for (let reach = STEP; !r && reach < 0.3; reach += STEP) r = profileOf(pts, at, reach + STEP);
    return r ?? new Float64Array(R);
  };
  const cache = new Map<string, Float64Array>();
  const bodyAt = (part: string, at: number) => {
    const key = `${part}:${at.toFixed(5)}`;
    let r = cache.get(key);
    if (!r) cache.set(key, (r = body(part, at)));
    return r;
  };
  /**
   * The outer face of earlier garments on `part` at `at`, per ring angle (0 where none reaches). A ring at another place
   * has its own centre (the trunk's centre line moves a few centimetres forward and back down the body): its radii are
   * moved to this place's centre along each ring angle first, or a ring centred further forward reads as wider here.
   */
  const floor = (part: string, at: number) => {
    const most = new Float64Array(R),
      ax = a.axes[part],
      here = ax.centre(at),
      side = ax.side(at),
      front = ax.front(at),
      moved = (g: Ring, k: number) => (g.outer[k] > 0 ? g.outer[k] + dot3(sub(g.c, here), add(scale(side, COS[k]), scale(front, SIN[k]))) : 0);
    const byGarment = new Map<number, Ring[]>();
    rings.forEach((g) => {
      if (g.part === part) (byGarment.get(g.garment) ?? byGarment.set(g.garment, []).get(g.garment)!).push(g);
    });
    for (const list of byGarment.values()) {
      list.sort((x, y) => x.at - y.at);
      if (at < list[0].at - OVERHANG || at > list[list.length - 1].at + OVERHANG) continue;
      let i = 0;
      while (i < list.length - 1 && list[i].at < at) i++;
      const A = list[Math.max(0, i - 1)],
        B = list[i],
        f = B.at > A.at ? Math.max(0, Math.min(1, (at - A.at) / (B.at - A.at))) : 1;
      for (let k = 0; k < R; k++) most[k] = Math.max(most[k], moved(A, k) + (moved(B, k) - moved(A, k)) * f);
      // A straight run of cloth between two of this garment's rings (at most a ring spacing apart) clears the rings of
      // the cloth beneath within that spacing too, not only where the two tubes' rings meet: a boot's toe ring.
      for (const g of list) if (Math.abs(g.at - at) <= FLOOR_REACH) for (let k = 0; k < R; k++) most[k] = Math.max(most[k], moved(g, k));
    }
    return most;
  };
  /** The outer face of earlier collars and necklines at `t` along the neck, per ring angle. */
  const neckFloor = (t: number) => {
    const most = new Float64Array(R);
    for (const c of collars) {
      if (t < c.ts[0] - NECK_STEP || t > c.ts[c.ts.length - 1] + NECK_STEP) continue;
      let i = 0;
      while (i < c.ts.length - 1 && c.ts[i] < t) i++;
      const i0 = Math.max(0, i - 1),
        f = c.ts[i] > c.ts[i0] ? Math.max(0, Math.min(1, (t - c.ts[i0]) / (c.ts[i] - c.ts[i0]))) : 1;
      for (let k = 0; k < R; k++) most[k] = Math.max(most[k], c.outer[i0][k] + (c.outer[i][k] - c.outer[i0][k]) * f);
    }
    return most;
  };
  const station = (part: string, at: number, r: Float64Array): Station => {
    const ax = a.axes[part];
    return { at, c: ax.centre(at), side: ax.side(at), front: ax.front(at), r, b: bodyAt(part, part === 'head' ? Math.min(at, a.heights.stature) : Math.max(at, 0)) };
  };
  const span = (from: number, to: number, step = STEP) => {
    const rows = Math.max(2, Math.ceil(Math.abs(to - from) / step) + 1);
    return Array.from({ length: rows }, (_, i) => from + ((to - from) * i) / (rows - 1));
  };
  // Below the crotch the cloth hangs around both legs and what they wear: the hull of the trunk's ring and both legs'.
  // With `clothed` each leg's ring is the cloth already on it at that height (trousers stand close at the thigh and wide
  // at the knee; the most any of it stands off the leg, applied all the way round, once made a coat's hem a barrel).
  const aroundLegs = (y: number, trunkR: Float64Array, legOut: number, clothed = false) => {
    const c = a.axes.trunk.centre(y),
      xs: number[] = [],
      zs: number[] = [];
    for (let k = 0; k < R; k++) {
      xs.push(trunkR[k] * COS[k]);
      zs.push(trunkR[k] * SIN[k]);
    }
    for (const leg of ['legL', 'legR']) {
      const lc = a.axes[leg].centre(y),
        f = clothed ? floor(leg, y) : null,
        r = f ? bodyAt(leg, y).map((x, k) => Math.max(x, f[k])) : bodyAt(leg, y);
      for (let k = 0; k < R; k++) {
        xs.push(lc[0] - c[0] + (r[k] + legOut) * COS[k]);
        zs.push(lc[2] - c[2] + (r[k] + legOut) * SIN[k]);
      }
    }
    return hullRadii(hull(xs, zs));
  };
  const addOffset = (r: Float64Array, d: number) => r.map((x) => x + d);
  // A coat hangs from the chest blade and the seat and bridges the hollow of the waist between, as a sack coat cut
  // without a waist seam does: each column takes the upper convex envelope of its radii down the trunk. Below the chest
  // it then falls plumb: no column comes back in toward the hem (the sack coat's "straight hanging" front and side
  // seams, Gordon 1895), so the hem is never narrower than the chest and nothing bellies out and in again over the
  // waist. Both run on every row's ring re-centred on one straight centre line (each row's own centre moves with the
  // trunk's centre line), then each ring goes back to its own centre once. The coat hangs from the body as it stands
  // with the arms down: each row's ring comes in by as much as the trunk's ring there does when the arms are lowered
  // (the armpit's flesh of an A or T rest pose), so the chest it hangs from is the worn chest; each row still clears
  // its own ring at rest. A row's ring rests on the layers beneath, and each of them clears the body's rings up to a
  // floor reach either side of its own, so the flesh it carries can come from that far up or down for every layer:
  // the row comes in by the most the body's ring does within that reach.
  const hang = (st: Station[]): Station[] => {
    const ys = st.map((s) => s.at),
      ref = st[st.length - 1].c,
      // Each row's ring round one centre line (the top row's, straight down): the envelope of radii taken round centres
      // that wander forward and back would bulge where the centre sits forward.
      at = st.map((s): V3 => [ref[0], s.c[1], ref[2]]),
      layers = new Set(rings.filter((g) => g.part === 'trunk').map((g) => g.garment)).size,
      reach = STEP + layers * FLOOR_REACH,
      lowers = span(ys[0] - reach, ys[ys.length - 1] + reach, STEP / 2).map((y) => {
        const rest = bodyAt('trunk', y),
          down = bodyAt('trunkDown', y);
        return { y, by: rest.map((x, k) => Math.max(0, x - down[k])) };
      }),
      e = st.map((s, i) => {
        const by = new Float64Array(R);
        for (const l of lowers) if (Math.abs(l.y - s.at) <= reach) for (let k = 0; k < R; k++) by[k] = Math.max(by[k], l.by[k]);
        return recentre({ ...s, r: s.r.map((x, k) => x - by[k]) }, at[i]);
      }),
      res = st.map((s) => ({ ...s, r: s.r.slice(), need: s.r.slice() })),
      hung = st.map(() => new Float64Array(R));
    let top = 0;
    while (top < st.length - 1 && st[top + 1].at <= H.chest) top++;
    for (let k = 0; k < R; k++) {
      const up: number[] = [];
      for (let i = 0; i < st.length; i++) {
        while (up.length >= 2) {
          const p = up[up.length - 2],
            q = up[up.length - 1];
          if ((ys[q] - ys[p]) * (e[i][k] - e[p][k]) - (e[q][k] - e[p][k]) * (ys[i] - ys[p]) >= 0) up.pop();
          else break;
        }
        up.push(i);
      }
      for (let u = 0; u + 1 < up.length; u++)
        for (let i = up[u]; i <= up[u + 1]; i++) {
          const f = (ys[i] - ys[up[u]]) / (ys[up[u + 1]] - ys[up[u]] || 1);
          hung[i][k] = e[up[u]][k] + (e[up[u + 1]][k] - e[up[u]][k]) * f;
        }
      // Plumb below the chest, in the same frame (one centre line, so a column is one vertical half plane).
      for (let i = top - 1; i >= 0; i--) hung[i][k] = Math.max(hung[i][k], hung[i + 1][k]);
    }
    res.forEach((s, i) => {
      const back = recentre({ ...s, c: at[i], r: hung[i] }, s.c);
      for (let k = 0; k < R; k++) s.r[k] = Math.max(s.r[k], back[k]);
    });
    return res;
  };
  // Over the shoulders. A tailor drafts the shoulder seam from the side neck point down to the shoulder point and the
  // neck gorge round the neck base (Gordon 1895, the sack coat draft); cloth under tension there bridges the hollows as
  // a tape does. So each column of a top runs from its ring under the arms up the convex hull of the body in its own
  // vertical plane (the trunk's points within a ring step either side) to the neck base ring, the cloth standing off
  // that outline by its ease (along the outline's normal: up on the shoulder, out on the chest).
  const yokeY = H.axilla - 0.02,
    c0 = a.axes.trunk.centre(yokeY),
    shoulderRing = bodyAt('trunk', yokeY),
    baseCentre = N.centre(N.tBase),
    baseRadii = N.radii(N.tBase),
    neckDir = (k: number): V3 => add(scale(N.side, COS[k]), scale(N.front, SIN[k])),
    meridian = (k: number, rho: number, y: number): V3 => [c0[0] + COS[k] * rho, y, c0[2] + SIN[k] * rho];
  const meridianChains = () => {
    // The trunk's points above the yoke's start, binned by ring angle: a column reads its own bin and both neighbours.
    const bins: number[][] = Array.from({ length: R }, () => []);
    // The shoulder point (the deltoid's cap) weighs to the arm, but the shoulder seam runs out to it: an arm's points
    // short of its sleeve's first ring belong to the yoke, or the cloth leaves a hole between the yoke and the sleeve.
    const capped = (v: number) => {
      const s = a.seg[v] - ARM;
      return (s === 0 || s === 1) && a.axes[s ? 'armR' : 'armL'].project!(a.pos, v * 3) < SLEEVE_START;
    };
    for (let v = 0; v < a.seg.length; v++)
      if ((a.seg[v] === TRUNK || capped(v)) && a.pos[v * 3 + 1] > yokeY) {
        const dx = a.pos[v * 3] - c0[0],
          dz = a.pos[v * 3 + 2] - c0[2],
          bin = Math.round((Math.atan2(dz, dx) / (2 * Math.PI)) * R);
        for (const b of [bin - 1, bin, bin + 1]) bins[(((b % R) + R) % R)].push(dx, dz, a.pos[v * 3 + 1]);
      }
    const wedge = Math.tan((2 * Math.PI) / R);
    return Array.from({ length: R }, (_, k) => {
      const ps = bins[k],
        end = add(baseCentre, scale(neckDir(k), baseRadii[k])),
        rhoE = (end[0] - c0[0]) * COS[k] + (end[2] - c0[2]) * SIN[k],
        yE = end[1],
        rhoS = shoulderRing[k],
        xs = [0, rhoS, rhoE, 0],
        ys = [yokeY, yokeY, yE, yE];
      for (let i = 0; i < ps.length; i += 3) {
        const rho = ps[i] * COS[k] + ps[i + 1] * SIN[k],
          across = -ps[i] * SIN[k] + ps[i + 1] * COS[k];
        if (rho > 0 && Math.abs(across) <= rho * wedge && ps[i + 2] < yE - 1e-6) {
          xs.push(rho);
          ys.push(ps[i + 2]);
        }
      }
      const h = yE > yokeY + 0.01 ? hull(xs, ys) : [],
        m = h.length / 2;
      let iS = -1,
        iE = -1;
      for (let i = 0; i < m; i++) {
        if (h[i * 2] === rhoS && h[i * 2 + 1] === yokeY) iS = i;
        if (h[i * 2] === rhoE && h[i * 2 + 1] === yE) iE = i;
      }
      const chain: [number, number][] = [];
      if (iS < 0 || iE < 0) chain.push([rhoS, yokeY], [rhoE, Math.max(yE, yokeY + 0.01)]);
      else
        for (let i = iS, guard = 0; guard <= m; i = (i + 1) % m, guard++) {
          chain.push([h[i * 2], h[i * 2 + 1]]);
          if (i === iE) break;
        }
      const arc = [0];
      for (let i = 1; i < chain.length; i++) arc.push(arc[i - 1] + Math.hypot(chain[i][0] - chain[i - 1][0], chain[i][1] - chain[i - 1][1]));
      return { chain, arc };
    });
  };
  let chains: ReturnType<typeof meridianChains> | undefined;
  /** The rows over the shoulders from the ring `top` under the arms to the neck ring `neckR` (radii round the base centre). */
  const yokeRows = (top: Station, neckR: Float64Array): Station[] => {
    const ch = (chains ??= meridianChains()),
      rows: Station[] = Array.from({ length: YOKE_ROWS }, () => ({ at: NaN, c: top.c, side: top.side, front: top.front, r: new Float64Array(R), b: new Float64Array(R), pts: [], dirs: [], anchors: [], seamK: new Uint8Array(R) }));
    const edge = (p: [number, number], q: [number, number]): [number, number] => {
      const dx = q[0] - p[0],
        dy = q[1] - p[1],
        l = Math.hypot(dx, dy) || 1;
      return [dy / l, -dx / l];
    };
    for (let k = 0; k < R; k++) {
      const { chain, arc } = ch[k],
        total = arc[arc.length - 1] || 1,
        offS = top.r[k] - shoulderRing[k],
        offE = neckR[k] - baseRadii[k],
        cloth: [number, number][] = [],
        normal: [number, number][] = [];
      chain.forEach((p, i) => {
        const before = i > 0 ? edge(chain[i - 1], p) : [1, 0],
          after = i < chain.length - 1 ? edge(p, chain[i + 1]) : [1, 0],
          l = Math.hypot(before[0] + after[0], before[1] + after[1]) || 1,
          nx = (before[0] + after[0]) / l,
          ny = (before[1] + after[1]) / l,
          off = offS + (offE - offS) * (arc[i] / total);
        cloth.push([p[0] + nx * off, p[1] + ny * off]);
        normal.push([nx, ny]);
      });
      const clothArc = [0];
      for (let i = 1; i < cloth.length; i++) clothArc.push(clothArc[i - 1] + Math.hypot(cloth[i][0] - cloth[i - 1][0], cloth[i][1] - cloth[i - 1][1]));
      // The chain lies in the column's plane; the neck ring is round the neck's own centre: bend into it toward the top.
      const last = cloth[cloth.length - 1],
        lastBody = chain[chain.length - 1],
        fixCloth = sub(add(baseCentre, scale(neckDir(k), neckR[k])), meridian(k, last[0], last[1])),
        fixBody = sub(add(baseCentre, scale(neckDir(k), baseRadii[k])), meridian(k, lastBody[0], lastBody[1]));
      for (let j = 1; j <= YOKE_ROWS; j++) {
        const f = j / YOKE_ROWS,
          [ci, cf] = locate(clothArc, f * clothArc[clothArc.length - 1]),
          [bi, bf] = locate(arc, f * total),
          p = lerp2(cloth, ci, cf),
          q = lerp2(chain, bi, bf),
          nn = lerp2(normal, ci, cf),
          row = rows[j - 1],
          d: V3 = [COS[k] * nn[0], nn[1], SIN[k] * nn[0]];
        row.pts!.push(add(meridian(k, p[0], p[1]), scale(fixCloth, f * f)));
        row.anchors!.push(add(meridian(k, q[0], q[1]), scale(fixBody, f * f)));
        row.dirs!.push(scale(d, 1 / (norm(d) || 1)));
        row.seamK![k] = Math.abs(COS[k]) > ARMSCYE ? 1 : 0;
      }
    }
    return rows;
  };
  /**
   * The neckline and collar of a top round the neck, from the neck base up `height` (no higher than the jaw): each ring
   * clears the neck above it (a stiff collar does not follow the neck in) by `ease`, or the collar under it by the gap.
   */
  const neckRings = (height: number, ease: number) => {
    const tEnd = Math.min(N.tBase + Math.max(0, height), N.tTop),
      count = Math.max(0, Math.ceil((tEnd - N.tBase) / 0.01 - 1e-9)),
      ts = Array.from({ length: count + 1 }, (_, i) => N.tBase + ((tEnd - N.tBase) * i) / Math.max(1, count)),
      raw = ts.map((t, i) => (i === 0 ? baseRadii : N.radii(t))),
      reach = raw.map((r) => r.slice());
    for (let i = ts.length - 2; i >= 0; i--) for (let k = 0; k < R; k++) reach[i][k] = Math.max(reach[i][k], reach[i + 1][k]);
    const inner = ts.map((t, i) => {
      const f = neckFloor(t);
      return reach[i].map((x, k) => Math.max(x + ease, f[k] > 0 ? f[k] + o.layerGap : 0));
    });
    return { ts, raw, inner };
  };
  /**
   * A point on a collar's whole (uncut) face `lift` off its inner face, `h` up the neck from its base (below the base: on
   * down the neck's axis) and `phi` round (radians from the body's left, PI/2 the centre front).
   */
  const collarPoint = (c: ReturnType<typeof neckRings>, h: number, phi: number, lift: number): V3 => {
    const t = N.tBase + Math.max(0, h),
      last = c.ts.length - 1;
    let i = 0;
    while (i < last - 1 && c.ts[i + 1] < t) i++;
    const j = Math.min(last, i + 1),
      f = c.ts[j] > c.ts[i] ? Math.max(0, Math.min(1, (t - c.ts[i]) / (c.ts[j] - c.ts[i]))) : 0,
      x = ((((phi / (2 * Math.PI)) * R) % R) + R) % R,
      k0 = Math.floor(x) % R,
      k1 = (k0 + 1) % R,
      g = x - Math.floor(x),
      at = (row: Float64Array) => row[k0] + (row[k1] - row[k0]) * g,
      radius = at(c.inner[i]) + (at(c.inner[j]) - at(c.inner[i])) * f,
      d = add(scale(N.side, Math.cos(phi)), scale(N.front, Math.sin(phi)));
    return add(add(N.centre(t), scale(N.axis, Math.min(0, h))), scale(d, radius + lift));
  };
  /** The shirt under a tie: its collar, cloth thickness and outer face, from the first top with a standing collar. */
  let shirt: { collar: ReturnType<typeof neckRings>; th: number; height: number; points: number; onCloth: ReturnType<typeof surfaceOf> } | undefined;
  /** A small mesh's normals from its own triangles, each turned to face `out` (per vertex). */
  const ownNormals = (mesh: Mesh, verts: number[], tris: number[][], out: (v: number) => V3) => {
    const acc = new Map<number, V3>(verts.map((v) => [v, [0, 0, 0]]));
    const P = (v: number): V3 => [mesh.p[v * 3], mesh.p[v * 3 + 1], mesh.p[v * 3 + 2]];
    for (const [a, b, c] of tris) {
      let n = cross(sub(P(b), P(a)), sub(P(c), P(a)));
      if (dot3(n, out(a)) < 0) n = scale(n, -1);
      for (const v of [a, b, c]) acc.set(v, add(acc.get(v)!, n));
    }
    for (const [v, n] of acc) {
      const l = norm(n) || 1,
        u = norm(n) > 1e-12 ? scale(n, 1 / l) : out(v);
      mesh.n[v * 3] = u[0];
      mesh.n[v * 3 + 1] = u[1];
      mesh.n[v * 3 + 2] = u[2];
    }
  };
  /** A V neckline: each column within the gorge of the centre front ends on the line from the break up to the neck base. */
  const neckline = (stations: Station[], opening: number, neckRow: number) => {
    const neckFront = add(baseCentre, scale(N.front, baseRadii[R / 4]))[1],
      yBreak = neckFront - opening * (neckFront - H.waist),
      cut = new Float64Array(R).fill(Infinity);
    for (let k = 0; k < R; k++) {
      const off = fromFront(k);
      if (off >= GORGE) continue;
      const ys = stations.map((s) => rowY(s, k)),
        yV = yBreak + (ys[neckRow] - yBreak) * (off / GORGE);
      let j = 0;
      while (j < ys.length && ys[j] < yV) j++;
      cut[k] = j === 0 ? 0 : j >= ys.length ? ys.length - 1 : j - 1 + (yV - ys[j - 1]) / Math.max(ys[j] - ys[j - 1], 1e-9);
    }
    return { cut, yBreak };
  };
  sorted.forEach((spec, garment) => {
    const mesh = new Mesh(),
      // Ease over the body (the cloth touching the skin, its triangles and its skinning) and ease over the layer beneath:
      // a tailor's measures are taken over the garment beneath (Gordon 1895: the breast "fairly close over the vest"),
      // so each layer stands its own ease off what it covers, not off every ease below it added up.
      layerEase = spec.ease * o.fit,
      ease = layerEase + o.ease,
      offset = ease,
      th = spec.thickness,
      cut = spec.cut;
    const PART: Record<string, number> = { trunk: TRUNK, head: HEAD, armL: ARM, armR: ARM + 1, legL: LEG, legR: LEG + 1 };
    // Every ring rests on the cloth already there: its inner face sits its ease outside their outer face.
    const settle = (partName: string, given: Station[]) =>
      given.map((s) => {
        if (s.pts || !Number.isFinite(s.at)) return s;
        const f = floor(partName, s.at);
        return { ...s, r: s.r.map((x, k) => Math.max(x, f[k] > 0 ? f[k] + layerEase + o.layerGap : 0)) };
      });
    const tube = (
      partName: string,
      given: Station[],
      seamKs: number[],
      seamZone: (s: Station) => boolean,
      close?: 'bottom' | 'top',
      cutAt?: Float64Array,
      drape?: (s: Station, k: number) => number,
    ) => {
      mesh.current = PART[partName];
      const stations = settle(partName, given),
        rows = stations.length,
        cols = R + 1,
        inner: V3[][] = [],
        outer: V3[][] = [],
        anchor: V3[][] = [],
        radial: V3[][] = [];
      for (const s of stations) {
        const ri: V3[] = [],
          ro: V3[] = [],
          ra: V3[] = [],
          rd: V3[] = [];
        for (let k = 0; k < R; k++) {
          const d = s.dirs ? s.dirs[k] : add(scale(s.side, COS[k]), scale(s.front, SIN[k])),
            dip = seamKs.includes(k) ? SEAM_DIP : 0;
          if (s.pts) {
            ri.push(s.pts[k]);
            ro.push(add(s.pts[k], scale(d, th - dip)));
            ra.push(s.anchors![k]);
          } else {
            ri.push(add(s.c, scale(d, s.r[k])));
            ro.push(add(s.c, scale(d, s.r[k] + th - dip)));
            ra.push(add(s.c, scale(d, s.b[k])));
          }
          rd.push(d);
        }
        inner.push(ri);
        outer.push(ro);
        anchor.push(ra);
        radial.push(rd);
      }
      // A cut column (a V neckline) ends at its cut; the rows above fold onto that point.
      if (cutAt)
        for (let k = 0; k < R; k++) {
          const c = cutAt[k];
          if (!(c < rows - 1)) continue;
          const j0 = Math.floor(c),
            f = c - j0,
            at = (g: V3[][]) => add(g[j0][k], scale(sub(g[j0 + 1][k], g[j0][k]), f)),
            pi = at(inner),
            po = at(outer),
            pa = at(anchor);
          for (let j = j0 + 1; j < rows; j++) {
            inner[j][k] = pi;
            outer[j][k] = po;
            anchor[j][k] = pa;
          }
        }
      // Folds move both faces along the ring's direction by the same height, so the cloth keeps its thickness and its
      // gap to what it covers; none above a V neckline's cut, where the rows fold onto one point.
      if (drape)
        for (let row = 0; row < rows; row++)
          for (let k = 0; k < R; k++) {
            if (cutAt && row > cutAt[k]) continue;
            const h = drape(stations[row], k);
            if (!h) continue;
            const d = scale(radial[row][k], h);
            inner[row][k] = add(inner[row][k], d);
            outer[row][k] = add(outer[row][k], d);
          }
      const faces = [] as { first: number; inner: boolean }[];
      let outerTris: [number, number] = [0, 0];
      for (const isInner of [false, true]) {
        const first = mesh.p.length / 3,
          grid = isInner ? inner : outer;
        stations.forEach((s, row) => {
          for (let j = 0; j < cols; j++) {
            const k = j % R,
              zone = s.seamK ? s.seamK[k] : seamZone(s) ? 1 : 0;
            // The rows folded onto a cut point all read their weights the way the row under the cut does, or a yoke row
            // (weights at its anchor) and a collar row (the lattice) folded onto one point part when the body moves.
            mesh.anchored = cutAt && row > cutAt[k] ? !!stations[Math.floor(cutAt[k])].pts : !!s.pts;
            mesh.vert(grid[row][k], [0, 0, 0], j / R, row / Math.max(1, rows - 1), zone, anchor[row][k]);
          }
        });
        mesh.anchored = false;
        // Normals across the grid by central differences, turned away from the axis (toward it for the inner face).
        const P = mesh.p,
          Nn = mesh.n;
        stations.forEach((_, row) => {
          for (let j = 0; j < cols; j++) {
            const at = first + row * cols + j,
              k = j % R,
              prev = first + row * cols + ((k + R - 1) % R),
              next = first + row * cols + ((k + 1) % R),
              up = first + Math.min(rows - 1, row + 1) * cols + j,
              dn = first + Math.max(0, row - 1) * cols + j,
              t1: V3 = [P[next * 3] - P[prev * 3], P[next * 3 + 1] - P[prev * 3 + 1], P[next * 3 + 2] - P[prev * 3 + 2]],
              t2: V3 = [P[up * 3] - P[dn * 3], P[up * 3 + 1] - P[dn * 3 + 1], P[up * 3 + 2] - P[dn * 3 + 2]],
              out1 = radial[row][k];
            let nn = cross(t1, t2);
            if (norm(nn) < 1e-12) nn = out1;
            if (dot3(nn, out1) * (isInner ? -1 : 1) < 0) nn = scale(nn, -1);
            const l = norm(nn) || 1;
            Nn[at * 3] = nn[0] / l;
            Nn[at * 3 + 1] = nn[1] / l;
            Nn[at * 3 + 2] = nn[2] / l;
          }
        });
        const from = mesh.face.length;
        for (let row = 0; row + 1 < rows; row++)
          for (let k = 0; k < R; k++) {
            const q = first + row * cols + k;
            mesh.tri(q, q + 1, q + cols, isInner ? FACE.inner : FACE.outer);
            mesh.tri(q + 1, q + cols + 1, q + cols, isInner ? FACE.inner : FACE.outer);
          }
        if (!isInner) outerTris = [from, mesh.face.length];
        faces.push({ first, inner: isInner });
      }
      stations.forEach((s, row) => {
        if (s.pts || !Number.isFinite(s.at)) return;
        const keep = (k: number) => !(cutAt && row > cutAt[k]);
        rings.push({ part: partName, at: s.at, c: s.c, inner: s.r.map((x, k) => (keep(k) ? x : 0)), outer: s.r.map((x, k) => (keep(k) ? x + th : 0)), garment });
      });
      // Hem bands join the two faces at each open end; a closed end gets a cap instead (a sole, a crown).
      for (const end of [0, rows - 1]) {
        const s = stations[end],
          isTop = end === rows - 1,
          along = sub(stations[Math.min(rows - 1, end + (isTop ? 0 : 1))].c, stations[Math.max(0, end - (isTop ? 1 : 0))].c),
          // Rows over the shoulders share one centre: a neckline's band faces up the neck.
          outward = norm(along) > 1e-9 ? scale(along, (isTop ? 1 : -1) / norm(along)) : scale(N.axis, isTop ? 1 : -1);
        if ((close === 'bottom' && end === 0) || (close === 'top' && isTop)) {
          const centre = mesh.vert(s.c, outward, 0.5, 0.5),
            rim: number[] = [];
          for (let k = 0; k < R; k++) {
            const d = add(scale(s.side, COS[k]), scale(s.front, SIN[k]));
            rim.push(mesh.vert(add(s.c, scale(d, s.r[k] + th)), outward, 0.5 + COS[k] / 2, 0.5 + SIN[k] / 2, 0, add(s.c, scale(d, s.b[k]))));
          }
          for (let k = 0; k < R; k++) mesh.tri(centre, rim[k], rim[(k + 1) % R], FACE.trim);
          continue;
        }
        const o1 = faces[0].first + end * cols,
          i1 = faces[1].first + end * cols,
          band: number[] = [];
        for (let k = 0; k < R; k++) {
          const ao = mesh.anchor.slice((o1 + k) * 3, (o1 + k) * 3 + 3) as V3;
          mesh.anchored = mesh.direct[o1 + k] === 1;
          band.push(mesh.vert([mesh.p[(o1 + k) * 3], mesh.p[(o1 + k) * 3 + 1], mesh.p[(o1 + k) * 3 + 2]], outward, k / R, 0, mesh.seam[o1 + k], ao));
          band.push(mesh.vert([mesh.p[(i1 + k) * 3], mesh.p[(i1 + k) * 3 + 1], mesh.p[(i1 + k) * 3 + 2]], outward, k / R, 1, mesh.seam[i1 + k], ao));
        }
        mesh.anchored = false;
        for (let k = 0; k < R; k++) {
          const j = (k + 1) % R;
          mesh.tri(band[k * 2], band[j * 2], band[k * 2 + 1], FACE.band);
          mesh.tri(band[j * 2], band[j * 2 + 1], band[k * 2 + 1], FACE.band);
        }
      }
      return { outer: faces[0].first, rows, cols, outerTris, stations };
    };
    const noSeam = () => false;
    const shoulderZone = (s: Station) => s.at < 0.06;
    const crotchZone = (s: Station) => s.at > H.crotch - 0.05;
    const trunkZone = (s: Station) => s.at > H.axilla - 0.04 || s.at < H.crotch + 0.02;
    if (cut === 'top') {
      const hem = spec.hem ?? 0.5,
        y0 = Math.min(H.crotch + (H.waist - H.crotch) * hem, H.waist),
        sleeves = spec.sleeves ?? 0,
        buttons = spec.buttons ?? 0,
        // A sleeved top, or one with a neckline (a waistcoat), goes over the shoulders to the neck; any other top stops
        // under the arms with its arm holes open (a bib, a life jacket).
        yoked = (sleeves > 0 || spec.opening !== undefined) && yokeY > y0 + STEP,
        y1 = yoked ? yokeY : H.axilla - 0.01,
        sack = sleeves > 0 && buttons > 0;
      let st = settle(
        'trunk',
        span(y0, y1).map((yy) => station('trunk', yy, yy < H.crotch ? aroundLegs(yy, addOffset(bodyAt('trunk', yy), offset), 0.004 + ease, true) : addOffset(bodyAt('trunk', yy), offset))),
      );
      if (sack) st = hang(st);
      let neckRow = -1,
        opening: { cut: Float64Array; yBreak: number } | undefined,
        collar: ReturnType<typeof neckRings> | undefined;
      if (yoked) {
        collar = neckRings(spec.collar ?? 0, ease);
        st = [...st, ...yokeRows(st[st.length - 1], collar.inner[0])];
        neckRow = st.length - 1;
        for (let i = 1; i < collar.ts.length; i++) st.push({ at: NaN, c: N.centre(collar.ts[i]), side: N.side, front: N.front, r: collar.inner[i], b: collar.raw[i], seamK: new Uint8Array(R) });
        if (spec.opening !== undefined) opening = neckline(st, spec.opening, neckRow);
      }
      // A wing collar: the fronts part from the stud at the base, and each top corner is cut off on the diagonal where
      // it turns down into a point (the points themselves are laid over the collar below).
      const height = collar && collar.ts.length > 1 ? collar.ts[collar.ts.length - 1] - N.tBase : 0,
        points = !opening && height > 0 ? Math.min(spec.points ?? 0, 0.8 * height) : 0,
        frontR = collar ? collar.inner[collar.ts.length - 1][R / 4] + th : 0,
        gapAngle = (POINTS.gap * points) / (frontR || 1),
        pointAngle = points / (frontR || 1);
      let pointCut: Float64Array | undefined;
      if (points > 0) {
        pointCut = new Float64Array(R).fill(Infinity);
        const above = collar!.ts.length - 1;
        for (let k = 0; k < R; k++) {
          const off = fromFront(k),
            h = off < gapAngle ? ((height - points) * off) / gapAngle : off < gapAngle + pointAngle ? height - points + (points * (off - gapAngle)) / pointAngle : Infinity;
          if (h < height) pointCut[k] = neckRow + (above * h) / height;
        }
      }
      // The flutes are as deep all the way down from the waist (never less below it, or a column the plumb hang keeps
      // straight would come back in over the seat), round the sides and the back only, the same on both sides with a
      // crest over the back seam. They fold the spare girth the hang leaves: crests out and troughs in about the plumb
      // line (cloth folds about where it hangs, it does not grow), a trough never deeper than the row's room over its
      // own ring. Standing out only, they once hung the back 1.8 cm further out than the plumb line all the way down.
      const flutes = (s: Station, k: number) => {
        if (s.pts || !Number.isFinite(s.at) || s.at >= H.chest || garment !== lastTop) return 0;
        const h = FOLD.flute * smoothstep(H.chest, H.waist, s.at) * smoothstep(FOLD.fluteFrom, FOLD.fluteFrom + 0.4, fromFront(k)),
          wave = h * (crest((fromFront(k) * FOLD.flutes) / (2 * Math.PI), 1) - 0.5);
        return Math.max(wave, s.need ? s.need[k] - s.r[k] : 0);
      };
      const built = tube('trunk', st, [0, R / 2, ...(buttons > 0 ? [R / 4] : [])], trunkZone, undefined, opening?.cut ?? pointCut, sack ? flutes : undefined);
      if (collar) collars.push({ ts: collar.ts, outer: collar.inner.map((r) => r.map((x) => x + th)) });
      mesh.current = TRUNK;
      const outerAt = (row: number, k: number): V3 => {
          const i = built.outer + row * built.cols + k;
          return [mesh.p[i * 3], mesh.p[i * 3 + 1], mesh.p[i * 3 + 2]];
        },
        onCloth = surfaceOf(mesh, built.outerTris[0], built.outerTris[1]),
        top = built.rows - 1,
        stepAngle = (2 * Math.PI) / R;
      // Lapels: the fronts above the break fold back over the chest, a strip from the roll line (the V's edge) out by the
      // lapel width, nothing at the break and the full width from four fifths of the way up (Gordon 1895: "2 1/4 inch
      // for width of lapel").
      // Each row runs across the lapel: the fold where the forepart turns over at the roll line, the folded edge two
      // layers up and standing off by the roll, across the lapel falling back to the chest, and the outer edge down to
      // the forepart. The top row (the gorge line) falls outward to the lapel's point.
      if (opening && (spec.lapel ?? 0) > 0)
        for (const hand of [1, -1]) {
          const strip: number[][] = [],
            clothN = new Map<number, V3>();
          for (let i = 0; i * stepAngle < GORGE; i++) {
            const k = (R / 4 - hand * i + R) % R,
              theta = k * stepAngle,
              level: V3 = hand > 0 ? [Math.sin(theta), 0, -Math.cos(theta)] : [-Math.sin(theta), 0, Math.cos(theta)],
              f = (i * stepAngle) / GORGE,
              last = (i + 1) * stepAngle >= GORGE,
              away = last ? scale(sub(level, [0, LAPEL.point, 0]), 1 / Math.hypot(1, LAPEL.point)) : level,
              roll = outerAt(top, k),
              w = spec.lapel! * Math.min(1, f / 0.8),
              lift = LAPEL.roll * f ** 1.5,
              across: [number, number][] = [
                [0, 0.0003],
                [Math.min(0.003, w / 4), 2 * th + lift],
                [w / 3, th + 0.45 * lift + 0.0004],
                [(2 * w) / 3, th + 0.12 * lift + 0.0004],
                [w, th + 0.0004],
                [w, 0.0002],
              ],
              row: number[] = [];
            across.forEach(([x, up], j) => {
              const s = onCloth(add(roll, scale(away, x)), up);
              mesh.anchored = s.direct;
              const v = mesh.vert(s.p, s.n, j / (across.length - 1), i / 10, 0, s.direct ? s.anchor : s.p);
              mesh.anchored = false;
              clothN.set(v, s.n);
              row.push(v);
            });
            strip.push(row);
          }
          const tris: number[][] = [];
          for (let i = 0; i + 1 < strip.length; i++)
            for (let j = 0; j + 1 < strip[i].length; j++) tris.push([strip[i][j], strip[i][j + 1], strip[i + 1][j]], [strip[i][j + 1], strip[i + 1][j + 1], strip[i + 1][j]]);
          ownNormals(mesh, [...clothN.keys()], tris, (v) => clothN.get(v)!);
          for (const [p, q, r] of tris) mesh.tri(p, q, r, FACE.trim);
        }
      // A wing collar's points: each top corner turned down and out over the collar on the diagonal from the top edge to
      // the front edge, the corner (at the top of the front edge) folding to the point below the diagonal's far end.
      if (points > 0) {
        const steps = 4;
        for (const hand of [1, -1]) {
          const at = (off: number, h: number, lift: number) => collarPoint(collar!, h, Math.PI / 2 - hand * off, lift),
            // (off, h): the diagonal's ends on the top edge and the front edge, and the point.
            A: [number, number] = [gapAngle + pointAngle, height],
            D: [number, number] = [gapAngle, height - points],
            P: [number, number] = [gapAngle + pointAngle, height - points],
            index = new Map<string, number>(),
            dirs = new Map<number, V3>();
          for (let a = 0; a <= steps; a++)
            for (let b = 0; a + b <= steps; b++) {
              const c = steps - a - b,
                off = (A[0] * a + D[0] * b + P[0] * c) / steps,
                h = (A[1] * a + D[1] * b + P[1] * c) / steps,
                p = at(off, h, th + 0.0005 + (POINTS.stand * c) / steps),
                d = sub(p, at(off, h, 0)),
                v = mesh.vert(p, d, a / steps, b / steps);
              index.set(`${a},${b}`, v);
              dirs.set(v, scale(d, 1 / (norm(d) || 1)));
            }
          const tris: number[][] = [];
          for (let a = 0; a < steps; a++)
            for (let b = 0; a + b < steps; b++) {
              tris.push([index.get(`${a},${b}`)!, index.get(`${a + 1},${b}`)!, index.get(`${a},${b + 1}`)!]);
              if (a + b + 1 < steps) tris.push([index.get(`${a + 1},${b}`)!, index.get(`${a + 1},${b + 1}`)!, index.get(`${a},${b + 1}`)!]);
            }
          ownNormals(mesh, [...dirs.keys()], tris, (v) => dirs.get(v)!);
          for (const [p, q, r] of tris) mesh.tri(p, q, r, FACE.trim);
        }
      }
      if (!shirt && collar && height > 0 && !opening) shirt = { collar, th, height, points, onCloth };
      // A coat collar turns down over its stand, from the stand's top edge to just below the neckline, round the back
      // from gorge to gorge; with lapels its ends stop a ring step short of the gorge, the notch over the lapel's point.
      if (opening && (spec.collar ?? 0) > 0) {
        const strip: number[][] = [],
          from = GORGE + ((spec.lapel ?? 0) > 0 ? stepAngle : 0) - 1e-9;
        for (let i = 0; i < R; i++) {
          const k = (R / 4 + i) % R;
          if (fromFront(k) < from) continue;
          const T = outerAt(top, k),
            dir = neckDir(k),
            B = onCloth(add(sub(T, scale(N.axis, spec.collar! + 0.02)), scale(dir, 0.025)), 1.5 * th).p,
            M = add(scale(add(T, B), 0.5), add(scale(dir, 0.006), scale(N.axis, 0.002))),
            n = add(scale(dir, 0.8), scale(N.axis, 0.6));
          strip.push([mesh.vert(add(T, scale(dir, 0.0008)), n, i / R, 0), mesh.vert(M, n, i / R, 0.5), mesh.vert(B, n, i / R, 1)]);
        }
        for (let i = 0; i + 1 < strip.length; i++)
          for (let j = 0; j < 2; j++) {
            mesh.tri(strip[i][j], strip[i + 1][j], strip[i][j + 1], FACE.trim);
            mesh.tri(strip[i + 1][j], strip[i + 1][j + 1], strip[i][j + 1], FACE.trim);
          }
      }
      if (buttons > 0) {
        const column = Array.from({ length: built.rows }, (_, j) => outerAt(j, R / 4)),
          topY = opening ? opening.yBreak - 0.015 : 0,
          lowY = opening ? H.waist - (sack ? 0.07 : 0.03) : 0;
        for (let b = 0; b < buttons; b++) {
          const yy = opening ? (buttons > 1 ? topY - ((topY - lowY) * b) / (buttons - 1) : topY) : H.waist + ((H.axilla - H.waist) * (b + 0.5)) / buttons;
          let j = 0;
          while (j < column.length - 2 && column[j + 1][1] < yy) j++;
          const A = column[j],
            B = column[j + 1],
            f = Math.max(0, Math.min(1, (yy - A[1]) / Math.max(B[1] - A[1], 1e-9)));
          disc(mesh, add(A, scale(sub(B, A), f)), 0.0085, 0.003);
        }
      }
      if (sleeves > 0)
        for (const [s, name] of [
          [0, 'armL'],
          [1, 'armR'],
        ] as const) {
          const length = a.armLength[s] * sleeves;
          const elbow = norm(sub(a.joint(s ? 'rightLowerArm' : 'leftLowerArm'), a.joint(s ? 'rightUpperArm' : 'leftUpperArm'))),
            folds = (st: Station, k: number) =>
              garment !== lastTop
                ? 0
                : FOLD.crease * near(st.at, elbow, FOLD.creaseReach) * Math.max(0, SIN[k]) * crest(st.at - elbow, FOLD.creasePeriod) +
                  FOLD.cuff * smoothstep(length - FOLD.cuffReach, length, st.at) * crest(length - st.at, FOLD.cuffPeriod);
          const start = SLEEVE_START - SLEEVE_LAP * sorted.slice(0, garment).filter((x) => x.cut === 'top' && (x.sleeves ?? 0) > 0).length;
          tube(name, span(start, length, SLEEVE_LAP).map((d) => station(name, d, addOffset(bodyAt(name, d), offset))), [], shoulderZone, undefined, undefined, folds);
        }
    } else if (cut === 'legs') {
      const topY = spec.bib ? H.chest : H.waist;
      tube('trunk', span(H.crotch - 0.01, topY).map((yy) => station('trunk', yy, addOffset(bodyAt('trunk', yy), offset))), [0, R / 2], trunkZone);
      const hemY = Math.max(spec.hem ?? 0.02, H.ankle + 0.01),
        // Trousers hang from the thigh to a knee and a bottom cut to the seat (TROUSER_KNEE), never inside the leg.
        seat = perimeterOf(bodyAt('trunk', H.hip)),
        kneeR = (seat * TROUSER_KNEE) / (2 * Math.PI),
        bottomR = Math.max(0, seat * TROUSER_KNEE - TROUSER_TAPER) / (2 * Math.PI),
        thighY = H.crotch - 0.04;
      for (const name of ['legL', 'legR']) {
        let widest = new Float64Array(R),
          thigh: Float64Array | undefined;
        const st = span(H.crotch, hemY, 0.01).map((yy) => {
          const r = bodyAt(name, yy);
          if (spec.fitted || spec.bib) {
            if (yy <= thighY) widest = widest.map((w, k) => Math.max(w, r[k]));
            const use = spec.fitted && yy < H.knee ? r : yy <= thighY ? widest : r;
            return station(name, yy, addOffset(use, offset));
          }
          const own = addOffset(r, offset);
          if (yy > thighY) return station(name, yy, own);
          const from = (thigh ??= own),
            f = yy > H.knee ? (thighY - yy) / Math.max(thighY - H.knee, 1e-6) : (H.knee - yy) / Math.max(H.knee - hemY, 1e-6);
          return station(name, yy, own.map((x, k) => Math.max(x, yy > H.knee ? from[k] + (kneeR - from[k]) * f : kneeR + (bottomR - kneeR) * f)));
        });
        const folds = (s: Station, k: number) =>
          spec.fitted || spec.bib || garment !== lastLegs
            ? 0
            : FOLD.break * smoothstep(hemY + FOLD.breakReach, hemY, s.at) * (0.3 + 0.7 * Math.max(0, SIN[k])) * crest(s.at - hemY, FOLD.breakPeriod) +
              FOLD.crease * near(s.at, H.knee, FOLD.creaseReach) * Math.max(0, -SIN[k]) * crest(s.at - H.knee, FOLD.creasePeriod);
        tube(name, st, [0, R / 2], crotchZone, undefined, undefined, folds);
      }
    } else if (cut === 'skirt') {
      const hemY = spec.hem ?? H.knee,
        flare = spec.flare ?? 0.15;
      const st = span(hemY, H.waist).map((yy) => {
        if (yy >= H.hip) return station('trunk', yy, addOffset(bodyAt('trunk', yy), offset));
        const r = aroundLegs(yy, addOffset(bodyAt('trunk', H.hip), offset), 0.004 + ease, true);
        return station('trunk', yy, addOffset(r, flare * (H.hip - yy)));
      });
      tube('trunk', st, [0, R / 2], trunkZone);
    } else if (cut === 'leggings' || cut === 'boots') {
      const topY = spec.top ?? 0.3,
        bottom = cut === 'boots' ? -th : H.ankle + 0.01;
      for (const name of ['legL', 'legR'])
        tube(name, span(bottom, topY).map((yy) => station(name, yy, addOffset(bodyAt(name, Math.max(yy, 0)), offset))), [], noSeam, cut === 'boots' ? 'bottom' : undefined);
    } else if (cut === 'tie') {
      // A necktie on the shirt: the knot at the collar's front over the stud, and a four-in-hand's blade down the shirt
      // front to the waist (or a bow's wings round the collar). Faces toward the neck are its inner face.
      mesh.current = TRUNK;
      const c = shirt?.collar ?? neckRings(0.04, ease),
        height = shirt?.height ?? 0.04,
        lift0 = (shirt?.th ?? 0) + TIE.gap,
        frontR = c.inner[c.ts.length - 1][R / 4],
        M = 16;
      const loft = (sections: V3[][]) => {
        const S = sections.length,
          first = mesh.p.length / 3,
          mid = sections.map((ring) => scale(ring.reduce((s, p) => add(s, p), [0, 0, 0] as V3), 1 / ring.length));
        sections.forEach((ring, s) =>
          ring.forEach((p, m) => {
            const out = sub(p, mid[s]);
            let n = cross(sub(ring[(m + 1) % M], ring[(m + M - 1) % M]), sub(sections[Math.min(S - 1, s + 1)][m], sections[Math.max(0, s - 1)][m]));
            if (norm(n) < 1e-12) n = out;
            if (dot3(n, out) < 0) n = scale(n, -1);
            mesh.vert(p, n, m / M, s / (S - 1));
          }),
        );
        const kind = (...vs: number[]) => {
          const f = vs.reduce((s, v) => s + mesh.n[v * 3] * N.front[0] + mesh.n[v * 3 + 1] * N.front[1] + mesh.n[v * 3 + 2] * N.front[2], 0) / vs.length;
          return f > 0.3 ? FACE.outer : f < -0.3 ? FACE.inner : FACE.band;
        };
        for (let s = 0; s + 1 < S; s++)
          for (let m = 0; m < M; m++) {
            const q = first + s * M + m,
              q1 = first + s * M + ((m + 1) % M);
            mesh.tri(q, q1, q + M, kind(q, q1, q + M));
            mesh.tri(q1, q1 + M, q + M, kind(q1, q1 + M, q + M));
          }
        for (const end of [0, S - 1]) {
          const along = sub(mid[end], mid[end === 0 ? 1 : S - 2]),
            centre = mesh.vert(mid[end], along, 0.5, 0.5);
          for (let m = 0; m < M; m++) mesh.tri(centre, first + end * M + m, first + end * M + ((m + 1) % M), FACE.trim);
        }
      };
      // A rounded section: `w` across, `d` deep, its back on `back` (out along `outward`, across along `across`).
      const section = (back: V3, across: V3, outward: V3, w: number, d: number) =>
        Array.from({ length: M }, (_, m): V3 => {
          const a = (2 * Math.PI * m) / M,
            x = Math.sign(Math.cos(a)) * Math.abs(Math.cos(a)) ** 0.8,
            z = Math.sign(Math.sin(a)) * Math.abs(Math.sin(a)) ** 0.8;
          return add(back, add(scale(across, (x * w) / 2), scale(outward, ((z + 1) * d) / 2)));
        });
      const radial = (h: number, phi: number): V3 => {
        const d = sub(collarPoint(c, h, phi, 1), collarPoint(c, h, phi, 0));
        return scale(d, 1 / (norm(d) || 1));
      };
      if (spec.knot === 'bow') {
        const h0 = 0.3 * height,
          wingAt = (side: number, u: number) => {
            const x = side * (0.008 + (TIE.bowSpan / 2 - 0.008) * u),
              phi = Math.PI / 2 - x / frontR,
              tall = 0.016 + (TIE.bowHeight - 0.016) * smoothstep(0, 0.7, u) * (u > 0.85 ? 1 - 2.5 * (u - 0.85) : 1);
            return section(collarPoint(c, h0, phi, lift0), N.axis, radial(h0, phi), tall, 0.006);
          };
        for (const side of [1, -1]) loft(Array.from({ length: 7 }, (_, i) => wingAt(side, i / 6)));
        loft(Array.from({ length: 5 }, (_, i) => section(collarPoint(c, h0 - 0.011 + (0.022 * i) / 4, Math.PI / 2, lift0 + 0.004), N.side, N.front, 0.02, 0.012)));
      } else {
        const top = Math.max(0.012, Math.min(height - 0.004, height - (shirt?.points ?? 0) + 0.006)),
          S = 8,
          knot = Array.from({ length: S }, (_, s) => {
            const u = s / (S - 1),
              h = top * u,
              crown = u < 0.8 ? 1 : 0.55 + 0.45 * Math.sqrt(Math.max(0, 1 - ((u - 0.8) / 0.2) ** 2));
            const w = (TIE.knotBottom + (TIE.knotTop - TIE.knotBottom) * u ** 0.8) * crown,
              out = radial(h, Math.PI / 2),
              base = collarPoint(c, h, Math.PI / 2, 0);
            // Its back clears the collar across its whole width, the turned points' stand included (a neck wider than
            // it is deep sets the collar further forward beside the centre than at it).
            let stand = lift0;
            for (let i = 0; i <= 6; i++) stand = Math.max(stand, dot3(sub(collarPoint(c, h, Math.PI / 2 - ((i / 6 - 0.5) * w) / frontR, lift0 + POINTS.stand), base), out));
            return section(add(base, scale(out, stand)), N.side, out, w, (TIE.depthBottom + (TIE.depthTop - TIE.depthBottom) * u) * crown);
          });
        loft(knot);
        // The blade: from under the knot down the shirt front, walked down the shirt's surface in 5 mm steps (a point
        // projected at each height snaps across the bend from the neck to the chest and leaves the shirt bare there);
        // a front and back face 5 samples across, and edge bands.
        const ax = a.axes.trunk,
          y1 = H.waist + TIE.end,
          cols = 5,
          surf = (q: V3, lift: number) => {
            const front = ax.front(q[1]);
            return shirt ? shirt.onCloth(q, lift) : { p: add(q, scale(front, ease + lift)), n: front, anchor: q, direct: false };
          },
          walk: { p: V3; side: V3; s: number }[] = [];
        let at = surf(collarPoint(c, 0, Math.PI / 2, 0), 0),
          walked = 0;
        for (let guard = 0; guard < 400 && at.p[1] > y1; guard++) {
          const n = at.n,
            down0: V3 = [-n[0] * -n[1], -1 + n[1] * n[1], -n[2] * -n[1]],
            down = scale(down0, 1 / (norm(down0) || 1)),
            side0 = ax.side(at.p[1]),
            side = sub(side0, scale(n, dot3(side0, n)));
          walk.push({ p: at.p, side: scale(side, 1 / (norm(side) || 1)), s: walked });
          const next = surf(add(at.p, scale(down, 0.005)), 0);
          walked += norm(sub(next.p, at.p));
          at = next;
        }
        const rows = walk.length - 1,
          faces: { first: number; inner: boolean }[] = [];
        for (const inner of [false, true]) {
          const first = mesh.p.length / 3;
          walk.forEach((r, row) => {
            const w = row === rows ? 0 : TIE.bladeTop + (TIE.blade - TIE.bladeTop) * smoothstep(0, TIE.flare, r.s);
            for (let j = 0; j < cols; j++) {
              const x = w * (j / (cols - 1) - 0.5),
                s = surf(add(r.p, scale(r.side, x)), spec.ease + (inner ? 0 : th));
              mesh.anchored = s.direct;
              mesh.vert(s.p, inner ? scale(s.n, -1) : s.n, j / (cols - 1), row / rows, 0, s.direct ? s.anchor : s.p);
              mesh.anchored = false;
            }
          });
          faces.push({ first, inner });
          for (let row = 0; row < rows; row++)
            for (let j = 0; j + 1 < cols; j++) {
              const q = first + row * cols + j;
              mesh.tri(q, q + 1, q + cols, inner ? FACE.inner : FACE.outer);
              mesh.tri(q + 1, q + cols + 1, q + cols, inner ? FACE.inner : FACE.outer);
            }
        }
        // Edge bands down both sides.
        for (const j of [0, cols - 1])
          for (let row = 0; row < rows; row++) {
            const o = faces[0].first + row * cols + j,
              i = faces[1].first + row * cols + j,
              dir = j === 0 ? -1 : 1,
              n = scale(walk[row].side, dir),
              band = [o, i, o + cols, i + cols].map((v) => {
                mesh.anchored = mesh.direct[v] === 1;
                const b = mesh.vert([mesh.p[v * 3], mesh.p[v * 3 + 1], mesh.p[v * 3 + 2]], n, j, row, 0, [mesh.anchor[v * 3], mesh.anchor[v * 3 + 1], mesh.anchor[v * 3 + 2]]);
                mesh.anchored = false;
                return b;
              });
            mesh.tri(band[0], band[1], band[2], FACE.band);
            mesh.tri(band[1], band[3], band[2], FACE.band);
          }
      }
    } else {
      // Hat: a crown ring on the head (and hair) at the hat band, closed on top (flat, or rounded over as a derby's), and
      // a brim following the band.
      const s = H.stature / 1.72,
        base = H.top - 0.09 * s,
        band = addOffset(bodyAt('head', base), offset),
        crown = Math.max(spec.crown ?? 0.1, H.top + ease + th - base),
        dome = spec.dome ?? 0,
        st = crownRows(dome).map((f) => {
          const yy = base + crown * f,
            above = bodyAt('head', Math.min(yy, H.top));
          return station('head', yy, band.map((b, k) => Math.max(b * crownTaper(f, dome), above[k] + offset)));
        });
      tube('head', st, [], noSeam, 'top');
      brim(mesh, a.axes.head.centre(base), band.map((b) => b + th), spec.brim ?? 0.06, th);
    }
    out.push({ spec, mesh, offset });
  });
  // The body under the cloth, ring by ring: below the crotch the trunk's ring spans both legs.
  const under = (part: string, at: number) =>
    part === 'trunk' && at < H.crotch ? aroundLegs(at, bodyAt('trunk', at), 0) : bodyAt(part, part === 'head' ? Math.min(at, H.stature) : Math.max(at, 0));
  return { garments: out, under };
}
/** A flat disc facing +z, radius r, thickness t: a button. */
function disc(m: Mesh, c: V3, r: number, t: number) {
  const steps = 16,
    centre = m.vert([c[0], c[1], c[2] + t], [0, 0, 1], 0.5, 0.5),
    rim: number[] = [];
  for (let k = 0; k < steps; k++) {
    const a = (k / steps) * 2 * Math.PI,
      d: V3 = [Math.cos(a), Math.sin(a), 0];
    rim.push(m.vert([c[0] + d[0] * r, c[1] + d[1] * r, c[2] + t], [0, 0, 1], 0.5 + d[0] / 2, 0.5 + d[1] / 2));
    rim.push(m.vert([c[0] + d[0] * r, c[1] + d[1] * r, c[2]], d, 0, 0));
    rim.push(m.vert([c[0] + d[0] * r, c[1] + d[1] * r, c[2] + t], d, 0, 1));
  }
  for (let k = 0; k < steps; k++) {
    const j = (k + 1) % steps;
    m.tri(centre, rim[k * 3], rim[j * 3], FACE.trim);
    m.tri(rim[k * 3 + 1], rim[j * 3 + 1], rim[k * 3 + 2], FACE.trim);
    m.tri(rim[j * 3 + 1], rim[j * 3 + 2], rim[k * 3 + 2], FACE.trim);
  }
}
/** A flat brim at height c[1]: from the band radii out by `width`, `t` thick, faces up, down and its rim. */
function brim(m: Mesh, c: V3, inner: Float64Array, width: number, t: number) {
  const ring = (r: (k: number) => number, y: number, n: V3 | null, v: number) =>
    Array.from({ length: R }, (_, k) => m.vert([c[0] + r(k) * COS[k], y, c[2] + r(k) * SIN[k]], n ?? [COS[k], 0, SIN[k]], k / R, v));
  const topIn = ring((k) => inner[k], c[1] + t, [0, 1, 0], 0),
    topOut = ring((k) => inner[k] + width, c[1] + t, [0, 1, 0], 1),
    botIn = ring((k) => inner[k], c[1], [0, -1, 0], 0),
    botOut = ring((k) => inner[k] + width, c[1], [0, -1, 0], 1),
    rimTop = ring((k) => inner[k] + width, c[1] + t, null, 1),
    rimBot = ring((k) => inner[k] + width, c[1], null, 1);
  for (let k = 0; k < R; k++) {
    const j = (k + 1) % R;
    for (const [a, b] of [
      [topIn, topOut],
      [botIn, botOut],
      [rimTop, rimBot],
    ]) {
      m.tri(a[k], a[j], b[k], FACE.trim);
      m.tri(a[j], b[j], b[k], FACE.trim);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Closest points on a triangle mesh.
// ---------------------------------------------------------------------------------------------------------------------

/** Closest point on triangle abc to p (Ericson 2005, 5.1.5): barycentric weights into `out`. */
function closestOnTriangle(p: V3, a: V3, b: V3, c: V3, out: Float64Array) {
  const ab = sub(b, a),
    ac = sub(c, a),
    ap = sub(p, a),
    d1 = dot3(ab, ap),
    d2 = dot3(ac, ap);
  if (d1 <= 0 && d2 <= 0) return out.set([1, 0, 0]);
  const bp = sub(p, b),
    d3 = dot3(ab, bp),
    d4 = dot3(ac, bp);
  if (d3 >= 0 && d4 <= d3) return out.set([0, 1, 0]);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return out.set([1 - v, v, 0]);
  }
  const cp = sub(p, c),
    d5 = dot3(ab, cp),
    d6 = dot3(ac, cp);
  if (d6 >= 0 && d5 <= d6) return out.set([0, 0, 1]);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return out.set([1 - w, 0, w]);
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return out.set([0, 1 - w, w]);
  }
  const den = 1 / (va + vb + vc),
    v = vb * den,
    w = vc * den;
  out.set([1 - v - w, v, w]);
}
/** A uniform grid over a triangle mesh's triangles for closest-point queries. */
class TriangleGrid {
  cell: number;
  lo: V3;
  dims: V3;
  start: Uint32Array;
  items: Uint32Array;
  stamp: Uint32Array;
  query = 0;
  tmp = new Float64Array(3);
  constructor(
    readonly pos: ArrayLike<number>,
    readonly tris: ArrayLike<number>,
    readonly list: ArrayLike<number>,
    cell: number,
  ) {
    const lo: V3 = [Infinity, Infinity, Infinity],
      hi: V3 = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < list.length; i++)
      for (let c = 0; c < 3; c++) {
        const v = tris[list[i] * 3 + c];
        for (let d = 0; d < 3; d++) {
          lo[d] = Math.min(lo[d], pos[v * 3 + d]);
          hi[d] = Math.max(hi[d], pos[v * 3 + d]);
        }
      }
    if (!list.length) lo.fill(0), hi.fill(0);
    this.cell = cell;
    this.lo = lo;
    this.dims = [0, 1, 2].map((d) => Math.max(1, Math.ceil((hi[d] - lo[d]) / cell) + 1)) as V3;
    const counts = new Uint32Array(this.dims[0] * this.dims[1] * this.dims[2] + 1),
      boxes: number[] = [];
    for (let i = 0; i < list.length; i++) {
      const box = [0, 1, 2].flatMap((d) => {
        let mn = Infinity,
          mx = -Infinity;
        for (let c = 0; c < 3; c++) {
          const v = pos[tris[list[i] * 3 + c] * 3 + d];
          mn = Math.min(mn, v);
          mx = Math.max(mx, v);
        }
        return [this.index(mn, d), this.index(mx, d)];
      });
      boxes.push(...box);
      for (let x = box[0]; x <= box[1]; x++) for (let y = box[2]; y <= box[3]; y++) for (let z = box[4]; z <= box[5]; z++) counts[this.key(x, y, z) + 1]++;
    }
    for (let i = 1; i < counts.length; i++) counts[i] += counts[i - 1];
    this.start = counts.slice();
    this.items = new Uint32Array(counts[counts.length - 1]);
    this.stamp = new Uint32Array(tris.length / 3);
    const fill = counts.slice();
    for (let i = 0; i < list.length; i++) {
      const box = boxes.slice(i * 6, i * 6 + 6);
      for (let x = box[0]; x <= box[1]; x++) for (let y = box[2]; y <= box[3]; y++) for (let z = box[4]; z <= box[5]; z++) this.items[fill[this.key(x, y, z)]++] = list[i];
    }
  }
  index(v: number, d: number) {
    return Math.max(0, Math.min(this.dims[d] - 1, Math.floor((v - this.lo[d]) / this.cell)));
  }
  key(x: number, y: number, z: number) {
    return (x * this.dims[1] + y) * this.dims[2] + z;
  }
  /** The closest triangle to p within `limit`: its index, barycentrics in `bary`, the squared distance; -1 for none. */
  closest(p: V3, limit: number, bary: Float64Array): { tri: number; d2: number } {
    // A point further than `limit` outside the grid's box has no triangle in reach.
    for (let d = 0; d < 3; d++) if (p[d] < this.lo[d] - limit || p[d] > this.lo[d] + this.dims[d] * this.cell + limit) return { tri: -1, d2: limit * limit };
    const cx = this.index(p[0], 0),
      cy = this.index(p[1], 1),
      cz = this.index(p[2], 2),
      tmp = this.tmp,
      stamp = this.stamp,
      query = ++this.query;
    let best = -1,
      bestD2 = limit * limit;
    const reach = Math.ceil(limit / this.cell);
    for (let ring = 0; ring <= reach; ring++) {
      // Every triangle within `ring` cells has been seen once the ring's inner distance passes the best found.
      if (best >= 0 && (ring - 1) * this.cell > Math.sqrt(bestD2)) break;
      for (let x = cx - ring; x <= cx + ring; x++)
        for (let y = cy - ring; y <= cy + ring; y++)
          for (let z = cz - ring; z <= cz + ring; z++) {
            if (Math.max(Math.abs(x - cx), Math.abs(y - cy), Math.abs(z - cz)) !== ring) continue;
            if (x < 0 || y < 0 || z < 0 || x >= this.dims[0] || y >= this.dims[1] || z >= this.dims[2]) continue;
            const key = this.key(x, y, z);
            for (let i = this.start[key]; i < this.start[key + 1]; i++) {
              const t = this.items[i];
              if (stamp[t] === query) continue;
              stamp[t] = query;
              const P = this.pos,
                T = this.tris,
                A: V3 = [P[T[t * 3] * 3], P[T[t * 3] * 3 + 1], P[T[t * 3] * 3 + 2]],
                B: V3 = [P[T[t * 3 + 1] * 3], P[T[t * 3 + 1] * 3 + 1], P[T[t * 3 + 1] * 3 + 2]],
                C: V3 = [P[T[t * 3 + 2] * 3], P[T[t * 3 + 2] * 3 + 1], P[T[t * 3 + 2] * 3 + 2]];
              closestOnTriangle(p, A, B, C, tmp);
              const q: V3 = [A[0] * tmp[0] + B[0] * tmp[1] + C[0] * tmp[2], A[1] * tmp[0] + B[1] * tmp[1] + C[1] * tmp[2], A[2] * tmp[0] + B[2] * tmp[1] + C[2] * tmp[2]],
                d2 = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 + (q[2] - p[2]) ** 2;
              if (d2 < bestD2) {
                bestD2 = d2;
                best = t;
                bary.set(tmp);
              }
            }
          }
    }
    return { tri: best, d2: bestD2 };
  }
}
/** Area-weighted vertex normals of a triangle mesh. */
function vertexNormals(pos: ArrayLike<number>, tris: ArrayLike<number>, count: number): Float64Array {
  const n = new Float64Array(count * 3);
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t],
      b = tris[t + 1],
      c = tris[t + 2],
      e1: V3 = [pos[b * 3] - pos[a * 3], pos[b * 3 + 1] - pos[a * 3 + 1], pos[b * 3 + 2] - pos[a * 3 + 2]],
      e2: V3 = [pos[c * 3] - pos[a * 3], pos[c * 3 + 1] - pos[a * 3 + 1], pos[c * 3 + 2] - pos[a * 3 + 2]],
      g = cross(e1, e2);
    for (const v of [a, b, c]) for (let d = 0; d < 3; d++) n[v * 3 + d] += g[d];
  }
  for (let v = 0; v < count; v++) {
    const l = Math.hypot(n[v * 3], n[v * 3 + 1], n[v * 3 + 2]) || 1;
    for (let d = 0; d < 3; d++) n[v * 3 + d] /= l;
  }
  return n;
}

// ---------------------------------------------------------------------------------------------------------------------
// Skin weights: matched on the body, inpainted elsewhere (Abdrashitov et al. 2023).
// ---------------------------------------------------------------------------------------------------------------------

/** Largest distance from a ring's anchor to the body for a direct weight match, metres. */
const MATCH = 0.015;
/** Spacing of the weight lattice along each part, metres. */
const LATTICE = 0.01;
/**
 * Skin weights on a lattice over one body part: rows along the part's axis, a node per ring angle, each at the body
 * point under the cloth there (its anchor). Every garment on the part reads its weights from here by its place and
 * angle, so all layers of one place move alike and keep their order in any pose.
 */
interface Lattice {
  at0: number;
  rows: number;
  bones: number[];
  W: Float64Array;
  matched: Uint8Array;
}
function weightLattice(
  body: RiggedBody,
  a: Analysis,
  grid: TriangleGrid,
  bodyNormals: Float64Array,
  part: string,
  from: number,
  to: number,
  under: (part: string, at: number) => Float64Array,
): Lattice {
  const ax = a.axes[part],
    at0 = from - LATTICE,
    rows = Math.max(2, Math.ceil((to - from) / LATTICE) + 3),
    nodes = rows * R,
    cosine = Math.cos((30 * Math.PI) / 180),
    bary = new Float64Array(3),
    nearest: Map<number, number>[] = [],
    matched = new Uint8Array(nodes);
  for (let j = 0; j < rows; j++) {
    const at = at0 + j * LATTICE,
      c = ax.centre(at),
      side = ax.side(at),
      front = ax.front(at),
      r = under(part, at);
    for (let k = 0; k < R; k++) {
      const d = add(scale(side, COS[k]), scale(front, SIN[k])),
        p = add(c, scale(d, r[k]));
      let hit = grid.closest(p, MATCH, bary),
        ok = hit.tri >= 0;
      if (!ok) hit = grid.closest(p, a.diagonal, bary);
      const w = new Map<number, number>(),
        nb: V3 = [0, 0, 0];
      for (let t = 0; t < 3; t++) {
        const vi = body.indices[hit.tri * 3 + t];
        for (let e = 0; e < 3; e++) nb[e] += bodyNormals[vi * 3 + e] * bary[t];
        for (let i = 0; i < 4; i++) {
          const bone = body.joints[vi * 4 + i],
            weight = body.weights[vi * 4 + i] * bary[t];
          if (weight > 0) w.set(bone, (w.get(bone) ?? 0) + weight);
        }
      }
      // Abdrashitov et al.'s normal test: the body there faces the way the ring does (within 30 degrees).
      if (ok) ok = dot3(d, nb) >= cosine * (norm(nb) || 1);
      matched[j * R + k] = ok ? 1 : 0;
      nearest.push(w);
    }
  }
  const fixed = matched.slice();
  if (!fixed.some((f) => f)) fixed.fill(1);
  const bones = new Map<number, number>();
  for (let x = 0; x < nodes; x++) if (fixed[x]) for (const b of nearest[x].keys()) if (!bones.has(b)) bones.set(b, bones.size);
  const B = Math.max(1, bones.size),
    W = new Float64Array(nodes * B);
  for (let x = 0; x < nodes; x++)
    if (fixed[x]) {
      let total = 0;
      for (const w of nearest[x].values()) total += w;
      for (const [b, w] of nearest[x]) W[x * B + bones.get(b)!] = w / (total || 1);
    }
  // Minimise the Dirichlet energy with the matched weights fixed: harmonic weights on the lattice (rows along the
  // part, angles around it with wrap) by over-relaxed Gauss-Seidel.
  const free: number[] = [];
  for (let x = 0; x < nodes; x++) if (!fixed[x]) free.push(x);
  const omega = 1.8,
    row = new Float64Array(B);
  for (let iter = 0; iter < 4000 && free.length; iter++) {
    let change = 0;
    for (const x of free) {
      const j = Math.floor(x / R),
        k = x % R,
        nb = [j * R + ((k + 1) % R), j * R + ((k + R - 1) % R), ...(j > 0 ? [x - R] : []), ...(j < rows - 1 ? [x + R] : [])];
      row.fill(0);
      for (const y of nb) for (let b = 0; b < B; b++) row[b] += W[y * B + b];
      for (let b = 0; b < B; b++) {
        const next = W[x * B + b] + omega * (row[b] / nb.length - W[x * B + b]);
        change = Math.max(change, Math.abs(next - W[x * B + b]));
        W[x * B + b] = next;
      }
    }
    if (change < 1e-7) break;
  }
  return { at0, rows, bones: bones.size ? [...bones.keys()] : [0], W, matched };
}
/**
 * A garment vertex's weights from the body at its anchor (the closest body point to it, blended over that triangle):
 * the rows over the shoulders, where one row crosses the trunk, the deltoid (weighted to the upper arm) and the neck, so
 * no single part's lattice holds its weights. Every layer of one row and column shares the anchor, so the layers move
 * alike. Returns whether the anchor lies within MATCH of the body.
 */
function anchorWeights(body: RiggedBody, grid: TriangleGrid, reach: number, anchors: readonly number[], v: number, joints: Uint16Array, weights: Float32Array): boolean {
  const bary = new Float64Array(3),
    hit = grid.closest([anchors[v * 3], anchors[v * 3 + 1], anchors[v * 3 + 2]], reach, bary),
    w = new Map<number, number>();
  for (let t = 0; t < 3; t++) {
    const vi = body.indices[hit.tri * 3 + t];
    for (let i = 0; i < 4; i++) {
      const weight = body.weights[vi * 4 + i] * bary[t];
      if (weight > 0) w.set(body.joints[vi * 4 + i], (w.get(body.joints[vi * 4 + i]) ?? 0) + weight);
    }
  }
  const top = [...w].sort((x, y) => y[1] - x[1]).slice(0, 4),
    total = top.reduce((s, [, x]) => s + x, 0);
  for (let i = 0; i < 4; i++) {
    joints[v * 4 + i] = top[i]?.[0] ?? 0;
    weights[v * 4 + i] = total > 0 ? (top[i]?.[1] ?? 0) / total : i === 0 ? 1 : 0;
  }
  return hit.d2 <= MATCH * MATCH;
}
/** A garment vertex's weights from its part's lattice, by its place along the part and its angle around it. */
function latticeWeights(lat: Lattice, ax: Axis, p: ArrayLike<number>, o: number, joints: Uint16Array, weights: Float32Array, v: number): boolean {
  const at = ax.project ? ax.project(p, o) : p[o + 1],
    c = ax.centre(at),
    d: V3 = [p[o] - c[0], p[o + 1] - c[1], p[o + 2] - c[2]],
    angle = Math.atan2(dot3(d, ax.front(at)), dot3(d, ax.side(at))),
    fk = ((((angle / (2 * Math.PI)) * R) % R) + R) % R,
    fj = Math.max(0, Math.min(lat.rows - 1, (at - lat.at0) / LATTICE)),
    j0 = Math.min(lat.rows - 2, Math.floor(fj)),
    tj = fj - j0,
    k0 = Math.floor(fk) % R,
    tk = fk - Math.floor(fk),
    B = lat.bones.length,
    sum = new Float64Array(B);
  let matched = 0;
  for (const [j, wj] of [
    [j0, 1 - tj],
    [j0 + 1, tj],
  ])
    for (const [k, wk] of [
      [k0, 1 - tk],
      [(k0 + 1) % R, tk],
    ]) {
      const x = j * R + k,
        w = wj * wk;
      matched += lat.matched[x] * w;
      for (let b = 0; b < B; b++) sum[b] += lat.W[x * B + b] * w;
    }
  const top = Array.from(sum, (w, b) => [b, Math.max(0, w)] as const)
      .sort((x, y) => y[1] - x[1])
      .slice(0, 4),
    total = top.reduce((s, [, w]) => s + w, 0);
  for (let i = 0; i < 4; i++) {
    const [b, w] = top[i] ?? [0, 0];
    joints[v * 4 + i] = lat.bones[b];
    weights[v * 4 + i] = total > 0 ? w / total : i === 0 ? 1 : 0;
  }
  return matched >= 0.5;
}

/**
 * Cuts every garment of `outfit` to `body` in its rest pose and skins it to the body's bones: one call for any of the
 * cast kit's outfits (`OUTFITS`) or your own. The body is measured as it stands (T-pose, A-pose or arms down, found from
 * the upper arms), each garment ring sits its ease over the convex hull of the body's slice there and over the garments
 * beneath it, and each vertex takes its skin weights from the body.
 * @example
 * const fit = fitOutfit(riggedBody(model), OUTFITS['townsman-1910']);
 * fit.pose; // 'T'
 * @throws TypeError for a body without a humanoid rig; RangeError for bad options.
 */
export function fitOutfit(body: RiggedBody, outfit: Outfit | OutfitName, options: FitOptions = {}): FittedOutfit {
  const o = typeof outfit === 'string' ? (OUTFITS as Record<string, Outfit>)[outfit] : outfit;
  if (!o || !Array.isArray(o.garments) || !o.garments.length) throw new TypeError(`fitOutfit needs an outfit: one of ${Object.keys(OUTFITS).join(', ')}, or an Outfit`);
  const opts = { fit: options.fit ?? 1, ease: options.ease ?? 0.003, layerGap: options.layerGap ?? 0.002 };
  if (!(opts.fit >= 0 && opts.fit <= 4) || !(opts.ease >= 0 && opts.ease <= 0.1) || !(opts.layerGap >= 0 && opts.layerGap <= 0.05))
    throw new RangeError('fitOutfit fit must be 0 to 4, ease 0 to 0.1 m and layerGap 0 to 0.05 m');
  if (options.unit !== undefined && !(options.unit > 0 && Number.isFinite(options.unit))) throw new RangeError('fitOutfit unit must be a positive number of metres');
  const a = analyse(body, options.unit),
    { garments: built, under } = fitGarments(a, o, opts);
  // Body triangles in the fit frame for the weight match.
  const tris = body.indices,
    triangles = Uint32Array.from({ length: tris.length / 3 }, (_, i) => i),
    grid = new TriangleGrid(a.pos, tris, triangles, 0.04),
    normals = vertexNormals(a.pos, tris, a.pos.length / 3);
  // One weight lattice per body part, over the reach of every garment on it.
  const reach = new Map<string, [number, number]>(),
    PARTS = ['trunk', 'head', 'armL', 'armR', 'legL', 'legR'],
    partName = (id: number) => (id === TRUNK ? 'trunk' : id === HEAD ? 'head' : id === ARM ? 'armL' : id === ARM + 1 ? 'armR' : id === LEG ? 'legL' : 'legR');
  for (const { mesh } of built)
    for (let v = 0; v < mesh.p.length / 3; v++) {
      const name = partName(mesh.part[v]),
        ax = a.axes[name],
        at = ax.project ? ax.project(mesh.p, v * 3) : mesh.p[v * 3 + 1],
        r = reach.get(name) ?? [Infinity, -Infinity];
      reach.set(name, [Math.min(r[0], at), Math.max(r[1], at)]);
    }
  const lattices = new Map(PARTS.filter((n) => reach.has(n)).map((n) => [n, weightLattice(body, a, grid, normals, n, reach.get(n)![0], reach.get(n)![1], under)]));
  const garments = built.map(({ spec, mesh }): FittedGarment => {
    const count = mesh.p.length / 3,
      joints = new Uint16Array(count * 4),
      weights = new Float32Array(count * 4),
      positions = new Float32Array(count * 3),
      nrm = new Float32Array(count * 3);
    let matchedCount = 0;
    for (let v = 0; v < count; v++) {
      const name = partName(mesh.part[v]);
      if (mesh.direct[v] ? anchorWeights(body, grid, a.diagonal, mesh.anchor, v, joints, weights) : latticeWeights(lattices.get(name)!, a.axes[name], mesh.p, v * 3, joints, weights, v)) matchedCount++;
    }
    const matched = matchedCount / Math.max(1, count);
    for (let v = 0; v < count; v++) {
      a.fromFit(mesh.p.slice(v * 3, v * 3 + 3), positions, v * 3);
      a.normalFromFit(mesh.n.slice(v * 3, v * 3 + 3), nrm, v * 3);
    }
    return {
      spec,
      positions,
      normals: nrm,
      uvs: new Float32Array(mesh.uv),
      indices: new Uint32Array(mesh.ix),
      joints,
      weights,
      faces: new Uint8Array(mesh.face),
      seams: new Uint8Array(mesh.seam),
      parts: new Uint8Array(mesh.part),
      matched,
      thickness: spec.thickness,
    };
  });
  const H = a.heights,
    girth = (part: string, at: number) => perimeterOf(profileOf(a.points[part], at, 0.01)),
    extent = (part: string, at: number, k: number) => {
      const r = profileOf(a.points[part], at, 0.01);
      return r ? r[k] + r[(k + R / 2) % R] : 0;
    };
  const arm = Math.max(...[0.06, 0.1, 0.14, 0.18].map((d) => girth('armL', d * (a.armLength[0] / 0.56)))),
    s = H.stature / 1.72,
    headBand = H.top - 0.09 * s,
    calf = Math.max(...[0.25, 0.3, 0.35, 0.4].map((f) => girth('legL', H.ankle + (H.knee - H.ankle) * f * 2)));
  const measures: CastBody = {
    name: 'measured',
    source:
      'Measured on the loaded body by @margoengine/humans/fit: convex hull girths of slices (ISO 8559-1:2017 tape girths; the neck square to its own axis, its narrowest ring between the clavicle line and the jaw) and joint heights',
    stature: H.stature,
    headGirth: girth('head', headBand),
    neckGirth: a.neck.girth,
    neckHeight: H.neck,
    shoulderHeight: H.shoulder,
    shoulderBreadth: Math.hypot(...sub(a.joint('leftUpperArm'), a.joint('rightUpperArm'))),
    scyeDepth: extent('trunk', H.axilla, R / 4),
    axillaHeight: H.axilla,
    chestHeight: H.chest,
    chestGirth: girth('trunk', H.chest),
    chestBreadth: extent('trunk', H.chest, 0),
    chestDepth: extent('trunk', H.chest, R / 4),
    waistHeight: H.waist,
    waistGirth: girth('trunk', H.waist),
    waistBreadth: extent('trunk', H.waist, 0),
    waistDepth: extent('trunk', H.waist, R / 4),
    hipHeight: H.hip,
    hipGirth: girth('trunk', H.hip),
    hipBreadth: extent('trunk', H.hip, 0),
    hipDepth: extent('trunk', H.hip, R / 4),
    crotchHeight: H.crotch,
    thighHeight: H.crotch - 0.03,
    thighGirth: girth('legL', H.crotch - 0.03),
    kneeHeight: H.knee,
    kneeGirth: girth('legL', H.knee),
    calfHeight: H.ankle + (H.knee - H.ankle) * 0.6,
    calfGirth: calf,
    armLength: a.armLength[0],
    armGirth: arm,
  };
  return { outfit: o, pose: a.pose, armAngle: a.armAngle, unit: a.unit, measures, garments };
}

// ---------------------------------------------------------------------------------------------------------------------
// Penetration: garments against the body and against each other, at rest or in any pose.
// ---------------------------------------------------------------------------------------------------------------------

/** {@link fitPenetration}'s result, metres. */
export interface FitPenetration {
  /** Deepest garment vertex inside the body. */
  readonly body: number;
  /** Deepest vertex of one garment through another (an outer layer under an inner one, or the reverse). */
  readonly layers: number;
  /** Which garment reaches deepest into the body and where (body space), and which pair crosses deepest and where. */
  readonly worst: { readonly body: string; readonly bodyAt: readonly number[]; readonly layers: string; readonly layersAt: readonly number[] };
}
/**
 * How far the fitted garments reach into the body and through each other, with the body and garments skinned by
 * `skin` (one 4x4 column-major matrix a bone, 16 numbers each: the bone's posed matrix times its inverse bind, by linear
 * blend skinning) or at rest when it is left out. A vertex counts where it lies over the other surface (its offset from
 * the closest point runs along that surface's normal), so a garment reaching past another's hem is not a crossing.
 * The armscye and crotch seams ({@link FittedGarment.seams}) are left out, as vertices and as surfaces: there a sleeve
 * or leg meets its trunk tube by design.
 * @example
 * const { body, layers } = fitPenetration(rigged, fit); // metres
 */
export function fitPenetration(body: RiggedBody, fit: FittedOutfit, skin?: ArrayLike<number>): FitPenetration {
  checkBody(body);
  if (skin !== undefined && skin.length !== body.bones.length * 16) throw new RangeError('fitPenetration skin needs 16 numbers for each bone');
  const pose = (pos: ArrayLike<number>, joints: ArrayLike<number>, weights: ArrayLike<number>) => {
    const out = new Float64Array(pos.length);
    for (let v = 0; v < pos.length / 3; v++) {
      const x = pos[v * 3],
        y = pos[v * 3 + 1],
        z = pos[v * 3 + 2];
      if (!skin) {
        out[v * 3] = x;
        out[v * 3 + 1] = y;
        out[v * 3 + 2] = z;
        continue;
      }
      for (let i = 0; i < 4; i++) {
        const w = weights[v * 4 + i];
        if (!w) continue;
        const m = joints[v * 4 + i] * 16;
        out[v * 3] += w * (skin[m] * x + skin[m + 4] * y + skin[m + 8] * z + skin[m + 12]);
        out[v * 3 + 1] += w * (skin[m + 1] * x + skin[m + 5] * y + skin[m + 9] * z + skin[m + 13]);
        out[v * 3 + 2] += w * (skin[m + 2] * x + skin[m + 6] * y + skin[m + 10] * z + skin[m + 14]);
      }
    }
    return out;
  };
  const unit = fit.unit,
    bodyPos = pose(body.positions, body.joints, body.weights),
    bodyN = vertexNormals(bodyPos, body.indices, bodyPos.length / 3),
    triCount = body.indices.length / 3,
    surfaces = new Map<number, number[]>();
  for (let t = 0; t < triCount; t++) {
    const s = body.surfaces ? body.surfaces[t] : 0;
    (surfaces.get(s) ?? surfaces.set(s, []).get(s)!).push(t);
  }
  const cell = 0.04 / unit,
    grids = [...surfaces.values()].map((list) => new TriangleGrid(bodyPos, body.indices, list, cell)),
    bary = new Float64Array(3),
    reach = 0.05 / unit;
  /** The signed offset of q over the surface at its closest point, or NaN where q lies off to the side (past an edge). */
  const over = (q: V3, pos: ArrayLike<number>, normals: ArrayLike<number>, tris: ArrayLike<number>, tri: number) => {
    const c: V3 = [0, 0, 0],
      nn: V3 = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      const vi = tris[tri * 3 + k];
      for (let d = 0; d < 3; d++) {
        c[d] += pos[vi * 3 + d] * bary[k];
        nn[d] += normals[vi * 3 + d] * bary[k];
      }
    }
    const off = sub(q, c),
      length = norm(off),
      side = dot3(off, nn) / (norm(nn) || 1);
    return length > 1e-9 && Math.abs(side) < 0.9 * length ? NaN : side;
  };
  const posed = fit.garments.map((g) => {
    const p = pose(g.positions, g.joints, g.weights),
      byPart = new Map<number, number[]>();
    // A triangle with no area (a V neckline folds the rows above its cut onto one point; skinned, those points part by
    // rounding) has no normal to measure along: its closest point lies on an edge its neighbours share, so it is left
    // out. It counts as flat when its height over its longest edge is under a micrometre.
    const height = (t: number) => {
      const [i, j, k] = [g.indices[t * 3] * 3, g.indices[t * 3 + 1] * 3, g.indices[t * 3 + 2] * 3],
        e1: V3 = [p[j] - p[i], p[j + 1] - p[i + 1], p[j + 2] - p[i + 2]],
        e2: V3 = [p[k] - p[i], p[k + 1] - p[i + 1], p[k + 2] - p[i + 2]];
      return norm(cross(e1, e2)) / (Math.max(norm(e1), norm(e2), norm(sub(e2, e1))) || 1);
    };
    for (let t = 0; t < g.faces.length; t++)
      if ((g.faces[t] === FACE.outer || g.faces[t] === FACE.inner) && !(g.seams[g.indices[t * 3]] && g.seams[g.indices[t * 3 + 1]] && g.seams[g.indices[t * 3 + 2]]) && height(t) > 1e-6 / unit) {
        const part = g.parts[g.indices[t * 3]];
        (byPart.get(part) ?? byPart.set(part, []).get(part)!).push(t);
      }
    const n = vertexNormals(p, g.indices, p.length / 3);
    return { g, p, n, grids: new Map([...byPart].map(([part, list]) => [part, new TriangleGrid(p, g.indices, list, cell)])) };
  });
  // Layers are compared part by part: a sleeve with the same arm's sleeves, a leg with the same leg and the trunk (coat
  // tails over trousers), the trunk with the trunk and both legs. A sleeve beside the trunk is no layer of it.
  const facing = (a: number, b: number) => a === b || (a === TRUNK && (b === LEG || b === LEG + 1)) || (b === TRUNK && (a === LEG || a === LEG + 1));
  let deepBody = 0,
    deepLayers = 0,
    worstBody = '',
    worstLayers = '',
    bodyAt: number[] = [],
    layersAt: number[] = [];
  for (const { g, p } of posed)
    for (let v = 0; v < p.length / 3; v++) {
      if (g.seams[v]) continue;
      const q: V3 = [p[v * 3], p[v * 3 + 1], p[v * 3 + 2]];
      for (const grid of grids) {
        const hit = grid.closest(q, reach, bary);
        if (hit.tri < 0) continue;
        const side = over(q, bodyPos, bodyN, body.indices, hit.tri);
        if (-side > deepBody) [deepBody, worstBody, bodyAt] = [-side, g.spec.name, [...q]];
      }
    }
  for (const A of posed)
    for (const B of posed) {
      if (A === B || A.g.spec.layer === B.g.spec.layer) continue;
      const th = B.g.thickness / unit,
        outer = A.g.spec.layer > B.g.spec.layer;
      for (let v = 0; v < A.p.length / 3; v++) {
        if (A.g.seams[v]) continue;
        const q: V3 = [A.p[v * 3], A.p[v * 3 + 1], A.p[v * 3 + 2]];
        for (const [part, grid] of B.grids) {
        if (!facing(A.g.parts[v], part)) continue;
        const hit = grid.closest(q, reach, bary);
        if (hit.tri < 0) continue;
        const side = over(q, B.p, B.n, B.g.indices, hit.tri);
        if (Number.isNaN(side)) continue;
        // The outer face points away from the body, the inner face toward it. An outer layer must lie past B's outer
        // face; an inner layer under B's inner face. Depth is how far it reaches the wrong way.
        const innerFace = B.g.faces[hit.tri] === FACE.inner,
          depth = outer ? (innerFace ? th + side : -side) : innerFace ? -side : th + side;
        if (depth > deepLayers) [deepLayers, worstLayers, layersAt] = [depth, `${A.g.spec.name} through ${B.g.spec.name}`, [...q]];
        }
      }
    }
  return { body: deepBody * unit, layers: deepLayers * unit, worst: { body: worstBody, bodyAt, layers: worstLayers, layersAt } };
}

// ---------------------------------------------------------------------------------------------------------------------
// The GLB and the one call.
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The fitted outfit as one GLB (binary glTF 2.0) on `model`'s skeleton: the model's node tree (names and rest
 * transforms, no meshes), one mesh on the body's skinned node with a primitive per garment, its skin over the body's
 * joints with the body's inverse bind matrices. Load it with `parseGLTFAsync` and play it with
 * `new Animation(outfit, {skeleton: model})`; {@link dressPerson} does both.
 * @example
 * const glb = fittedOutfitGLB(model, fitOutfit(riggedBody(model), 'townsman-1910'));
 */
export function fittedOutfitGLB(model: PBRModel, fit: FittedOutfit, materials: readonly string[] = BODY_MATERIALS): Uint8Array {
  const doc = model.asset.doc as unknown as Doc,
    picked = model.primitives.filter((p) => isBody(doc, p, materials) && doc.nodes[p.nodeIndex]?.skin !== undefined && !p.topology);
  if (!picked.length) throw new TypeError('fittedOutfitGLB needs the model the fit was made from');
  const skeleton = bodySkeleton(model, picked),
    host = skeleton.host;
  const chunks: Uint8Array[] = [],
    bufferViews: object[] = [],
    accessors: object[] = [];
  let length = 0;
  const view = (data: Float32Array | Uint32Array | Uint16Array, target?: number) => {
    chunks.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    bufferViews.push({ buffer: 0, byteOffset: length, byteLength: data.byteLength, ...(target ? { target } : {}) });
    length += (data.byteLength + 3) & ~3;
    if (data.byteLength & 3) chunks.push(new Uint8Array(4 - (data.byteLength & 3)));
    return bufferViews.length - 1;
  };
  const acc = (data: Float32Array | Uint32Array | Uint16Array, type: string, count: number, target?: number, extra = {}) => {
    accessors.push({ bufferView: view(data, target), componentType: data instanceof Float32Array ? 5126 : data instanceof Uint16Array ? 5123 : 5125, count, type, ...extra });
    return accessors.length - 1;
  };
  const materialsOut: object[] = [],
    primitives: object[] = [];
  for (const g of fit.garments) {
    const count = g.positions.length / 3,
      min = [Infinity, Infinity, Infinity],
      max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < g.positions.length; i++) {
      min[i % 3] = Math.min(min[i % 3], g.positions[i]);
      max[i % 3] = Math.max(max[i % 3], g.positions[i]);
    }
    const lobes = garmentMaterial(g.spec);
    materialsOut.push({
      name: g.spec.name,
      pbrMetallicRoughness: { baseColorFactor: [...lobes.baseColor, 1], metallicFactor: 0, roughnessFactor: lobes.roughness },
      doubleSided: true,
      ...(lobes.sheenColor.some((c) => c > 0) ? { extensions: { KHR_materials_sheen: { sheenColorFactor: [...lobes.sheenColor], sheenRoughnessFactor: lobes.sheenRoughness } } } : {}),
    });
    primitives.push({
      attributes: {
        POSITION: acc(g.positions, 'VEC3', count, 34962, { min, max }),
        NORMAL: acc(g.normals, 'VEC3', count, 34962),
        TEXCOORD_0: acc(g.uvs, 'VEC2', count, 34962),
        JOINTS_0: acc(g.joints, 'VEC4', count, 34962),
        WEIGHTS_0: acc(g.weights, 'VEC4', count, 34962),
      },
      indices: acc(g.indices, 'SCALAR', g.indices.length, 34963),
      material: materialsOut.length - 1,
    });
  }
  const ibmAccessor = acc(skeleton.inverseBinds, 'MAT4', skeleton.nodes.length);
  const nodes = doc.nodes.map((n, i) => ({
    ...(n.name !== undefined ? { name: n.name } : {}),
    ...(n.children?.length ? { children: [...n.children] } : {}),
    ...(n.matrix ? { matrix: [...n.matrix] } : {}),
    ...(n.translation ? { translation: [...n.translation] } : {}),
    ...(n.rotation ? { rotation: [...n.rotation] } : {}),
    ...(n.scale ? { scale: [...n.scale] } : {}),
    ...(i === host ? { mesh: 0, skin: 0 } : {}),
  }));
  const roots = doc.scenes?.[doc.scene ?? 0]?.nodes ?? doc.nodes.map((_, i) => i).filter((i) => !doc.nodes.some((n) => n.children?.includes(i)));
  const bin = new Uint8Array(length);
  let at = 0;
  for (const c of chunks) {
    bin.set(c, at);
    at += c.byteLength;
  }
  const json = {
    asset: { version: '2.0', generator: '@margoengine/humans/fit' },
    extensionsUsed: ['KHR_materials_sheen'],
    scene: 0,
    scenes: [{ nodes: [...roots] }],
    nodes,
    meshes: [{ name: 'outfit', primitives }],
    skins: [{ joints: [...skeleton.nodes], inverseBindMatrices: ibmAccessor }],
    materials: materialsOut,
    accessors,
    bufferViews,
    buffers: [{ byteLength: bin.byteLength }],
  };
  const raw = new TextEncoder().encode(JSON.stringify(json)),
    text = new Uint8Array((raw.length + 3) & ~3).fill(0x20);
  text.set(raw);
  const glb = new Uint8Array(12 + 8 + text.length + 8 + bin.length),
    dv = new DataView(glb.buffer);
  dv.setUint32(0, GLB_MAGIC, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, glb.length, true);
  dv.setUint32(12, text.length, true);
  dv.setUint32(16, GLB_JSON, true);
  glb.set(text, 20);
  dv.setUint32(20 + text.length, bin.length, true);
  dv.setUint32(24 + text.length, GLB_BIN, true);
  glb.set(bin, 28 + text.length);
  return glb;
}

/** Anything the outfit can join for shadows or ambient occlusion: `Shadows`, a GTAO pass. */
export interface OutfitReceiver {
  add(source: never, ...rest: never[]): unknown;
}
/** Options of {@link dressPerson}: the fit rows plus where the outfit joins the scene. */
export interface DressOptions extends FitOptions {
  /** The body's material, node or mesh names. Default {@link BODY_MATERIALS}. */
  readonly materials?: readonly string[];
  /** How the bones blend, as the person's: default `'dual-quaternion'` (addPerson's default). */
  readonly skinning?: 'dual-quaternion' | 'linear';
  /** Shadows to cast into and receive from, or false. Default the scene's (`scene.parts.shadows`), or the model scene's `Shadows`. */
  readonly shadows?: OutfitReceiver | false;
  /** An ambient occlusion pass to join. Default the scene's `parts.occlusion`, if a scene is passed. */
  readonly occlusion?: OutfitReceiver | false;
  /** A `@margoengine/scenes` handle whose `parts.shadows` and `parts.occlusion` are used when the two above are unset. */
  readonly scene?: { readonly parts: { readonly shadows?: OutfitReceiver; readonly occlusion?: OutfitReceiver } };
}
/** What {@link dressPerson} returns. Dispose it (or use `using`) to take the outfit off. */
export interface DressedPerson {
  /** The outfit model, a child of the person's model. */
  readonly model: PBRModel;
  /** The fit it was made from: pose, measurements, garments. */
  readonly fit: FittedOutfit;
  /** The Animation that skins the outfit to the person's skeleton. */
  readonly animation: Animation;
  dispose(): void;
  [Symbol.dispose](): void;
}
/**
 * Dresses a loaded person (an `addPerson` result, or the model itself) in one of the cast kit's outfits in one call:
 * measures the body in its rest pose, cuts and layers the garments to it, skins them to its skeleton so they follow
 * every clip, gives them their cloth (the measured sheen) and joins the scene's shadows.
 * @example
 * const person = await addPerson(engine, model, {scene});
 * const outfit = await dressPerson(engine, person, 'townsman-1910', {scene});
 * person.play('walk'); // the clothes walk with him
 * @throws TypeError for a model without a humanoid skinned body; RangeError for bad options.
 */
export async function dressPerson(
  engine: Engine,
  person: { readonly model: PBRModel } | PBRModel,
  outfit: OutfitName | Outfit,
  options: DressOptions = {},
): Promise<DressedPerson> {
  const model = 'primitives' in person ? person : person.model;
  if (!model || !Array.isArray(model.primitives) || model.root?.engine !== engine)
    throw new TypeError('dressPerson needs a person (addPerson) or a loaded gltf/pbr model of this engine');
  if (options.skinning !== undefined && options.skinning !== 'dual-quaternion' && options.skinning !== 'linear')
    throw new TypeError("dressPerson skinning must be 'dual-quaternion' or 'linear'");
  // The loader, materials and skinning load with the first dress: fitting alone (fitOutfit) needs none of them.
  const [{ parseGLTFAsync }, { install }, { Animation }, { dualQuaternionSkinning }] = await Promise.all([
    import('@margoengine/gltf/pbr'),
    import('@margoengine/materials'),
    import('@margoengine/animation'),
    import('@margoengine/animation/dqs'),
  ]);
  const kernel = engine as unknown as EngineKernel,
    materials = options.materials ?? BODY_MATERIALS,
    fit = fitOutfit(riggedBody(model, materials), outfit, options),
    // The outfit is a child of the model, so it loads into the model's scene, not whichever scene is active now: a
    // model in another scene would otherwise get a child from a foreign scene (Foreign parent).
    into = kernel.sceneOf(model as never) ?? model.root.scene,
    dressed = await sceneScope(kernel, into).run(() => parseGLTFAsync(kernel, fittedOutfitGLB(model, fit, materials)));
  const cleanups: (() => void)[] = [() => dressed.dispose?.()];
  try {
    dressed.root.setParent(model.root);
    const sheen = install(dressed);
    cleanups.push(() => sheen.dispose());
    const animation = new Animation(dressed, { skeleton: model, ...(options.skinning === 'linear' ? {} : { skinning: dualQuaternionSkinning }) });
    kernel.use(animation, into);
    cleanups.push(() => animation.dispose());
    const pick = (value: OutfitReceiver | false | undefined, fromScene: OutfitReceiver | undefined) => (value === false ? undefined : (value ?? fromScene));
    const shadows = pick(options.shadows, options.scene?.parts.shadows ?? (kernel.sceneOf(model as never)?.plugins.get('shadows') as OutfitReceiver | undefined)),
      occlusion = pick(options.occlusion, options.scene?.parts.occlusion);
    for (const r of [shadows, occlusion]) {
      if (!r) continue;
      if (typeof r.add !== 'function') throw new TypeError('dressPerson shadows and occlusion must have an add() method or be false');
      const off = r.add(dressed as never);
      if (typeof off === 'function') cleanups.push(off as () => void);
    }
    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      for (const step of cleanups.reverse()) step();
    };
    return { model: dressed, fit, animation, dispose, [Symbol.dispose]: dispose };
  } catch (error) {
    for (const step of cleanups.reverse()) step();
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Slider rows on the shared shape.
// ---------------------------------------------------------------------------------------------------------------------

/** The fit's slider rows: ease scale, ease over the body and the gap between layers. All refit the garments. */
export const FIT_SETTINGS: readonly SettingRow[] = [
  numberSetting('fit', 'fit', 1, 0, 4, 0.05, '', "Every garment's ease (its gap to the layer beneath) times this.", false),
  numberSetting('ease', 'fit', 0.003, 0, 0.1, 0.0005, 'm', 'Added to every ease over the body: covers its triangles and its skinning.', false),
  numberSetting('layerGap', 'fit', 0.002, 0, 0.05, 0.0005, 'm', 'Added between a garment and the garment under it.', false),
];
/** The row defaults. */
export const fitSettingDefaults = (): Record<string, unknown> => settingDefaults(FIT_SETTINGS);
/**
 * The {@link FitOptions} the slider values describe (rows left out take their defaults).
 * @example
 * fitOutfit(body, 'miner-1910', applyFitSettings({ fit: 1.5 }));
 */
export function applyFitSettings(values: Readonly<Record<string, number>>): Required<Omit<FitOptions, 'unit'>> {
  checkSettings(FIT_SETTINGS, values as never, 'humans/fit', 'FIT_SETTINGS in @margoengine/humans/fit');
  const v: Record<string, number> = {};
  applySettings(FIT_SETTINGS, values as never, 'humans/fit', (row, value) => (v[row.name] = value as number));
  return { fit: v.fit, ease: v.ease, layerGap: v.layerGap };
}
