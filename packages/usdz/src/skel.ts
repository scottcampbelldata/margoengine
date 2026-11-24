// UsdSkel: skeletons, skin weights, blend shapes and their animation, as glTF skins, morph targets and one clip. Built from
// OpenUSD's public UsdSkel documentation (Schemas, Skinning and Intro pages). Skinned points follow its equation:
// p = sum of weight * (inverse bind * joint skeleton transform) on (geomBindTransform on the local point), so a skinned
// prim's own transform does nothing and glTF's rule, which ignores a skinned mesh's node, says the same.
import { decomposeAffine } from '@margoengine/math/affine';
import { invertMatrix, multiplyMatrices } from '@margoengine/math/mat4';
import type { GLTFNode } from '../../shared/gltf.js';
import { bracket, clipOf, flat, slerp, streamOf, type Stream } from './clip.js';
import type { ExtensionHooks, SceneMesh, SceneRead, USDExtension } from './extension.js';

/** A skeleton in the scene: its joints as nodes, posed by one animation source. */
interface Instance {
  names: string[];
  nodes: number[];
  /** Each joint's bind transform, in skeleton space. */
  binds: number[][];
  animation?: string;
}
/** glTF allows eight influences through the engine's two sets of four. */
const MOST_INFLUENCES = 8;
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const multiply = (a: number[], b: number[]) => multiplyMatrices(a, b, new Array<number>(16));

/** USD quaternions read real part first; glTF holds it last. */
const toGLTF = (q: number[], i: number) => [q[i + 1], q[i + 2], q[i + 3], q[i]];

function scene(read: SceneRead): void {
  const { specs, document: doc } = read,
    inverse = (m: number[]) => {
      const out = invertMatrix(m, new Array<number>(16));
      if (out) return out;
      read.soft('a bind transform cannot be inverted; that joint keeps the identity');
      return IDENTITY;
    },
    field = (path: string, name: string) => specs[path + '.' + name]?.fields,
    value = (path: string, name: string) => {
      const stream = streamOf(read, path, name);
      return stream?.values[0];
    },
    tokens = (path: string, name: string): string[] | undefined => {
      const f = field(path, name),
        samples = f?.timeSamples as { values: unknown[] } | undefined,
        list = samples?.values?.[0] ?? f?.default;
      return Array.isArray(list) ? (list as string[]) : undefined;
    },
    targets = (path: string, name: string) => (field(path, name)?.targetPaths ?? []) as string[],
    parentOf = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/',
    type = (path: string) => specs[path]?.fields.typeName;
  /** The nearest SkelRoot at or above `path`. */
  const skelRoot = (path: string) => {
    for (let at = path; at !== '/'; at = parentOf(at)) if (type(at) === 'SkelRoot') return at;
    return undefined;
  };
  /** The nearest authored target of a binding, from `path` up to `top`. */
  const inherited = (path: string, top: string, name: string) => {
    for (let at = path; ; at = parentOf(at)) {
      const list = targets(at, name);
      if (list.length) return { target: list[0], at };
      if (at === top || at === '/') return undefined;
    }
  };

  const instances = new Map<string, Instance | null>();
  function instance(skeleton: string, animation: string | undefined): Instance | null {
    const key = skeleton + '\0' + (animation ?? '');
    const known = instances.get(key);
    if (known !== undefined) return known;
    const names = tokens(skeleton, 'joints'),
      bind = value(skeleton, 'bindTransforms'),
      rest = value(skeleton, 'restTransforms'),
      owner = read.nodes.get(skeleton);
    if (!names?.length || owner === undefined || !bind || bind.length !== names.length * 16) {
      read.soft(`skeleton ${skeleton} has no usable joints or bind transforms`);
      instances.set(key, null);
      return null;
    }
    const index = new Map(names.map((name, i) => [name, i])),
      parents = names.map((name) => {
        const cut = name.lastIndexOf('/');
        return cut < 0 ? -1 : (index.get(name.slice(0, cut)) ?? -1);
      }),
      binds = names.map((_, i) => bind.slice(i * 16, i * 16 + 16));
    /** A joint's rest pose, in its parent's space. Without rest transforms, the bind pose stands in. */
    const local = (i: number) => {
      if (rest && rest.length === names.length * 16) return rest.slice(i * 16, i * 16 + 16);
      return parents[i] < 0 ? binds[i] : multiply(inverse(binds[parents[i]]), binds[i]);
    };
    const nodes = names.map((name, i) => {
      const parts = decomposeAffine(local(i)),
        node: GLTFNode & { children: number[] } = {
          name: name.slice(name.lastIndexOf('/') + 1),
          translation: Array.from(parts.translation),
          rotation: Array.from(parts.rotation),
          scale: Array.from(parts.scale),
          children: [],
        };
      if (!parts.lossless) read.soft(`joint ${name} of ${skeleton} has shear, which a joint node cannot hold`);
      doc.nodes!.push(node);
      return doc.nodes!.length - 1;
    });
    names.forEach((_, i) => {
      const parent = parents[i] < 0 ? owner : nodes[parents[i]];
      (doc.nodes![parent].children ??= []).push(nodes[i]);
    });
    const made: Instance = { names, nodes, binds, animation };
    instances.set(key, made);
    if (animation) pose(made, animation);
    return made;
  }
  /** The joints a SkelAnimation moves. A joint it does not list keeps its rest pose. */
  function pose(skeleton: Instance, animation: string) {
    const list = tokens(animation, 'joints');
    if (!list?.length) return;
    const t = streamOf(read, animation, 'translations'),
      r = streamOf(read, animation, 'rotations'),
      s = streamOf(read, animation, 'scales');
    // The schema: an animation counts only with all three, each sized to its joints.
    if (!t || !r || !s) return read.soft(`animation ${animation} lacks translations, rotations or scales`);
    const all = [...new Set([...t.times, ...r.times, ...s.times])].sort((a, b) => a - b),
      clip = clipOf(read),
      seconds = clip.seconds(all),
      count = Math.max(all.length, 1);
    const at = (stream: Stream, time: number | undefined, width: number) => {
      const [a, b, f] = time === undefined ? ([0, 0, 0] as const) : bracket(stream.times, time);
      return { from: stream.values[a], to: stream.values[b], f, width };
    };
    list.forEach((joint, k) => {
      const j = skeleton.names.indexOf(joint);
      if (j < 0) return;
      const moved = new Float32Array(count * 3),
        turned = new Float32Array(count * 4),
        sized = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        const time = all[i],
          p = at(t, time, 3),
          q = at(r, time, 4),
          z = at(s, time, 3);
        for (let d = 0; d < 3; d++) {
          moved[i * 3 + d] = p.from[k * 3 + d] + (p.to[k * 3 + d] - p.from[k * 3 + d]) * p.f;
          sized[i * 3 + d] = z.from[k * 3 + d] + (z.to[k * 3 + d] - z.from[k * 3 + d]) * z.f;
        }
        slerp(toGLTF(q.from, k * 4), toGLTF(q.to, k * 4), q.f, turned, i * 4);
      }
      const node = doc.nodes![skeleton.nodes[j]];
      node.translation = Array.from(moved.subarray(0, 3));
      node.rotation = Array.from(turned.subarray(0, 4));
      node.scale = Array.from(sized.subarray(0, 3));
      if (all.length < 2) return;
      const still = (data: Float32Array, width: number) => data.every((v, i) => v === data[i % width]);
      if (!still(moved, 3)) clip.channel(skeleton.nodes[j], 'translation', seconds, moved);
      if (!still(turned, 4)) clip.channel(skeleton.nodes[j], 'rotation', seconds, turned);
      if (!still(sized, 3)) clip.channel(skeleton.nodes[j], 'scale', seconds, sized);
    });
  }
  /** Skin weights to JOINTS and WEIGHTS over the mesh's expanded vertices, and the skin itself. */
  function skin(mesh: SceneMesh, skeleton: Instance) {
    const indices = value(mesh.path, 'primvars:skel:jointIndices'),
      weights = value(mesh.path, 'primvars:skel:jointWeights');
    if (!indices?.length || indices.length !== weights?.length) return;
    const info = field(mesh.path, 'primvars:skel:jointIndices'),
      size = typeof info?.elementSize === 'number' && info.elementSize > 0 ? info.elementSize : 1,
      constant = info?.interpolation === 'constant';
    if (info?.interpolation !== undefined && !constant && info.interpolation !== 'vertex')
      return read.soft(`joint influences of ${mesh.path} are ${String(info.interpolation)}, which the schema calls an error`);
    // skel:joints is this mesh's own order for its indices.
    const order = tokens(mesh.path, 'skel:joints'),
      remap = order?.map((name) => skeleton.names.indexOf(name));
    if (remap?.includes(-1)) return read.soft(`skel:joints of ${mesh.path} names a joint its skeleton lacks`);
    const points = constant ? 1 : indices.length / size,
      slots = Math.min(size, MOST_INFLUENCES),
      sets = Math.ceil(slots / 4),
      picked = new Uint16Array(points * sets * 4),
      amount = new Float32Array(points * sets * 4);
    let cut = false;
    for (let p = 0; p < points; p++) {
      const own: [number, number][] = [];
      for (let i = 0; i < size; i++) {
        const w = weights[p * size + i],
          j = indices[p * size + i];
        if (!w) continue;
        const joint = remap ? remap[j] : j;
        // glTF JOINTS hold unsigned 16-bit indices: a larger one would wrap onto another joint.
        if (!Number.isInteger(joint) || joint < 0 || joint >= skeleton.names.length)
          return read.soft(`a joint index of ${mesh.path} is outside its skeleton's ${skeleton.names.length} joints`);
        if (joint > 65_535)
          return read.soft(`${mesh.path} uses joint ${joint}; glTF JOINTS hold at most 65,536 joints, so it is not skinned`);
        own.push([joint, w]);
      }
      own.sort((a, b) => b[1] - a[1]);
      let scale = 1;
      if (own.length > MOST_INFLUENCES) {
        cut = true;
        const all = own.reduce((sum, item) => sum + item[1], 0),
          kept = own.slice(0, MOST_INFLUENCES).reduce((sum, item) => sum + item[1], 0);
        scale = kept ? all / kept : 1;
      }
      own.slice(0, MOST_INFLUENCES).forEach(([j, w], i) => {
        picked[p * sets * 4 + i] = j;
        amount[p * sets * 4 + i] = w * scale;
      });
    }
    if (cut) read.soft(`${mesh.path} has more than ${MOST_INFLUENCES} influences on a point; the strongest are kept and scaled`);
    // A refined point takes the influences of the points it comes from, in proportion.
    const refined = !constant ? mesh.shape?.influences?.(picked, amount, sets * 4) : undefined,
      finalJoints = refined?.joints ?? picked,
      finalWeights = refined?.weights ?? amount;
    const count = mesh.vertexOf.length,
      attributes = doc.meshes![mesh.mesh].primitives.map((p) => p.attributes!);
    for (let set = 0; set < sets; set++) {
      const joints = new Uint16Array(count * 4),
        strength = new Float32Array(count * 4);
      for (let v = 0; v < count; v++) {
        const from = ((constant ? 0 : mesh.vertexOf[v]) * sets + set) * 4;
        for (let d = 0; d < 4; d++) {
          joints[v * 4 + d] = finalJoints[from + d];
          strength[v * 4 + d] = finalWeights[from + d];
        }
      }
      const j = read.accessor(joints, 'VEC4'),
        w = read.accessor(strength, 'VEC4');
      for (const list of attributes) {
        list['JOINTS_' + set] = j;
        list['WEIGHTS_' + set] = w;
      }
    }
    const geomBind = value(mesh.path, 'primvars:skel:geomBindTransform') ?? IDENTITY,
      binds = new Float32Array(skeleton.names.length * 16);
    skeleton.binds.forEach((bind, j) => binds.set(multiply(inverse(bind), geomBind), j * 16));
    (doc.skins ??= []).push({ joints: skeleton.nodes, inverseBindMatrices: read.accessor(binds, 'MAT4') });
    doc.nodes![mesh.node].skin = doc.skins.length - 1;
  }
  /** Blend shapes to morph targets. In-betweens are targets of their own, so one shape weight can drive several. */
  function blend(mesh: SceneMesh, animation: string | undefined) {
    const names = tokens(mesh.path, 'skel:blendShapes'),
      prims = targets(mesh.path, 'skel:blendShapeTargets');
    if (!names?.length || !prims.length) return;
    if (names.length !== prims.length) return read.soft(`skel:blendShapes of ${mesh.path} do not match its targets`);
    const count = mesh.vertexOf.length,
      points = mesh.shape ? (value(mesh.path, 'points')?.length ?? 0) / 3 : 1 + mesh.vertexOf.reduce((most, p) => Math.max(most, p), 0);
    /** Per-point offsets spread over the mesh's expanded vertices. */
    const spread = (offsets: number[], sparse: number[] | undefined) => {
      const authored = new Float32Array(points * 3),
        length = offsets.length / 3;
      for (let i = 0; i < length; i++) {
        const point = sparse ? sparse[i] : i;
        if (point >= points) continue;
        for (let d = 0; d < 3; d++) authored[point * 3 + d] = offsets[i * 3 + d];
      }
      const perPoint = mesh.shape?.spread?.(authored, 3) ?? authored,
        out = new Float32Array(count * 3);
      for (let v = 0; v < count; v++)
        for (let d = 0; d < 3; d++) out[v * 3 + d] = perPoint[mesh.vertexOf[v] * 3 + d];
      return out;
    };
    /** Each shape's steps by weight, the implied empty shape at 0 included, as target numbers. */
    const shapes: { weight: number; target: number }[][] = [],
      morphs: Record<string, number>[] = [];
    prims.forEach((shape) => {
      const sparse = value(shape, 'pointIndices'),
        steps: { weight: number; target: number }[] = [{ weight: 0, target: -1 }];
      const add = (weight: number, offsets: number[] | undefined, normals: number[] | undefined) => {
        if (!offsets?.length) return;
        const morph: Record<string, number> = { POSITION: read.accessor(spread(offsets, sparse), 'VEC3') };
        if (normals?.length) morph.NORMAL = read.accessor(spread(normals, sparse), 'VEC3');
        steps.push({ weight, target: morphs.length });
        morphs.push(morph);
      };
      add(1, value(shape, 'offsets'), value(shape, 'normalOffsets'));
      for (const key in specs) {
        if (!key.startsWith(shape + '.inbetweens:') || key.endsWith(':normalOffsets')) continue;
        const name = key.slice(shape.length + 1),
          weight = specs[key].fields.weight;
        if (typeof weight !== 'number' || weight === 0 || weight === 1 || steps.some((s) => s.weight === weight)) {
          read.soft(`in-between ${key} has no usable weight`);
          continue;
        }
        add(weight, value(shape, name), value(shape, name + ':normalOffsets'));
      }
      shapes.push(steps.sort((a, b) => a.weight - b.weight));
    });
    if (!morphs.length) return;
    for (const primitive of doc.meshes![mesh.mesh].primitives) primitive.targets = morphs;
    /** Morph weights for a shape's weight: linear between its two nearest steps, and past them at the ends. */
    const apply = (shape: { weight: number; target: number }[], w: number, out: Float32Array, offset: number) => {
      let i = 0;
      while (i < shape.length - 2 && w >= shape[i + 1].weight) i++;
      const a = shape[i],
        b = shape[i + 1];
      if (!b) return;
      const f = (w - a.weight) / (b.weight - a.weight);
      if (a.target >= 0) out[offset + a.target] += 1 - f;
      if (b.target >= 0) out[offset + b.target] += f;
    };
    const channel = animation ? streamOf(read, animation, 'blendShapeWeights') : undefined,
      order = animation ? tokens(animation, 'blendShapes') : undefined,
      weightsAt = (values: number[], out: Float32Array, offset: number) => {
        names.forEach((name, i) => {
          const k = order?.indexOf(name) ?? -1;
          apply(shapes[i], k < 0 ? 0 : values[k], out, offset);
        });
      };
    const first = new Float32Array(morphs.length);
    if (channel) weightsAt(channel.values[0], first, 0);
    doc.meshes![mesh.mesh].weights = Array.from(first);
    if (!channel || channel.times.length < 2) return;
    // Morph weights are linear between keys and shape weights bend at each in-between, so a key goes where one is crossed.
    const times: number[] = [],
      rows: number[][] = [];
    channel.values.forEach((values, i) => {
      times.push(channel.times[i]);
      rows.push(values);
      const next = channel.values[i + 1];
      if (!next) return;
      const crossed = new Set<number>();
      names.forEach((name, s) => {
        const k = order?.indexOf(name) ?? -1;
        if (k < 0 || values[k] === next[k]) return;
        for (const { weight } of shapes[s]) {
          const f = (weight - values[k]) / (next[k] - values[k]);
          if (f > 0 && f < 1) crossed.add(f);
        }
      });
      for (const f of [...crossed].sort((a, b) => a - b)) {
        times.push(channel.times[i] + (channel.times[i + 1] - channel.times[i]) * f);
        rows.push(values.map((v, k) => v + (next[k] - v) * f));
      }
    });
    const clip = clipOf(read),
      output = new Float32Array(times.length * morphs.length);
    rows.forEach((values, i) => weightsAt(values, output, i * morphs.length));
    clip.channel(mesh.node, 'weights', clip.seconds(times), output);
  }

  for (const mesh of read.meshes) {
    // Bindings outside a SkelRoot mean nothing, by the schema.
    const top = skelRoot(mesh.path);
    if (!top) continue;
    const bound = inherited(mesh.path, top, 'skel:skeleton'),
      skeleton = bound?.target;
    if (!skeleton || type(skeleton) !== 'Skeleton') {
      blend(mesh, undefined);
      continue;
    }
    // An animation source reaches down to the next skeleton binding; the Skeleton prim may hold one for itself.
    const animation = inherited(bound!.at, top, 'skel:animationSource')?.target ?? targets(skeleton, 'skel:animationSource')[0],
      made = instance(skeleton, animation);
    if (!made) continue;
    skin(mesh, made);
    blend(mesh, animation);
  }
}

/** UsdSkel for the USD readers: pass `extensions: [composition(), skeletons()]`. Rigged characters then play through the clip. */
export function skeletons(): USDExtension {
  const hook: ExtensionHooks = { name: 'skel', scene };
  return hook;
}
