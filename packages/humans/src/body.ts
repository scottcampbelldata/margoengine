// @margoengine/humans/body: a person from a skeleton and skinned meshes built in code (a procedural body, a body read
// from another format, a body a tool hands over), with no glTF file. addBody writes the bones and meshes into an
// in-memory glTF 2.0 document (bone nodes from the bind matrices, one skin with their inverse binds, the clips given or a
// rest clip), loads it as a gltf/pbr model and hands it to addPerson, so the body gets the same defaults a loaded person
// does: skin, eyes and hair by material name, dual quaternion skinning, shadows and the human anatomy limits.
import type { Engine } from '@margoengine/core';
import type { Engine as EngineKernel } from '@margoengine/core/extension';
import { invertMatrix, multiplyMatrices } from '@margoengine/math/mat4';
import { addPerson, type Person, type PersonOptions } from './index.js';
import type { RiggedBone } from './fit.js';

export type { RiggedBone } from './fit.js';

/** One skinned mesh of a {@link BodyDescription}, in the body's rest pose (the space of the bones' bind matrices). */
export interface BodyMesh {
  /** Mesh name. Default `body`, `body1`, ... */
  readonly name?: string;
  /**
   * Material name; addPerson dresses by it (`Skin`, `Eye`, `Hair` and the other names it knows). Default `Skin`.
   */
  readonly material?: string;
  /** Rest positions, 3 numbers a vertex, in metres. */
  readonly positions: ArrayLike<number>;
  /** Unit normals, 3 numbers a vertex. */
  readonly normals: ArrayLike<number>;
  /** Texture coordinates, 2 numbers a vertex. Default all zero. */
  readonly uvs?: ArrayLike<number>;
  /** Triangle vertex indices. */
  readonly indices: ArrayLike<number>;
  /** Four bone indices a vertex, into `bones`. */
  readonly joints: ArrayLike<number>;
  /** Four weights a vertex, summing to 1. */
  readonly weights: ArrayLike<number>;
}
/** One animated property of one bone in a {@link BodyClip}, as a glTF animation channel holds it. */
export interface BodyChannel {
  /** The bone, by name or index into `bones`. */
  readonly bone: string | number;
  /** Which property the keys set, in the bone's parent's space. */
  readonly path: 'rotation' | 'translation' | 'scale';
  /** Key times in seconds, increasing. */
  readonly times: ArrayLike<number>;
  /** Key values: 4 numbers a key (x, y, z, w) for rotation, 3 for translation and scale. */
  readonly values: ArrayLike<number>;
  /** Default `LINEAR`. */
  readonly interpolation?: 'LINEAR' | 'STEP';
}
/** A named clip of a {@link BodyDescription}. */
export interface BodyClip {
  readonly name: string;
  readonly channels: readonly BodyChannel[];
}
/** What {@link addBody} builds a person from. */
export interface BodyDescription {
  /**
   * The skeleton, parents before children: each bone's name, its parent's index (-1 for a root) and its bind matrix in
   * the body's space, 16 numbers column-major. Human bone names (the humanoid names, Mixamo, Character Creator, ...)
   * give the body its anatomy limits.
   */
  readonly bones: readonly RiggedBone[];
  /** The skinned meshes, at least one. */
  readonly meshes: readonly BodyMesh[];
  /** Clips to play. Default one clip `rest` holding every bone at its bind pose. */
  readonly clips?: readonly BodyClip[];
}

type Doc = Record<string, unknown> & { accessors: object[]; bufferViews: object[]; buffers: object[] };

/** Splits a matrix into translation, rotation (unit quaternion x, y, z, w) and scale. Shear is not kept. */
function decompose(m: ArrayLike<number>): { t: number[]; r: number[]; s: number[] } {
  const sx = Math.hypot(m[0], m[1], m[2]),
    sy = Math.hypot(m[4], m[5], m[6]),
    sz0 = Math.hypot(m[8], m[9], m[10]),
    det =
      m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]),
    sz = det < 0 ? -sz0 : sz0,
    a = m[0] / sx,
    b = m[1] / sx,
    c = m[2] / sx,
    d = m[4] / sy,
    e = m[5] / sy,
    f = m[6] / sy,
    g = m[8] / sz,
    h = m[9] / sz,
    k = m[10] / sz,
    trace = a + e + k;
  let r: number[];
  // Shepperd's method: the largest of the four squared components decides which formula is well conditioned.
  if (trace > 0) {
    const q = Math.sqrt(trace + 1) * 2;
    r = [(f - h) / q, (g - c) / q, (b - d) / q, q / 4];
  } else if (a > e && a > k) {
    const q = Math.sqrt(1 + a - e - k) * 2;
    r = [q / 4, (d + b) / q, (g + c) / q, (f - h) / q];
  } else if (e > k) {
    const q = Math.sqrt(1 + e - a - k) * 2;
    r = [(d + b) / q, q / 4, (h + f) / q, (g - c) / q];
  } else {
    const q = Math.sqrt(1 + k - a - e) * 2;
    r = [(g + c) / q, (h + f) / q, q / 4, (b - d) / q];
  }
  const n = Math.hypot(r[0], r[1], r[2], r[3]);
  return { t: [m[12], m[13], m[14]], r: r.map((v) => v / n), s: [sx, sy, sz] };
}

const finite = (data: ArrayLike<number>, label: string): void => {
  for (let i = 0; i < data.length; i++)
    if (!Number.isFinite(data[i])) throw new RangeError(`addBody ${label} holds a value that is not a finite number`);
};

/**
 * The glTF 2.0 document and binary buffer {@link addBody} loads: bone nodes (their rest pose from the bind matrices),
 * one skinned mesh node a mesh, one skin and the clips. Exported to save a body as a file or to check it.
 * @throws TypeError for a missing or malformed part; RangeError for a value out of range.
 */
export function bodyGLTF(description: BodyDescription): { doc: Record<string, unknown>; buffer: Uint8Array } {
  const { bones, meshes, clips } = description ?? ({} as BodyDescription);
  if (!Array.isArray(bones) || !bones.length) throw new TypeError('addBody needs bones: [{name, parent, bind}, ...]');
  if (!Array.isArray(meshes) || !meshes.length)
    throw new TypeError('addBody needs meshes: [{positions, normals, indices, joints, weights}, ...]');
  const names = new Map<string, number>();
  bones.forEach((bone, i) => {
    if (!bone || typeof bone.name !== 'string' || !bone.name) throw new TypeError(`addBody bone ${i} needs a name`);
    if (names.has(bone.name)) throw new TypeError(`addBody bone name ${bone.name} is used twice`);
    names.set(bone.name, i);
    if (!Number.isInteger(bone.parent) || bone.parent < -1 || bone.parent >= i)
      throw new RangeError(`addBody bone ${bone.name} parent must be -1 or the index of an earlier bone`);
    if (!bone.bind || bone.bind.length !== 16) throw new TypeError(`addBody bone ${bone.name} bind needs 16 numbers`);
    finite(bone.bind, `bone ${bone.name} bind`);
  });
  const chunks: Uint8Array[] = [],
    doc: Doc = { accessors: [], bufferViews: [], buffers: [] };
  let length = 0;
  const accessor = (
    data: Float32Array | Uint16Array | Uint32Array,
    type: string,
    extra: object = {},
    target?: number,
  ) => {
    chunks.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    doc.bufferViews.push({ buffer: 0, byteOffset: length, byteLength: data.byteLength, ...(target ? { target } : {}) });
    length += data.byteLength;
    const pad = (4 - (data.byteLength % 4)) % 4;
    if (pad) {
      chunks.push(new Uint8Array(pad));
      length += pad;
    }
    const width = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[type]!,
      componentType = data instanceof Float32Array ? 5126 : data instanceof Uint16Array ? 5123 : 5125;
    doc.accessors.push({
      bufferView: doc.bufferViews.length - 1,
      componentType,
      count: data.length / width,
      type,
      ...extra,
    });
    return doc.accessors.length - 1;
  };
  // Bone nodes: each one's local rest matrix is its parent's inverse bind times its own bind.
  const inverses = bones.map((bone) => {
      const inv = invertMatrix(Float64Array.from(bone.bind));
      if (!inv) throw new RangeError(`addBody bone ${bone.name} bind matrix cannot be inverted`);
      return inv;
    }),
    rest = bones.map((bone) =>
      decompose(bone.parent < 0 ? bone.bind : multiplyMatrices(inverses[bone.parent], Float64Array.from(bone.bind))),
    ),
    nodes: Record<string, unknown>[] = bones.map((bone, i) => {
      const children = bones.flatMap((c, j) => (c.parent === i ? [j] : []));
      return {
        name: bone.name,
        translation: rest[i].t,
        rotation: rest[i].r,
        scale: rest[i].s,
        ...(children.length ? { children } : {}),
      };
    });
  const ibm = new Float32Array(bones.length * 16);
  inverses.forEach((inv, i) => ibm.set(inv, i * 16));
  const skin = { joints: bones.map((_, i) => i), inverseBindMatrices: accessor(ibm, 'MAT4') },
    materials: string[] = [],
    gltfMeshes = meshes.map((mesh, m) => {
      if (!mesh || typeof mesh !== 'object') throw new TypeError(`addBody mesh ${m} must be an object`);
      const n = mesh.positions?.length / 3;
      if (!Number.isInteger(n) || n < 1) throw new TypeError(`addBody mesh ${m} positions need 3 numbers a vertex`);
      if (mesh.normals?.length !== n * 3) throw new TypeError(`addBody mesh ${m} normals need 3 numbers a vertex`);
      if (mesh.joints?.length !== n * 4 || mesh.weights?.length !== n * 4)
        throw new TypeError(`addBody mesh ${m} joints and weights need 4 numbers a vertex`);
      if (mesh.uvs !== undefined && mesh.uvs.length !== n * 2)
        throw new TypeError(`addBody mesh ${m} uvs need 2 numbers a vertex`);
      if (!mesh.indices?.length || mesh.indices.length % 3)
        throw new TypeError(`addBody mesh ${m} indices need 3 a triangle`);
      finite(mesh.positions, `mesh ${m} positions`);
      finite(mesh.normals, `mesh ${m} normals`);
      finite(mesh.weights, `mesh ${m} weights`);
      for (let i = 0; i < mesh.indices.length; i++)
        if (!Number.isInteger(mesh.indices[i]) || mesh.indices[i] < 0 || mesh.indices[i] >= n)
          throw new RangeError(`addBody mesh ${m} index ${i} is not a vertex of the mesh`);
      for (let i = 0; i < mesh.joints.length; i++)
        if (!Number.isInteger(mesh.joints[i]) || mesh.joints[i] < 0 || mesh.joints[i] >= bones.length)
          throw new RangeError(`addBody mesh ${m} joint ${i} is not a bone index`);
      const positions = Float32Array.from(mesh.positions),
        min = [Infinity, Infinity, Infinity],
        max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < positions.length; i++) {
        min[i % 3] = Math.min(min[i % 3], positions[i]);
        max[i % 3] = Math.max(max[i % 3], positions[i]);
      }
      const material = mesh.material ?? 'Skin';
      if (!materials.includes(material)) materials.push(material);
      const attributes = {
        POSITION: accessor(positions, 'VEC3', { min, max }, 34962),
        NORMAL: accessor(Float32Array.from(mesh.normals), 'VEC3', {}, 34962),
        TEXCOORD_0: accessor(mesh.uvs ? Float32Array.from(mesh.uvs) : new Float32Array(n * 2), 'VEC2', {}, 34962),
        JOINTS_0: accessor(Uint16Array.from(mesh.joints), 'VEC4', {}, 34962),
        WEIGHTS_0: accessor(Float32Array.from(mesh.weights), 'VEC4', {}, 34962),
      };
      const indices = accessor(Uint32Array.from(mesh.indices), 'SCALAR', {}, 34963);
      nodes.push({ name: mesh.name ?? (m ? `body${m}` : 'body'), mesh: m, skin: 0 });
      return {
        name: mesh.name ?? (m ? `body${m}` : 'body'),
        primitives: [{ attributes, indices, material: materials.indexOf(material) }],
      };
    });
  // Clips: the ones given, or `rest` holding every bone at its bind pose (two keys, so the clip has a length).
  const given: readonly BodyClip[] = clips ?? [
      {
        name: 'rest',
        channels: bones.map((_, i) => ({
          bone: i,
          path: 'rotation' as const,
          times: [0, 1],
          values: [...rest[i].r, ...rest[i].r],
        })),
      },
    ],
    animations = given.map((clip, c) => {
      if (!clip || typeof clip.name !== 'string' || !Array.isArray(clip.channels) || !clip.channels.length)
        throw new TypeError(`addBody clip ${c} needs a name and channels`);
      const samplers: object[] = [],
        channels = clip.channels.map((ch, k) => {
          const node = typeof ch.bone === 'number' ? ch.bone : names.get(ch.bone);
          if (node === undefined || !Number.isInteger(node) || node < 0 || node >= bones.length)
            throw new RangeError(`addBody clip ${clip.name} channel ${k} names no bone`);
          const width = ch.path === 'rotation' ? 4 : ch.path === 'translation' || ch.path === 'scale' ? 3 : 0;
          if (!width)
            throw new TypeError(`addBody clip ${clip.name} channel ${k} path must be rotation, translation or scale`);
          const times = Float32Array.from(ch.times ?? []);
          if (!times.length || ch.values?.length !== times.length * width)
            throw new TypeError(`addBody clip ${clip.name} channel ${k} needs ${width} values a key time`);
          finite(times, `clip ${clip.name} times`);
          finite(ch.values, `clip ${clip.name} values`);
          for (let i = 1; i < times.length; i++)
            if (!(times[i] > times[i - 1])) throw new RangeError(`addBody clip ${clip.name} key times must increase`);
          samplers.push({
            input: accessor(times, 'SCALAR', { min: [times[0]], max: [times[times.length - 1]] }),
            output: accessor(Float32Array.from(ch.values), width === 4 ? 'VEC4' : 'VEC3'),
            interpolation: ch.interpolation ?? 'LINEAR',
          });
          return { sampler: k, target: { node, path: ch.path } };
        });
      return { name: clip.name, channels, samplers };
    });
  const buffer = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, at);
    at += chunk.byteLength;
  }
  doc.buffers.push({ byteLength: buffer.byteLength });
  const roots = bones.flatMap((bone, i) => (bone.parent < 0 ? [i] : []));
  return {
    doc: {
      asset: { version: '2.0', generator: 'Margo humans addBody' },
      scene: 0,
      scenes: [{ nodes: [...roots, ...meshes.map((_, m) => bones.length + m)] }],
      nodes,
      meshes: gltfMeshes,
      materials: materials.map((name) => ({
        name,
        pbrMetallicRoughness: { baseColorFactor: [0.8, 0.62, 0.52, 1], metallicFactor: 0, roughnessFactor: 0.55 },
      })),
      skins: [skin],
      animations,
      ...doc,
    },
    buffer,
  };
}

/**
 * A person from bones and skinned meshes built in code: {@link bodyGLTF} writes them into an in-memory glTF, gltf/pbr
 * loads it, and {@link addPerson} dresses and animates it with every default a loaded person gets, the human anatomy
 * limits included. `options` are addPerson's. `person.model` is the model addBody built; disposing the person disposes it.
 * @example
 * import { addBody } from '@margoengine/humans/body';
 * const person = await addBody(engine, { bones, meshes: [{ positions, normals, indices, joints, weights }] });
 * person.check(); // [] for a body that keeps to its anatomy
 * @throws TypeError or RangeError for a malformed body (see {@link bodyGLTF}), and what addPerson throws.
 */
export async function addBody(
  engine: Engine,
  description: BodyDescription,
  options: PersonOptions = {},
): Promise<Person> {
  const { doc, buffer } = bodyGLTF(description),
    { parseGLTFAsync } = await import('@margoengine/gltf/pbr'),
    model = await parseGLTFAsync(engine as unknown as EngineKernel, doc, [buffer]);
  let person: Person;
  try {
    person = await addPerson(engine, model, options);
  } catch (error) {
    model.dispose();
    throw error;
  }
  const release = person.dispose,
    dispose = () => {
      release();
      model.dispose();
    };
  return Object.assign(person, { dispose, [Symbol.dispose]: dispose });
}
