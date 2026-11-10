/// <reference lib="esnext.disposable" preserve="true" />
// Clean-room JSON importer. See docs/clean-room.md, batch 245 job 4, for specification and research sources.
import { fault } from '../../shared/errors.js';
import { Skeleton2D, SkinnedMesh, solveChainIK, solveTwoBoneIK, type Bone } from './skeletal.js';
import {
  attachmentKey,
  bool,
  constraintList,
  duration,
  fail,
  names,
  num,
  obj,
  objects,
  readData,
  record,
  skinMap,
  str,
  values,
  type SpineObject,
  type SpineReadOptions,
  type SpineValue,
  type SpineWarning,
} from './spine-data.js';
import {
  angle,
  interpolate,
  keyPair,
  pathSampler,
  point,
  RAD,
  rgba,
  sample,
  setWorld,
  unpoint,
  updateBone,
  type Extra,
} from './spine-math.js';
import { geometry, regionGeometry, sequenceIndex, SpineAttachment, type SpineRegion } from './spine-mesh.js';
export { SpineAttachment, SpineMesh, type SpineRegion } from './spine-mesh.js';
export type { SpineObject, SpineValue, SpineReadOptions, SpineWarning } from './spine-data.js';

/** Rig instantiation settings. A document can create any number of independent rigs. */
export interface SpineSkeletonOptions {
  /** Named regions in one SpriteAtlas, already loaded by the application. Omitted: each image uses its own full size. */
  regions?: Readonly<Record<string, SpineRegion>>;
  /** Rig units per exported unit. Default 1. */
  scale?: number;
  /** Convert the export's y-up coordinates to sprite y-down coordinates. Default true. */
  yDown?: boolean;
  /** Initial skin. Default 'default', or the first skin if no default exists. */
  skin?: string;
}
/** Pose settings. Each call starts from setup pose, so backward seeks are deterministic. */
export interface SpinePoseOptions {
  /** Wrap time into the animation. Default true. */ loop?: boolean;
}
/** A named animation's complete exported timelines and its duration in seconds. */
export interface SpineAnimation {
  readonly name: string;
  readonly duration: number;
  readonly timelines: SpineObject;
}
/** Event values with definition defaults applied; audio is metadata for the application's audio system. */
export interface SpineEvent {
  name: string;
  time: number;
  int: number;
  float: number;
  string: string | null;
  audio: string | null;
  volume: number;
  balance: number;
}
/** Current slot colors and blend metadata, including two-color tint timelines. */
export interface SpineSlotState {
  color: number[];
  dark: number[];
  blend: string;
  attachment: string | null;
}

/** A validated, reusable exported document. Spine is a trademark of Esoteric Software LLC; no affiliation. */
export class SpineAsset {
  /** Every exported animation, including zero-duration setup clips. */
  readonly animations: ReadonlyMap<string, SpineAnimation>;
  /** Named skins, including their bone and constraint activation sets. */
  readonly skins: ReadonlyMap<string, SpineObject>;
  /** Physics is retained but not evaluated during Scott's physics hold. */
  readonly warnings: readonly SpineWarning[];
  /** @internal Use parseSpineJSON to validate input. */
  constructor(
    /** The complete validated export, including unknown metadata and physics timelines. */ readonly data: SpineObject,
  ) {
    this.skins = skinMap(data);
    this.animations = new Map(
      Object.entries(record(data.animations)).map(([name, a]) => [
        name,
        { name, duration: duration(a), timelines: obj(a) },
      ]),
    );
    this.warnings = constraintList(data)
      .filter((c) => c.kind === 'physics')
      .map(({ data: c }) => ({
        code: 'spine-physics-deferred',
        constraint: str(c.name),
        message: `Physics constraint ${str(c.name)} is retained but evaluation waits for the physics phase.`,
      }));
    for (const warning of this.warnings) console.warn(`${warning.code}: ${warning.message}`);
  }
  /** Create an independent job 2 Skeleton2D rig and SkinnedMesh attachments. */
  createSkeleton(options: SpineSkeletonOptions = {}): SpineSkeleton {
    return new SpineSkeleton(this, options);
  }
  /** Round-trip all exported fields, including physics definitions, resets, curves and metadata. */
  toJSON(): SpineObject {
    return this.data;
  }
}

/** Parse a JSON string or plain JSON object. Throws a coded 'failed' error for invalid data or exceeded limits. */
export function parseSpineJSON(input: unknown, options: SpineReadOptions = {}): SpineAsset {
  return new SpineAsset(readData(input, options));
}
/** Serialize a validated document, preserving all exported values. Whitespace and object identity are not retained. */
export function serializeSpineJSON(asset: SpineAsset): string {
  return JSON.stringify(asset.data);
}
/** Fetch a JSON document. AbortSignal covers the request, body read and validation. */
export async function loadSpineJSON(url: string | URL, options: SpineReadOptions = {}): Promise<SpineAsset> {
  options.signal?.throwIfAborted();
  const response = await fetch(url, { signal: options.signal });
  if (!response.ok) throw fault('failed', `Skeletal JSON request returned ${response.status}`, 'sprite-options');
  const text = await response.text();
  options.signal?.throwIfAborted();
  return parseSpineJSON(text, options);
}
const dummy = (skeleton: Skeleton2D) => {
  const mesh = new SkinnedMesh({
    skeleton,
    positions: [0, 0, 0, 0, 0, 0],
    uvs: [0, 0, 0, 0, 0, 0],
    indices: [0, 1, 2],
    joints: new Array(12).fill(0),
    weights: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
    jointPositions: new Array(24).fill(0),
  });
  mesh.visible = false;
  return mesh;
};
const mixValue = (c: SpineObject, modern: string, legacy: string, fallback = 1): number =>
  num(c[modern], num(c[legacy], fallback));

/** An imported rig, directly usable by SkeletalLayer.addSkeleton. Physics never affects its pose. */
export class SpineSkeleton extends Skeleton2D {
  /** Reusable source document. */
  readonly asset: SpineAsset;
  /** Per-slot animated light/dark colors, blend mode and unqualified attachment name. */
  readonly slotStates = new Map<string, SpineSlotState>();
  private readonly extras = new Map<Bone, Extra>();
  private readonly attachments = new Map<string, SpineAttachment>();
  private readonly sourceBones: SpineObject[];
  private readonly sourceSlots: SpineObject[];
  private readonly constraints: { kind: string; data: SpineObject }[];
  private readonly coordinateSign: number;
  private readonly unitScale: number;
  private readonly absoluteCurves: boolean;
  private skinName: string;
  private evaluatingSlider = false;

  constructor(asset: SpineAsset, options: SpineSkeletonOptions = {}) {
    const scale = options.scale ?? 1,
      sign = options.yDown === false ? 1 : -1,
      sourceBones = objects(asset.data.bones);
    if (!(scale > 0) || !Number.isFinite(scale)) fail('scale must be finite and positive');
    super(
      sourceBones.map((b) => ({
        name: str(b.name),
        parent: b.parent === undefined ? undefined : str(b.parent),
        x: num(b.x) * scale,
        y: num(b.y) * scale * sign,
        rotation: num(b.rotation) * RAD * sign,
        scaleX: num(b.scaleX, 1),
        scaleY: num(b.scaleY, 1),
        length: num(b.length) * scale,
      })),
    );
    this.asset = asset;
    this.sourceBones = sourceBones;
    this.sourceSlots = objects(asset.data.slots);
    this.coordinateSign = sign;
    this.unitScale = scale;
    this.absoluteCurves = Number.parseInt(str(record(asset.data.skeleton).spine, '3').split('.')[0], 10) >= 4;
    this.skinName =
      options.skin ?? (asset.skins.has('default') ? 'default' : (asset.skins.keys().next().value ?? 'default'));
    if (asset.skins.size && !asset.skins.has(this.skinName)) fail(`unknown skin ${this.skinName}`);
    this.constraints = constraintList(asset.data).filter((c) => c.kind !== 'physics');
    this.resetPose();
    this.update();
    const all = new Map<string, { data: SpineObject; slot: SpineObject; skin: string; name: string }>();
    for (const [skin, data] of asset.skins)
      for (const [slot, aa] of Object.entries(record(data.attachments)))
        for (const [name, a] of Object.entries(obj(aa)))
          all.set(attachmentKey(skin, slot, name), {
            data: obj(a),
            slot: this.sourceSlots.find((s) => s.name === slot)!,
            skin,
            name,
          });
    const build = (key: string): SpineAttachment => {
      const found = this.attachments.get(key);
      if (found) return found;
      const { data, slot, name } = all.get(key)!;
      const path = str(data.path, str(data.name, name)),
        sequence = data.sequence === undefined ? undefined : obj(data.sequence);
      const region = (index: number): SpineRegion => {
        const regionName = sequence
          ? path + String(index + num(sequence.start, 1)).padStart(num(sequence.digits), '0')
          : path;
        const r = options.regions?.[regionName];
        if (
          options.regions &&
          !r &&
          ['region', 'mesh', 'linkedmesh', 'weightedmesh', 'skinnedmesh'].includes(str(data.type, 'region'))
        )
          fail(`missing atlas region ${regionName}`);
        const result = r ?? { x: 0, y: 0, width: num(data.width, 1), height: num(data.height, 1) };
        if (
          ![result.x, result.y, result.width, result.height, result.offsetX ?? 0, result.offsetY ?? 0].every(
            Number.isFinite,
          ) ||
          result.width <= 0 ||
          result.height <= 0 ||
          ![0, 90, 180, 270].includes(result.rotation ?? 0)
        )
          fail('invalid atlas region');
        return result;
      };
      const bone = this.bones.findIndex((b) => b.name === slot.bone);
      let attachment: SpineAttachment;
      if (data.type === 'linkedmesh') {
        const parent = build(attachmentKey(str(data.skin, 'default'), str(slot.name), str(data.parent)));
        attachment = new SpineAttachment(data, this, parent.geometry, region);
        if (bool(data.deform, true)) attachment.source = parent.source;
      } else {
        const g =
          str(data.type, 'region') === 'region'
            ? regionGeometry(data, region(num(sequence?.setup)), bone, sign, scale)
            : geometry(data, bone, sign, scale);
        attachment = new SpineAttachment(data, this, g, region);
      }
      this.attachments.set(key, attachment);
      return attachment;
    };
    for (const key of all.keys()) build(key);
    for (const slot of this.sourceSlots) {
      const entries: [string, SkinnedMesh][] = [];
      for (const [key, a] of this.attachments)
        if ((JSON.parse(key) as string[])[1] === slot.name) entries.push([key, a.mesh ?? dummy(this)]);
      this.addSlot({
        name: str(slot.name),
        bone: str(slot.bone),
        attachments: Object.fromEntries(entries),
        attachment: null,
      });
    }
    this.resetSlots();
    this.applyConstraints(new Map());
    this.update();
  }
  /** Current skin name. */
  get skin(): string {
    return this.skinName;
  }
  /** Select a skin with default-skin fallback; resets slots and pose to setup. */
  setSkin(name: string): void {
    if (!this.asset.skins.has(name)) fail(`unknown skin ${name}`);
    this.skinName = name;
    this.resetPose();
    this.resetSlots();
    this.update();
    this.applyConstraints(new Map());
    this.update();
  }
  /** Lookup an attachment by slot, placeholder name and optional skin; defaults to the current selection. */
  getAttachment(slot: string, name?: string, skin = this.skinName): SpineAttachment | undefined {
    const selection = name ?? this.slotStates.get(slot)?.attachment;
    if (selection === null || selection === undefined) return undefined;
    return (
      this.attachments.get(attachmentKey(skin, slot, selection)) ??
      this.attachments.get(attachmentKey('default', slot, selection))
    );
  }
  /** Restore all local bone channels, including shear and inheritance. */
  override resetPose(): void {
    super.resetPose();
    if (!this.sourceBones) return;
    for (let i = 0; i < this.bones.length; i++) {
      const b = this.bones[i],
        data = this.sourceBones[i];
      this.extras.set(b, {
        shearX: num(data.shearX) * RAD * this.coordinateSign,
        shearY: num(data.shearY) * RAD * this.coordinateSign,
        inherit: str(data.transform ?? data.inherit, 'normal'),
        active: true,
      });
    }
    const skin = this.asset.skins.get(this.skinName),
      skinBones = new Set(names(skin?.bones));
    for (const b of this.bones)
      if (skinBones.has(b.name)) {
        let p: Bone | null = b;
        while (p) {
          skinBones.add(p.name);
          p = p.parent;
        }
      }
    for (let i = 0; i < this.bones.length; i++) {
      const b = this.bones[i];
      this.extras.get(b)!.active =
        (!bool(this.sourceBones[i].skin) || skinBones.has(b.name)) && (!b.parent || this.extras.get(b.parent)!.active);
    }
  }
  /** Update inherited world transforms and every currently drawn attachment, including clipping. */
  override update(): void {
    if (!this.extras?.size) {
      super.update();
      return;
    }
    for (const b of this.bones) {
      if (![b.x, b.y, b.rotation, b.scaleX, b.scaleY].every(Number.isFinite)) fail(`non-finite bone ${b.name}`);
      updateBone(b, this.extras.get(b)!);
    }
    let clipping: SpineAttachment | undefined;
    for (const slot of this.drawOrder) {
      const a = this.getAttachment(slot.name);
      if (a?.type === 'clipping' && !clipping) clipping = a;
      if (a?.mesh) {
        a.mesh.visible = this.extras.get(slot.bone)!.active;
        a.mesh.prepare(clipping?.worldVertices());
        const state = this.slotStates.get(slot.name)!,
          c = rgba(a.data.color);
        a.mesh.tint =
          Math.round(state.color[0] * c[0] * 255) * 65536 +
          Math.round(state.color[1] * c[1] * 255) * 256 +
          Math.round(state.color[2] * c[2] * 255);
        a.mesh.alpha = Math.max(0, Math.min(1, state.color[3] * c[3]));
        a.mesh.darkTint =
          Math.round(state.dark[0] * 255) * 65536 +
          Math.round(state.dark[1] * 255) * 256 +
          Math.round(state.dark[2] * 255);
        a.mesh.blendMode = state.blend === 'additive' ? 'add' : (state.blend as SkinnedMesh['blendMode']);
      }
      if (clipping && clipping.data.end === slot.name) clipping = undefined;
    }
  }
  private select(slot: string, name: string | null): void {
    const state = this.slotStates.get(slot)!;
    state.attachment = name;
    let key: string | null = null;
    if (name !== null) {
      const candidate = attachmentKey(this.skinName, slot, name),
        fallback = attachmentKey('default', slot, name);
      key = this.attachments.has(candidate) ? candidate : this.attachments.has(fallback) ? fallback : null;
    }
    this.slot(slot)!.setAttachment(key);
  }
  private resetSlots(): void {
    for (const s of this.sourceSlots) {
      const name = str(s.name);
      this.slotStates.set(name, {
        color: rgba(s.color),
        dark: rgba(s.dark, '000000'),
        blend: str(s.blend, 'normal'),
        attachment: null,
      });
      this.select(name, s.attachment === undefined ? null : str(s.attachment));
    }
    this.setDrawOrder(this.sourceSlots.map((s) => str(s.name)));
    for (const a of this.attachments.values()) {
      a.deformation.fill(0);
      a.sequenceIndex = a.data.sequence === undefined ? 0 : num(obj(a.data.sequence).setup);
    }
  }
  /** Pose any animation at seconds. Missing channels use setup values; constraints run in exported order. */
  pose(name: string, time: number, options: SpinePoseOptions = {}): void {
    const animation = this.asset.animations.get(name) ?? fail('unknown animation');
    if (!Number.isFinite(time)) fail('non-finite time');
    const d = animation.duration,
      t = options.loop !== false && d > 0 ? ((time % d) + d) % d : Math.max(0, Math.min(d, time)),
      data = animation.timelines;
    this.resetPose();
    this.resetSlots();
    for (const [boneName, raw] of Object.entries(record(data.bones))) {
      const b = this.bone(boneName)!,
        e = this.extras.get(b)!;
      for (const [type, timeline] of Object.entries(obj(raw))) {
        const keys = objects(timeline),
          get = (field: string, fallback = 0, channel = 0) =>
            sample(keys, t, field, fallback, channel, this.absoluteCurves);
        if (type === 'inherit') {
          const k = keyPair(keys, t)?.[0];
          if (k) e.inherit = str(k.inherit, 'normal');
          continue;
        }
        if (type === 'rotate') {
          const v = get(keys.some((k) => k.value !== undefined) ? 'value' : 'angle');
          if (v !== undefined) b.rotation += v * RAD * this.coordinateSign;
        } else {
          const scale = type.startsWith('scale'),
            shear = type.startsWith('shear'),
            split = type.endsWith('x') || type.endsWith('y');
          for (const [i, axis] of ['x', 'y'].entries()) {
            if (split && !type.endsWith(axis)) continue;
            const v = get(split ? 'value' : axis, scale ? 1 : 0, split ? 0 : i);
            if (v === undefined) continue;
            if (scale) {
              if (axis === 'x') b.scaleX *= v;
              else b.scaleY *= v;
            } else if (shear) {
              if (axis === 'x') e.shearX += v * RAD * this.coordinateSign;
              else e.shearY += v * RAD * this.coordinateSign;
            } else {
              if (axis === 'x') b.x += v * this.unitScale;
              else b.y += v * this.unitScale * this.coordinateSign;
            }
          }
        }
      }
    }
    for (const [slotName, raw] of Object.entries(record(data.slots)))
      for (const [type, timeline] of Object.entries(obj(raw))) {
        const keys = objects(timeline),
          pair = keyPair(keys, t);
        if (!pair) continue;
        const [a, b] = pair,
          state = this.slotStates.get(slotName)!;
        if (type === 'attachment') {
          this.select(slotName, a.name === undefined || a.name === null ? null : str(a.name));
          continue;
        }
        if (type === 'alpha') {
          state.color[3] = sample(keys, t, 'value', 1, 0, this.absoluteCurves)!;
          continue;
        }
        const lightName = type === 'twoColor' ? 'light' : type.includes('2') ? 'light' : 'color';
        const first = rgba(a[lightName] ?? a.color),
          last = rgba(b[lightName] ?? b.color),
          channels = type.startsWith('rgb') && !type.startsWith('rgba') ? 3 : 4;
        for (let i = 0; i < channels; i++)
          state.color[i] = a === b ? first[i] : interpolate(a, b, t, first[i], last[i], i, this.absoluteCurves);
        if (type === 'twoColor' || type.endsWith('2')) {
          const dark0 = rgba(a.dark, '000000'),
            dark1 = rgba(b.dark, '000000');
          for (let i = 0; i < 3; i++)
            state.dark[i] =
              a === b ? dark0[i] : interpolate(a, b, t, dark0[i], dark1[i], channels + i, this.absoluteCurves);
        }
        state.color = state.color.map((v) => Math.max(0, Math.min(1, v)));
        state.dark = state.dark.map((v) => Math.max(0, Math.min(1, v)));
      }
    this.poseAttachments(data.deform ?? data.ffd, t, false);
    this.poseAttachments(data.attachments, t, true);
    const order = keyPair(objects(data.drawOrder ?? data.draworder), t)?.[0];
    if (order) {
      const setup = this.sourceSlots.map((s) => str(s.name)),
        out: (string | undefined)[] = new Array(setup.length),
        moved = new Set<string>();
      for (const offset of objects(order.offsets)) {
        const name = str(offset.slot);
        out[setup.indexOf(name) + num(offset.offset)] = name;
        moved.add(name);
      }
      const rest = setup.filter((n) => !moved.has(n));
      let at = 0;
      for (let i = 0; i < out.length; i++) if (out[i] === undefined) out[i] = rest[at++];
      this.setDrawOrder(out as string[]);
    }
    const constraints = new Map<string, SpineObject>();
    for (const { kind, data: setup } of this.constraints) {
      const c = { ...setup },
        timelines = record(data[kind] ?? (kind === 'path' ? data.paths : undefined) ?? data.constraints),
        raw = timelines[str(setup.name)];
      const channels = Array.isArray(raw) ? { all: raw } : record(raw);
      for (const [channel, timeline] of Object.entries(channels)) {
        const keys = objects(timeline),
          pair = keyPair(keys, t);
        if (!pair) continue;
        const fields = new Set([...Object.keys(pair[0]), ...Object.keys(pair[1])]);
        fields.delete('time');
        fields.delete('curve');
        for (const field of fields) {
          const value = pair[0][field];
          if (typeof value === 'boolean') c[field] = value;
          else if (typeof value === 'number' || value === undefined)
            c[channel !== 'all' && field === 'value' ? channel : field] = sample(
              keys,
              t,
              field,
              1,
              [...fields].indexOf(field),
              this.absoluteCurves,
            )!;
        }
      }
      constraints.set(`${kind}/${str(c.name)}`, c);
    }
    this.update();
    this.applyConstraints(constraints);
    this.update();
  }
  private poseAttachments(raw: SpineValue | undefined, t: number, sequences: boolean): void {
    for (const [skin, ss] of Object.entries(record(raw)))
      for (const [slot, aa] of Object.entries(obj(ss)))
        for (const [name, timeline] of Object.entries(obj(aa))) {
          const target = this.attachments.get(attachmentKey(skin, slot, name))!;
          if (sequences && !Array.isArray(timeline)) {
            const channels = obj(timeline);
            if (channels.deform) this.deformAttachment(target, objects(channels.deform), t);
            if (channels.sequence) {
              const key = keyPair(objects(channels.sequence), t)?.[0];
              if (key) target.sequenceIndex = sequenceIndex(obj(target.data.sequence), key, t);
            }
          } else if (sequences) {
            const key = keyPair(objects(timeline), t)?.[0];
            if (key) target.sequenceIndex = sequenceIndex(obj(target.data.sequence), key, t);
          } else this.deformAttachment(target, objects(timeline), t);
        }
  }
  private deformAttachment(target: SpineAttachment, keys: SpineObject[], t: number): void {
    const pair = keyPair(keys, t);
    if (!pair) return;
    const [a, b] = pair,
      v0 = a.vertices === undefined ? [] : values(a.vertices),
      v1 = b.vertices === undefined ? [] : values(b.vertices);
    for (let i = 0; i < target.deformation.length; i++) {
      const x = v0[i - num(a.offset)] ?? 0,
        y = v1[i - num(b.offset)] ?? 0;
      // Deform curves describe a single 0..1 interpolation, independently of how many vertices are keyed.
      const f = a === b ? 0 : interpolate(a, b, t, 0, 1, 0, this.absoluteCurves);
      target.deformation[i] = (x + (y - x) * f) * this.unitScale * (i % 2 ? this.coordinateSign : 1);
    }
    for (const a of this.attachments.values())
      if (a !== target && a.source === target.source) a.deformation.set(target.deformation);
  }
  private applyConstraints(animated: Map<string, SpineObject>): void {
    if (this.evaluatingSlider) return;
    const skin = this.asset.skins.get(this.skinName);
    for (const { kind, data } of this.constraints) {
      const c = animated.get(`${kind}/${str(data.name)}`) ?? data;
      if (bool(c.skin) && ![...names(skin?.[kind]), ...names(skin?.constraints)].includes(str(c.name))) continue;
      const bones = names(c.bones ?? (c.bone === undefined ? undefined : [c.bone])).map((n) => this.bone(n)!);
      if (bones.some((b) => !this.extras.get(b)!.active)) continue;
      if (kind === 'slider') {
        this.applySlider(c);
        continue;
      }
      if (kind === 'ik') this.applyIK(c, bones);
      else if (kind === 'transform') this.applyTransform(c, bones);
      else this.applyPath(c, bones);
      this.update();
    }
  }
  private applyIK(c: SpineObject, bones: Bone[]): void {
    const target = this.bone(str(c.target))!,
      root = bones[0],
      mix = num(c.mix, 1),
      sign = this.coordinateSign;
    let tx = target.world[4],
      ty = target.world[5];
    const distance = Math.hypot(tx - root.world[4], ty - root.world[5]),
      length = bones.reduce((sum, b) => sum + Math.hypot(b.world[0], b.world[1]) * b.length, 0),
      softness = num(c.softness) * this.unitScale;
    if (softness > 0 && distance > length - softness) {
      const delta = Math.min(2, (distance - length + softness) / softness),
        eased = Math.min(length, distance - (softness * delta * delta) / 4),
        f = distance ? eased / distance : 0;
      tx = root.world[4] + (tx - root.world[4]) * f;
      ty = root.world[5] + (ty - root.world[5]) * f;
    }
    if (
      ((bool(c.stretch) && distance > length) || (bool(c.compress) && bones.length === 1 && distance < length)) &&
      length > 0
    ) {
      const factor = 1 + (distance / length - 1) * mix;
      root.scaleX *= factor;
      if (bool(c.uniform) || c.scaleYMode === 'uniform') root.scaleY *= factor;
      else if (c.scaleYMode === 'volume' && factor !== 0) root.scaleY /= factor;
      this.update();
    }
    const options = { mix, bendPositive: bool(c.bendPositive, true) === sign > 0, tolerance: 1e-6, iterations: 128 };
    if (bones.length === 2) solveTwoBoneIK(this, root.name, bones[1].name, [tx, ty], options);
    else if (root.length > 0) solveChainIK(this, [root.name], [tx, ty], options);
    else {
      const p = root.parent ? unpoint(root.parent.world, tx, ty) : [tx, ty];
      root.rotation += angle(Math.atan2(p[1] - root.y, p[0] - root.x) - root.rotation) * mix;
    }
  }
  private applyTransform(c: SpineObject, bones: Bone[]): void {
    if (c.properties !== undefined) {
      this.applyPropertyTransform(c, bones);
      return;
    }
    const target = this.bone(str(c.target))!,
      sign = this.coordinateSign,
      relative = bool(c.relative),
      local = bool(c.local),
      te = this.extras.get(target)!;
    const rotateMix = mixValue(c, 'mixRotate', 'rotateMix'),
      mx = mixValue(c, 'mixX', 'translateMix'),
      my = mixValue(c, 'mixY', 'translateMix'),
      sx = mixValue(c, 'mixScaleX', 'scaleMix'),
      sy = mixValue(c, 'mixScaleY', 'scaleMix'),
      shearMix = mixValue(c, 'mixShearY', 'shearMix');
    for (const b of bones) {
      const e = this.extras.get(b)!;
      if (local) {
        b.x += ((relative ? 0 : -b.x) + target.x + num(c.x) * this.unitScale) * mx;
        b.y += ((relative ? 0 : -b.y) + target.y + num(c.y) * this.unitScale * sign) * my;
        b.rotation += angle((relative ? 0 : -b.rotation) + target.rotation + num(c.rotation) * RAD * sign) * rotateMix;
        if (relative) {
          b.scaleX *= 1 + (target.scaleX - 1 + num(c.scaleX)) * sx;
          b.scaleY *= 1 + (target.scaleY - 1 + num(c.scaleY)) * sy;
        } else {
          b.scaleX += (target.scaleX + num(c.scaleX) - b.scaleX) * sx;
          b.scaleY += (target.scaleY + num(c.scaleY) - b.scaleY) * sy;
        }
        e.shearY += angle((relative ? 0 : -e.shearY) + te.shearY + num(c.shearY) * RAD * sign) * shearMix;
      } else {
        const m = [...b.world],
          t = target.world,
          reflect = t[0] * t[3] - t[1] * t[2] < 0 ? -1 : 1;
        const r =
          angle(
            Math.atan2(t[1], t[0]) - (relative ? 0 : Math.atan2(m[1], m[0])) + num(c.rotation) * RAD * sign * reflect,
          ) * rotateMix;
        const cs = Math.cos(r),
          sn = Math.sin(r),
          a = m[0],
          bb = m[1],
          cc = m[2],
          dd = m[3];
        m[0] = a * cs - bb * sn;
        m[1] = a * sn + bb * cs;
        m[2] = cc * cs - dd * sn;
        m[3] = cc * sn + dd * cs;
        const offset = point(t, num(c.x) * this.unitScale, num(c.y) * this.unitScale * sign);
        m[4] += (offset[0] - (relative ? 0 : m[4])) * mx;
        m[5] += (offset[1] - (relative ? 0 : m[5])) * my;
        const bx = Math.hypot(m[0], m[1]),
          by = Math.hypot(m[2], m[3]),
          tx = Math.hypot(t[0], t[1]),
          ty = Math.hypot(t[2], t[3]);
        const fx = relative ? 1 + (tx - 1 + num(c.scaleX)) * sx : bx ? 1 + ((tx + num(c.scaleX) - bx) / bx) * sx : 1;
        const fy = relative ? 1 + (ty - 1 + num(c.scaleY)) * sy : by ? 1 + ((ty + num(c.scaleY) - by) / by) * sy : 1;
        m[0] *= fx;
        m[1] *= fx;
        m[2] *= fy;
        m[3] *= fy;
        const current = angle(Math.atan2(m[3], m[2]) - Math.atan2(m[1], m[0]) - Math.PI / 2),
          desired = angle(Math.atan2(t[3], t[2]) - Math.atan2(t[1], t[0]) - Math.PI / 2);
        const sh =
            Math.atan2(m[3], m[2]) +
            angle(desired + num(c.shearY) * RAD * sign * reflect - (relative ? 0 : current)) * shearMix,
          len = Math.hypot(m[2], m[3]);
        m[2] = Math.cos(sh) * len;
        m[3] = Math.sin(sh) * len;
        setWorld(b, e, m);
      }
      this.update();
    }
  }
  private properties(b: Bone, local: boolean): Record<string, number> {
    const e = this.extras.get(b)!,
      m = b.world,
      sign = this.coordinateSign,
      scale = this.unitScale;
    const rotation = Math.atan2(m[1], m[0]),
      reflection = m[0] * m[3] - m[1] * m[2] < 0 ? -1 : 1;
    return local
      ? {
          x: b.x / scale,
          y: b.y / scale / sign,
          rotation: b.rotation / RAD / sign,
          rotate: b.rotation / RAD / sign,
          scaleX: b.scaleX,
          scaleY: b.scaleY,
          shearY: e.shearY / RAD / sign,
        }
      : {
          x: m[4] / scale,
          y: m[5] / scale / sign,
          rotation: rotation / RAD / sign,
          rotate: rotation / RAD / sign,
          scaleX: Math.hypot(m[0], m[1]),
          scaleY: Math.hypot(m[2], m[3]) * reflection,
          shearY: angle(Math.atan2(m[3] * reflection, m[2] * reflection) - rotation - Math.PI / 2) / RAD / sign,
        };
  }
  private applySlider(c: SpineObject): void {
    const name = str(c.animation),
      animation = this.asset.animations.get(name)!,
      mix = num(c.mix, 1),
      additive = bool(c.additive);
    if (mix === 0) return;
    const read = (b: Bone) => {
      const e = this.extras.get(b)!;
      return [b.x, b.y, b.rotation, b.scaleX, b.scaleY, e.shearX, e.shearY];
    };
    const write = (b: Bone, v: number[]) => {
      [b.x, b.y, b.rotation, b.scaleX, b.scaleY] = v;
      const e = this.extras.get(b)!;
      e.shearX = v[5];
      e.shearY = v[6];
    };
    const before = this.bones.map(read),
      extras = this.bones.map((b) => ({ ...this.extras.get(b)! }));
    const slotBefore = new Map(
      [...this.slotStates].map(([n, s]) => [n, { ...s, color: [...s.color], dark: [...s.dark] }]),
    );
    const order = this.drawOrder.map((s) => s.name),
      attachmentBefore = new Map(
        [...this.attachments].map(([key, a]) => [key, { deform: a.deformation.slice(), sequence: a.sequenceIndex }]),
      );
    let time = num(c.time);
    if (c.bone !== undefined) {
      const p = this.properties(this.bone(str(c.bone))!, bool(c.local));
      time = (p[str(c.property, 'x')] + num(c.offset)) * num(c.scale, 1);
    }
    this.evaluatingSlider = true;
    this.pose(name, time, { loop: bool(c.loop) });
    this.evaluatingSlider = false;
    const sampled = this.bones.map(read),
      sampledExtras = this.bones.map((b) => ({ ...this.extras.get(b)! }));
    for (let i = 0; i < this.bones.length; i++) {
      this.extras.set(this.bones[i], extras[i]);
      write(this.bones[i], before[i]);
    }
    for (const [boneName, raw] of Object.entries(record(animation.timelines.bones))) {
      const b = this.bone(boneName)!,
        i = this.bones.indexOf(b),
        channels = new Set<number>();
      for (const type of Object.keys(obj(raw))) {
        if (type === 'inherit') {
          if (mix >= 0.5) this.extras.get(b)!.inherit = sampledExtras[i].inherit;
          continue;
        }
        if (type === 'rotate') channels.add(2);
        else {
          const start = type.startsWith('translate') ? 0 : type.startsWith('scale') ? 3 : 5;
          if (!type.endsWith('y')) channels.add(start);
          if (!type.endsWith('x')) channels.add(start + 1);
        }
      }
      const result = [...before[i]],
        setup = [
          ...b.setup,
          num(this.sourceBones[i].shearX) * RAD * this.coordinateSign,
          num(this.sourceBones[i].shearY) * RAD * this.coordinateSign,
        ];
      for (const channel of channels)
        result[channel] += (sampled[i][channel] - (additive ? setup[channel] : result[channel])) * mix;
      write(b, result);
    }
    for (const [slot, s] of slotBefore) {
      const sampledState = this.slotStates.get(slot)!,
        keys = record(record(animation.timelines.slots)[slot]);
      if (Object.keys(keys).some((k) => k !== 'attachment')) {
        s.color = s.color.map((v, i) =>
          Math.max(0, Math.min(1, v + (sampledState.color[i] - (additive ? 1 : v)) * mix)),
        );
        s.dark = s.dark.map((v, i) => Math.max(0, Math.min(1, v + (sampledState.dark[i] - (additive ? 0 : v)) * mix)));
      }
      if (keys.attachment && mix >= 0.5) s.attachment = sampledState.attachment;
      this.slotStates.set(slot, s);
      this.select(slot, s.attachment);
    }
    if (!(animation.timelines.drawOrder ?? animation.timelines.draworder) || mix < 0.5) this.setDrawOrder(order);
    const keyed = new Set<string>();
    for (const timelines of [animation.timelines.deform ?? animation.timelines.ffd, animation.timelines.attachments])
      for (const [skin, ss] of Object.entries(record(timelines)))
        for (const [slot, aa] of Object.entries(obj(ss)))
          for (const attachment of Object.keys(obj(aa))) keyed.add(attachmentKey(skin, slot, attachment));
    const sources = new Set([...keyed].map((key) => this.attachments.get(key)!.source));
    for (const [key, previous] of attachmentBefore) {
      const a = this.attachments.get(key)!;
      if (sources.has(a.source))
        for (let i = 0; i < a.deformation.length; i++)
          a.deformation[i] = previous.deform[i] + (a.deformation[i] - (additive ? 0 : previous.deform[i])) * mix;
      else a.deformation.set(previous.deform);
      if (!keyed.has(key) || mix < 0.5) a.sequenceIndex = previous.sequence;
    }
    this.update();
  }
  private applyPropertyTransform(c: SpineObject, bones: Bone[]): void {
    const source = this.properties(this.bone(str(c.target))!, bool(c.localSource)),
      additive = bool(c.additive),
      localTarget = bool(c.localTarget);
    const mixNames: Record<string, string> = {
      rotation: 'mixRotate',
      rotate: 'mixRotate',
      x: 'mixX',
      y: 'mixY',
      scaleX: 'mixScaleX',
      scaleY: 'mixScaleY',
      shearY: 'mixShearY',
    };
    for (const b of bones) {
      const current = this.properties(b, localTarget),
        out = { ...current };
      for (const [from, raw] of Object.entries(record(c.properties))) {
        const property = obj(raw),
          value = source[from] - num(property.offset);
        for (const [to, target] of Object.entries(record(property.to))) {
          const mapping = obj(target),
            offset = num(mapping.offset),
            maximum = num(mapping.max, 100);
          let desired = value * num(mapping.scale, 1) + offset;
          if (bool(c.clamp))
            desired = Math.max(Math.min(offset, maximum), Math.min(Math.max(offset, maximum), desired));
          desired += num(c[to]);
          const mix = num(c[mixNames[to]], 1),
            key = to === 'rotate' ? 'rotation' : to;
          if (additive && key.startsWith('scale')) out[key] *= 1 + (desired - 1) * mix;
          else out[key] += (desired - (additive ? 0 : current[key])) * mix;
        }
      }
      const e = this.extras.get(b)!,
        r = out.rotation * RAD * this.coordinateSign,
        sh = out.shearY * RAD * this.coordinateSign;
      if (localTarget) {
        b.x = out.x * this.unitScale;
        b.y = out.y * this.unitScale * this.coordinateSign;
        b.rotation = r;
        b.scaleX = out.scaleX;
        b.scaleY = out.scaleY;
        e.shearY = sh;
      } else
        setWorld(b, e, [
          Math.cos(r) * out.scaleX,
          Math.sin(r) * out.scaleX,
          -Math.sin(r + sh) * out.scaleY,
          Math.cos(r + sh) * out.scaleY,
          out.x * this.unitScale,
          out.y * this.unitScale * this.coordinateSign,
        ]);
      this.update();
    }
  }
  private applyPath(c: SpineObject, bones: Bone[]): void {
    const path = this.getAttachment(str(c.target));
    if (path?.type !== 'path') return;
    const sampler = pathSampler(path.worldVertices(), path.data),
      mode = str(c.spacingMode, 'length'),
      rotateMode = str(c.rotateMode, 'tangent');
    const spacing = num(c.spacing),
      rotateMix = mixValue(c, 'mixRotate', 'rotateMix'),
      mx = mixValue(c, 'mixX', 'translateMix'),
      my = mixValue(c, 'mixY', 'translateMix');
    let distance = num(c.position) * (str(c.positionMode, 'percent') === 'percent' ? sampler.length : this.unitScale);
    const lengths = bones.map((b) => b.length * Math.hypot(b.world[0], b.world[1])),
      total = lengths.reduce((a, b) => a + b, 0);
    for (let i = 0; i < bones.length; i++) {
      const b = bones[i],
        p = sampler.at(distance),
        step =
          mode === 'percent'
            ? spacing * sampler.length
            : mode === 'proportional'
              ? total
                ? (spacing * sampler.length * lengths[i]) / total
                : 0
              : mode === 'fixed'
                ? spacing * this.unitScale
                : lengths[i] + spacing * this.unitScale;
      const next = sampler.at(distance + step),
        m = [...b.world];
      m[4] += (p.x - m[4]) * mx;
      m[5] += (p.y - m[5]) * my;
      const desired = rotateMode === 'tangent' ? p.angle : Math.atan2(next.y - p.y, next.x - p.x),
        r = angle(desired - Math.atan2(m[1], m[0]) + num(c.rotation) * RAD * this.coordinateSign) * rotateMix;
      const cs = Math.cos(r),
        sn = Math.sin(r),
        a = m[0],
        bb = m[1],
        cc = m[2],
        dd = m[3];
      m[0] = a * cs - bb * sn;
      m[1] = a * sn + bb * cs;
      m[2] = cc * cs - dd * sn;
      m[3] = cc * sn + dd * cs;
      if (rotateMode === 'chainScale' || rotateMode === 'chain scale') {
        const len = b.length * Math.hypot(m[0], m[1]);
        if (len > 0) {
          const factor = 1 + (Math.hypot(next.x - p.x, next.y - p.y) / len - 1) * rotateMix;
          m[0] *= factor;
          m[1] *= factor;
        }
      }
      setWorld(b, this.extras.get(b)!, m);
      this.update();
      distance += step;
    }
  }
  /** Events in (from, to], including each crossed loop. Pass from=-1 to include time zero. Backward seeks emit none. */
  eventsBetween(name: string, from: number, to: number, loop = true): SpineEvent[] {
    const animation = this.asset.animations.get(name) ?? fail('unknown animation');
    if (!Number.isFinite(from) || !Number.isFinite(to)) fail('invalid event interval');
    if (to < from) return [];
    const d = animation.duration,
      keys = objects(animation.timelines.events),
      out: SpineEvent[] = [];
    const first = loop && d > 0 ? Math.max(0, Math.floor(from / d)) : 0,
      last = loop && d > 0 ? Math.max(0, Math.floor(to / d)) : 0;
    if (last - first > 10000 || (last - first + 1) * keys.length > 1_000_000)
      fail('event interval exceeds resource limit');
    for (let cycle = first; cycle <= last; cycle++)
      for (const key of keys) {
        const time = num(key.time) + cycle * d;
        if (time <= from || time > to) continue;
        const eventName = str(key.name),
          base = obj(record(this.asset.data.events)[eventName]);
        out.push({
          name: eventName,
          time,
          int: num(key.int, num(base.int)),
          float: num(key.float, num(base.float)),
          string: key.string === undefined && base.string === undefined ? null : str(key.string, str(base.string)),
          audio: base.audio === undefined ? null : str(base.audio),
          volume: num(key.volume, num(base.volume, 1)),
          balance: num(key.balance, num(base.balance)),
        });
      }
    return out;
  }
}
