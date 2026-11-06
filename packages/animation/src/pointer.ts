import { textureCoordinates, textureTransform } from '@margoengine/gltf-pro';
import type { GLTFLight, PBRMaterial, PBRModel, TextureTransform } from '@margoengine/gltf-pro';
import { attenuationPower } from '../../shared/attenuation.js';
import { createKeyframeClip, type Keyframe, type KeyframeClip, type PropertyTrackData } from './keyframes.js';
import { animationIndex, animationInterpolation, animationSampler, type AnimationDefinition } from './gltf.js';
import type { AnimationPath } from './gltf.js';

type Json = Record<string, unknown>;
type Writer = (value: Float64Array) => void;
type AccessorType = 'SCALAR' | 'VEC2' | 'VEC3' | 'VEC4';
/** A pointer channel that drives a node's TRS or morph weights: played as an ordinary node track. */
export interface PointerNodeChannel {
  node: number;
  path: AnimationPath;
  sampler: unknown;
}
/** What {@link PointerChannels} found in one glTF clip. */
export interface PointerPlan {
  /** Channels without KHR_animation_pointer, for the ordinary node track parser. */
  ordinary: unknown[];
  /** Node TRS and weights pointers, mesh weights expanded to every node using the mesh. */
  nodes: PointerNodeChannel[];
  /** Binds the material, light, camera and visibility pointers to live values; undefined when there are none. */
  bind?: () => KeyframeClip;
  /** The last key time of every pointer channel, skipped ones included. */
  duration: number;
  /** One line per skipped pointer channel. */
  warnings: string[];
}
/**
 * The shape of {@link pointerChannels}, the opt-in KHR_animation_pointer support `Animation` takes as its `pointers`
 * option: sorts one glTF clip's channels (`def`, labelled `clip` in messages) for `model`.
 */
export type PointerChannels = (model: PBRModel, def: AnimationDefinition, clip: string) => PointerPlan;
interface Target {
  accessor: AccessorType;
  size: number;
  type: 'number' | 'vector' | 'color';
  bool?: boolean;
  /**
   * Builds the writer. `shared` holds what channels of one binding share: a state per glTF material and the owned
   * texture transforms per material and slot.
   */
  make: (shared: Map<string, unknown>) => Writer;
}
interface MaterialState {
  mats: PBRMaterial[];
  emissive: number[];
  strength: number;
  atten: number[];
  thickness: number;
  distance: number;
}

const sizes: Record<AccessorType, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
const object = (value: unknown): Json | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined;
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const lookup = (root: unknown, path: string): unknown =>
  path.split('/').reduce<unknown>((value, key) => object(value)?.[key], root);
// Texture slots of PBRMaterial.maps (and rows of uvt) by texture-info path.
const slots: Record<string, number> = {
  'pbrMetallicRoughness/baseColorTexture': 0,
  'pbrMetallicRoughness/metallicRoughnessTexture': 1,
  normalTexture: 2,
  occlusionTexture: 3,
  emissiveTexture: 4,
  'extensions/KHR_materials_clearcoat/clearcoatTexture': 5,
  'extensions/KHR_materials_clearcoat/clearcoatRoughnessTexture': 6,
  'extensions/KHR_materials_clearcoat/clearcoatNormalTexture': 7,
  'extensions/KHR_materials_transmission/transmissionTexture': 8,
  'extensions/KHR_materials_sheen/sheenColorTexture': 9,
  'extensions/KHR_materials_sheen/sheenRoughnessTexture': 10,
  'extensions/KHR_materials_specular/specularTexture': 11,
  'extensions/KHR_materials_specular/specularColorTexture': 12,
};
// Material factors: accessor type, the live array and offset written, and whether the factor needs the physical rows.
type Field = 'base' | 'factors' | 'settings' | 'physical' | 'ext' | 'emissive' | 'strength' | 'dispersion' | 'volume';
const factors: Record<string, [AccessorType, Field, number, string?]> = {
  'pbrMetallicRoughness/baseColorFactor': ['VEC4', 'base', 0],
  'pbrMetallicRoughness/roughnessFactor': ['SCALAR', 'factors', 0],
  'pbrMetallicRoughness/metallicFactor': ['SCALAR', 'factors', 1],
  'normalTexture/scale': ['SCALAR', 'factors', 2, 'normalTexture'],
  'occlusionTexture/strength': ['SCALAR', 'factors', 3, 'occlusionTexture'],
  emissiveFactor: ['VEC3', 'emissive', 0],
  alphaCutoff: ['SCALAR', 'settings', 1],
  'extensions/KHR_materials_emissive_strength/emissiveStrength': [
    'SCALAR',
    'strength',
    0,
    'extensions/KHR_materials_emissive_strength',
  ],
  'extensions/KHR_materials_dispersion/dispersion': ['SCALAR', 'dispersion', 0, 'extensions/KHR_materials_dispersion'],
  'extensions/KHR_materials_clearcoat/clearcoatFactor': ['SCALAR', 'physical', 0],
  'extensions/KHR_materials_clearcoat/clearcoatRoughnessFactor': ['SCALAR', 'physical', 1],
  'extensions/KHR_materials_clearcoat/clearcoatNormalTexture/scale': [
    'SCALAR',
    'physical',
    2,
    'extensions/KHR_materials_clearcoat/clearcoatNormalTexture',
  ],
  'extensions/KHR_materials_transmission/transmissionFactor': ['SCALAR', 'physical', 3],
  'extensions/KHR_materials_specular/specularColorFactor': ['VEC3', 'physical', 4],
  'extensions/KHR_materials_specular/specularFactor': ['SCALAR', 'physical', 7],
  'extensions/KHR_materials_sheen/sheenColorFactor': ['VEC3', 'physical', 8],
  'extensions/KHR_materials_sheen/sheenRoughnessFactor': ['SCALAR', 'physical', 11],
  'extensions/KHR_materials_ior/ior': ['SCALAR', 'ext', 1],
  'extensions/KHR_materials_volume/thicknessFactor': ['SCALAR', 'volume', 0],
  'extensions/KHR_materials_volume/attenuationColor': ['VEC3', 'volume', 1],
  'extensions/KHR_materials_volume/attenuationDistance': [
    'SCALAR',
    'volume',
    4,
    'extensions/KHR_materials_volume/attenuationDistance',
  ],
};
const lightFields: Record<string, AccessorType> = {
  color: 'VEC3',
  intensity: 'SCALAR',
  range: 'SCALAR',
  'spot/innerConeAngle': 'SCALAR',
  'spot/outerConeAngle': 'SCALAR',
};
const cameraFields: Record<string, string[]> = {
  perspective: ['yfov', 'aspectRatio', 'znear', 'zfar'],
  orthographic: ['xmag', 'ymag', 'znear', 'zfar'],
};
const colors = new Set(['pbrMetallicRoughness/baseColorFactor', 'emissiveFactor', 'color']);
/** Says an unplayable but valid pointer is skipped; caught per channel and reported as a warning. */
class Skip {
  constructor(readonly reason: string) {}
}
const shared = new WeakMap<PBRModel, Map<string, unknown>>();
const skip = (reason: string): never => {
  throw new Skip(reason);
};

/**
 * KHR_animation_pointer playback for `Animation`: pass it as the `pointers` option
 * (`Animation.attach(model, {pointers: pointerChannels})`). For each glTF clip it sorts the channels into ordinary
 * channels, pointer channels that drive node TRS and weights (played as node tracks) and property pointers bound on the
 * clip's first playback to the model's live material factors, texture transforms, lights, cameras and node
 * visibility. Malformed pointers, pointers to properties glTF does not let animations change and mismatched accessors
 * throw TypeError or RangeError; valid pointers it cannot drive are skipped and listed in `animation.warnings`.
 * `Animation` calls it; apps only pass it along.
 */
export const pointerChannels: PointerChannels = (model, def, clip) => {
  const doc = model.asset.doc as unknown as Json,
    ordinary: unknown[] = [],
    nodeChannels: PointerNodeChannel[] = [],
    meshChannels: PointerNodeChannel[] = [],
    weighted = new Set<number>(),
    properties: Array<{ target: Target; keys: Keyframe[]; pointer: string }> = [],
    warnings: string[] = [],
    seen = new Set<string>();
  let duration = 0;
  def.channels.forEach((value, c) => {
    const channel = object(value),
      target = object(channel?.target),
      extensions = object(target?.extensions),
      pointer = object(extensions?.KHR_animation_pointer)?.pointer;
    if (target?.path !== 'pointer' && extensions?.KHR_animation_pointer === undefined) {
      if (target?.path === 'weights' && typeof target.node === 'number') weighted.add(target.node);
      ordinary.push(value);
      return;
    }
    const label = `Animation ${clip} channel ${c}`;
    if (target?.path !== 'pointer' || Object.hasOwn(target, 'node') || typeof pointer !== 'string')
      throw new TypeError(
        `${label} KHR_animation_pointer needs path 'pointer', no target node and a pointer string; fix the channel target`,
      );
    if (seen.has(pointer)) throw new TypeError(`${label} repeats pointer ${pointer}; use one channel per property`);
    seen.add(pointer);
    const sampler = animationSampler(def.samplers[animationIndex(channel!.sampler, def.samplers.length, 'sampler')]),
      interpolation = animationInterpolation(sampler.interpolation),
      times = model.asset.accessor(sampler.input, 'SCALAR');
    if (times.some((v, i) => v < 0 || (i > 0 && v <= times[i - 1])))
      throw new RangeError(`${label} key times must be nonnegative and strictly increasing; fix the sampler input`);
    duration = Math.max(duration, times[times.length - 1]);
    let resolved: { nodes: number[]; path: AnimationPath; mesh: boolean } | Target;
    try {
      resolved = resolvePointer(model, doc, pointer, label);
    } catch (error) {
      if (!(error instanceof Skip)) throw error;
      warnings.push(`${label}: pointer ${pointer} ${error.reason}; skipped`);
      return;
    }
    if ('path' in resolved) {
      if (!resolved.mesh) weighted.add(resolved.nodes[0]);
      for (const node of resolved.nodes)
        (resolved.mesh ? meshChannels : nodeChannels).push({ node, path: resolved.path, sampler: channel!.sampler });
      if (!resolved.nodes.length) warnings.push(`${label}: pointer ${pointer} has no node using the mesh; skipped`);
      return;
    }
    const { accessor, size, bool } = resolved,
      accessorDef = object(list(doc.accessors)[sampler.output as number]);
    if (bool && (interpolation !== 'STEP' || accessorDef?.componentType !== 5121 || accessorDef.normalized))
      throw new TypeError(`${label} pointer ${pointer} is a boolean; use STEP and an unsigned byte SCALAR accessor`);
    const values = model.asset.accessor(sampler.output, accessor),
      cubic = interpolation === 'CUBICSPLINE',
      stride = size * (cubic ? 3 : 1);
    if (values.length !== times.length * stride)
      throw new RangeError(
        `${label} pointer ${pointer} has ${values.length / size} output values for ${times.length} keys; key one ${accessor} per time${cubic ? ' with in and out tangents' : ''}`,
      );
    const keys = Array.from(times, (time, k): Keyframe => {
      const at = k * stride + (cubic ? size : 0),
        key: Keyframe = {
          time,
          value: Array.from(values.subarray(at, at + size)),
          interpolation: cubic ? 'cubicSpline' : interpolation === 'STEP' ? 'discrete' : 'linear',
        };
      if (cubic) {
        key.inTangent = Array.from(values.subarray(at - size, at));
        key.outTangent = Array.from(values.subarray(at + size, at + 2 * size));
      }
      return key;
    });
    properties.push({ target: resolved, keys, pointer });
  });
  // A node's own weights win over its mesh's.
  for (const channel of meshChannels) if (!weighted.has(channel.node)) nodeChannels.unshift(channel);
  return {
    ordinary,
    nodes: nodeChannels,
    duration,
    warnings,
    ...(properties.length
      ? {
          bind: () => {
            // Every clip and player of a model shares one state per material (emissive factor and strength; base
            // colour, transmission and volume) and one owned copy of each texture transform and camera.
            let states = shared.get(model);
            if (!states) shared.set(model, (states = new Map()));
            return createKeyframeClip({
              name: clip,
              tracks: properties.map(
                ({ target, keys, pointer }): PropertyTrackData => ({
                  target: model,
                  name: pointer,
                  type: target.type,
                  set: target.make(states),
                  keys,
                }),
              ),
            });
          },
        }
      : {}),
  };
};

function index(token: string | undefined, length: number, what: string, label: string, pointer: string): number {
  if (token === undefined || !/^(0|[1-9]\d*)$/.test(token) || Number(token) >= length)
    throw new TypeError(`${label} pointer ${pointer} names no ${what} ${token ?? ''}; point at an existing index`);
  return Number(token);
}

function resolvePointer(
  model: PBRModel,
  doc: Json,
  pointer: string,
  label: string,
): { nodes: number[]; path: AnimationPath; mesh: boolean } | Target {
  if (!pointer.startsWith('/'))
    throw new TypeError(`${label} pointer ${pointer} is not a JSON pointer; start it with '/'`);
  const tokens = pointer
      .slice(1)
      .split('/')
      .map((t) => t.replaceAll('~1', '/').replaceAll('~0', '~')),
    invalid = (): never => {
      throw new TypeError(
        `${label} pointer ${pointer} is not an animatable glTF property; point at a property animations may change`,
      );
    },
    nested = (rest: string) => rest.split('/').some((t) => t === 'extras' || t === 'extensions');
  if (tokens.includes('extras')) skip('targets application-defined extras');
  const [root, id, ...rest] = tokens,
    tail = rest.join('/');
  if (root === 'nodes') {
    const node = index(id, list(doc.nodes).length, 'node', label, pointer);
    if (['translation', 'rotation', 'scale', 'weights'].includes(tail))
      return { nodes: [node], path: tail as AnimationPath, mesh: false };
    if (tail === 'extensions/KHR_node_visibility/visible') {
      if (!object(lookup(list(doc.nodes)[node], 'extensions/KHR_node_visibility')))
        skip('targets a node without KHR_node_visibility');
      const mesh = model.nodes[node];
      return {
        accessor: 'SCALAR',
        size: 1,
        type: 'number',
        bool: true,
        make: () => (value) => {
          mesh.visible = value[0] !== 0;
        },
      };
    }
    if (nested(tail)) skip('targets a node extension this player does not drive');
    return invalid();
  }
  if (root === 'meshes') {
    const mesh = index(id, list(doc.meshes).length, 'mesh', label, pointer);
    if (tail === 'weights')
      return {
        nodes: list(doc.nodes).flatMap((n, i) => (object(n)?.mesh === mesh ? [i] : [])),
        path: 'weights',
        mesh: true,
      };
    if (nested(tail)) skip('targets a mesh extension this player does not drive');
    return invalid();
  }
  if (root === 'materials')
    return materialTarget(model, doc, index(id, list(doc.materials).length, 'material', label, pointer), tail, invalid);
  if (root === 'cameras') {
    const camera = index(id, list(doc.cameras).length, 'camera', label, pointer),
      def = object(list(doc.cameras)[camera])!,
      [kind, field, more] = rest;
    if (!cameraFields[kind]?.includes(field) || more !== undefined) return invalid();
    if (def.type !== kind || !object(def[kind])) skip(`targets ${kind} values of a ${String(def.type)} camera`);
    if (object(def[kind])![field] === undefined) skip(`targets ${field}, which the camera does not define`);
    const live = model.cameras.filter((c) => object(list(doc.nodes)[c.nodeIndex])?.camera === camera);
    if (!live.length) skip('targets a camera no scene node uses');
    return {
      accessor: 'SCALAR',
      size: 1,
      type: 'number',
      make: (shared) => {
        // Own the values once per binding: model.cameras entries share their perspective/orthographic object with the
        // asset document.
        const key = `camera ${camera}`,
          views =
            (shared.get(key) as Record<string, number>[] | undefined) ??
            live.map((c) => {
              const own = { ...c[kind as 'perspective'] } as Record<string, number>;
              (c as unknown as Json)[kind] = own;
              return own;
            });
        shared.set(key, views);
        return (value) => {
          for (const view of views) view[field] = value[0];
        };
      },
    };
  }
  if (root === 'extensions' && id === 'KHR_lights_punctual' && rest[0] === 'lights') {
    const lights = list(object(object(doc.extensions)?.KHR_lights_punctual)?.lights),
      light = index(rest[1], lights.length, 'light', label, pointer),
      field = rest.slice(2).join('/'),
      def = object(lights[light])!,
      accessor = lightFields[field];
    if (!accessor) return invalid();
    if (field.startsWith('spot/') && def.type !== 'spot') skip(`targets spot cones of a ${String(def.type)} light`);
    if (field === 'range' && def.range === undefined) skip('targets range, which the light does not define');
    const live = model.lights.filter(
      (l) => object(lookup(list(doc.nodes)[l.nodeIndex], 'extensions/KHR_lights_punctual'))?.light === light,
    );
    if (!live.length) skip('targets a light no scene node uses');
    const key = (field.startsWith('spot/') ? field.slice(5) : field) as keyof GLTFLight;
    return {
      accessor,
      size: sizes[accessor],
      type: colors.has(field) ? 'color' : 'number',
      make: (shared) => {
        if (field === 'color') {
          // The light's colour aliases the asset document's array; write a copy, once per model.
          if (!shared.has(`light ${light}`)) for (const l of live) l.color = l.color.slice();
          shared.set(`light ${light}`, true);
          return (value) => {
            for (const l of live) for (let c = 0; c < 3; c++) l.color[c] = value[c];
          };
        }
        return (value) => {
          for (const l of live) (l as unknown as Record<string, number>)[key] = value[0];
        };
      },
    };
  }
  if (root === 'extensions') skip(`targets ${id}, which this player does not drive`);
  return invalid();
}

function materialTarget(model: PBRModel, doc: Json, material: number, path: string, invalid: () => never): Target {
  const def = object(list(doc.materials)[material])!,
    mats = [
      ...new Set(
        [...model.primitives, ...model.pointsAndLines]
          .filter((p) => p.definition.material === material)
          .map((p) => p.material),
      ),
    ];
  const transform = /^(.+)\/extensions\/KHR_texture_transform\/(offset|scale|rotation|texCoord)$/.exec(path);
  if (transform) {
    const slot = slots[transform[1]],
      property = transform[2] as 'offset' | 'scale' | 'rotation';
    if (slot === undefined) skip('targets a texture this player does not map to a live UV transform');
    if (property === ('texCoord' as string)) skip('targets texCoord, an integer UV set this player does not switch');
    if (!object(lookup(def, transform[1]))) skip('targets a texture the material does not define');
    if (!mats.length) skip('targets a material no primitive draws');
    if (!mats.some((m) => m.maps[slot])) skip('targets a texture no drawn primitive samples');
    const accessor = property === 'rotation' ? 'SCALAR' : 'VEC2';
    return {
      accessor,
      size: sizes[accessor],
      type: property === 'rotation' ? 'number' : 'vector',
      make: (shared) => {
        const key = `texture ${material} ${slot}`,
          owned = (shared.get(key) as Owned[] | undefined) ?? own(mats, slot);
        shared.set(key, owned);
        return (value) => {
          for (const { m, own, texCoord } of owned) {
            if (property === 'rotation') own.rotation = value[0];
            else {
              const pair = own[property] as unknown as number[];
              pair[0] = value[0];
              pair[1] = value[1];
            }
            const rows = textureTransform(own, texCoord);
            if (m.uvt && m.uvt.length >= slot * 8 + 8) for (let i = 0; i < 8; i++) m.uvt[slot * 8 + i] = rows[i];
          }
        };
      },
    };
  }
  const factor = factors[path];
  if (!factor) {
    if (path.startsWith('extensions/') || path.includes('/extensions/'))
      skip('targets a material extension property this player does not drive');
    return invalid();
  }
  const [accessor, field, offset, needs] = factor,
    extension = path.startsWith('extensions/') ? path.split('/').slice(0, 2).join('/') : undefined;
  if (needs && lookup(def, needs) === undefined)
    skip(`targets ${needs.split('/').pop()}, which the material does not define`);
  if (extension && !object(lookup(def, extension)))
    skip(`targets ${extension.slice(11)}, which the material does not use`);
  if (!mats.length) skip('targets a material no primitive draws');
  if (field === 'physical' || field === 'ext' || field === 'volume') {
    if (mats.some((m) => !m.physical))
      skip('targets a physical material factor gltf-pro did not load (pass decoders.materials)');
    if ((field === 'volume' || offset === 3) && mats.some((m) => !m.tint))
      skip('targets transmission or volume of a material loaded without transmission');
  }
  const size = sizes[accessor];
  return {
    accessor,
    size,
    type: colors.has(path) ? 'color' : size === 1 ? 'number' : 'vector',
    make: (states) => {
      const key = `material ${material}`,
        shared = (states.get(key) as MaterialState | undefined) ?? materialState(def, mats);
      states.set(key, shared);
      // gltf-pro's base colour can be the asset document's own array; write a copy.
      if (field === 'base') for (const m of mats) m.base = m.base.slice();
      return (value) => {
        if (field === 'emissive' || field === 'strength') {
          if (field === 'strength') shared.strength = value[0];
          else for (let c = 0; c < 3; c++) shared.emissive[c] = value[c];
          for (const m of mats) for (let c = 0; c < 3; c++) m.emission[c] = shared.emissive[c] * shared.strength;
          return;
        }
        if (field === 'volume') {
          if (offset === 0) shared.thickness = value[0];
          else if (offset === 4) shared.distance = value[0];
          else for (let c = 0; c < 3; c++) shared.atten[c] = value[c];
        } else if (field === 'dispersion') for (const m of mats) m.dispersion = value[0];
        else for (const m of mats) for (let c = 0; c < size; c++) m[field]![offset + c] = value[c];
        if (field === 'base' || field === 'volume' || (field === 'physical' && offset === 3)) tint(shared);
      };
    },
  };
}

interface Owned {
  m: PBRMaterial;
  own: TextureTransform;
  texCoord: number;
}
/** Gives each material's map in `slot` its own texture transform, once per binding. */
function own(mats: PBRMaterial[], slot: number): Owned[] {
  return mats.flatMap((m) => {
    const map = m.maps[slot];
    if (!map) return [];
    const old = (map.extensions?.KHR_texture_transform ?? {}) as TextureTransform,
      texCoord = textureCoordinates(map).texCoord,
      transform: TextureTransform = {
        ...old,
        offset: [...(old.offset ?? [0, 0])],
        scale: [...(old.scale ?? [1, 1])],
        rotation: old.rotation ?? 0,
      },
      maps = m.maps.slice();
    maps[slot] = { ...map, texCoord, extensions: { ...map.extensions, KHR_texture_transform: transform } };
    m.maps = maps;
    return [{ m, own: transform, texCoord }];
  });
}
function materialState(def: Json, mats: PBRMaterial[]): MaterialState {
  const volume = object(lookup(def, 'extensions/KHR_materials_volume')),
    distance = volume?.attenuationDistance;
  return {
    mats,
    emissive: [...((def.emissiveFactor as number[] | undefined) ?? [0, 0, 0])],
    strength: (lookup(def, 'extensions/KHR_materials_emissive_strength/emissiveStrength') as number | undefined) ?? 1,
    atten: [...((volume?.attenuationColor as number[] | undefined) ?? [1, 1, 1])],
    thickness: (volume?.thicknessFactor as number | undefined) ?? 0,
    distance: typeof distance === 'number' ? distance : Infinity,
  };
}

// Recomputes what gltf-pro derives from base colour, transmission and volume at load.
function tint({ mats, atten, thickness, distance }: MaterialState): void {
  const depth = thickness / distance;
  for (const m of mats) {
    if (!m.tint || !m.physical) continue;
    for (let c = 0; c < 3; c++) m.tint[c] = m.base[c] * m.physical[3] * attenuationPower(atten[c], depth);
    if (m.volume) {
      m.volume[0] = thickness;
      for (let c = 0; c < 3; c++) m.volume[1 + c] = attenuationPower(atten[c], 1 / distance);
    }
  }
}
