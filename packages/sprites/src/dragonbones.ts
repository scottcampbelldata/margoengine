/// <reference lib="esnext.disposable" preserve="true" />
// Clean-room DragonBones 5.x JSON reader on the shared skeletal JSON runtime. Sources: docs/clean-room.md,
// "DragonBones reader". DragonBones is a project of the DragonBones team; no affiliation or endorsement.
import { fault } from '../../shared/errors.js';
import type { SpineObject } from './spine-data.js';
import { parseSpineJSON, SpineSkeleton, type SpineAsset, type SpineRegion } from './spine.js';
import {
  apply,
  b,
  bad,
  colorHex,
  copyJSON,
  curveOf,
  int,
  invert,
  linear,
  n,
  nums,
  o,
  objs,
  poseMatrix,
  s,
  transformMatrix,
  type DragonBonesObject,
  type DragonBonesReadOptions,
  type Matrix,
} from './dragonbones-data.js';
export type { DragonBonesObject, DragonBonesReadOptions, DragonBonesValue } from './dragonbones-data.js';

/** A loaded texture atlas (`_tex.json`): named regions in texels of one page image. */
export interface DragonBonesAtlas {
  readonly name: string;
  /** The page image file named by the export, relative to the atlas file. */
  readonly imagePath: string;
  readonly width: number;
  readonly height: number;
  /** Texels per design unit. Default 1. */
  readonly scale: number;
  /** Regions by texture name, ready for `createArmature({ regions })` and a `SkeletalLayer` atlas of this page. */
  readonly regions: Readonly<Record<string, SpineRegion>>;
}
/** Parse options. `atlas` sizes image displays; without it, a document with image displays is rejected. */
export interface DragonBonesParseOptions extends DragonBonesReadOptions {
  /** A parsed atlas, or the `_tex.json` text or object. */
  atlas?: DragonBonesAtlas | unknown;
}
/** A diagnostic for exported data the shared runtime does not reproduce exactly. Emitted once per cause. */
export interface DragonBonesWarning {
  code:
    | 'dragonbones-color-offset'
    | 'dragonbones-blend-mode'
    | 'dragonbones-timeline-scale'
    | 'dragonbones-inherit-translation';
  armature: string;
  message: string;
}
/** A frame event, sound event or play action, at its time in seconds. */
export interface DragonBonesEvent {
  type: 'event' | 'sound' | 'play';
  name: string;
  time: number;
  bone: string | null;
  slot: string | null;
  ints: number[];
  floats: number[];
  strings: string[];
}
/** An exported animation. Durations are in seconds; `frames` is the exported length at the armature frame rate. */
export interface DragonBonesAnimation {
  readonly name: string;
  readonly duration: number;
  readonly frames: number;
  /** 0 loops forever; N plays N times and holds the last frame. */
  readonly playTimes: number;
  readonly fadeInTime: number;
  readonly events: readonly DragonBonesEvent[];
}
/** Armature instance settings. */
export interface DragonBonesArmatureOptions {
  /** Regions in the layer's atlas. Default: the regions of the atlas given to the parser. */
  regions?: Readonly<Record<string, SpineRegion>>;
  /** Rig units per exported unit. Default 1. */
  scale?: number;
  /** Initial skin by exported name ('' is the default skin). Default: the first skin. */
  skin?: string;
}
/** Pose settings. */
export interface DragonBonesPoseOptions {
  /** Shared-runtime form: true loops forever (play count 0), false plays once. Ignored when playTimes is given. */
  loop?: boolean;
  /** Override the animation's play count: 0 loops forever. Default: the exported `playTimes`. */
  playTimes?: number;
}

const BLENDS: Record<string, string> = { normal: 'normal', add: 'additive', multiply: 'multiply', screen: 'screen' };
const skinName = (name: string) => (name === '' ? 'default' : name);

/** Parse a `_tex.json` atlas description (string or object). Rotated regions are rejected. */
export function parseDragonBonesAtlas(input: unknown, options: DragonBonesReadOptions = {}): DragonBonesAtlas {
  const d = copyJSON(input, options),
    regions: Record<string, SpineRegion> = {};
  for (const t of objs(d.SubTexture, 'SubTexture')) {
    const name = s(t.name, '', 'SubTexture name');
    if (!name || regions[name]) bad(`empty or duplicate texture name ${name}`);
    if (b(t.rotated, false, 'SubTexture rotated'))
      bad(`texture ${name} is rotated in the atlas; export the atlas without rotation`);
    const x = n(t.x, 0, name),
      y = n(t.y, 0, name),
      width = n(t.width, NaN, name),
      height = n(t.height, NaN, name),
      fw = n(t.frameWidth, width, name),
      fh = n(t.frameHeight, height, name),
      fx = n(t.frameX, 0, name),
      fy = n(t.frameY, 0, name);
    if (!(width > 0 && height > 0 && fw >= width - fx && fh >= height - fy && fx <= 0 && fy <= 0 && x >= 0 && y >= 0))
      bad(`texture ${name} has an invalid rectangle or frame`);
    regions[name] = {
      x,
      y,
      width,
      height,
      originalWidth: fw,
      originalHeight: fh,
      offsetX: -fx,
      offsetY: fh + fy - height,
    };
  }
  const scale = n(d.scale, 1, 'atlas scale');
  if (!(scale > 0)) bad('atlas scale must be positive');
  return {
    name: s(d.name, '', 'atlas name'),
    imagePath: s(d.imagePath, '', 'atlas imagePath'),
    width: n(d.width, 0, 'atlas width'),
    height: n(d.height, 0, 'atlas height'),
    scale,
    regions,
  };
}
const fetchText = async (url: string | URL, signal?: AbortSignal) => {
  signal?.throwIfAborted();
  const response = await fetch(url, { signal });
  if (!response.ok) throw fault('failed', `DragonBones request returned ${response.status}`, 'sprite-options');
  const text = await response.text();
  signal?.throwIfAborted();
  return text;
};
/** Fetch and parse a `_tex.json` atlas. AbortSignal covers the request, body read and validation. */
export async function loadDragonBonesAtlas(url: string | URL, options: DragonBonesReadOptions = {}) {
  return parseDragonBonesAtlas(await fetchText(url, options.signal), options);
}

// ---- conversion ----------------------------------------------------------------------------------------------

interface Geometry {
  /** Per vertex: the bone each influence is in and the linear map from mesh space to that bone's bind space. */
  influences: { invLinear: Matrix }[][] | null;
  displayLinear: Matrix;
  vertexCount: number;
}
interface Instance {
  arm: DragonBonesObject;
  name: string;
  prefix: string;
  fps: number;
  bones: Map<string, string>; // db name -> out name
  boneOut: number[]; // db index -> out index
  slots: string[]; // db slot names, setup order
  slotOut: Map<string, string>;
  placeholders: Map<string, string[]>;
  baseSkin: DragonBonesObject | undefined;
  setupIndex: Map<string, number>;
  /** Host conditions: every one must show its display for this instance's slots to draw. */
  conditions: { inst: Instance; slot: string; index: number }[];
  children: Map<string, { index: number; inst: Instance }[]>; // host db slot -> nested instances
  play: string | undefined;
  geometry: Map<string, Geometry>; // `${skin}\n${slot}\n${display}` -> geometry
}
interface Context {
  data: DragonBonesObject;
  armatures: Map<string, DragonBonesObject>;
  atlas: DragonBonesAtlas | undefined;
  warnings: DragonBonesWarning[];
  warned: Set<string>;
  vertices: number;
  vertexLimit: number;
  top: string;
  out: {
    bones: SpineObject[];
    boneIndex: Map<string, number>;
    slots: SpineObject[];
    skins: Map<string, Record<string, Record<string, SpineObject>>>;
    ik: SpineObject[];
  };
}
const warn = (ctx: Context, code: DragonBonesWarning['code'], message: string) => {
  if (ctx.warned.has(code)) return;
  ctx.warned.add(code);
  ctx.warnings.push({ code, armature: ctx.top, message });
};
const named = (items: DragonBonesObject[], what: string) => {
  const m = new Map<string, DragonBonesObject>();
  for (const x of items) {
    const k = s(x.name, '', `${what} name`);
    if (m.has(k) || (!k && what !== 'skin')) bad(`empty or duplicate ${what} name ${k}`);
    m.set(k, x);
  }
  return m;
};
const fpsOf = (arm: DragonBonesObject, data: DragonBonesObject) => {
  const f = n(arm.frameRate, n(data.frameRate, 24, 'frameRate'), 'frameRate');
  return f > 0 ? f : bad('frameRate must be positive');
};
const boneFields = (t: DragonBonesObject | undefined, what: string) => {
  const skX = n(t?.skX, 0, what),
    skY = n(t?.skY, 0, what);
  return {
    x: n(t?.x, 0, what),
    y: n(t?.y, 0, what),
    rotation: skY,
    shearY: skX - skY,
    scaleX: n(t?.scX, 1, what),
    scaleY: n(t?.scY, 1, what),
  };
};
const geometryKey = (skin: string, slot: string, display: string) => `${skin}\n${slot}\n${display}`;

/** Build one armature instance's bones, slots and attachments into the shared output; recurse into nested ones. */
function instantiate(
  ctx: Context,
  name: string,
  prefix: string,
  hostBone: string | undefined,
  conditions: Instance['conditions'],
  play: string | undefined,
  depth: number,
): Instance {
  if (depth > 8) bad(`armature ${name} nests too deeply or recursively`);
  const arm = ctx.armatures.get(name) ?? bad(`unknown armature ${name}`),
    what = `armature ${name}`,
    out = ctx.out;
  const inst: Instance = {
    arm,
    name,
    prefix,
    fps: fpsOf(arm, ctx.data),
    bones: new Map(),
    boneOut: [],
    slots: [],
    slotOut: new Map(),
    placeholders: new Map(),
    baseSkin: undefined,
    setupIndex: new Map(),
    conditions,
    children: new Map(),
    play,
    geometry: new Map(),
  };
  const bones = objs(arm.bone, `${what} bone`);
  if (!bones.length) bad(`${what} needs at least one bone`);
  named(bones, 'bone');
  for (const bone of bones) {
    const dbName = s(bone.name, '', 'bone name'),
      parent = bone.parent === undefined || bone.parent === null ? undefined : s(bone.parent, '', 'bone parent');
    if (parent !== undefined && !inst.bones.has(parent)) bad(`bone ${dbName} has an unknown or later parent ${parent}`);
    const rot = b(bone.inheritRotation, true, 'inheritRotation'),
      scale = b(bone.inheritScale, true, 'inheritScale'),
      reflect = b(bone.inheritReflection, true, 'inheritReflection');
    if (!b(bone.inheritTranslation, true, 'inheritTranslation'))
      warn(ctx, 'dragonbones-inherit-translation', 'inheritTranslation false is read as true');
    const inherit =
      parent === undefined
        ? 'normal'
        : !rot && !scale
          ? 'onlyTranslation'
          : !rot
            ? 'noRotationOrReflection'
            : !scale
              ? reflect
                ? 'noScale'
                : 'noScaleOrReflection'
              : 'normal';
    const outName = prefix + dbName;
    if (out.boneIndex.has(outName)) bad(`bone name ${outName} is used twice after nesting`);
    const length = n(bone.length, 0, 'bone length');
    if (length < 0) bad('negative bone length');
    out.boneIndex.set(outName, out.bones.length);
    inst.boneOut.push(out.bones.length);
    out.bones.push({
      name: outName,
      ...(parent !== undefined ? { parent: prefix + parent } : hostBone !== undefined ? { parent: hostBone } : {}),
      ...boneFields(bone.transform === undefined ? undefined : o(bone.transform, 'bone transform'), `bone ${dbName}`),
      length,
      inherit,
      ...(bone.userData === undefined ? {} : { dragonBones: { userData: bone.userData } }),
    });
    inst.bones.set(dbName, outName);
  }
  const slots = objs(arm.slot, `${what} slot`);
  named(slots, 'slot');
  const skins = named(objs(arm.skin, `${what} skin`), 'skin');
  inst.baseSkin = skins.get('') ?? skins.values().next().value;
  const displaysOf = (skin: DragonBonesObject | undefined, slot: string) =>
    objs(objs(skin?.slot, 'skin slot').find((x) => s(x.name, '', 'skin slot name') === slot)?.display, 'slot display');
  for (const skin of skins.values())
    for (const entry of objs(skin.slot, 'skin slot'))
      if (!slots.some((x) => x.name === entry.name)) bad(`skin slot ${String(entry.name)} has no slot`);
  for (const slot of slots) {
    const dbName = s(slot.name, '', 'slot name'),
      bone = inst.bones.get(s(slot.parent, '', 'slot parent')) ?? bad(`slot ${dbName} has an unknown parent bone`);
    const list = displaysOf(inst.baseSkin, dbName),
      used = new Set<string>(),
      placeholders: string[] = [];
    let longest = list.length;
    for (const skin of skins.values()) longest = Math.max(longest, displaysOf(skin, dbName).length);
    for (let i = 0; i < longest; i++) {
      let p = i < list.length ? s(list[i].name, '', 'display name') : '';
      if (!p || used.has(p)) p = `${p}#${i}`;
      used.add(p);
      placeholders.push(p);
    }
    inst.placeholders.set(dbName, placeholders);
    const index = Math.trunc(n(slot.displayIndex, 0, 'displayIndex'));
    inst.setupIndex.set(dbName, index);
    const blend = s(slot.blendMode, 'normal', 'blendMode');
    if (!BLENDS[blend]) warn(ctx, 'dragonbones-blend-mode', `blend mode ${blend} draws as normal`);
    const color = colorHex(slot.color === undefined ? undefined : o(slot.color, 'slot color'), 'slot color');
    if (color.offset) warn(ctx, 'dragonbones-color-offset', 'colour offsets are not drawn; multipliers are');
    const visible = conditions.every((c) => c.inst.setupIndex.get(c.slot) === c.index);
    const outName = prefix + dbName;
    if (out.slots.some((x) => x.name === outName)) bad(`slot name ${outName} is used twice after nesting`);
    inst.slots.push(dbName);
    inst.slotOut.set(dbName, outName);
    out.slots.push({
      name: outName,
      bone,
      color: color.hex,
      blend: BLENDS[blend] ?? 'normal',
      ...(visible && index >= 0 && index < placeholders.length ? { attachment: placeholders[index] } : {}),
    });
    // Displays of every skin. Nested armatures become child instances drawn right after this slot.
    for (const [dbSkin, skin] of skins) {
      const target = depth === 0 ? skinName(dbSkin) : 'default';
      if (depth > 0 && skin !== inst.baseSkin) continue;
      const displays = displaysOf(skin, dbName);
      displays.forEach((d, i) => {
        const type = s(d.type, 'image', 'display type');
        if (type === 'armature') {
          if (skin !== inst.baseSkin) return;
          const childName = s(d.path, s(d.name, '', 'display name'), 'display path');
          const actions = objs(d.actions, 'display actions');
          const childPlay =
            actions.length && actions[0].gotoAndPlay !== undefined
              ? s(actions[0].gotoAndPlay, '', 'gotoAndPlay')
              : undefined;
          const childBone = `${outName}#${i}`;
          if (out.boneIndex.has(childBone)) bad(`bone name ${childBone} is used twice after nesting`);
          out.boneIndex.set(childBone, out.bones.length);
          out.bones.push({
            name: childBone,
            parent: bone,
            ...boneFields(d.transform === undefined ? undefined : o(d.transform, 'display transform'), childBone),
          });
          const child = instantiate(
            ctx,
            childName,
            `${childBone}/`,
            childBone,
            [...conditions, { inst, slot: dbName, index: i }],
            childPlay,
            depth + 1,
          );
          const list = inst.children.get(dbName) ?? [];
          list.push({ index: i, inst: child });
          inst.children.set(dbName, list);
          return;
        }
        const attachment = convertDisplay(ctx, inst, skin, displays, d, type, bone, `${dbName} display ${i}`);
        const skinOut = out.skins.get(target) ?? {};
        out.skins.set(target, skinOut);
        const slotOut = (skinOut[outName] ??= {});
        slotOut[placeholders[i]] = attachment;
        inst.geometry.set(geometryKey(dbSkin, dbName, s(d.name, '', 'display name')), attachment.__geometry as never);
        delete attachment.__geometry;
      });
    }
  }
  // Inverse kinematics: `bone` is the chain's end, `chain` its count of parents (0 or 1).
  for (const ik of objs(arm.ik, `${what} ik`)) {
    const end = s(ik.bone, '', 'ik bone'),
      target = s(ik.target, '', 'ik target'),
      chain = int(ik.chain, 0, 'ik chain');
    const endBone = bones.find((x) => x.name === end) ?? bad(`IK bone ${end} is unknown`);
    if (!inst.bones.has(target)) bad(`IK target ${target} is unknown`);
    if (chain > 1) bad(`IK ${String(ik.name)} chain ${chain} is longer than two bones`);
    const parent =
      endBone.parent === undefined || endBone.parent === null ? undefined : s(endBone.parent, '', 'parent');
    if (chain === 1 && parent === undefined) bad(`IK ${String(ik.name)} chain needs a parent bone`);
    const chainBones = chain === 1 ? [prefix + parent, prefix + end] : [prefix + end];
    out.ik.push({
      name: prefix + s(ik.name, '', 'ik name'),
      order: out.ik.length,
      bones: chainBones,
      target: prefix + target,
      bendPositive: b(ik.bendPositive, true, 'ik bendPositive'),
      mix: Math.max(0, Math.min(1, n(ik.weight, 1, 'ik weight'))),
    });
  }
  return inst;
}

/** One display to a shared-runtime attachment, with its geometry for deform conversion. */
function convertDisplay(
  ctx: Context,
  inst: Instance,
  skin: DragonBonesObject,
  displays: DragonBonesObject[],
  d: DragonBonesObject,
  type: string,
  bone: string,
  what: string,
): SpineObject {
  const m = transformMatrix(d.transform === undefined ? undefined : o(d.transform, 'display transform'), what),
    lin: Matrix = [m[0], m[1], m[2], m[3], 0, 0],
    path = s(d.path, s(d.name, '', 'display name'), 'display path');
  const count = (k: number) => {
    if ((ctx.vertices += k) > ctx.vertexLimit) bad('vertex resource limit exceeded');
  };
  if (type === 'image') {
    const r =
      ctx.atlas?.regions[path] ?? bad(`image display ${path} needs an atlas region (pass the _tex.json as atlas)`);
    const scale = ctx.atlas!.scale,
      fw = (r.originalWidth ?? r.width) / scale,
      fh = (r.originalHeight ?? r.height) / scale,
      w = r.width / scale,
      h = r.height / scale,
      left = (r.offsetX ?? 0) / scale,
      top = fh - (r.offsetY ?? 0) / scale - h;
    const pivot = d.pivot === undefined ? undefined : o(d.pivot, 'display pivot'),
      px = n(pivot?.x, 0.5, 'pivot x'),
      py = n(pivot?.y, 0.5, 'pivot y');
    const x0 = left - px * fw,
      y0 = top - py * fh,
      corners = [
        [x0, y0],
        [x0 + w, y0],
        [x0 + w, y0 + h],
        [x0, y0 + h],
      ];
    count(4);
    return {
      type: 'mesh',
      path,
      uvs: corners.flatMap(([x, y]) => [(x + px * fw) / fw, (y + py * fh) / fh]),
      triangles: [0, 1, 2, 2, 3, 0],
      vertices: corners.flatMap(([x, y]) => apply(m, x, y)),
      hull: 4,
      width: fw,
      height: fh,
      dragonBones: { type: 'image' },
      __geometry: { influences: null, displayLinear: lin, vertexCount: 4 } as never,
    };
  }
  let source = d;
  if (type === 'mesh' && d.share !== undefined && d.share !== null) {
    const share = s(d.share, '', 'mesh share');
    source =
      displays.find((x) => x.name === share && x.type === 'mesh' && x.share === undefined) ??
      objs(skin.slot, 'skin slot')
        .flatMap((x) => objs(x.display, 'slot display'))
        .find((x) => x.name === share && x.type === 'mesh' && x.share === undefined) ??
      bad(`${what} shares unknown mesh ${share}`);
  }
  if (type === 'boundingBox') {
    const sub = s(d.subType, 'rectangle', 'boundingBox subType');
    let vertices: number[];
    if (sub === 'rectangle' || sub === 'ellipse') {
      const w = n(d.width, 0, 'boundingBox width'),
        h = n(d.height, 0, 'boundingBox height');
      if (!(w >= 0 && h >= 0)) bad(`${what} needs a nonnegative size`);
      const k = sub === 'rectangle' ? 4 : 64;
      vertices = [];
      for (let i = 0; i < k; i++) {
        const a = sub === 'rectangle' ? 0 : (i / k) * 2 * Math.PI,
          [x, y] =
            sub === 'rectangle'
              ? [(i === 1 || i === 2 ? 0.5 : -0.5) * w, (i >= 2 ? 0.5 : -0.5) * h]
              : [Math.cos(a) * w * 0.5, Math.sin(a) * h * 0.5];
        vertices.push(...apply(m, x, y));
      }
    } else if (sub === 'polygon') {
      const v = nums(d.vertices, 'boundingBox vertices');
      if (v.length < 6 || v.length % 2) bad(`${what} polygon needs three or more points`);
      if (d.weights !== undefined) return weighted(ctx, inst, d, v, what, 'boundingbox', path, count);
      vertices = [];
      for (let i = 0; i < v.length; i += 2) vertices.push(...apply(m, v[i], v[i + 1]));
    } else return bad(`${what} has unknown boundingBox subType ${sub}`);
    count(vertices.length / 2);
    return {
      type: 'boundingbox',
      vertexCount: vertices.length / 2,
      vertices,
      dragonBones: {
        type: 'boundingBox',
        subType: sub,
        ...(sub === 'polygon' ? {} : { width: n(d.width, 0, 'w'), height: n(d.height, 0, 'h') }),
      },
      __geometry: { influences: null, displayLinear: lin, vertexCount: vertices.length / 2 } as never,
    };
  }
  if (type !== 'mesh') return bad(`${what} has unknown display type ${type}`);
  const v = nums(source.vertices, 'mesh vertices'),
    uvs = nums(source.uvs, 'mesh uvs'),
    triangles = nums(source.triangles, 'mesh triangles'),
    count0 = v.length / 2;
  if (!v.length || v.length % 2 || uvs.length !== v.length) bad(`${what} needs matching vertex and uv pairs`);
  if (
    !triangles.length ||
    triangles.length % 3 ||
    triangles.some((t) => !Number.isSafeInteger(t) || t < 0 || t >= count0)
  )
    bad(`${what} has invalid triangles`);
  const geometry: SpineObject =
    source.weights !== undefined
      ? weighted(ctx, inst, source, v, what, 'mesh', path, count)
      : (count(count0),
        {
          type: 'mesh',
          path,
          vertices: Array.from({ length: count0 }, (_, i) => apply(m, v[i * 2], v[i * 2 + 1])).flat(),
          __geometry: { influences: null, displayLinear: lin, vertexCount: count0 } as never,
        });
  return {
    ...geometry,
    uvs,
    triangles,
    ...(source.width === undefined ? {} : { width: n(source.width, 0, 'mesh width') }),
    ...(source.height === undefined ? {} : { height: n(source.height, 0, 'mesh height') }),
    dragonBones: { type: 'mesh', ...(d.share === undefined ? {} : { share: s(d.share, '', 'share') }) },
  };
}

/** Weighted vertices: bind each influence in its bone's bind pose (`bonePose`), from mesh space via `slotPose`. */
function weighted(
  ctx: Context,
  inst: Instance,
  d: DragonBonesObject,
  v: number[],
  what: string,
  type: string,
  path: string,
  count: (k: number) => void,
): SpineObject {
  const weights = nums(d.weights, 'weights'),
    slotPose =
      d.slotPose === undefined
        ? ([1, 0, 0, 1, 0, 0] as Matrix)
        : poseMatrix(nums(d.slotPose, 'slotPose'), 0, 'slotPose'),
    poses = nums(d.bonePose, 'bonePose'),
    binds = new Map<number, Matrix>();
  if (poses.length % 7) bad(`${what} bonePose must hold groups of seven`);
  for (let i = 0; i < poses.length; i += 7) {
    const index = poses[i];
    if (!Number.isSafeInteger(index) || index < 0 || index >= inst.boneOut.length)
      bad(`${what} bonePose bone out of range`);
    binds.set(index, poseMatrix(poses, i + 1, 'bonePose'));
  }
  const out: number[] = [],
    influences: Geometry['influences'] = [],
    slotLinear: Matrix = [slotPose[0], slotPose[1], slotPose[2], slotPose[3], 0, 0];
  let at = 0;
  for (let i = 0; i < v.length / 2; i++) {
    const k = weights[at++];
    if (!Number.isSafeInteger(k) || k < 1 || at + k * 2 > weights.length) bad(`${what} has a truncated weight record`);
    const [wx, wy] = apply(slotPose, v[i * 2], v[i * 2 + 1]),
      list: { invLinear: Matrix }[] = [];
    out.push(k);
    let sum = 0;
    for (let j = 0; j < k; j++) {
      const index = weights[at++],
        weight = weights[at++];
      const bind = binds.get(index) ?? bad(`${what} weights a bone with no bonePose`);
      if (!(weight >= 0)) bad(`${what} has a negative weight`);
      const inv = invert(bind, `${what} bonePose`),
        [lx, ly] = apply(inv, wx, wy),
        il: Matrix = [inv[0], inv[1], inv[2], inv[3], 0, 0];
      sum += weight;
      out.push(inst.boneOut[index], lx, ly, weight);
      list.push({
        invLinear: [
          il[0] * slotLinear[0] + il[2] * slotLinear[1],
          il[1] * slotLinear[0] + il[3] * slotLinear[1],
          il[0] * slotLinear[2] + il[2] * slotLinear[3],
          il[1] * slotLinear[2] + il[3] * slotLinear[3],
          0,
          0,
        ],
      });
    }
    if (!(sum > 0)) bad(`${what} has a vertex with no positive weight`);
    influences.push(list);
  }
  if (at !== weights.length) bad(`${what} has trailing weight data`);
  count(v.length / 2);
  return {
    type,
    path,
    ...(type === 'boundingbox' ? { vertexCount: v.length / 2 } : {}),
    vertices: out,
    __geometry: { influences, displayLinear: [1, 0, 0, 1, 0, 0], vertexCount: v.length / 2 } as never,
  };
}

/** Key start frames of a frame list (integers, so repeated cycles stay exactly ordered). */
const timesOf = (frames: DragonBonesObject[], what: string) => {
  let at = 0;
  return frames.map((f) => {
    const t = at;
    at += int(f.duration, 1, `${what} duration`);
    return t;
  });
};
/** A clip of one instance inside one top-level animation: which animation and how it repeats on the top clock. */
interface Clip {
  anim: DragonBonesObject | undefined;
  /** Cycle length in frames at `fps`. */
  period: number;
  fps: number;
  repeats: number;
}
/** Repeat one cycle of keys (times in frames) across a clip, in seconds. A repeated cycle ends at its period. */
const repeat = (keys: SpineObject[], clip: Clip): SpineObject[] => {
  const cycle = clip.repeats > 1 ? keys.filter((k) => (k.time as number) <= clip.period) : keys,
    outKeys: SpineObject[] = [];
  for (let r = 0; r < clip.repeats; r++)
    for (const k of cycle) outKeys.push({ ...k, time: ((k.time as number) + r * clip.period) / clip.fps });
  return outKeys;
};
/** Step function of a display index over the top clock, as sorted [time, index] with the setup value first. */
type Steps = [number, number][];

function convertAnimations(ctx: Context, top: Instance, all: Instance[], signal?: AbortSignal) {
  const animations: Record<string, SpineObject> = {},
    events: Record<string, SpineObject> = {},
    info = new Map<string, DragonBonesAnimation>(),
    animsOf = (inst: Instance) => named(objs(inst.arm.animation, 'animation'), 'animation');
  const tops = animsOf(top);
  for (const [name, anim] of tops) {
    signal?.throwIfAborted();
    const frames = int(anim.duration, 1, 'animation duration'),
      duration = frames / top.fps,
      out: SpineObject = {},
      clips = new Map<Instance, Clip>();
    for (const inst of all) {
      if (inst === top) {
        clips.set(inst, { anim, period: frames, fps: top.fps, repeats: 1 });
        continue;
      }
      const list = animsOf(inst),
        defaults = objs(inst.arm.defaultActions, 'defaultActions'),
        pick = inst.play ?? (defaults.length ? s(defaults[0].gotoAndPlay, '', 'gotoAndPlay') : undefined),
        a =
          pick === undefined ? list.values().next().value : (list.get(pick) ?? bad(`unknown nested animation ${pick}`));
      const period = a ? int(a.duration, 1, 'animation duration') : 0,
        playTimes = a ? int(a.playTimes, 1, 'playTimes') : 1,
        need = period > 0 ? Math.max(1, Math.ceil((duration * inst.fps) / period - 1e-9)) : 1;
      clips.set(inst, { anim: a, period, fps: inst.fps, repeats: playTimes === 0 ? need : Math.min(playTimes, need) });
    }
    const displaySteps = new Map<Instance, Map<string, Steps>>();
    for (const inst of all) {
      const clip = clips.get(inst)!,
        a = clip.anim,
        steps = new Map<string, Steps>();
      displaySteps.set(inst, steps);
      for (const [slot, index] of inst.setupIndex) steps.set(slot, [[0, index]]);
      if (!a) continue;
      const what = `animation ${inst.name}/${String(a.name)}`;
      // Bone timelines: translate adds, rotate adds (with turn direction), skew adds to shear, scale multiplies.
      for (const tl of objs(a.bone, `${what} bone`)) {
        const dbName = s(tl.name, '', 'bone timeline name'),
          bone = inst.bones.get(dbName) ?? bad(`${what} animates unknown bone ${dbName}`);
        if (tl.frame !== undefined) bad(`${what} uses the pre-5.5 bone "frame" layout; re-export as 5.5 JSON`);
        if (n(tl.offset, 0, 'timeline offset') !== 0 || ![0, 1].includes(n(tl.scale, 1, 'timeline scale')))
          warn(ctx, 'dragonbones-timeline-scale', 'timeline scale and offset are read as 1 and 0');
        const channels: SpineObject = {};
        const keys = (frames: DragonBonesObject[], map: (f: DragonBonesObject, i: number) => SpineObject) => {
          const times = timesOf(frames, what);
          return repeat(
            frames.map((f, i) => {
              const c = i < frames.length - 1 ? curveOf(f, what) : undefined;
              return { time: times[i], ...map(f, i), ...(c === undefined ? {} : { curve: c }) };
            }),
            clip,
          );
        };
        const tf = objs(tl.translateFrame, 'translateFrame');
        if (tf.length) channels.translate = keys(tf, (f) => ({ x: n(f.x, 0, 'x'), y: n(f.y, 0, 'y') }));
        const rf = objs(tl.rotateFrame, 'rotateFrame');
        if (rf.length) {
          let previous = 0;
          const unwrapped = rf.map((f, i) => {
            const r = n(f.rotate, 0, 'rotate');
            if (i === 0) return (previous = r);
            const turn = Math.trunc(n(rf[i - 1].clockwise, 0, 'clockwise'));
            let delta = r - n(rf[i - 1].rotate, 0, 'rotate');
            if (turn === 0) delta -= 360 * Math.round(delta / 360);
            else if (turn > 0) delta = (((delta % 360) + 360) % 360) + 360 * (turn - 1);
            else delta = -((((-delta % 360) + 360) % 360) + 360 * (-turn - 1));
            return (previous += delta);
          });
          channels.rotate = keys(rf, (_, i) => ({ value: unwrapped[i] }));
          if (rf.some((f) => n(f.skew, 0, 'skew') !== 0))
            channels.shear = keys(rf, (f) => ({ x: 0, y: n(f.skew, 0, 'skew') }));
        }
        const sf = objs(tl.scaleFrame, 'scaleFrame');
        if (sf.length) channels.scale = keys(sf, (f) => ({ x: n(f.x, 1, 'x'), y: n(f.y, 1, 'y') }));
        if (Object.keys(channels).length) ((out.bones ??= {}) as SpineObject)[bone] = channels;
      }
      for (const tl of objs(a.slot, `${what} slot`)) {
        const dbName = s(tl.name, '', 'slot timeline name');
        if (!inst.slotOut.has(dbName)) bad(`${what} animates unknown slot ${dbName}`);
        if (tl.frame !== undefined) bad(`${what} uses the pre-5.5 slot "frame" layout; re-export as 5.5 JSON`);
        const df = objs(tl.displayFrame, 'displayFrame');
        if (df.length) {
          const times = timesOf(df, what),
            st: Steps = [];
          for (let r = 0; r < clip.repeats; r++)
            df.forEach((f, i) => {
              if (clip.repeats === 1 || times[i] <= clip.period)
                st.push([(times[i] + r * clip.period) / clip.fps, Math.trunc(n(f.value, 0, 'display value'))]);
            });
          if (st[0][0] > 0) st.unshift([0, inst.setupIndex.get(dbName)!]);
          steps.set(dbName, st);
        }
        const cf = objs(tl.colorFrame, 'colorFrame');
        if (cf.length) {
          const times = timesOf(cf, what);
          const ks = repeat(
            cf.map((f, i) => {
              const c = colorHex(
                f.value === undefined && f.color === undefined ? undefined : o(f.value ?? f.color, 'color'),
                'color',
              );
              if (c.offset) warn(ctx, 'dragonbones-color-offset', 'colour offsets are not drawn; multipliers are');
              const curve = i < cf.length - 1 ? curveOf(f, what) : undefined;
              return { time: times[i], color: c.hex, ...(curve === undefined ? {} : { curve }) };
            }),
            clip,
          );
          const slots = ((out.slots ??= {}) as SpineObject)[inst.slotOut.get(dbName)!] ?? {};
          (slots as SpineObject).rgba = ks;
          (out.slots as SpineObject)[inst.slotOut.get(dbName)!] = slots;
        }
      }
      // Free-form deformation: per-vertex offsets in mesh space, mapped into bone space per influence.
      for (const tl of objs(a.ffd, `${what} ffd`)) {
        const display = s(tl.name, '', 'ffd name'),
          slot = s(tl.slot, '', 'ffd slot'),
          dbSkin = s(tl.skin, '', 'ffd skin'),
          skins = named(objs(inst.arm.skin, 'skin'), 'skin'),
          skin = skins.get(dbSkin) ?? (dbSkin === '' ? inst.baseSkin : undefined) ?? bad(`${what} ffd skin unknown`);
        const realSkin = s(skin.name, '', 'skin name');
        const targets: { slot: string; display: string }[] = [];
        const g =
          inst.geometry.get(geometryKey(realSkin, slot, display)) ?? bad(`${what} ffd targets unknown mesh ${display}`);
        targets.push({ slot, display });
        for (const entry of objs(skin.slot, 'skin slot'))
          for (const d of objs(entry.display, 'display'))
            if (d.share === display && d.inheritDeform !== false && d.type === 'mesh')
              targets.push({ slot: s(entry.name, '', 'slot'), display: s(d.name, '', 'display') });
        const ffdFrames = objs(tl.frame, 'ffd frame'),
          times = timesOf(ffdFrames, what);
        const ks = repeat(
          ffdFrames.map((f, i) => {
            const offset = int(f.offset, 0, 'ffd offset'),
              raw = nums(f.vertices, 'ffd vertices'),
              full = new Array<number>(g.vertexCount * 2).fill(0),
              vertices: number[] = [];
            if (offset + raw.length > full.length) bad(`${what} ffd range exceeds the mesh`);
            raw.forEach((x, j) => (full[offset + j] = x));
            for (let vi = 0; vi < g.vertexCount; vi++) {
              const dx = full[vi * 2],
                dy = full[vi * 2 + 1];
              if (g.influences) for (const inf of g.influences[vi]) vertices.push(...linear(inf.invLinear, dx, dy));
              else vertices.push(...linear(g.displayLinear, dx, dy));
            }
            const c = i < ffdFrames.length - 1 ? curveOf(f, what) : undefined;
            return { time: times[i], offset: 0, vertices, ...(c === undefined ? {} : { curve: c }) };
          }),
          clip,
        );
        const outSkin = inst.prefix ? 'default' : skinName(realSkin);
        const deform = ((out.deform ??= {}) as SpineObject)[outSkin] ?? {};
        (out.deform as SpineObject)[outSkin] = deform;
        for (const t of targets) {
          const slotName = inst.slotOut.get(t.slot) ?? bad(`${what} ffd slot ${t.slot} is unknown`);
          const list = inst.placeholders.get(t.slot)!,
            index = objs(objs(skin.slot, 'skin slot').find((x) => x.name === t.slot)?.display, 'display').findIndex(
              (x) => x.name === t.display,
            );
          const slotDeform = ((deform as SpineObject)[slotName] ??= {}) as SpineObject;
          slotDeform[list[index]] = ks;
        }
      }
      for (const tl of objs(a.ik, `${what} ik`)) {
        const ikName = inst.prefix + s(tl.name, '', 'ik timeline name');
        if (!ctx.out.ik.some((x) => x.name === ikName)) bad(`${what} animates unknown IK ${ikName}`);
        const ikFrames = objs(tl.frame, 'ik frame'),
          times = timesOf(ikFrames, what);
        ((out.ik ??= {}) as SpineObject)[ikName] = repeat(
          ikFrames.map((f, i) => {
            const c = i < ikFrames.length - 1 ? curveOf(f, what) : undefined;
            return {
              time: times[i],
              mix: Math.max(0, Math.min(1, n(f.weight, 1, 'ik weight'))),
              bendPositive: b(f.bendPositive, true, 'ik bendPositive'),
              ...(c === undefined ? {} : { curve: c }),
            };
          }),
          clip,
        );
      }
    }
    // Attachments: a slot draws its display when every nesting host shows the nested armature.
    const at = (st: Steps, t: number) => {
      let v = st[0][1];
      for (const [time, value] of st) if (time <= t) v = value;
      return v;
    };
    for (const inst of all) {
      const chain = inst.conditions.map((c) => displaySteps.get(c.inst)!.get(c.slot)!);
      for (const slot of inst.slots) {
        const own = displaySteps.get(inst)!.get(slot)!,
          sources = [own, ...chain];
        if (sources.every((x) => x.length === 1)) continue;
        const times = [...new Set(sources.flatMap((x) => x.map((p) => p[0])))].sort((p, q) => p - q),
          placeholders = inst.placeholders.get(slot)!;
        const keys = times.map((t) => {
          const shown = inst.conditions.every((c, i) => at(chain[i], t) === c.index),
            index = at(own, t);
          return { time: t, name: shown && index >= 0 && index < placeholders.length ? placeholders[index] : null };
        });
        const slots = ((out.slots ??= {}) as SpineObject)[inst.slotOut.get(slot)!] ?? {};
        (slots as SpineObject).attachment = keys;
        (out.slots as SpineObject)[inst.slotOut.get(slot)!] = slots;
      }
    }
    // Draw order: each instance's z-order keys (listed slot moves by its offset; others keep setup order), with
    // nested armatures drawn in place of the slot that hosts them, as one full ordering per key time.
    const orderSteps = new Map<Instance, { time: number; order: string[] }[]>();
    for (const inst of all) {
      const clip = clips.get(inst)!,
        z = clip.anim?.zOrder === undefined ? undefined : o(clip.anim.zOrder, 'zOrder');
      const list = [{ time: 0, order: inst.slots }];
      if (z) {
        const zf = objs(z.frame, 'zOrder frame'),
          times = timesOf(zf, 'zOrder');
        for (let r = 0; r < clip.repeats; r++)
          zf.forEach((f, i) => {
            if (clip.repeats > 1 && times[i] > clip.period) return;
            const offsets = nums(f.zOrder, 'zOrder');
            if (offsets.length % 2) bad('zOrder needs slot index and offset pairs');
            const order = new Array<string | undefined>(inst.slots.length),
              moved = new Set<number>();
            for (let j = 0; j < offsets.length; j += 2) {
              const index = offsets[j],
                target = index + offsets[j + 1];
              if (!Number.isSafeInteger(index) || index < 0 || index >= inst.slots.length || moved.has(index))
                bad('zOrder slot index out of range');
              if (!Number.isSafeInteger(target) || target < 0 || target >= order.length || order[target] !== undefined)
                bad('zOrder offset out of range');
              order[target] = inst.slots[index];
              moved.add(index);
            }
            const rest = inst.slots.filter((_, j) => !moved.has(j));
            let k = 0;
            for (let j = 0; j < order.length; j++) if (order[j] === undefined) order[j] = rest[k++];
            list.push({ time: (times[i] + r * clip.period) / clip.fps, order: order as string[] });
          });
      }
      orderSteps.set(inst, list);
    }
    if ([...orderSteps.values()].some((x) => x.length > 1)) {
      const times = [...new Set([...orderSteps.values()].flatMap((x) => x.map((p) => p.time)))].sort((p, q) => p - q);
      const orderAt = (inst: Instance, t: number): string[] => {
        let current = inst.slots;
        for (const p of orderSteps.get(inst)!) if (p.time <= t) current = p.order;
        return current.flatMap((slot) => [
          inst.slotOut.get(slot)!,
          ...(inst.children.get(slot) ?? []).flatMap((c) => orderAt(c.inst, t)),
        ]);
      };
      const setup = ctx.out.slots.map((x) => x.name as string);
      out.drawOrder = times.map((t) => {
        const order = orderAt(top, t);
        return {
          time: t,
          offsets: setup.map((name, i) => ({ slot: name, offset: order.indexOf(name) - i })).filter((x) => x.offset),
        };
      });
    }
    // Frame events, sound events and play actions on the top armature's action timeline.
    const list: DragonBonesEvent[] = [];
    const actionFrames = objs(anim.frame, 'action frame'),
      times = timesOf(actionFrames, 'action frame').map((t) => t / top.fps);
    actionFrames.forEach((f, i) => {
      const push = (type: DragonBonesEvent['type'], e: DragonBonesObject | string) => {
        const x = typeof e === 'string' ? { name: e } : e;
        const bone = x.bone === undefined || x.bone === null ? null : s(x.bone, '', 'event bone'),
          slot = x.slot === undefined || x.slot === null ? null : s(x.slot, '', 'event slot');
        if (bone !== null && !top.bones.has(bone)) bad(`event bone ${bone} is unknown`);
        if (slot !== null && !top.slotOut.has(slot)) bad(`event slot ${slot} is unknown`);
        list.push({
          type,
          name: s(x.name, '', 'event name'),
          time: times[i],
          bone,
          slot,
          ints: nums(x.ints, 'ints'),
          floats: nums(x.floats, 'floats'),
          strings: (Array.isArray(x.strings) ? x.strings : []).map((v) => s(v, '', 'strings')),
        });
      };
      for (const a of objs(f.actions, 'actions')) {
        const type = int(a.type, 0, 'action type');
        push(
          type === 10 ? 'event' : type === 11 ? 'sound' : 'play',
          a.name === undefined ? { ...a, name: s(a.gotoAndPlay, '', 'gotoAndPlay') } : a,
        );
      }
      for (const e of objs(f.events, 'events')) push('event', e);
      if (f.event !== undefined) push('event', s(f.event, '', 'event'));
      if (f.sound !== undefined) push('sound', s(f.sound, '', 'sound'));
      if (f.action !== undefined) push('play', s(f.action, '', 'action'));
    });
    const spineEvents = list
      .filter((e) => e.type !== 'play')
      .map((e) => {
        events[e.name] ??= {};
        return {
          time: e.time,
          name: e.name,
          ...(e.ints.length ? { int: e.ints[0] } : {}),
          ...(e.floats.length ? { float: e.floats[0] } : {}),
          ...(e.strings.length ? { string: e.strings[0] } : {}),
          ...(e.type === 'sound' ? { audio: e.name } : {}),
        };
      });
    if (spineEvents.length) out.events = spineEvents;
    animations[name] = out;
    info.set(name, {
      name,
      duration,
      frames,
      playTimes: int(anim.playTimes, 1, 'playTimes'),
      fadeInTime: n(anim.fadeInTime, 0, 'fadeInTime'),
      events: list,
    });
  }
  return { animations, events, info };
}

/** One exported armature: its animations, skins and the shared-runtime document it converts to. */
export class DragonBonesArmatureData {
  readonly name: string;
  readonly frameRate: number;
  readonly animations: ReadonlyMap<string, DragonBonesAnimation>;
  /** The first `defaultActions` animation, or null. */
  readonly defaultAnimation: string | null;
  /** Exported skin names; '' is the default skin. */
  readonly skins: readonly string[];
  /** The converted document on the shared skeletal JSON runtime, including nested armatures flattened in place. */
  readonly asset: SpineAsset;
  readonly warnings: readonly DragonBonesWarning[];
  /** @internal */
  constructor(
    readonly source: DragonBonesObject,
    data: DragonBonesObject,
    armatures: Map<string, DragonBonesObject>,
    atlas: DragonBonesAtlas | undefined,
    options: DragonBonesReadOptions,
  ) {
    this.name = s(source.name, '', 'armature name');
    const ctx: Context = {
      data,
      armatures,
      atlas,
      warnings: [],
      warned: new Set(),
      vertices: 0,
      vertexLimit: options.maxVertices ?? 1_000_000,
      top: this.name,
      out: { bones: [], boneIndex: new Map(), slots: [], skins: new Map(), ik: [] },
    };
    if (!Number.isSafeInteger(ctx.vertexLimit) || ctx.vertexLimit < 1) bad('invalid resource limit');
    const all: Instance[] = [];
    const top = instantiate(ctx, this.name, '', undefined, [], undefined, 0);
    const collect = (i: Instance) => {
      all.push(i);
      for (const list of i.children.values()) for (const c of list) collect(c.inst);
    };
    collect(top);
    this.frameRate = top.fps;
    const { animations, events, info } = convertAnimations(ctx, top, all, options.signal);
    const skins = [...named(objs(source.skin, 'skin'), 'skin').keys()];
    this.skins = skins;
    if (!ctx.out.skins.has('default') && (all.length > 1 || !skins.length)) ctx.out.skins.set('default', {});
    for (const skin of skins) if (!ctx.out.skins.has(skinName(skin))) ctx.out.skins.set(skinName(skin), {});
    const converted: SpineObject = {
      skeleton: { spine: '3.8.99', dragonBones: s(data.version, '', 'version'), name: this.name },
      bones: ctx.out.bones,
      slots: ctx.out.slots,
      ik: ctx.out.ik,
      skins: [...ctx.out.skins].map(([name, attachments]) => ({ name, attachments })),
      events,
      animations,
    };
    const limit = options.maxValues ?? 1_000_000;
    this.asset = parseSpineJSON(converted, {
      maxValues: Math.min(Number.MAX_SAFE_INTEGER, limit * 8),
      maxVertices: ctx.vertexLimit * 8,
    });
    this.animations = info;
    const defaults = objs(source.defaultActions, 'defaultActions');
    const first = defaults.length ? defaults[0].gotoAndPlay : undefined;
    this.defaultAnimation = first === undefined || first === null ? null : s(first, '', 'gotoAndPlay');
    this.warnings = ctx.warnings;
  }
  /** Create an independent rig, directly usable by `SkeletalLayer.addSkeleton`. */
  createArmature(options: DragonBonesArmatureOptions = {}): DragonBonesArmature {
    return new DragonBonesArmature(this, options);
  }
}
const defaultRegions: WeakMap<DragonBonesArmatureData, Readonly<Record<string, SpineRegion>>> = new WeakMap();

/** A validated DragonBones document with every armature converted. */
export class DragonBonesData {
  readonly name: string;
  readonly version: string;
  readonly frameRate: number;
  readonly armatures: ReadonlyMap<string, DragonBonesArmatureData>;
  readonly atlas: DragonBonesAtlas | undefined;
  /** Diagnostics of every armature, in document order. */
  readonly warnings: readonly DragonBonesWarning[];
  /** @internal Use parseDragonBonesJSON. */
  constructor(
    readonly data: DragonBonesObject,
    atlas: DragonBonesAtlas | undefined,
    options: DragonBonesReadOptions,
  ) {
    const version = s(data.version, '', 'version'),
      compatible = s(data.compatibleVersion, version, 'compatibleVersion'),
      major = Number.parseInt((compatible || version).split('.')[0], 10);
    if (!(major >= 5)) bad(`version ${version || 'unknown'} is not read; export DragonBones 5.5 JSON`);
    this.name = s(data.name, '', 'name');
    this.version = version;
    this.frameRate = n(data.frameRate, 24, 'frameRate');
    this.atlas = atlas;
    const sources = named(objs(data.armature, 'armature'), 'armature'),
      armatures = new Map<string, DragonBonesArmatureData>();
    for (const [name, source] of sources) {
      options.signal?.throwIfAborted();
      const a = new DragonBonesArmatureData(source, data, sources, atlas, options);
      if (atlas) defaultRegions.set(a, atlas.regions);
      armatures.set(name, a);
    }
    this.armatures = armatures;
    this.warnings = [...armatures.values()].flatMap((a) => a.warnings);
  }
  /** Create a rig of a named armature (default: the first). */
  createArmature(name?: string, options: DragonBonesArmatureOptions = {}): DragonBonesArmature {
    const a = name === undefined ? this.armatures.values().next().value : this.armatures.get(name);
    if (!a) return bad(`unknown armature ${name ?? ''}`);
    return a.createArmature(options);
  }
  /** The validated source document, including user data. */
  toJSON(): DragonBonesObject {
    return this.data;
  }
}

/** An imported armature on the shared skeletal runtime. Times are in seconds. */
export class DragonBonesArmature extends SpineSkeleton {
  readonly armature: DragonBonesArmatureData;
  constructor(armature: DragonBonesArmatureData, options: DragonBonesArmatureOptions = {}) {
    const regions = options.regions ?? defaultRegions.get(armature);
    super(armature.asset, {
      yDown: false,
      scale: options.scale ?? 1,
      ...(regions ? { regions } : {}),
      ...(options.skin === undefined
        ? armature.skins.length
          ? { skin: skinName(armature.skins[0]) }
          : {}
        : { skin: skinName(options.skin) }),
    });
    this.armature = armature;
  }
  /** Pose an animation at seconds from its start, looping or holding as its play count says. */
  override pose(name: string, time: number, options: DragonBonesPoseOptions = {}): void {
    const a = this.armature.animations.get(name) ?? bad(`unknown animation ${name}`);
    if (!Number.isFinite(time)) bad('non-finite time');
    const times = options.playTimes ?? (options.loop === undefined ? a.playTimes : options.loop ? 0 : 1),
      d = a.duration;
    if (!Number.isSafeInteger(times) || times < 0) bad('playTimes must be a nonnegative integer');
    const t = d <= 0 ? 0 : time < 0 ? 0 : times !== 0 && time >= d * times ? d : time % d;
    super.pose(name, t, { loop: false });
  }
  /** Frame events, sound events and play actions with `from <= time < to` on the unwrapped (looping) clock. */
  frameEvents(name: string, from: number, to: number, options: DragonBonesPoseOptions = {}): DragonBonesEvent[] {
    const a = this.armature.animations.get(name) ?? bad(`unknown animation ${name}`);
    if (!Number.isFinite(from) || !Number.isFinite(to)) bad('non-finite time');
    const times = options.playTimes ?? a.playTimes,
      d = a.duration,
      out: DragonBonesEvent[] = [];
    if (!(to > from)) return out;
    const loops = d <= 0 ? 1 : times === 0 ? Infinity : times;
    // An event at the very end of a cycle (time d) belongs to that cycle, so start one cycle early.
    const first = d <= 0 ? 0 : Math.max(0, Math.floor(from / d) - 1);
    for (let k = first; k < loops && (d <= 0 ? k === 0 : k * d < to); k++)
      for (const e of a.events) {
        const t = e.time + k * d;
        if (t >= from && t < to) out.push({ ...e, time: t });
      }
    return out;
  }
}

/** Parse a `_ske.json` document (string, object or UTF-8 bytes). Throws a coded 'failed' error on invalid data. */
export function parseDragonBonesJSON(input: unknown, options: DragonBonesParseOptions = {}): DragonBonesData {
  const data = copyJSON(input, options);
  const raw = options.atlas;
  const atlas =
    raw === undefined
      ? undefined
      : raw && typeof raw === 'object' && 'regions' in raw && 'scale' in raw
        ? (raw as DragonBonesAtlas)
        : parseDragonBonesAtlas(raw, options);
  return new DragonBonesData(data, atlas, options);
}
/** Fetch and parse a `_ske.json` document, and its `_tex.json` atlas when `atlas` is a URL. */
export async function loadDragonBonesJSON(
  url: string | URL,
  options: Omit<DragonBonesParseOptions, 'atlas'> & { atlas?: string | URL | DragonBonesAtlas } = {},
): Promise<DragonBonesData> {
  const atlas =
    typeof options.atlas === 'string' || options.atlas instanceof URL
      ? await loadDragonBonesAtlas(
          new URL(options.atlas, url instanceof URL ? url : new URL(url, globalThis.location?.href)),
          options,
        )
      : options.atlas;
  return parseDragonBonesJSON(await fetchText(url, options.signal), { ...options, atlas });
}
