// The glTF Asset Object Model as a behaviour graph sees it: every pointer of the object model, read from the document and
// from what the graph has written since. A write also goes to `live`, which reaches the rendered model.
import { composeMatrix, multiplyMatrices } from '@margoengine/math/mat4';
import type { GraphRef, GraphValue } from './interactivity-ops.js';

type Json = Record<string, any>;
/** One property of the object model. */
export interface ModelProperty {
  type: string;
  get(): GraphValue;
  /** Absent on a read-only property. */
  set?(value: GraphValue): void;
}
/** The camera the viewer shows, for `/extensions/KHR_interactivity/activeCamera`. Any part may be left out. */
export interface ActiveCamera {
  position?: readonly number[];
  rotation?: readonly number[];
  perspective?: { aspectRatio: number; yfov: number; znear: number; zfar: number };
  orthographic?: { xmag: number; ymag: number; znear: number; zfar: number };
}
/** One animation channel, flattened to the pointer it writes. */
export interface ModelChannel {
  pointer: string;
  times: Float32Array;
  values: Float32Array;
  width: number;
  interpolation: 'STEP' | 'LINEAR' | 'CUBICSPLINE';
}
/** What `/animations/{}/extensions/KHR_interactivity` reports for one animation. */
export interface AnimationState {
  channels: ModelChannel[];
  minTime: number;
  maxTime: number;
  isPlaying: boolean;
  playhead: number;
  virtualPlayhead: number;
}
/** What the object model asks of its surroundings. */
export interface ModelHost {
  accessor(index: number, type: string): Float32Array;
  live?(pointer: string, value: GraphValue): void;
  camera?(): ActiveCamera | undefined;
  /** glTF extensions this runtime supports. */
  supports(extension: string): boolean;
}

export const INT_MAX = 2147483647;
/** The most simultaneous delays, animations and interpolations of each kind; the graph sees them under `limits`. */
export const ACTIVE_LIMIT = 65536;
const nan = (n: number) => new Array<number>(n).fill(NaN);
const canonical = /\/(0|[1-9]\d*)(?=\/|$|\.length$)/g;
const clearcoat = 'extensions/KHR_materials_clearcoat/',
  iridescence = 'extensions/KHR_materials_iridescence/',
  sheen = 'extensions/KHR_materials_sheen/',
  specular = 'extensions/KHR_materials_specular/',
  volume = 'extensions/KHR_materials_volume/',
  anisotropy = 'extensions/KHR_materials_anisotropy/',
  metal = 'pbrMetallicRoughness/';
// Material properties with their type and default.
const materialFields: Record<string, [string, number | number[]]> = {
  alphaCutoff: ['float', 0.5],
  emissiveFactor: ['float3', [0, 0, 0]],
  'normalTexture/scale': ['float', 1],
  'occlusionTexture/strength': ['float', 1],
  [`${metal}baseColorFactor`]: ['float4', [1, 1, 1, 1]],
  [`${metal}metallicFactor`]: ['float', 1],
  [`${metal}roughnessFactor`]: ['float', 1],
  [`${anisotropy}anisotropyRotation`]: ['float', 0],
  [`${anisotropy}anisotropyStrength`]: ['float', 0],
  [`${clearcoat}clearcoatFactor`]: ['float', 0],
  [`${clearcoat}clearcoatRoughnessFactor`]: ['float', 0],
  [`${clearcoat}clearcoatNormalTexture/scale`]: ['float', 1],
  'extensions/KHR_materials_dispersion/dispersion': ['float', 0],
  'extensions/KHR_materials_emissive_strength/emissiveStrength': ['float', 1],
  'extensions/KHR_materials_ior/ior': ['float', 1.5],
  [`${iridescence}iridescenceFactor`]: ['float', 0],
  [`${iridescence}iridescenceIor`]: ['float', 1.3],
  [`${iridescence}iridescenceThicknessMinimum`]: ['float', 100],
  [`${iridescence}iridescenceThicknessMaximum`]: ['float', 400],
  [`${sheen}sheenColorFactor`]: ['float3', [0, 0, 0]],
  [`${sheen}sheenRoughnessFactor`]: ['float', 0],
  [`${specular}specularFactor`]: ['float', 1],
  [`${specular}specularColorFactor`]: ['float3', [1, 1, 1]],
  'extensions/KHR_materials_transmission/transmissionFactor': ['float', 0],
  [`${volume}thicknessFactor`]: ['float', 0],
  [`${volume}attenuationDistance`]: ['float', Infinity],
  [`${volume}attenuationColor`]: ['float3', [1, 1, 1]],
};
const textures = new Set([
  'emissiveTexture',
  'normalTexture',
  'occlusionTexture',
  `${metal}baseColorTexture`,
  `${metal}metallicRoughnessTexture`,
  `${anisotropy}anisotropyTexture`,
  `${clearcoat}clearcoatTexture`,
  `${clearcoat}clearcoatRoughnessTexture`,
  `${clearcoat}clearcoatNormalTexture`,
  `${iridescence}iridescenceTexture`,
  `${iridescence}iridescenceThicknessTexture`,
  `${sheen}sheenColorTexture`,
  `${sheen}sheenRoughnessTexture`,
  `${specular}specularTexture`,
  `${specular}specularColorTexture`,
  'extensions/KHR_materials_transmission/transmissionTexture',
  `${volume}thicknessTexture`,
]);
const transformFields: Record<string, [string, number | number[]]> = {
  offset: ['float2', [0, 0]],
  rotation: ['float', 0],
  scale: ['float2', [1, 1]],
};
const lightFields: Record<string, [string, number | number[]]> = {
  color: ['float3', [1, 1, 1]],
  intensity: ['float', 1],
  range: ['float', Infinity],
  'spot/innerConeAngle': ['float', 0],
  'spot/outerConeAngle': ['float', Math.PI / 4],
};
const cameraFields: Record<string, string[]> = {
  perspective: ['aspectRatio', 'yfov', 'zfar', 'znear'],
  orthographic: ['xmag', 'ymag', 'zfar', 'znear'],
};
const lookup = (root: unknown, path: string) =>
  path.split('/').reduce<any>((value, key) => (value && typeof value === 'object' ? value[key] : undefined), root);

/** The object model of one asset. */
export class ObjectModel {
  readonly animations: AnimationState[];
  private readonly doc: Json;
  private readonly host: ModelHost;
  private readonly written = new Map<string, GraphValue>();
  private readonly refs = new Map<string, GraphRef>();
  private readonly parents: Int32Array;
  private readonly nodes: Json[];

  constructor(doc: Json, host: ModelHost) {
    this.doc = doc;
    this.host = host;
    this.nodes = doc.nodes ?? [];
    this.parents = new Int32Array(this.nodes.length).fill(-1);
    this.nodes.forEach((node, i) => {
      for (const child of node.children ?? []) this.parents[child] = i;
    });
    this.animations = (doc.animations ?? []).map((animation: Json) => this.animation(animation));
  }

  /** The one reference of `path`: references of the same object are the same value. */
  ref(path: string): GraphRef {
    let ref = this.refs.get(path);
    if (!ref) this.refs.set(path, (ref = { path }));
    return ref;
  }
  /** The reference a static pointer names, or null. */
  resolveRef(pointer: string): GraphRef | null {
    const found = this.property(pointer);
    if (found?.type === 'ref') return found.get() as GraphRef | null;
    return null;
  }

  private animation(def: Json): AnimationState {
    const channels: ModelChannel[] = [],
      state = { channels, minTime: NaN, maxTime: NaN, isPlaying: false, playhead: 0, virtualPlayhead: 0 };
    let min = Infinity,
      max = -Infinity;
    for (const channel of def.channels ?? []) {
      const sampler = def.samplers?.[channel.sampler],
        input = this.doc.accessors?.[sampler?.input],
        pointer = this.channelPointer(channel.target);
      if (!input || !pointer) return { ...state, playhead: NaN, virtualPlayhead: NaN };
      min = Math.min(min, input.min?.[0] ?? Infinity);
      max = Math.max(max, input.max?.[0] ?? -Infinity);
      const times = this.host.accessor(sampler.input, 'SCALAR'),
        interpolation = sampler.interpolation ?? 'LINEAR',
        target = this.doc.accessors?.[sampler.output],
        values = this.host.accessor(sampler.output, target?.type),
        keyed = values.length / (interpolation === 'CUBICSPLINE' ? 3 : 1);
      channels.push({ pointer, times, values, width: keyed / times.length, interpolation });
    }
    return channels.length ? { ...state, minTime: min, maxTime: max } : { ...state, playhead: NaN, virtualPlayhead: NaN };
  }
  private channelPointer(target: Json | undefined): string | undefined {
    if (target?.path === 'pointer') return target.extensions?.KHR_animation_pointer?.pointer;
    return target && Number.isInteger(target.node) ? `/nodes/${target.node}/${target.path}` : undefined;
  }

  /** Writes what an animation produced; `/nodes/{}/weights` takes the whole array, which no graph can do. */
  animate(pointer: string, value: number[]): void {
    if (pointer.endsWith('/weights')) value.forEach((weight, i) => this.property(`${pointer}/${i}`)?.set?.(weight));
    else {
      const property = this.property(pointer);
      if (property?.type === 'bool') property.set?.(value[0] !== 0);
      else property?.set?.(property.type === 'float' ? value[0] : value);
    }
  }

  /** The property `pointer` resolves to, or undefined. */
  property(pointer: string): ModelProperty | undefined {
    const ids: number[] = [],
      key = pointer.replace(canonical, (_, id) => {
        ids.push(+id);
        return '/#';
      });
    return this.fixed(key, ids, pointer) ?? this.objects(key, ids, pointer);
  }

  private count(list: unknown[] | undefined): ModelProperty {
    return { type: 'int', get: () => list?.length ?? 0 };
  }
  private refTo(path: string | undefined): ModelProperty | undefined {
    return path === undefined ? undefined : { type: 'ref', get: () => this.ref(path) };
  }
  private stored(pointer: string, type: string, fallback: () => GraphValue, mutable = true): ModelProperty {
    return {
      type,
      get: () => (this.written.has(pointer) ? this.written.get(pointer)! : fallback()),
      ...(mutable
        ? {
            set: (value: GraphValue) => {
              this.written.set(pointer, value);
              this.host.live?.(pointer, value);
            },
          }
        : {}),
    };
  }

  private fixed(key: string, ids: number[], pointer: string): ModelProperty | undefined {
    const doc = this.doc;
    const lengths: Record<string, unknown[] | undefined> = {
      '/animations.length': doc.animations,
      '/cameras.length': doc.cameras,
      '/materials.length': doc.materials,
      '/meshes.length': doc.meshes,
      '/nodes.length': doc.nodes,
      '/scenes.length': doc.scenes,
      '/skins.length': doc.skins,
      '/extensions/KHR_lights_punctual/lights.length': doc.extensions?.KHR_lights_punctual?.lights,
    };
    if (key in lengths) return this.count(lengths[key]);
    if (key === '/scene') return this.refTo(doc.scene === undefined ? undefined : `/scenes/${doc.scene}`);
    const list: Record<string, unknown[] | undefined> = {
      '/animations/#': doc.animations,
      '/cameras/#': doc.cameras,
      '/materials/#': doc.materials,
      '/meshes/#': doc.meshes,
      '/nodes/#': doc.nodes,
      '/scenes/#': doc.scenes,
      '/skins/#': doc.skins,
      '/extensions/KHR_lights_punctual/lights/#': doc.extensions?.KHR_lights_punctual?.lights,
    };
    if (key in list) return list[key]?.[ids[0]] !== undefined ? this.refTo(pointer) : undefined;
    if (!key.startsWith('/extensions/KHR_interactivity/')) return undefined;
    const tail = key.slice(30);
    // The newest version this runtime knows is 2.0, so an asset of a later one presents as 2.0.
    if (tail === 'asset/majorVersion') return { type: 'int', get: () => 2 };
    if (tail === 'asset/minorVersion') return { type: 'int', get: () => 0 };
    const enabled = /^asset\/extensions\/([^/]+)\/enabled$/.exec(tail);
    if (enabled)
      return (doc.extensionsUsed ?? []).includes(enabled[1]) && this.host.supports(enabled[1])
        ? { type: 'bool', get: () => true }
        : undefined;
    if (/^limits\/maxActive(Animations|Delays|PropertyInterpolations|VariableInterpolations)$/.test(tail))
      return { type: 'int', get: () => ACTIVE_LIMIT };
    return this.activeCamera(tail);
  }
  private activeCamera(tail: string): ModelProperty | undefined {
    const camera = () => this.host.camera?.();
    if (tail === 'activeCamera/position')
      return { type: 'float3', get: () => (camera()?.position ? [...camera()!.position!] : nan(3)) };
    if (tail === 'activeCamera/rotation')
      return { type: 'float4', get: () => (camera()?.rotation ? [...camera()!.rotation!] : nan(4)) };
    const field = /^activeCamera\/(perspective|orthographic)\/(\w+)$/.exec(tail);
    if (!field || !cameraFields[field[1]].includes(field[2])) return undefined;
    return { type: 'float', get: () => (camera()?.[field[1] as 'perspective'] as any)?.[field[2]] ?? NaN };
  }

  private objects(key: string, ids: number[], pointer: string): ModelProperty | undefined {
    const [, root] = key.split('/');
    if (root === 'nodes') return this.node(key, ids, pointer);
    if (root === 'materials') return this.material(key, ids, pointer);
    if (root === 'meshes') return this.mesh(key, ids);
    if (root === 'animations') return this.animationProperty(key, ids);
    if (root === 'cameras') {
      const camera = this.doc.cameras?.[ids[0]],
        field = /^\/cameras\/#\/(perspective|orthographic)\/(\w+)$/.exec(key);
      if (!camera || !field || !cameraFields[field[1]].includes(field[2]) || !camera[field[1]]) return undefined;
      const value = camera[field[1]][field[2]];
      return this.stored(pointer, 'float', () => value ?? (field[2] === 'zfar' ? Infinity : NaN));
    }
    if (root === 'scenes') {
      const scene = this.doc.scenes?.[ids[0]];
      if (!scene) return undefined;
      if (key === '/scenes/#/nodes.length') return this.count(scene.nodes);
      if (key === '/scenes/#/nodes/#') return this.member(scene.nodes, ids[1]);
      return undefined;
    }
    if (root === 'skins') {
      const skin = this.doc.skins?.[ids[0]];
      if (!skin) return undefined;
      if (key === '/skins/#/joints.length') return this.count(skin.joints);
      if (key === '/skins/#/joints/#') return this.member(skin.joints, ids[1]);
      if (key === '/skins/#/skeleton') return this.refTo(skin.skeleton === undefined ? undefined : `/nodes/${skin.skeleton}`);
      return undefined;
    }
    const drive = /^\/extensions\/KHR_physics_rigid_bodies\/physicsJoints\/#\/drives\/#\/(maxForce|positionTarget|velocityTarget|stiffness|damping)$/.exec(key);
    if (drive) {
      const own = this.doc.extensions?.KHR_physics_rigid_bodies?.physicsJoints?.[ids[0]]?.drives?.[ids[1]];
      return own ? this.stored(pointer, 'float', () => own[drive[1]] ?? (drive[1] === 'maxForce' ? Infinity : 0)) : undefined;
    }
    const light = /^\/extensions\/KHR_lights_punctual\/lights\/#\/(.+)$/.exec(key);
    if (light) {
      const def = this.doc.extensions?.KHR_lights_punctual?.lights?.[ids[0]],
        field = lightFields[light[1]];
      if (!def || !field) return undefined;
      if (light[1].startsWith('spot/') && def.type !== 'spot') return undefined;
      return this.stored(pointer, field[0], () => lookup(def, light[1]) ?? field[1]);
    }
    return undefined;
  }
  private member(list: number[] | undefined, index: number): ModelProperty | undefined {
    return list?.[index] === undefined ? undefined : this.refTo(`/nodes/${list[index]}`);
  }

  private node(key: string, ids: number[], pointer: string): ModelProperty | undefined {
    const i = ids[0],
      node = this.nodes[i];
    if (!node) return undefined;
    const tail = key.slice(9),
      mesh = this.doc.meshes?.[node.mesh],
      targets: number = mesh?.primitives?.[0]?.targets?.length ?? 0;
    switch (tail) {
      case 'translation':
        return this.stored(pointer, 'float3', () => (node.matrix ? node.matrix.slice(12, 15) : (node.translation ?? [0, 0, 0]).slice()));
      case 'rotation':
        return node.matrix ? undefined : this.stored(pointer, 'float4', () => (node.rotation ?? [0, 0, 0, 1]).slice());
      case 'scale':
        return node.matrix ? undefined : this.stored(pointer, 'float3', () => (node.scale ?? [1, 1, 1]).slice());
      case 'matrix':
        return { type: 'float4x4', get: () => Array.from(this.local(i)) };
      case 'globalMatrix':
        return { type: 'float4x4', get: () => Array.from(this.global(i)) };
      case 'parent':
        return this.refTo(this.parents[i] < 0 ? undefined : `/nodes/${this.parents[i]}`);
      case 'camera':
        return this.refTo(node.camera === undefined ? undefined : `/cameras/${node.camera}`);
      case 'mesh':
        return this.refTo(node.mesh === undefined ? undefined : `/meshes/${node.mesh}`);
      case 'skin':
        return this.refTo(node.skin === undefined ? undefined : `/skins/${node.skin}`);
      case 'children.length':
        return this.count(node.children);
      case 'children/#':
        return this.member(node.children, ids[1]);
      case 'weights.length':
        return mesh ? { type: 'int', get: () => targets } : undefined;
      case 'weights/#':
        if (ids[1] >= targets) return undefined;
        return this.stored(pointer, 'float', () => node.weights?.[ids[1]] ?? mesh.weights?.[ids[1]] ?? 0);
      case 'extensions/KHR_lights_punctual/light': {
        const light = node.extensions?.KHR_lights_punctual?.light;
        return this.refTo(light === undefined ? undefined : `/extensions/KHR_lights_punctual/lights/${light}`);
      }
    }
    const motion = /^extensions\/KHR_physics_rigid_bodies\/motion\/(linearVelocity|angularVelocity|gravityFactor)$/.exec(tail);
    if (motion) {
      const own = node.extensions?.KHR_physics_rigid_bodies?.motion;
      if (!own) return undefined;
      return motion[1] === 'gravityFactor'
        ? this.stored(pointer, 'float', () => own.gravityFactor ?? 1)
        : this.stored(pointer, 'float3', () => (own[motion[1]] ?? [0, 0, 0]).slice());
    }
    const flag = /^extensions\/KHR_node_(visibility\/visible|selectability\/selectable|hoverability\/hoverable)$/.exec(tail);
    if (!flag) return undefined;
    return this.stored(pointer, 'bool', () => lookup(node, tail) ?? true);
  }
  private local(i: number): Float64Array {
    const node = this.nodes[i],
      get = (name: string) => this.property(`/nodes/${i}/${name}`)?.get() as number[];
    if (node.matrix) {
      const matrix = Float64Array.from(node.matrix);
      matrix.set(get('translation'), 12);
      return matrix;
    }
    return composeMatrix(get('translation'), get('rotation'), get('scale'), new Float64Array(16));
  }
  private global(i: number): Float64Array {
    const own = this.local(i);
    return this.parents[i] < 0 ? own : multiplyMatrices(this.global(this.parents[i]), own, new Float64Array(16));
  }
  /** Whether `flag` is on for `node` and every node above it. */
  inherited(node: number, flag: string): boolean {
    for (let i = node; i >= 0; i = this.parents[i])
      if (this.property(`/nodes/${i}/extensions/KHR_node_${flag}`)?.get() === false) return false;
    return true;
  }
  /** The parent of `node`, or -1. */
  parent(node: number): number {
    return this.parents[node] ?? -1;
  }
  get nodeCount(): number {
    return this.nodes.length;
  }

  private material(key: string, ids: number[], pointer: string): ModelProperty | undefined {
    const def = this.doc.materials?.[ids[0]];
    if (!def) return undefined;
    const path = key.slice(13);
    if (path === 'doubleSided') return { type: 'bool', get: () => !!def.doubleSided };
    const transform = /^(.+)\/extensions\/KHR_texture_transform\/(offset|rotation|scale)$/.exec(path);
    if (transform) {
      if (!textures.has(transform[1]) || !lookup(def, transform[1])) return undefined;
      const [type, fallback] = transformFields[transform[2]];
      return this.stored(pointer, type, () => {
        const value = lookup(def, `${transform[1]}/extensions/KHR_texture_transform/${transform[2]}`) ?? fallback;
        return Array.isArray(value) ? value.slice() : value;
      });
    }
    const field = materialFields[path];
    if (!field) return undefined;
    const owner = /^extensions\/[^/]+/.exec(path)?.[0] ?? /^(normal|occlusion)Texture/.exec(path)?.[0];
    if (owner && !lookup(def, owner)) return undefined;
    return this.stored(pointer, field[0], () => {
      const value = lookup(def, path) ?? field[1];
      return Array.isArray(value) ? value.slice() : value;
    });
  }

  private mesh(key: string, ids: number[]): ModelProperty | undefined {
    const mesh = this.doc.meshes?.[ids[0]];
    if (!mesh) return undefined;
    if (key === '/meshes/#/primitives.length') return this.count(mesh.primitives);
    if (key === '/meshes/#/primitives/#')
      return mesh.primitives?.[ids[1]] ? this.refTo(`/meshes/${ids[0]}/primitives/${ids[1]}`) : undefined;
    if (key === '/meshes/#/primitives/#/material') {
      const primitive = mesh.primitives?.[ids[1]];
      if (!primitive) return undefined;
      return this.refTo(primitive.material === undefined ? undefined : `/materials/${primitive.material}`);
    }
    return undefined;
  }

  private animationProperty(key: string, ids: number[]): ModelProperty | undefined {
    const state = this.animations[ids[0]],
      field = /^\/animations\/#\/extensions\/KHR_interactivity\/(isPlaying|minTime|maxTime|playhead|virtualPlayhead)$/.exec(key)?.[1];
    if (!state || !field) return undefined;
    return { type: field === 'isPlaying' ? 'bool' : 'float', get: () => state[field as 'minTime'] };
  }
}
