// A model from the asset library as one mesh part for a biome scatter (`BiomeViewOptions.meshes`): read from its .gltf
// and buffers, merged under its node transforms, its base on y = 0. Part of the `/library` entry.

/** Options of {@link libraryMesh}. */
export interface LibraryMeshOptions {
  /** The look the part takes in a biome scatter. Default `'stone'`. */
  readonly kind?: 'bark' | 'foliage' | 'stone';
  /**
   * Albedo, linear RGB 0..1. Default: the mean of the materials' `baseColorFactor`. A model coloured by a texture
   * (most scans) needs its mean texture colour here: the biome scatter draws one colour a part.
   */
  readonly color?: readonly [number, number, number];
  /** Most triangles the merged mesh may hold (it is drawn once per placed object). Default 40,000. */
  readonly maxTriangles?: number;
  /** Uniform scale to metres. Default 1. */
  readonly scale?: number;
  readonly signal?: AbortSignal;
  /** The fetch to use. Default the global one. */
  readonly fetch?: (
    url: string,
    init?: { signal?: AbortSignal },
  ) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; arrayBuffer(): Promise<ArrayBuffer> }>;
}

/** A merged library mesh, ready for `BiomeViewOptions.meshes` (`{ 'procedural:rock': [part] }`). */
export interface LibraryMeshPart {
  readonly geometry: {
    readonly positions: Float32Array;
    readonly normals: Float32Array;
    readonly indices: Uint32Array;
  };
  readonly color: readonly [number, number, number];
  readonly kind: 'bark' | 'foliage' | 'stone';
}

export type Node = {
  mesh?: number;
  children?: number[];
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
};
export type Doc = {
  buffers?: { uri?: string; byteLength: number }[];
  bufferViews?: { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }[];
  accessors?: { bufferView?: number; byteOffset?: number; componentType: number; count: number; type: string }[];
  meshes?: {
    primitives: { attributes: Record<string, number>; indices?: number; material?: number; mode?: number }[];
  }[];
  nodes?: Node[];
  scenes?: { nodes?: number[] }[];
  scene?: number;
  materials?: { pbrMetallicRoughness?: { baseColorFactor?: number[] } }[];
};

/** Column-major 4x4 of a node's matrix, or of its translation, rotation and scale (glTF 2.0 section 5.25). */
export function nodeMatrix(n: Node): number[] {
  if (n.matrix) return n.matrix;
  const [x, y, z, w] = n.rotation ?? [0, 0, 0, 1],
    [sx, sy, sz] = n.scale ?? [1, 1, 1],
    [tx, ty, tz] = n.translation ?? [0, 0, 0];
  return [
    (1 - 2 * (y * y + z * z)) * sx,
    2 * (x * y + z * w) * sx,
    2 * (x * z - y * w) * sx,
    0,
    2 * (x * y - z * w) * sy,
    (1 - 2 * (x * x + z * z)) * sy,
    2 * (y * z + x * w) * sy,
    0,
    2 * (x * z + y * w) * sz,
    2 * (y * z - x * w) * sz,
    (1 - 2 * (x * x + y * y)) * sz,
    0,
    tx,
    ty,
    tz,
    1,
  ];
}

export const mul = (a: number[], b: number[]) =>
  Array.from({ length: 16 }, (_, i) => {
    const c = Math.floor(i / 4),
      r = i % 4;
    return a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  });

/** Component types: bytes and reader. */
export const KINDS: Record<number, [number, (d: DataView, o: number) => number]> = {
  5126: [4, (d, o) => d.getFloat32(o, true)],
  5125: [4, (d, o) => d.getUint32(o, true)],
  5123: [2, (d, o) => d.getUint16(o, true)],
  5121: [1, (d, o) => d.getUint8(o)],
};

/**
 * Loads a glTF model (`.gltf` with external buffers) as one merged mesh part for a biome scatter: every triangle
 * primitive of the default scene under its node transforms, its base on y = 0 and centred on x = z = 0, so a placed
 * object stands on the ground. Textures are not read (see `color`).
 * @throws TypeError for a document with no triangles with float positions and normals; RangeError for a mesh over
 *   `maxTriangles`; Error for a file that does not load.
 * @example
 * const rock = await libraryMesh('/asset-library/big-burn-1910/rocks/rock_07/rock_07_2k.gltf', { color: [0.3, 0.29, 0.27] });
 * const scene = await attach(engine, { meshes: { 'procedural:rock': [rock] } });
 */
export async function libraryMesh(url: string, options: LibraryMeshOptions = {}): Promise<LibraryMeshPart> {
  const get = options.fetch ?? (globalThis.fetch as unknown as NonNullable<LibraryMeshOptions['fetch']>),
    init = options.signal ? { signal: options.signal } : {},
    response = await get(url, init);
  if (!response.ok)
    throw new TypeError(`libraryMesh: ${url} answered ${response.status}; check the URL and that the server is up`);
  const doc = (await response.json()) as Doc,
    base = url.slice(0, url.lastIndexOf('/') + 1),
    buffers: ArrayBuffer[] = [];
  if (!doc.meshes?.length || !doc.accessors || !doc.bufferViews || !doc.buffers || !doc.nodes)
    throw new TypeError(
      `libraryMesh: ${url} holds no meshes; pass a .gltf with meshes, accessors, buffer views, buffers and nodes`,
    );
  for (const b of doc.buffers) {
    if (!b.uri || b.uri.startsWith('data:'))
      throw new TypeError(
        'libraryMesh reads a .gltf with external buffers; export the glTF with separate .bin buffers',
      );
    const r = await get(base + b.uri, init);
    if (!r.ok)
      throw new TypeError(
        `libraryMesh: ${base + b.uri} answered ${r.status}; check that the buffer file sits beside the .gltf`,
      );
    buffers.push(await r.arrayBuffer());
  }
  const read = (id: number, components: number, index: boolean): Float32Array | Uint32Array => {
    const a = doc.accessors![id],
      v = a ? doc.bufferViews![a.bufferView ?? -1] : undefined,
      kind = a ? KINDS[a.componentType] : undefined;
    if (!a || !v)
      throw new TypeError(
        'libraryMesh: an accessor without a buffer view; export the glTF without sparse or empty accessors',
      );
    if (!kind || index === (a.componentType === 5126))
      throw new TypeError(
        `libraryMesh: unsupported accessor component type ${a.componentType}; use float positions and normals and integer indices`,
      );
    const [size, at] = kind,
      stride = v.byteStride ?? size * components,
      view = new DataView(buffers[v.buffer], (v.byteOffset ?? 0) + (a.byteOffset ?? 0)),
      out = index ? new Uint32Array(a.count * components) : new Float32Array(a.count * components);
    for (let i = 0; i < a.count; i++)
      for (let c = 0; c < components; c++) out[i * components + c] = at(view, i * stride + c * size);
    return out;
  };
  const positions: number[] = [],
    normals: number[] = [],
    indices: number[] = [],
    colors: number[][] = [];
  const visit = (id: number, parent: number[]) => {
    const node = doc.nodes![id],
      m = mul(parent, nodeMatrix(node));
    if (node.mesh !== undefined)
      for (const p of doc.meshes![node.mesh].primitives) {
        if ((p.mode ?? 4) !== 4 || p.attributes.POSITION === undefined || p.attributes.NORMAL === undefined) continue;
        const pos = read(p.attributes.POSITION, 3, false),
          nor = read(p.attributes.NORMAL, 3, false),
          first = positions.length / 3,
          count = pos.length / 3;
        for (let i = 0; i < count; i++) {
          const x = pos[i * 3],
            y = pos[i * 3 + 1],
            z = pos[i * 3 + 2],
            nx = nor[i * 3],
            ny = nor[i * 3 + 1],
            nz = nor[i * 3 + 2];
          positions.push(
            m[0] * x + m[4] * y + m[8] * z + m[12],
            m[1] * x + m[5] * y + m[9] * z + m[13],
            m[2] * x + m[6] * y + m[10] * z + m[14],
          );
          const tx = m[0] * nx + m[4] * ny + m[8] * nz,
            ty = m[1] * nx + m[5] * ny + m[9] * nz,
            tz = m[2] * nx + m[6] * ny + m[10] * nz,
            l = Math.hypot(tx, ty, tz) || 1;
          normals.push(tx / l, ty / l, tz / l);
        }
        const idx =
          p.indices !== undefined ? read(p.indices, 1, true) : Uint32Array.from({ length: count }, (_, i) => i);
        for (const i of idx) indices.push(first + i);
        const f = doc.materials?.[p.material ?? -1]?.pbrMetallicRoughness?.baseColorFactor;
        if (f) colors.push(f);
      }
    for (const c of node.children ?? []) visit(c, m);
  };
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    roots = doc.scenes?.[doc.scene ?? 0]?.nodes ?? doc.nodes.map((_, i) => i);
  for (const r of roots) visit(r, identity);
  const triangles = indices.length / 3,
    most = options.maxTriangles ?? 40000;
  if (!triangles)
    throw new TypeError(
      `libraryMesh: ${url} holds no triangles with positions and normals; export triangle meshes with normals`,
    );
  if (triangles > most)
    throw new RangeError(
      `libraryMesh: ${url} has ${triangles} triangles, over maxTriangles ${most}; export a lighter level of it`,
    );
  let minY = Infinity,
    x0 = Infinity,
    x1 = -Infinity,
    z0 = Infinity,
    z1 = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    minY = Math.min(minY, positions[i + 1]);
    x0 = Math.min(x0, positions[i]);
    x1 = Math.max(x1, positions[i]);
    z0 = Math.min(z0, positions[i + 2]);
    z1 = Math.max(z1, positions[i + 2]);
  }
  const k = options.scale ?? 1,
    cx = (x0 + x1) / 2,
    cz = (z0 + z1) / 2,
    out = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    out[i] = (positions[i] - cx) * k;
    out[i + 1] = (positions[i + 1] - minY) * k;
    out[i + 2] = (positions[i + 2] - cz) * k;
  }
  const mean = (c: number) => (colors.length ? colors.reduce((s, f) => s + f[c], 0) / colors.length : 0.5),
    color = options.color ?? ([mean(0), mean(1), mean(2)] as [number, number, number]);
  return {
    geometry: { positions: out, normals: Float32Array.from(normals), indices: Uint32Array.from(indices) },
    color,
    kind: options.kind ?? 'stone',
  };
}
