/** Lossless animation reduction, reachable-resource pruning and static GPU instancing for GLB files. */
import { dropUnreadAccessors } from './glb-columns.js';
import { joinGLB, readAccessor, splitGLB, type GLBParts } from './glb.js';
import { addView, packGLB, useExtension, type JSONObject, type NewViews } from './glb-pack.js';
import { decompose } from './scene.js';

/** Controls the independent passes. All passes default to enabled. */
export interface OptimizeExtraOptions {
  /** Remove redundant LINEAR and STEP animation keys. Default true; cubic splines remain unchanged. */
  resample?: boolean;
  /** Remove unreachable nodes and resources. Default true. Unknown extensions retain indices conservatively. */
  prune?: boolean;
  /** Batch static mesh references under the same parent. Default true. */
  instance?: boolean;
  /** Smallest batch, an integer at least two. Default 2. */
  minInstances?: number;
  /** Stop before a pass, animation sampler or instance batch. */
  signal?: AbortSignal;
}

/** Deterministic work and storage counts, without timing measurements. */
export interface OptimizeExtraStats {
  /** Animation keys removed. */
  keys: number;
  /** Nodes removed. */
  nodes: number;
  /** Unused meshes, skins, cameras, materials, textures, samplers, images and accessors removed. */
  resources: number;
  /** New GPU instance batches. */
  batches: number;
  /** Mesh references converted into GPU instances. */
  instances: number;
}

function floatAccessor(json: JSONObject, fresh: NewViews, values: number[], width: number, target?: number): number {
  const data = Float32Array.from(values),
    bufferView = addView(json, fresh, new Uint8Array(data.buffer), target ? { target } : {}),
    accessor: JSONObject = {
      bufferView,
      componentType: 5126,
      count: data.length / width,
      type: ['SCALAR', 'VEC2', 'VEC3', 'VEC4'][width - 1],
    };
  if (width === 1) {
    accessor.min = [values[0]];
    accessor.max = [values[values.length - 1]];
  }
  json.accessors ??= [];
  return json.accessors.push(accessor) - 1;
}

// Compare the complete piecewise curve, not just adjacent equal values. With zero tolerance, this only
// removes keys on the same interpolation arc. STEP keeps both sides of each discontinuity.
function reduced(
  times: ArrayLike<number>,
  values: ArrayLike<number>,
  width: number,
  rotation: boolean,
  step: boolean,
): number[] {
  const keep = [0],
    last = times.length - 1;
  const same = (a: number, b: number): boolean => {
    for (let k = 0; k < width; k++) if (values[a * width + k] !== values[b * width + k]) return false;
    return true;
  };
  if (step) {
    for (let i = 1; i < last; i++) if (!same(keep[keep.length - 1], i)) keep.push(i);
  } else {
    const required = new Set([0, last]),
      ranges = [[0, last]];
    while (ranges.length) {
      const [a, b] = ranges.pop()!;
      let split = -1;
      for (let i = a + 1; i < b; i++) {
        const t = (times[i] - times[a]) / (times[b] - times[a]);
        let dot = 0;
        if (rotation) for (let k = 0; k < 4; k++) dot += values[a * 4 + k] * values[b * 4 + k];
        const sign = dot < 0 ? -1 : 1,
          angle = Math.acos(Math.min(1, Math.abs(dot))),
          sine = Math.sin(angle),
          x = rotation && sine > 1e-6 ? Math.sin((1 - t) * angle) / sine : 1 - t,
          y = rotation && sine > 1e-6 ? Math.sin(t * angle) / sine : t;
        // Float32 is the stored precision. Equality here never uses a caller-controlled tolerance.
        let equal = true,
          opposite = rotation;
        const interpolated = Array.from(
          { length: width },
          (_, k) => x * values[a * width + k] + y * (rotation ? sign : 1) * values[b * width + k],
        );
        const norm = rotation ? Math.hypot(...interpolated) : 1;
        for (let k = 0; k < width; k++) {
          const expected = Math.fround(interpolated[k] / norm),
            actual = values[i * width + k];
          equal &&= expected === actual;
          opposite &&= -expected === actual;
        }
        if (!equal && !opposite) {
          split = i;
          break;
        }
      }
      if (split >= 0) {
        required.add(split);
        ranges.push([a, split], [split, b]);
      }
    }
    keep.length = 0;
    keep.push(...[...required].sort((a, b) => a - b));
  }
  if (keep[keep.length - 1] !== last) keep.push(last);
  return keep;
}

function resample(parts: GLBParts, fresh: NewViews, stats: OptimizeExtraStats, signal?: AbortSignal): void {
  const json = parts.json as JSONObject;
  for (const animation of json.animations ?? [])
    for (let index = 0; index < animation.samplers.length; index++) {
      signal?.throwIfAborted();
      const sampler = animation.samplers[index],
        channels: JSONObject[] = animation.channels.filter((c: JSONObject) => c.sampler === index),
        interpolation = sampler.interpolation ?? 'LINEAR';
      if (!channels.length || !['LINEAR', 'STEP'].includes(interpolation)) continue;
      const paths = channels.map((c) => c.target.path);
      if (paths.some((p) => !['translation', 'rotation', 'scale', 'weights'].includes(p))) continue;
      const times = readAccessor(parts, sampler.input).values,
        output = readAccessor(parts, sampler.output),
        width = output.values.length / times.length;
      if (times.length < 3 || !Number.isInteger(width) || width < 1) continue;
      const rotation = paths.includes('rotation');
      if (rotation && (width !== 4 || paths.some((p) => p !== 'rotation'))) continue;
      const keep = reduced(times, output.values, width, rotation, interpolation === 'STEP');
      if (keep.length === times.length) continue;
      const values: number[] = [];
      for (const i of keep) for (let k = 0; k < width; k++) values.push(output.values[i * width + k]);
      sampler.input = floatAccessor(
        json,
        fresh,
        keep.map((i) => times[i]),
        1,
      );
      sampler.output = floatAccessor(json, fresh, values, paths[0] === 'weights' ? 1 : width);
      stats.keys += times.length - keep.length;
    }
}

function walk(value: unknown, visit: (object: JSONObject, key: string) => void): void {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    visit(value as JSONObject, key);
    walk(child, visit);
  }
}

// Extensions with hidden indices cannot safely be renumbered by an unaware transform.
function opaque(json: JSONObject): boolean {
  return (json.extensionsUsed ?? []).some(
    (name: string) =>
      !/^KHR_materials_(?!variants$)/.test(name) &&
      ![
        'KHR_materials_variants',
        'KHR_texture_transform',
        'KHR_mesh_quantization',
        'KHR_draco_mesh_compression',
        'EXT_meshopt_compression',
        'EXT_mesh_gpu_instancing',
        'EXT_texture_webp',
        'EXT_texture_avif',
        'KHR_texture_basisu',
        'KHR_lights_punctual',
        'KHR_node_visibility',
      ].includes(name),
  );
}

function prune(json: JSONObject, stats: OptimizeExtraStats): void {
  if (opaque(json)) return;
  const compact = (name: string, refs: [JSONObject, string][], retained: Iterable<number> = []): void => {
      const list: JSONObject[] = json[name] ?? [],
        used = new Set([...refs.map(([holder, key]) => holder[key]), ...retained]),
        indices = new Map<number, number>(),
        kept = list.filter((_, i) => {
          if (!used.has(i)) return false;
          indices.set(i, indices.size);
          return true;
        });
      stats[name === 'nodes' ? 'nodes' : 'resources'] += list.length - kept.length;
      for (const [holder, key] of refs) holder[key] = indices.get(holder[key]);
      if (kept.length) json[name] = kept;
      else delete json[name];
    },
    refs = (name: string, objects: JSONObject[]): [JSONObject, string][] =>
      objects.filter((o) => Number.isSafeInteger(o[name])).map((o) => [o, name]);
  const nodes: JSONObject[] = json.nodes ?? [],
    live = new Set<number>();
  const mark = (i: number): void => {
    if (live.has(i) || !nodes[i]) return;
    live.add(i);
    for (const child of nodes[i].children ?? []) mark(child);
  };
  for (const scene of json.scenes ?? []) for (const i of scene.nodes ?? []) mark(i);
  for (const animation of json.animations ?? [])
    for (const c of animation.channels ?? []) if (c.target.node !== undefined) mark(c.target.node);
  // Animation targets, skin joints and transform ancestors can each expose another skin.
  // Finish the dependency closure before compacting any of their node references.
  const usedSkins = new Set<number>();
  let changed = true;
  while (changed) {
    const before = live.size;
    for (const i of live) {
      const index = nodes[i].skin, skin = json.skins?.[index];
      if (!skin || usedSkins.has(index)) continue;
      usedSkins.add(index);
      for (const joint of [...skin.joints, ...(skin.skeleton === undefined ? [] : [skin.skeleton])]) mark(joint);
    }
    nodes.forEach((n, i) => {
      if (!live.has(i) && n.children?.some((c: number) => live.has(c))) live.add(i);
    });
    changed = live.size !== before;
  }
  const protectedNodes = new Set<number>();
  for (const animation of json.animations ?? [])
    for (const c of animation.channels ?? []) protectedNodes.add(c.target.node);
  for (const [index, skin] of (json.skins ?? []).entries())
    if (usedSkins.has(index)) {
      for (const i of skin.joints) protectedNodes.add(i);
      if (skin.skeleton !== undefined) protectedNodes.add(skin.skeleton);
    }
  changed = true;
  while (changed) {
    changed = false;
    for (const i of live) {
      const n = nodes[i];
      if (
        protectedNodes.has(i) ||
        n.mesh !== undefined ||
        n.camera !== undefined ||
        n.extensions ||
        n.extras ||
        n.children?.length
      )
        continue;
      live.delete(i);
      changed = true;
      for (const scene of json.scenes ?? []) if (scene.nodes) scene.nodes = scene.nodes.filter((j: number) => j !== i);
      for (const parent of nodes) if (parent.children) parent.children = parent.children.filter((j: number) => j !== i);
    }
  }
  // Detach unreachable subgraphs first; no dangling references are admitted to compaction.
  for (let i = 0; i < nodes.length; i++) if (!live.has(i)) nodes[i] = {};
  const nodeRefs: [JSONObject, string][] = [];
  for (const scene of json.scenes ?? [])
    for (const key of Object.keys(scene.nodes ?? [])) nodeRefs.push([scene.nodes, key]);
  for (const node of nodes) for (const key of Object.keys(node.children ?? [])) nodeRefs.push([node.children, key]);
  for (const [index, skin] of (json.skins ?? []).entries())
    if (usedSkins.has(index)) {
      nodeRefs.push(...refs('skeleton', [skin]));
      for (const key of Object.keys(skin.joints ?? [])) nodeRefs.push([skin.joints, key]);
    }
  for (const animation of json.animations ?? [])
    for (const c of animation.channels ?? []) nodeRefs.push(...refs('node', [c.target]));
  compact('nodes', nodeRefs, live);
  const keptNodes = json.nodes ?? [];
  compact('meshes', refs('mesh', keptNodes));
  compact('skins', refs('skin', keptNodes));
  compact('cameras', refs('camera', keptNodes));
  const materialRefs: [JSONObject, string][] = [];
  for (const mesh of json.meshes ?? [])
    for (const p of mesh.primitives) {
      materialRefs.push(...refs('material', [p]));
      for (const m of p.extensions?.KHR_materials_variants?.mappings ?? []) materialRefs.push(...refs('material', [m]));
    }
  compact('materials', materialRefs);
  const textureRefs: [JSONObject, string][] = [];
  walk(json.materials, (holder, key) => {
    if (key.endsWith('Texture') && Number.isSafeInteger(holder[key]?.index)) textureRefs.push([holder[key], 'index']);
  });
  compact('textures', textureRefs);
  compact('samplers', refs('sampler', json.textures ?? []));
  const imageRefs: [JSONObject, string][] = [];
  walk(json.textures, (holder, key) => {
    if (key === 'source' && Number.isSafeInteger(holder[key])) imageRefs.push([holder, key]);
  });
  compact('images', imageRefs);
  const before = json.accessors?.length ?? 0;
  json.accessors ??= [];
  dropUnreadAccessors(json);
  stats.resources += before - json.accessors.length;
  if (!json.accessors.length) delete json.accessors;
}

function instance(
  json: JSONObject,
  fresh: NewViews,
  stats: OptimizeExtraStats,
  min: number,
  signal?: AbortSignal,
): void {
  if (opaque(json)) return;
  const nodes: JSONObject[] = json.nodes ?? [],
    animated = new Set<number>(),
    joints = new Set<number>();
  for (const a of json.animations ?? []) for (const c of a.channels) animated.add(c.target.node);
  for (const s of json.skins ?? []) for (const j of s.joints) joints.add(j);
  const containers: JSONObject[] = [...(json.scenes ?? []), ...nodes.map((n) => ({ nodes: n.children }))];
  const memberships = new Map<number, number>();
  for (const c of containers) for (const i of c.nodes ?? []) memberships.set(i, (memberships.get(i) ?? 0) + 1);
  for (const container of containers) {
    const groups = new Map<string, { index: number; trs: { t: number[]; r: number[]; s: number[] } }[]>();
    for (const index of container.nodes ?? []) {
      const n = nodes[index];
      if (
        memberships.get(index) !== 1 ||
        n.mesh === undefined ||
        n.skin !== undefined ||
        animated.has(index) ||
        joints.has(index) ||
        n.extensions ||
        n.extras ||
        n.weights ||
        json.meshes[n.mesh].weights ||
        json.meshes[n.mesh].primitives.some((p: JSONObject) => p.targets?.length)
      )
        continue;
      const trs = n.matrix
        ? decompose(Float64Array.from(n.matrix))
        : { t: n.translation ?? [0, 0, 0], r: n.rotation ?? [0, 0, 0, 1], s: n.scale ?? [1, 1, 1] };
      if (!trs) continue;
      // Reflections need separate batches, since winding is a draw-level property.
      const key = `${n.mesh}:${Math.sign(trs.s[0] * trs.s[1] * trs.s[2])}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push({ index, trs });
    }
    for (const group of groups.values()) {
      signal?.throwIfAborted();
      if (group.length < min) continue;
      const attributes: JSONObject = {};
      for (const [name, field, width] of [
        ['TRANSLATION', 't', 3],
        ['ROTATION', 'r', 4],
        ['SCALE', 's', 3],
      ] as const) {
        attributes[name] = floatAccessor(
          json,
          fresh,
          group.flatMap((g) => g.trs[field]),
          width,
          34962,
        );
      }
      const node = { mesh: nodes[group[0].index].mesh, extensions: { EXT_mesh_gpu_instancing: { attributes } } };
      container.nodes.push(nodes.push(node) - 1);
      for (const { index } of group) delete nodes[index].mesh;
      useExtension(json, 'EXT_mesh_gpu_instancing', true);
      stats.batches++;
      stats.instances += group.length;
    }
  }
}

/**
 * Optimize a self-contained GLB without mutating the source. Animation keys, unused resources and static mesh
 * references are processed independently. Unknown extension indices are retained rather than guessed.
 * @throws {RangeError} If minInstances is invalid; use an integer at least two.
 */
export function optimizeExtraGLB(
  bytes: Uint8Array,
  options: OptimizeExtraOptions = {},
): { glb: Uint8Array; stats: OptimizeExtraStats } {
  const min = options.minInstances ?? 2;
  if (!Number.isSafeInteger(min) || min < 2)
    throw new RangeError(
      'MARGO_EXPORT_OPTIMIZE_MIN: minInstances must be an integer at least 2; set minInstances to 2 or more. See docs/limits.md',
    );
  options.signal?.throwIfAborted();
  let parts = splitGLB(bytes);
  const stats: OptimizeExtraStats = { keys: 0, nodes: 0, resources: 0, batches: 0, instances: 0 },
    fresh: NewViews = new Map();
  if (options.resample !== false) resample(parts, fresh, stats, options.signal);
  if (options.instance !== false) instance(parts.json, fresh, stats, min, options.signal);
  if (options.prune !== false) prune(parts.json, stats);
  else if (!opaque(parts.json)) {
    parts.json.accessors ??= [];
    dropUnreadAccessors(parts.json);
  }
  options.signal?.throwIfAborted();
  parts = packGLB(parts, fresh);
  return { glb: joinGLB(parts), stats };
}
