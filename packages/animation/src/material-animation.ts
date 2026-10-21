import {
  PBRModel,
  textureCoordinates,
  textureTransform,
  type PBRMaterial,
  type PBRPrimitive,
} from '@margoengine/gltf-pro';
import { MargoError } from '@margoengine/math';
import { animationDefinition, animationIndex, animationSampler, type AnimationDefinition } from './gltf.js';
import { sampleTrackInto } from './sampling.js';

type Property = 'offset' | 'scale';
interface MaterialTrack {
  material: number;
  property: Property;
  times: Float32Array;
  values: Float32Array;
}
interface Binding {
  material: PBRMaterial;
  texture: number;
  primitives: Map<PBRPrimitive, number>;
  tracks: Map<Property, MaterialTrack>;
}
const claims = new WeakMap<PBRMaterial, Set<Property>>();

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(label + ' must be an object');
  return value as Record<string, unknown>;
}
function pair(value: unknown, label: string): asserts value is [number, number] {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    value.some((v) => typeof v !== 'number' || !Number.isFinite(Math.fround(v)))
  )
    throw new TypeError(label + ' needs two finite Float32 values');
}
function accessor(model: PBRModel, id: unknown, type: 'SCALAR' | 'VEC2'): Float32Array {
  const definitions = model.asset.doc.accessors ?? [],
    index = animationIndex(id, definitions.length, 'material accessor'),
    def = definitions[index];
  if (def.componentType !== 5126 || def.type !== type || (def.normalized !== undefined && def.normalized !== false))
    throw new TypeError('Material animation accessors must be unnormalized Float32 ' + type);
  if (!Number.isSafeInteger(def.count) || def.count < 1)
    throw new RangeError('Material animation accessor count must be positive');
  const data = model.asset.accessor(index, type);
  if (data.length !== def.count * (type === 'SCALAR' ? 1 : 2) || data.some((v) => !Number.isFinite(v)))
    throw new RangeError('Material animation accessor length/values must match its definition');
  return new Float32Array(data);
}
function timesFor(model: PBRModel, def: AnimationDefinition, value: unknown): Float32Array {
  const sampler = animationSampler(def.samplers[animationIndex(value, def.samplers.length, 'material sampler')]),
    times = accessor(model, sampler.input, 'SCALAR');
  if (times.some((v, i) => v < 0 || (i > 0 && v <= times[i - 1])))
    throw new RangeError('Material animation times must be nonnegative and strictly increasing');
  return times;
}

/** @internal Validate only the fixed material pointer subset; leave ordinary node parsing to Animation. */
export function materialTracks(
  model: PBRModel,
  def: AnimationDefinition,
): { tracks: MaterialTrack[]; nodeChannels: unknown[]; duration: number } {
  const tracks: MaterialTrack[] = [],
    nodeChannels: unknown[] = [],
    destinations = new Set<string>();
  let duration = 0;
  for (const value of def.channels) {
    const channel = object(value, 'Animation channel'),
      target = object(channel.target, 'Animation target'),
      extensions =
        target.extensions === undefined ? undefined : object(target.extensions, 'Animation target extensions');
    if (target.path !== 'pointer' && extensions?.KHR_animation_pointer === undefined) {
      nodeChannels.push(value);
      continue;
    }
    if (target.path !== 'pointer' || Object.hasOwn(target, 'node'))
      throw new TypeError('Material animation pointer requires path pointer and an absent target node');
    const pointer = object(extensions?.KHR_animation_pointer, 'KHR_animation_pointer').pointer;
    const match =
      typeof pointer === 'string' &&
      /^\/materials\/(0|[1-9]\d*)\/pbrMetallicRoughness\/baseColorTexture\/extensions\/KHR_texture_transform\/(offset|scale)$/.exec(
        pointer,
      );
    if (!match) throw new TypeError('Unsupported material animation pointer; use baseColorTexture offset or scale');
    const material = animationIndex(Number(match[1]), model.asset.doc.materials?.length ?? 0, 'material'),
      property = match[2] as Property;
    const info = model.asset.doc.materials![material].pbrMetallicRoughness?.baseColorTexture;
    if (
      !info ||
      !Number.isInteger(info.index) ||
      info.index < 0 ||
      info.index >= (model.asset.doc.textures?.length ?? 0)
    )
      throw new TypeError('Material animation target needs a real baseColorTexture');
    const transform = object(info.extensions?.KHR_texture_transform, 'Material animation initial transform');
    pair(transform[property], 'Material animation initial ' + property);
    textureCoordinates(info);
    if (!model.primitives.some((p) => p.definition.material === material))
      throw new TypeError('Material animation target must have a current model primitive');
    const key = material + ':' + property;
    if (destinations.has(key)) throw new TypeError('Duplicate material animation target; use one channel per property');
    destinations.add(key);
    const sampler = animationSampler(
      def.samplers[animationIndex(channel.sampler, def.samplers.length, 'material sampler')],
    );
    if (sampler.interpolation !== 'STEP')
      throw new TypeError('Material animation requires explicit STEP interpolation');
    const times = timesFor(model, def, channel.sampler),
      values = accessor(model, sampler.output, 'VEC2');
    if (values.length !== times.length * 2) throw new RangeError('Material animation output count must match its keys');
    duration = Math.max(duration, times[times.length - 1]);
    tracks.push({ material, property, times, values });
  }
  return { tracks, nodeChannels, duration };
}

function live(model: PBRModel): void {
  if (!(model instanceof PBRModel)) throw new TypeError('Material animation needs a PBRModel');
  const root = model.root,
    engine = root.engine;
  if (model.disposed || engine.disposed)
    throw new MargoError('disposed', 'Material animation model is disposed; load a new model');
  if (engine.meshes.get(root.id) !== root)
    throw new MargoError('state', 'Material animation model root is stale; load a new model');
}
function mapFor(binding: Binding) {
  const map = binding.material.maps?.[0];
  if (!map || map.index !== binding.texture || !Array.isArray(binding.material.uvt) || binding.material.uvt.length < 8)
    throw new MargoError('state', 'Material animation binding changed; recreate the player for the current material');
  const transform = object(map.extensions?.KHR_texture_transform, 'Material animation map transform');
  for (const property of binding.tracks.keys()) pair(transform[property], 'Material animation map ' + property);
  textureCoordinates(map);
  return map;
}

/**
 * Create a fixed-target STEP texture-transform player for an original glTF clip index (default 0).
 * seek uses finite nonnegative seconds, clamps by default, or wraps at the selected clip duration when loop is true.
 * A zero-duration single-key clip always holds its key. Construction does not seek; dispose releases ownership,
 * leaves the displayed sample intact and is safe to repeat. The model disposes its player automatically.
 */
export function createMaterialAnimation(
  model: PBRModel,
  options: { clip?: number; loop?: boolean } = {},
): { seek(seconds: number): void; dispose(): void } {
  live(model);
  object(options, 'Material animation options');
  if (options.loop !== undefined && typeof options.loop !== 'boolean')
    throw new TypeError('Material animation loop must be boolean');
  const definitions = model.asset.doc.animations ?? [],
    index = animationIndex(options.clip === undefined ? 0 : options.clip, definitions.length, 'material clip'),
    def = animationDefinition(definitions[index]);
  const parsed = materialTracks(model, def);
  if (!parsed.tracks.length) throw new TypeError('Selected clip needs supported material animation tracks');
  let duration = parsed.duration;
  // Mixed clips wrap at their whole duration, including ordinary node tracks.
  for (const channel of parsed.nodeChannels) {
    const times = timesFor(model, def, object(channel, 'Animation channel').sampler);
    duration = Math.max(duration, times[times.length - 1]);
  }
  const asset = model.asset,
    doc = asset.doc,
    bindings = new Map<PBRMaterial, Binding>(),
    indices = new Set(parsed.tracks.map((t) => t.material));
  for (const track of parsed.tracks)
    for (const primitive of model.primitives)
      if (primitive.definition.material === track.material) {
        let binding = bindings.get(primitive.material);
        if (!binding) {
          binding = {
            material: primitive.material,
            texture: doc.materials![track.material].pbrMetallicRoughness!.baseColorTexture!.index,
            primitives: new Map(),
            tracks: new Map(),
          };
          bindings.set(primitive.material, binding);
        }
        const previous = binding.tracks.get(track.property);
        if (previous && previous !== track)
          throw new TypeError('Aliased material animation targets overlap; use one track per actual material property');
        binding.tracks.set(track.property, track);
        binding.primitives.set(primitive, track.material);
      }
  const preflight = (): void => {
    live(model);
    if (model.asset !== asset || model.asset.doc !== doc)
      throw new MargoError('state', 'Material animation asset changed; recreate the player');
    let count = 0,
      expected = 0;
    for (const binding of bindings.values()) {
      expected += binding.primitives.size;
      for (const [primitive, index] of binding.primitives) {
        if (
          !model.primitives.includes(primitive) ||
          primitive.material !== binding.material ||
          primitive.definition.material !== index ||
          primitive.node.engine !== model.root.engine ||
          primitive.node.engine.meshes.get(primitive.node.id) !== primitive.node
        )
          throw new MargoError('state', 'Material animation primitive binding changed; recreate the player');
      }
      mapFor(binding);
    }
    for (const primitive of model.primitives) if (indices.has(primitive.definition.material!)) count++;
    if (count !== expected)
      throw new MargoError('state', 'Material animation primitive bindings changed; recreate the player');
  };
  preflight();
  for (const binding of bindings.values())
    for (const property of binding.tracks.keys())
      if (claims.get(binding.material)?.has(property))
        throw new MargoError(
          'attached',
          'Material animation property is already owned by an active player; dispose that player first',
        );
  for (const binding of bindings.values()) {
    let properties = claims.get(binding.material);
    if (!properties) claims.set(binding.material, (properties = new Set()));
    for (const property of binding.tracks.keys()) properties.add(property);
  }
  let disposed = false,
    unsubscribe: (() => void) | undefined;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    unsubscribe?.();
    unsubscribe = undefined;
    for (const binding of bindings.values()) {
      const properties = claims.get(binding.material)!;
      for (const property of binding.tracks.keys()) properties.delete(property);
      if (!properties.size) claims.delete(binding.material);
    }
  };
  try {
    unsubscribe = model.onDispose(dispose);
  } catch (error) {
    dispose();
    throw error;
  }
  const loop = options.loop ?? false;
  return {
    dispose,
    seek(seconds: number): void {
      if (disposed) throw new MargoError('disposed', 'Material animation player is disposed; create a new player');
      if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0)
        throw new RangeError('Material animation seconds must be finite and nonnegative');
      preflight();
      const time = loop && duration > 0 ? seconds % duration : Math.min(seconds, duration);
      const samples = new Map<MaterialTrack, [number, number]>();
      for (const track of parsed.tracks) {
        const sample = sampleTrackInto(track.times, track.values, 2, time, 'STEP');
        samples.set(track, [sample[0], sample[1]]);
      }
      // Prepare every descriptor and row before writing even the first material.
      const updates = Array.from(bindings.values(), (binding) => {
        const map = mapFor(binding),
          old = map.extensions!.KHR_texture_transform!;
        const transform = { ...old };
        for (const [property, track] of binding.tracks) transform[property] = samples.get(track)!;
        // Own the nested pair metadata as well; imported maps can alias the immutable asset document.
        if (transform.offset) transform.offset = [...transform.offset];
        if (transform.scale) transform.scale = [...transform.scale];
        const texCoord = textureCoordinates(map).texCoord,
          rows = textureTransform({ ...transform, texCoord }, texCoord),
          uvt = binding.material.uvt!;
        const changed =
          [...binding.tracks.keys()].some((property) => {
            const a = old[property]!,
              b = transform[property]!;
            return !Object.is(a[0], b[0]) || !Object.is(a[1], b[1]);
          }) || rows.some((v, i) => !Object.is(v, uvt[i]));
        return {
          binding,
          changed,
          map: { ...map, extensions: { ...map.extensions, KHR_texture_transform: transform } },
          rows,
        };
      });
      for (const { binding, changed, map, rows } of updates)
        if (changed) {
          const maps = binding.material.maps.slice();
          maps[0] = map;
          binding.material.maps = maps;
          for (let i = 0; i < 8; i++) binding.material.uvt![i] = rows[i];
        }
    },
  };
}
