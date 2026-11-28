/// <reference lib="esnext.disposable" preserve="true" />
// People in one call: addPerson(engine, model) dresses a loaded character the way a film needs it. Skin, eyes and strand
// hair go on by glTF material name (@margoengine/materials), an Animator plays the clips with cross-fades
// (@margoengine/animator over @margoengine/animation, dual quaternion skinning), and the model joins the scene's
// shadows, ambient occlusion and sky light. Each later default (hands, face, cloth) is one lazy import below, so a page pays only
// for what a person uses.
import type { Engine } from '@margoengine/core';
import type { Engine as EngineKernel } from '@margoengine/core/extension';
import type { PBRModel } from '@margoengine/gltf/pbr-model';
import { Animation } from '@margoengine/animation';
import { dualQuaternionSkinning } from '@margoengine/animation/dqs';
import { Animator } from '@margoengine/animator';
import { install, Texture, type MaterialInstallation, type ModelFeatures } from '@margoengine/materials';
import { skin, type SkinOptions } from '@margoengine/materials/skin';
import { eye, type EyeLid, type EyeOptions } from '@margoengine/materials/eye';
import { eyeLidMargin } from './eye-lid.js';

export { eyeLidMargin, type EyeBall, type EyeLidMargin } from './eye-lid.js';
import { hair, hairCards, type HairCardOptions, type HairOptions } from '@margoengine/materials/hair';
import type { Hands, HandsOptions } from '@margoengine/rigging/hands';
import type { AnatomicalRig, ClampIssue, Tier } from '@margoengine/rigging/anatomy';
import type { FitHumanOptions } from '@margoengine/rigging/anatomy/human';
import { MargoError } from '@margoengine/math/errors';
import { setAnatomy } from '@margoengine/animator';
import { invertMatrix, multiplyMatrices } from '@margoengine/math/mat4';

/** Anything a person can join for shadows or ambient occlusion: `Shadows`, a `GTAO` pass, a scene's `parts`. */
export interface PersonReceiver {
  add(source: never, ...rest: never[]): unknown;
}

/**
 * The glTF material names each look is put on. A name the model lacks is skipped. The defaults include Character
 * Creator's names (`Std_Skin_Head` ..., `Std_Eye_L`, `Std_Cornea_L` ...), so its people load with nothing to name.
 */
export interface PersonMaterialNames {
  /** Default `['Skin', 'Body', 'Face', 'Std_Skin_Head', 'Std_Skin_Body', 'Std_Skin_Arm', 'Std_Skin_Leg']`. */
  skin?: readonly string[];
  /** Default `['EyeL', 'EyeR', 'Eye', 'Eyes', 'Std_Eye_L', 'Std_Eye_R']`. */
  eyes?: readonly string[];
  /**
   * Default `['Hair', 'Brows', 'Eyebrows', 'Lashes', 'Eyelashes', 'Moustache', 'Beard']`. Each name also covers
   * Character Creator's hair materials made from it, `<name>_Transparency` and `<name>_<part>_Transparency`
   * (`Hair_Transparency`, `Hair_Clap_Transparency`, `Brows_Base_Transparency` ...), as CC names every hair mesh's
   * material after the mesh with `_Transparency` on the end.
   */
  hair?: readonly string[];
  /**
   * Clear shells over an eyeball that the eye look already draws (its cornea and tear film), hidden while the person
   * has its looks: drawn as well they would cover the iris or line the lids in white. Default `['Std_Cornea_L',
   * 'Std_Cornea_R', 'Std_Tearline_L', 'Std_Tearline_R']` (Character Creator's cornea spheres and tear line strips).
   * Nothing is hidden when `eyes` is false, nor a tear line that `@margoengine/fbx/character-creator` drew from
   * Character Creator's own json (material `extras.characterCreator.shader` `'RLEyeTearline'`): that one is the wet
   * glossy strip along the lid, not a white shell.
   */
  shells?: readonly string[];
  /**
   * Hair cards drawn as the layer of fibres they stand for (`hairCards()` from `@margoengine/materials/hair`): a lash
   * card seen nearly edge on from the front darkens the lid line as a fringe of lashes does. Default `['Std_Eyelash',
   * 'Lashes', 'Eyelashes']`. Nothing changes when `cards` is false.
   */
  cards?: readonly string[];
}

/**
 * How {@link addPerson} fits the body's anatomy (`fitHuman` from `@margoengine/rigging/anatomy/human`): the options of
 * `fitHuman` (`sex`, `age`, `preset`, `map`, `forward`, `roll`, `limits`), and how playback holds the ranges.
 */
export interface PersonAnatomyOptions extends FitHumanOptions {
  /**
   * The range playback holds every frame: `'structural'` (the stops no body passes: an elbow never folds back past 5
   * degrees) or `'normal'` (the clinical range). Default `'structural'`.
   */
  tier?: Tier;
  /**
   * Reads how the upper arms and thighs are rolled from the model's clips (`hingeRolls`), so an elbow or knee whose
   * rig is rolled still bends about its own axis. Default true; it only runs for a model with clips.
   */
  calibrate?: boolean;
  /** Called on a frame whose pose needed bringing back into range, with what was brought back. Default none. */
  onClamp?: (issues: readonly ClampIssue[]) => void;
}

/** Options of {@link addPerson}. Every one is optional; the defaults give a finished person. */
export interface PersonOptions {
  /** Skin options for `skin()` from `@margoengine/materials/skin`, or false for none. Default `{}`. */
  skin?: SkinOptions | false;
  /** Eye options for `eye()` from `@margoengine/materials/eye`, or false for none. Default `{}` (a grey blue iris). */
  eyes?: EyeOptions | false;
  /**
   * Strand hair options for `hair()` from `@margoengine/materials/hair`, on head hair, brows, lashes and beard, or false
   * for none. Default `{strands: 1024}`: fine strands, each with its own highlight, that hold up in a close shot.
   */
  hair?: HairOptions | false;
  /**
   * Hair card options for `hairCards()` from `@margoengine/materials/hair`, on the lash cards in `materials.cards`, or
   * false for none. Default `{}`; it joins the strand hair look on a material that has both.
   */
  cards?: HairCardOptions | false;
  /** Which material names get which look. Default {@link PersonMaterialNames}'s lists. */
  materials?: PersonMaterialNames;
  /** The clip to start on, a name from `model`'s animations. Default the first clip. */
  clip?: string;
  /**
   * How the bones blend: `'dual-quaternion'` keeps a twisted shoulder or wrist its volume (Kavan et al. 2008),
   * `'linear'` blends matrices. Default `'dual-quaternion'`.
   */
  skinning?: 'dual-quaternion' | 'linear';
  /** Cross-fade length in seconds for {@link Person.play}. Default 0.3. */
  fade?: number;
  /**
   * Shadows to cast into and receive from, or false for none. Default the `Shadows` attached to the model's scene, if
   * there is one (a `@margoengine/scenes` scene attaches one).
   */
  shadows?: PersonReceiver | false;
  /**
   * Hand poses (`@margoengine/rigging/hands`), or false for none. Default `{}`: every clip whose fingers are near flat
   * gets the relaxed hand blended in, so no hand is a flat board, and `person.hands.left` / `.right` take keyed poses
   * (`grip(0.035)`, `fist()`, `point()` ...). A rig whose bone names no preset knows gets none; pass `hands: {bones}`.
   */
  hands?: HandsOptions | false;
  /**
   * The body's anatomy (`@margoengine/rigging/anatomy`), or false for none. Default `{}`: a model whose bones a human
   * naming knows (Character Creator, Mixamo, VRM humanoid, H-Anim and the other namings of
   * `@margoengine/rigging/anatomy/human`) is fitted with the human table, its arm and leg rolls read from its clips;
   * the Animator's IK solvers and foot IK then bend each joint the anatomical way (`setAnatomy`), and every frame's
   * pose is held inside the joints' stops (`addAnatomyLimits`), so no clip or solver folds an elbow or knee backwards.
   * A model whose bones no naming knows gets no body; name its joints with `anatomy: {map}`. `anatomy: {limits:
   * false}` fits the body and holds nothing.
   */
  anatomy?: PersonAnatomyOptions | false;
  /** An ambient occlusion pass to join, such as a scene's `parts.occlusion`. Default none. */
  occlusion?: PersonReceiver | false;
  /**
   * The sky whose light falls on the person (`Sky` from `@margoengine/sky`, `add(model)`), or false for none. Default
   * the `Sky` attached to the model's scene, if there is one (a `@margoengine/scenes` scene attaches one): its diffuse
   * light and its reflections, blurred by each material's roughness, as the ground under it gets. Without it a glTF
   * model has only the flat built-in ambient, which reads no roughness, so skin under an overcast sky shows no sheen.
   * Given (a Sky or false), the model stops joining its scene's sky by itself (`model.sceneSky` false until dispose).
   */
  sky?: PersonReceiver | false;
  /** A `@margoengine/scenes` handle: its `parts.shadows` and `parts.occlusion` are used when the two above are unset. */
  scene?: { readonly parts: { readonly shadows?: PersonReceiver; readonly occlusion?: PersonReceiver } };
}

/** What {@link addPerson} returns. Dispose it (or use `using`) to take the person's additions off the model. */
export interface Person {
  /** The model, as passed in. */
  readonly model: PBRModel;
  /** The skin, eye and hair installation, or undefined when no material matched. */
  readonly materials: MaterialInstallation | undefined;
  /** The model's Animation (skinning, clips). */
  readonly animation: Animation;
  /** The Animator that plays the clips: one state per clip, named as the clip. Undefined for a model with no clips. */
  readonly animator: Animator | undefined;
  /** The clips by name, in file order. */
  readonly clips: readonly string[];
  /**
   * The hands (`@margoengine/rigging/hands`): `hands.right.set(grip(0.035))` and keyed poses; their clock runs with
   * playback and is set by `time`. Undefined with `hands: false` or a model with no clips.
   */
  readonly hands: Hands | undefined;
  /**
   * The body's anatomy, fitted to the model's nodes bone for bone (`fitHuman`): its joints, ranges and rest pose. Read
   * clinical angles with `jointAngles(person.body, pose)`. Undefined with `anatomy: false`, or for a model whose bones
   * no human naming knows.
   */
  readonly body: AnatomicalRig | undefined;
  /**
   * The motions of the pose on screen now that are outside the body's range at `tier` (default `'normal'`, the clinical
   * range; `'structural'` lists what passes a stop, which the held pose never does). Empty for a person with no body.
   * @example
   * for (const issue of person.check()) console.log(issue.joint, issue.motion, issue.value, issue.limit);
   */
  check(tier?: Tier): ClampIssue[];
  /**
   * Cross-fades to `clip` over `fade` seconds (default the person's `fade`), starting it at `at` seconds into the clip
   * (default 0). Returns the person.
   */
  play(clip: string, options?: { fade?: number; at?: number }): this;
  /**
   * Seconds into the current clip. Setting it moves the pose there on the next frame; with `playing` false it is a pure
   * function of the time, so a film can seek any frame.
   */
  time: number;
  /** Advances the clip with the engine's frames while true. Default true. */
  playing: boolean;
  /** Takes the materials, Animator, Animation, shadows, occlusion and sky light off the model. The model stays. */
  dispose(): void;
  [Symbol.dispose](): void;
}

const NAMES: Required<PersonMaterialNames> = {
  skin: ['Skin', 'Body', 'Face', 'Std_Skin_Head', 'Std_Skin_Body', 'Std_Skin_Arm', 'Std_Skin_Leg'],
  eyes: ['EyeL', 'EyeR', 'Eye', 'Eyes', 'Std_Eye_L', 'Std_Eye_R'],
  hair: ['Hair', 'Brows', 'Eyebrows', 'Lashes', 'Eyelashes', 'Moustache', 'Beard'],
  shells: ['Std_Cornea_L', 'Std_Cornea_R', 'Std_Tearline_L', 'Std_Tearline_R'],
  cards: ['Std_Eyelash', 'Lashes', 'Eyelashes'],
};

/** A look {@link addPerson} puts on a material. */
export type PersonLook = 'skin' | 'eyes' | 'hair';

/**
 * Which look {@link addPerson} puts on each of `names` (a model's glTF material names) with `options`: material name to
 * look, for the names that get one. Looks turned off (`skin: false` ...) are left out.
 * @example
 * personMaterials(['Skin', 'EyeL', 'Hair', 'Suit']); // {Skin: 'skin', EyeL: 'eyes', Hair: 'hair'}
 */
export function personMaterials(
  names: readonly string[],
  options: Pick<PersonOptions, 'skin' | 'eyes' | 'hair' | 'materials'> = {},
): Record<string, PersonLook> {
  if (!Array.isArray(names)) throw new TypeError('personMaterials needs the material names, an array of strings');
  const lists = { ...NAMES, ...options.materials },
    present = new Set(names),
    out: Record<string, PersonLook> = {};
  for (const look of ['skin', 'eyes', 'hair'] as const) {
    if (options[look] === false) continue;
    const list = lists[look];
    if (!Array.isArray(list) || list.some((n) => typeof n !== 'string'))
      throw new TypeError(`addPerson materials.${look} must be an array of material names`);
    for (const name of list) if (present.has(name) && !Object.hasOwn(out, name)) out[name] = look;
    if (look === 'hair')
      for (const name of names) if (!Object.hasOwn(out, name) && list.some((n) => ccHairOf(name, n))) out[name] = look;
  }
  return out;
}

// Character Creator names a hair mesh's material after the mesh, with `_Transparency` on the end: `Hair_Transparency`,
// `Hair_Clap_Transparency`, `Brows_Base_Transparency`. Such a name belongs to the listed hair name it starts with.
const ccHairOf = (name: string, listed: string) =>
  name.endsWith('_Transparency') && (name === `${listed}_Transparency` || name.startsWith(`${listed}_`));

// Character Creator's eye maps (Std_Eye_* and Std_Cornea_* of CC4 and CC5) hold the iris within 0.123 of the map's
// middle and the pupil within 0.042 (measured across a row of Wilbur's 1024-pixel maps), on a UV sphere whose middle is
// the front of the eye.
const CC_IRIS_UV = 0.123,
  CC_PUPIL = 0.042 / CC_IRIS_UV;
type Doc = {
  nodes: { skin?: number }[];
  skins?: { joints: number[]; inverseBindMatrices?: number }[];
  materials?: { pbrMetallicRoughness?: { baseColorTexture?: { index: number } } }[];
  textures?: { source?: number }[];
  images?: { bufferView?: number; mimeType?: string }[];
};
type Primitive = PBRModel['primitives'][number];

/**
 * The `eye()` options {@link addPerson} fits to an eyeball primitive of `model`: the centre of its vertices' bounds,
 * and for a skinned eyeball a `follow` giving the skin matrix of the joint that carries most of its weight, so the iris
 * turns with the head and the eye joint. A Character Creator eye (material `Std_Eye_*`) also takes its axis from the
 * vertex at its map's middle, its iris size from the vertices at the iris's radius in the map, and, in a browser, the
 * map itself as the iris picture. Use it to wire `eye()` by hand.
 * @example
 * const p = model.primitives.find((p) => p.material.name === 'Std_Eye_L');
 * install(model, {features: {Std_Eye_L: [eye(await personEye(model, p))]}});
 */
export async function personEye(model: PBRModel, p: Primitive): Promise<EyeOptions> {
  if (!model || !Array.isArray(model.primitives) || !model.primitives.includes(p))
    throw new TypeError(
      'personEye needs a loaded model and one of its primitives: personEye(model, model.primitives[k])',
    );
  const cc = ((p.material as { name?: string }).name ?? '').startsWith('Std_Eye_');
  const v = p.vertices,
    count = v.length / 20,
    low = [Infinity, Infinity, Infinity],
    high = [-Infinity, -Infinity, -Infinity];
  if (!count) return {};
  for (let k = 0; k < count; k++)
    for (let i = 0; i < 3; i++) {
      low[i] = Math.min(low[i], v[k * 20 + i]);
      high[i] = Math.max(high[i], v[k * 20 + i]);
    }
  const center = [0, 1, 2].map((i) => (low[i] + high[i]) / 2) as [number, number, number],
    out: EyeOptions = { center },
    asset = model.asset,
    doc = asset.doc as unknown as Doc;
  if (cc) {
    let front = 0,
      nearest = Infinity;
    for (let k = 0; k < count; k++) {
      const d = Math.hypot(v[k * 20 + 12] - 0.5, v[k * 20 + 13] - 0.5);
      if (d < nearest) [nearest, front] = [d, k];
    }
    const axis = [0, 1, 2].map((i) => v[front * 20 + i] - center[i]),
      length = Math.hypot(...axis);
    if (length > 0) {
      out.axis = axis.map((a) => a / length) as [number, number, number];
      // The lids' margins over this eye, measured on the head's skin (Character Creator's `Std_Skin_Head`).
      const lids = lidFromHead(model, p, center, out.axis, length);
      if (lids) out.lid = lids.lid;
      if (lids?.lowerLid) out.lowerLid = lids.lowerLid;
      // The iris's radius on the ball, sin of the angle from the axis, between the vertices just inside and just
      // outside the iris's radius in the map.
      const below = [-Infinity, 0],
        above = [Infinity, 0];
      for (let k = 0; k < count; k++) {
        const rho = Math.hypot(v[k * 20 + 12] - 0.5, v[k * 20 + 13] - 0.5),
          r = [0, 1, 2].map((i) => v[k * 20 + i] - center[i]),
          along = (r[0] * axis[0] + r[1] * axis[1] + r[2] * axis[2]) / length,
          size = Math.hypot(...r);
        if (!(size > 0 && along > 0)) continue;
        const sine = Math.sqrt(Math.max(0, 1 - (along / size) ** 2));
        if (rho <= CC_IRIS_UV && rho > below[0]) [below[0], below[1]] = [rho, sine];
        if (rho >= CC_IRIS_UV && rho < above[0]) [above[0], above[1]] = [rho, sine];
      }
      if (Number.isFinite(below[0]) && Number.isFinite(above[0]))
        out.irisRadius =
          above[0] > below[0]
            ? below[1] + ((above[1] - below[1]) * (CC_IRIS_UV - below[0])) / (above[0] - below[0])
            : below[1];
    }
    const material = doc.materials?.[p.definition.material ?? -1],
      image = doc.images?.[doc.textures?.[material?.pbrMetallicRoughness?.baseColorTexture?.index ?? -1]?.source ?? -1];
    // Decoded where the platform can (a browser); elsewhere the eye draws its own fibres.
    if (image?.bufferView !== undefined && typeof createImageBitmap === 'function') {
      const bytes = asset.view(image.bufferView),
        bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: image.mimeType ?? 'image/png' }), {
          colorSpaceConversion: 'none',
        });
      out.irisMap = new Texture(bitmap, { colorSpace: 'srgb' });
      out.irisMapRadius = CC_IRIS_UV;
      out.irisMapPupil = CC_PUPIL;
    }
  }
  const follow = jointFollow(model, p);
  if (follow) out.follow = follow;
  return out;
}

/** The lids' margins over an eyeball of `p`, from the model's head skin moved into `p`'s mesh axes. */
function lidFromHead(
  model: PBRModel,
  p: Primitive,
  center: readonly number[],
  axis: readonly number[],
  radius: number,
): { lid: EyeLid; lowerLid?: EyeLid } | undefined {
  const heads = model.primitives.filter((q) => (q.material as { name?: string }).name === 'Std_Skin_Head');
  if (!heads.length) return undefined;
  const inverse = new Float64Array(16),
    into = new Float64Array(16),
    eyeSpace = p.node ? invertMatrix(p.node.matrix, inverse) : undefined,
    positions: number[] = [],
    indices: number[] = [];
  for (const head of heads) {
    const m = eyeSpace && head.node ? multiplyMatrices(inverse, head.node.matrix, into) : undefined,
      v = head.vertices,
      base = positions.length / 3;
    for (let k = 0; k < v.length; k += 20) {
      const [x, y, z] = [v[k], v[k + 1], v[k + 2]];
      if (m)
        positions.push(
          m[0] * x + m[4] * y + m[8] * z + m[12],
          m[1] * x + m[5] * y + m[9] * z + m[13],
          m[2] * x + m[6] * y + m[10] * z + m[14],
        );
      else positions.push(x, y, z);
    }
    for (let k = 0; k < head.indices.length; k++) indices.push(head.indices[k] + base);
  }
  const margin = eyeLidMargin({ center, axis, radius }, { positions, indices });
  if (!margin) return undefined;
  const { lower } = margin;
  return {
    lid: { height: margin.height, tilt: margin.tilt, curve: margin.curve },
    ...(lower && { lowerLid: { height: lower.height, tilt: lower.tilt, curve: lower.curve } }),
  };
}

/**
 * The skin matrix, in the mesh's axes, of the joint that carries most of `p`'s weight, read on every call, for a
 * feature's `follow`; undefined for a primitive that is not skinned.
 */
function jointFollow(model: PBRModel, p: Primitive): (() => ArrayLike<number>) | undefined {
  const asset = model.asset,
    doc = asset.doc as unknown as Doc,
    count = p.vertices.length / 20,
    skinId = doc.nodes[p.nodeIndex]?.skin,
    skin = skinId === undefined ? undefined : doc.skins?.[skinId],
    attributes = p.definition.attributes as Record<string, number | undefined>;
  if (skin && attributes.JOINTS_0 !== undefined && attributes.WEIGHTS_0 !== undefined) {
    const ids = asset.accessor(attributes.JOINTS_0, 'VEC4'),
      weights = asset.accessor(attributes.WEIGHTS_0, 'VEC4'),
      total = new Float64Array(skin.joints.length),
      map = p.part?.vertexMap;
    for (let k = 0; k < count; k++) {
      const at = (map ? map[k] : k) * 4;
      for (let i = 0; i < 4; i++) if (ids[at + i] < total.length) total[ids[at + i]] += weights[at + i];
    }
    const joint = total.indexOf(Math.max(...total)),
      bind =
        skin.inverseBindMatrices === undefined
          ? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
          : asset.accessor(skin.inverseBindMatrices, 'MAT4').subarray(joint * 16, joint * 16 + 16),
      node = model.nodes[skin.joints[joint]],
      inverse = new Float64Array(16),
      moved = new Float64Array(16),
      matrix = new Float64Array(16);
    // As the skinning moves the vertices: the mesh's inverse world matrix, the joint's world matrix, its inverse bind.
    if (node)
      return () => {
        multiplyMatrices(node.matrix, bind, moved);
        return invertMatrix(p.node.matrix, inverse) ? multiplyMatrices(inverse, moved, matrix) : moved;
      };
  }
  return undefined;
}

const receiver = (value: unknown, what: string): PersonReceiver | undefined => {
  if (value === undefined || value === false) return undefined;
  if (!value || typeof (value as PersonReceiver).add !== 'function')
    throw new TypeError(`addPerson ${what} must have an add() method (Shadows, a GTAO pass, a Sky) or be false`);
  return value as PersonReceiver;
};

/**
 * Dresses `model` (a `@margoengine/gltf/pbr` model) as a person: skin, eyes and strand hair on the materials named for
 * them, an Animator over its clips with cross-fades, dual quaternion skinning, and the scene's shadows. Resolves to a
 * {@link Person}.
 * @example
 * const model = await loadGLTF(engine, 'wilbur.glb');
 * const person = await addPerson(engine, model, {clip: 'idle'});
 * person.play('wave'); // a 0.3 s cross-fade
 * @throws TypeError for a model of another engine or bad options; RangeError for an unknown clip or a bad fade.
 */
export async function addPerson(engine: Engine, model: PBRModel, options: PersonOptions = {}): Promise<Person> {
  if (!model || !Array.isArray(model.primitives) || !Array.isArray(model.nodes) || model.root?.engine !== engine)
    throw new TypeError(
      'addPerson needs a loaded gltf/pbr model of this engine: addPerson(engine, await loadGLTF(engine, url))',
    );
  const fade = options.fade ?? 0.3;
  if (!(fade >= 0 && fade < Infinity))
    throw new RangeError('addPerson fade must be a finite number of seconds, 0 or more');
  if (options.skinning !== undefined && options.skinning !== 'dual-quaternion' && options.skinning !== 'linear')
    throw new TypeError("addPerson skinning must be 'dual-quaternion' or 'linear'");
  const shadows =
    options.shadows === undefined
      ? (options.scene?.parts.shadows ??
        (engine.sceneOf(model as never)?.plugins.get('shadows') as PersonReceiver | undefined))
      : receiver(options.shadows, 'shadows');
  const occlusion =
    options.occlusion === undefined ? options.scene?.parts.occlusion : receiver(options.occlusion, 'occlusion');
  receiver(shadows, 'shadows');
  receiver(occlusion, 'occlusion');
  const sky =
    options.sky === undefined
      ? (engine.sceneOf(model as never)?.plugins.get('sky') as PersonReceiver | undefined)
      : receiver(options.sky, 'sky');
  receiver(sky, 'sky');

  // A tear line fbx/character-creator built from the CC json is its glossy strip: drawn, never hidden as a shell.
  const readerTearLine = (p: Primitive) =>
    (p.material as { extras?: { characterCreator?: { shader?: unknown } } } | undefined)?.extras?.characterCreator
      ?.shader === 'RLEyeTearline';
  // Looks by material name: each list is matched against the names the model carries (a man without a moustache).
  const nameOf = (p: Primitive) => (p.material as { name?: string } | undefined)?.name ?? '',
    looks = personMaterials(model.primitives.map(nameOf), options),
    // The eye's shells, hidden while it has its look: the names in materials.shells the model carries.
    shellNames = options.eyes === false ? [] : (options.materials?.shells ?? NAMES.shells),
    // Each eyeball is fitted to its own vertices; what the caller passes wins.
    eyes: Record<string, EyeOptions> = {};
  if (!Array.isArray(shellNames) || shellNames.some((n) => typeof n !== 'string'))
    throw new TypeError('addPerson materials.shells must be an array of material names');
  for (const p of model.primitives) {
    const name = nameOf(p);
    if (looks[name] === 'eyes' && !eyes[name]) eyes[name] = await personEye(model, p);
  }
  const make = {
      skin: () => [skin(options.skin || {})],
      eyes: (name: string) => [eye({ ...eyes[name], ...(options.eyes || {}) })],
      // A direction given in the mesh's axes turns with the joint that carries the hair; 'u' and 'v' read skinned tangents.
      hair: (name: string) => {
        const own = options.hair || {},
          p = model.primitives.find((q) => nameOf(q) === name),
          follow = Array.isArray(own.direction) && !own.follow && p ? jointFollow(model, p) : undefined;
        return [hair({ strands: 1024, ...own, ...(follow ? { follow } : {}) })];
      },
    },
    features: Record<string, ModelFeatures[string]> = {},
    shells = new Set(
      model.primitives.filter((p) => shellNames.includes(nameOf(p)) && !readerTearLine(p)).map((p) => p.material),
    );
  for (const [name, look] of Object.entries(looks)) features[name] = make[look](name);
  // Lash cards as a layer of fibres, beside the strand look where a material has both.
  const cardNames = options.cards === false ? [] : (options.materials?.cards ?? NAMES.cards);
  if (!Array.isArray(cardNames) || cardNames.some((n) => typeof n !== 'string'))
    throw new TypeError('addPerson materials.cards must be an array of material names');
  for (const name of new Set(model.primitives.map(nameOf)))
    if (cardNames.includes(name)) features[name] = [...(features[name] ?? []), hairCards(options.cards || {})];
  // Defaults that live in other packages load first, so a failed load leaves the model as it was. Each is one line.
  const handsModule = options.hands === false ? undefined : await import('@margoengine/rigging/hands');
  if (options.anatomy !== undefined && options.anatomy !== false && (typeof options.anatomy !== 'object' || !options.anatomy))
    throw new TypeError('addPerson anatomy must be an options object or false');
  const anatomyModules: AnatomyModules | undefined =
    options.anatomy === false
      ? undefined
      : await Promise.all([import('@margoengine/rigging/anatomy'), import('@margoengine/rigging/anatomy/human')]);

  // Everything is built and checked before anything is attached, so bad options leave the model as it was.
  const animation = new Animation(model, options.skinning === 'linear' ? {} : { skinning: dualQuaternionSkinning }),
    clips = animation.clips.map((c) => c.name);
  if (options.clip !== undefined && !clips.includes(options.clip))
    throw new RangeError(
      `addPerson clip "${options.clip}" is not in the model; it has ${clips.join(', ') || 'no clips'}`,
    );
  const states = Object.fromEntries(clips.map((c) => [c, c])),
    body = anatomyModules && personBody(model, animation, states, anatomyModules, options.anatomy || {}),
    animator = clips.length ? new Animator(animation, { initial: options.clip ?? clips[0], states }) : undefined;

  const cleanups: Array<() => void> = [];
  for (const fitted of Object.values(eyes)) if (fitted.irisMap) cleanups.push(() => fitted.irisMap!.dispose());
  const materials = Object.keys(features).length ? install(model, { features }) : undefined;
  if (materials) cleanups.push(() => materials.dispose());
  // A shell is cut away whole (alpha 0 under a cut-off of 1), shadows too, and put back on dispose.
  for (const m of shells) {
    const was = { mode: m.settings[0], cutoff: m.settings[1], alpha: m.base[3] };
    m.settings[0] = 1;
    m.settings[1] = 1;
    m.base[3] = 0;
    cleanups.push(() => {
      m.settings[0] = was.mode;
      m.settings[1] = was.cutoff;
      m.base[3] = was.alpha;
    });
  }
  // Into the model's scene, as Animation.attach and Animator.attach do: the deform pass runs in the scene that draws it.
  const kernel = engine as unknown as EngineKernel,
    into = kernel.sceneOf(model as never) ?? model.root.scene;
  kernel.use(animation, into);
  cleanups.push(() => animation.dispose());
  let hands: Hands | undefined;
  if (animator) {
    kernel.use(animator, into);
    cleanups.push(() => animator.dispose());
    if (handsModule) {
      const own = (hands = handsModule.addHands(animator, options.hands || {}));
      cleanups.push(() => own.dispose());
    }
    if (body) {
      // The solvers bend each joint the anatomical way, and after them every frame's pose is held inside the stops.
      // Solvers added later obey the body themselves (setAnatomy).
      const { tier, onClamp } = options.anatomy || {};
      setAnatomy(animator, body);
      cleanups.push(() => setAnatomy(animator, null));
      cleanups.push(anatomyModules![0].addAnatomyLimits(animator, body, { tier, onClamp }));
    }
  }
  if (shadows) {
    const off = shadows.add(model as never);
    if (typeof off === 'function') cleanups.push(off as () => void);
  }
  if (occlusion) {
    const off = occlusion.add(model as never);
    if (typeof off === 'function') cleanups.push(off as () => void);
  }
  if (options.sky !== undefined && model.sceneSky !== false) {
    // A sky named here, or none, replaces the scene's sky the model would join by itself (gltf/pbr sceneSky).
    model.sceneSky = false;
    cleanups.push(() => {
      model.sceneSky = true;
    });
  }
  if (sky) {
    const off = sky.add(model as never);
    if (typeof off === 'function') cleanups.push(off as () => void);
  }

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const step of cleanups.reverse()) step();
  };
  const person: Person = {
    model,
    materials,
    animation,
    animator,
    clips,
    hands,
    body,
    check(tier = 'normal') {
      if (!body) return [];
      if (tier !== 'normal' && tier !== 'structural')
        throw new RangeError("Person check tier must be 'normal' or 'structural'");
      const t = model.root.engine.store.transforms,
        pose = body.rest.slice(),
        issues: ClampIssue[] = [];
      model.nodes.forEach((node, i) =>
        pose.set(
          [t.x[node.id], t.y[node.id], t.z[node.id], t.qx[node.id], t.qy[node.id], t.qz[node.id], t.qw[node.id]],
          i * 10,
        ),
      );
      anatomyModules![0].clampPose(body, pose, { tier, issues, force: true });
      return issues;
    },
    play(clip, { fade: length = fade, at = 0 } = {}) {
      if (!animator) throw new RangeError('This person has no clips to play; load a model with animations to play one');
      if (!clips.includes(clip)) throw new RangeError(`Unknown clip "${clip}"; use one of ${clips.join(', ')}`);
      if (!(at >= 0 && at < Infinity)) throw new RangeError('play at must be a finite number of seconds, 0 or more');
      if (clip === animator.state) animator.time = at;
      else {
        animator.transition(clip, length);
        animator.time = at;
      }
      return person;
    },
    get time() {
      return animator ? animator.time : animation.time;
    },
    set time(value: number) {
      if (!(value >= 0 && value < Infinity))
        throw new RangeError('Person time must be a finite number of seconds, 0 or more');
      if (animator) animator.time = value;
      else animation.seek(value);
      if (hands) hands.time = value;
    },
    get playing() {
      return animator ? animator.playing : animation.playing;
    },
    set playing(value: boolean) {
      if (animator) animator.playing = value;
      else animation.playing = value;
    },
    dispose,
    [Symbol.dispose]: dispose,
  };
  return person;
}

type AnatomyModules = [
  typeof import('@margoengine/rigging/anatomy'),
  typeof import('@margoengine/rigging/anatomy/human'),
];

/** The model's nodes as a rig: names, parents and their local transforms now (the rest pose, before any clip plays). */
function modelRig(model: PBRModel) {
  const store = model.root.engine.store,
    t = store.transforms,
    ids = new Map(model.nodes.map((node, i) => [node.id, i])),
    rest = new Float64Array(model.nodes.length * 10);
  model.nodes.forEach((node, i) => {
    const id = node.id;
    rest.set([t.x[id], t.y[id], t.z[id], t.qx[id], t.qy[id], t.qz[id], t.qw[id], t.sx[id], t.sy[id], t.sz[id]], i * 10);
  });
  return {
    names: model.nodes.map((node, i) => node.name || `node${i}`),
    parents: model.nodes.map((node) => ids.get(store.parents[node.id]) ?? -1),
    rest,
  };
}

// Poses read from the clips to find how the limbs are rolled: about 30 a second, at most this many in all.
const ROLL_POSES = 2400;
// The largest shoulder or hip roll the clips may teach, in degrees. A rig's own roll is small (a Character Creator
// person's clips show under 5 degrees); a larger one is a clip that bends an elbow or knee backwards or sideways, and
// reading it as the rig's roll would turn the hinge round to fit the wrong pose instead of holding it
// (KB-HUM-ROLLTRUST1).
const ROLL_TRUST = 30;

/**
 * Fits the human table to `model`'s nodes; undefined when no human naming knows its bones and no `map` or `preset` is
 * given. With clips and `calibrate`, the body is fitted again with the roll its clips show (`hingeRolls`) at the
 * shoulders and hips only: an upper arm or thigh has no knuckles to read its roll from, while a hand's roll is read
 * from its knuckles in the fit itself.
 */
function personBody(
  model: PBRModel,
  animation: Animation,
  states: Record<string, string>,
  [anatomy, humans]: AnatomyModules,
  options: PersonAnatomyOptions,
): AnatomicalRig | undefined {
  const { tier, calibrate = true, onClamp, ...fit } = options;
  if (tier !== undefined && tier !== 'normal' && tier !== 'structural')
    throw new RangeError("addPerson anatomy.tier must be 'normal' or 'structural'");
  if (onClamp !== undefined && typeof onClamp !== 'function')
    throw new TypeError('addPerson anatomy.onClamp must be a function');
  const rig = modelRig(model);
  if (!fit.map && !fit.preset && !humans.human.naming?.(rig.names)) return undefined;
  const fitted = (roll?: Record<string, number>): AnatomicalRig => {
    try {
      return humans.fitHuman(rig, roll ? { ...fit, roll: { ...roll, ...fit.roll } } : fit);
    } catch (error) {
      throw new MargoError(
        'unsupported',
        `addPerson could not fit the human anatomy to this model (${(error as Error).message}); name its joints with anatomy.map, or pass anatomy: false`,
      );
    }
  };
  const body = fitted(),
    clips = animation.clips.filter((clip) => clip.duration > 0);
  if (!calibrate || !clips.length) return body;
  // A throwaway Animator samples each clip's local pose; the person's own Animator is made after it.
  const sampler = new Animator(animation, { initial: clips[0].name, states }),
    pose = body.rest.slice(),
    total = clips.reduce((sum, clip) => sum + Math.ceil(clip.duration * 30) + 1, 0),
    stride = Math.max(1, total / ROLL_POSES);
  function* poses(): Generator<Float64Array> {
    for (const clip of clips) {
      sampler.transition(clip.name, 0);
      const count = Math.max(2, Math.round((clip.duration * 30) / stride) + 1);
      for (let k = 0; k < count; k++) {
        sampler.time = (clip.duration * k) / (count - 1);
        const sample = sampler.onPreUpdate(0, true)!;
        for (let i = 0; i < sample.rotation.length; i++) {
          pose.set(sample.position[i], i * 10);
          pose.set(sample.rotation[i], i * 10 + 3);
        }
        yield pose;
      }
    }
  }
  let rolls: Record<string, number>;
  try {
    rolls = anatomy.hingeRolls(body, poses());
  } finally {
    sampler.dispose();
  }
  const kept = Object.fromEntries(
    Object.entries(rolls).filter(
      ([id, roll]) => body.joints[body.index.get(id) ?? -1]?.kind === 'ball' && Math.abs(roll) <= ROLL_TRUST,
    ),
  );
  return Object.keys(kept).length ? fitted(kept) : body;
}
