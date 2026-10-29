// Margo implementation of the parity loader scenes (../parity.js, area 'loaders'). Task scenes: create() fetches the
// bytes (outside the timing), task(i) parses them once into Margo's scene objects or parsed data, output() returns
// counts that show both engines did the same job.
import { engineFor } from '../margo.js';

/** A camera for engineFor: task scenes draw nothing, but gltf-pro models need an engine to attach to. */
const CAMERA = { fov: 50, near: 0.1, far: 100, at: () => [0, 1, 3], target: [0, 0, 0] };

const fetchBytes = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`fetch ${url}: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
};
const fetchText = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`fetch ${url}: ${response.status}`);
  return response.text();
};
/** The scene's bytes: data.bytes, else data.url fetched (outside the timing). */
const inputBytes = async (data) => data.bytes ?? fetchBytes(data.url);

/**
 * The Khronos samples in examples/assets/khronos are stored as `<Name>/<Name>.glb` or `.gltf`, not in a `glTF-Binary`
 * folder as parity.js names them: use the spec's URL when it exists, else the folder's own file.
 */
async function khronosURL(url) {
  if ((await fetch(url, { method: 'HEAD' })).ok) return url;
  const flat = url.replace('/glTF-Binary/', '/');
  if ((await fetch(flat, { method: 'HEAD' })).ok) return flat;
  return flat.replace(/\.glb$/, '.gltf');
}

/**
 * A .gltf with external buffers and images packed into one self-contained GLB in memory (outside the timing), so the
 * timed parse reads only memory, as with the other glTF scenes. Buffer 0 becomes the BIN chunk; each image is appended
 * as a bufferView; a meshopt fallback buffer (`fallback: true`, never read when meshopt is decoded) keeps only its
 * byteLength. The same packing is done on the three.js side.
 */
async function packGLB(url, transform = (doc) => doc) {
  const base = new URL(url, location.href),
    doc = transform(JSON.parse(await fetchText(base.href))),
    meshoptFallback = (b) =>
      b.extensions?.EXT_meshopt_compression?.fallback || b.extensions?.KHR_meshopt_compression?.fallback;
  const parts = [],
    pad4 = (n) => (n + 3) & ~3;
  let length = 0;
  const append = async (bytes) => {
    const offset = length;
    parts.push({ offset, bytes });
    length = pad4(offset + bytes.length);
    return offset;
  };
  doc.buffers = await Promise.all(
    doc.buffers.map(async (b, i) => {
      if (i === 0) return b;
      if (meshoptFallback(b)) return { byteLength: b.byteLength, extensions: b.extensions };
      throw new Error(`packGLB: only buffer 0 and meshopt fallbacks are supported (${b.uri})`);
    }),
  );
  if (doc.buffers[0].uri) await append(await fetchBytes(new URL(doc.buffers[0].uri, base).href));
  delete doc.buffers[0].uri;
  for (const image of doc.images ?? []) {
    if (!image.uri) continue;
    const bytes = await fetchBytes(new URL(image.uri, base).href),
      offset = await append(bytes);
    image.bufferView = doc.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length }) - 1;
    image.mimeType = /\.png$/i.test(image.uri) ? 'image/png' : 'image/jpeg';
    delete image.uri;
  }
  doc.buffers[0].byteLength = length;
  const json = new TextEncoder().encode(JSON.stringify(doc)),
    jsonLength = pad4(json.length),
    total = 12 + 8 + jsonLength + 8 + length,
    out = new Uint8Array(total),
    view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.fill(0x20, 20, 20 + jsonLength);
  out.set(json, 20);
  view.setUint32(20 + jsonLength, length, true);
  view.setUint32(24 + jsonLength, 0x004e4942, true);
  for (const p of parts) out.set(p.bytes, 28 + jsonLength + p.offset);
  return out;
}

/**
 * p-draco: the Avocado's PNGs are not in the repository, so its images, textures, samplers and every material texture
 * reference are removed (the same edit on both sides).
 */
function stripTextures(doc) {
  delete doc.images;
  delete doc.textures;
  delete doc.samplers;
  for (const m of doc.materials ?? []) {
    for (const key of ['normalTexture', 'occlusionTexture', 'emissiveTexture']) delete m[key];
    if (m.pbrMetallicRoughness) {
      delete m.pbrMetallicRoughness.baseColorTexture;
      delete m.pbrMetallicRoughness.metallicRoughnessTexture;
    }
  }
  return doc;
}

/** Counts of a gltf-pro model: primitives (three: one Mesh each), packed vertices (20 floats each), triangles. */
function modelCounts(model, extra = {}) {
  const doc = model.asset.doc;
  let vertices = 0,
    triangles = 0;
  for (const p of model.primitives) {
    vertices += p.vertices.length / 20;
    triangles += p.indices.length / 3;
  }
  return {
    meshes: model.primitives.length,
    vertices,
    triangles,
    materials: doc.materials?.length ?? 0,
    textures: doc.textures?.length ?? 0,
    animations: doc.animations?.length ?? 0,
    ...extra,
  };
}

/**
 * A glTF task: each call parses the GLB with parseGLTFAsync (geometry packed, images decoded and uploaded, the model
 * attached to the engine). The previous call's model is disposed at the start of the next call (GPU memory would
 * otherwise grow by one model per call); that release is inside the timing and is small.
 */
async function gltfTask(canvas, bytes, marks, { decoders, animate } = {}) {
  const engine = await engineFor(canvas, CAMERA, 4096, marks),
    s = performance.now(),
    [{ parseGLTFAsync }, animation] = await Promise.all([
      import('@margoengine/gltf-pro'),
      animate ? import('@margoengine/animation') : undefined,
    ]);
  marks.buildMs = +(performance.now() - s).toFixed(1);
  let model, rig;
  const release = () => {
    rig?.destroy();
    model?.dispose();
    rig = model = undefined;
  };
  return {
    async task() {
      release();
      model = await parseGLTFAsync(engine, bytes, decoders ? { decoders } : {});
      if (animate) rig = animation.Animation.attach(model);
    },
    output: () => modelCounts(model, rig ? { clips: rig.clips.length } : {}),
    info: () => ({
      note: animate
        ? 'parseGLTFAsync (images decoded and uploaded to the GPU, geometry packed into GPU buffers) + Animation.attach (clips, GPU skin and morph buffers); previous model disposed in the call'
        : 'parseGLTFAsync: images decoded and uploaded to the GPU, geometry packed into GPU buffers; previous model disposed in the call',
    }),
  };
}

/** Sums vertices and triangles of LoadedGeometry-like results. */
const geometryCounts = (list) => ({
  meshes: list.length,
  vertices: list.reduce((n, g) => n + g.positions.length / 3, 0),
  triangles: list.reduce((n, g) => n + (g.indices ? g.indices.length / 3 : 0), 0),
});

const timed = async (marks, load) => {
  const s = performance.now(),
    out = await load();
  marks.buildMs = +(performance.now() - s).toFixed(1);
  return out;
};

export const builders = {
  async 'p-gltf-parse'(canvas, data, marks) {
    return gltfTask(canvas, await fetchBytes(data.url), marks);
  },

  async 'p-gltf-animated'(canvas, data, marks) {
    return gltfTask(canvas, await fetchBytes(data.url), marks, { animate: true });
  },

  async 'p-gltf-extensions'(canvas, data, marks) {
    return gltfTask(canvas, await fetchBytes(await khronosURL(data.url)), marks);
  },

  async 'p-meshopt'(canvas, data, marks) {
    const url = await khronosURL(data.url),
      bytes = /\.gltf$/.test(url) ? await packGLB(url) : await fetchBytes(url),
      { MeshoptDecoder } = await import('@margoengine/decoders/meshopt');
    return gltfTask(canvas, bytes, marks, { decoders: { meshopt: MeshoptDecoder } });
  },

  async 'p-draco'(canvas, data, marks) {
    const bytes = await packGLB(data.url, stripTextures),
      { DracoDecoder } = await import('@margoengine/decoders'),
      draco = new DracoDecoder(); // created once, warm across calls (gltf-pro leaves a supplied decoder open)
    return gltfTask(canvas, bytes, marks, { decoders: { draco } });
  },

  async 'p-fbx'(canvas, data, marks) {
    const bytes = await inputBytes(data),
      engine = await engineFor(canvas, CAMERA, 4096, marks),
      [{ parseFBX }, { Animation }] = await timed(marks, () =>
        Promise.all([import('@margoengine/fbx'), import('@margoengine/animation')]),
      );
    let model, rig;
    return {
      async task() {
        rig?.destroy();
        model?.dispose();
        model = await parseFBX(engine, bytes);
        rig = Animation.attach(model);
      },
      output: () => modelCounts(model, { clips: rig.clips.length }),
      info: () => ({
        note: 'parseFBX (native FBX -> in-memory GLB -> parseGLTF, GPU buffers) + Animation.attach (clips, GPU skin); previous model disposed in the call',
      }),
    };
  },

  async 'p-obj'(canvas, data, marks) {
    const { parseOBJ } = await timed(marks, () => import('@margoengine/loaders'));
    let out;
    return {
      async task() {
        out = await parseOBJ(data.text);
      },
      output: () => geometryCounts([out]),
      info: () => ({ note: 'parseOBJ: CPU geometry data (no GPU upload)' }),
    };
  },

  async 'p-mtl'(canvas, data, marks) {
    const { parseMTL } = await timed(marks, () => import('@margoengine/loaders'));
    let out;
    return {
      task() {
        out = parseMTL(data.text);
      },
      output: () => ({ materials: out.length, maps: out.filter((m) => m.maps?.map_Kd).length }),
      info: () => ({ note: 'parseMTL: material records with map names (no Material objects, no textures)' }),
    };
  },

  async 'p-stl'(canvas, data, marks) {
    const { parseSTL } = await timed(marks, () => import('@margoengine/loaders'));
    let out;
    return {
      task() {
        out = parseSTL(data.bytes);
      },
      output: () => geometryCounts([out]),
      info: () => ({
        note: 'parseSTL: CPU geometry data (typed arrays, no weld, flat normals computed where the file stores zero); like-for-like with a plain STL loader',
      }),
    };
  },

  async 'p-stl-normals'(canvas, data, marks) {
    const { parseSTL } = await timed(marks, () => import('@margoengine/loaders'));
    let out;
    return {
      task() {
        out = parseSTL(data.bytes);
      },
      output: () => geometryCounts([out]),
      info: () => ({
        note: 'parseSTL: its normals are already computed (flat, where the file stores zero), so the mesh lights correctly with no further call; three needs computeVertexNormals() after STLLoader.parse',
      }),
    };
  },

  async 'p-ply'(canvas, data, marks) {
    const { parsePLY } = await timed(marks, () => import('@margoengine/loaders'));
    let out;
    return {
      task() {
        out = parsePLY(data.bytes);
      },
      output: () => geometryCounts([out]),
      info: () => ({ note: 'parsePLY: CPU geometry data' }),
    };
  },

  async 'p-3mf'(canvas, data, marks) {
    const bytes = await inputBytes(data),
      { parse3MF } = await timed(marks, () => import('@margoengine/loaders'));
    let out;
    return {
      async task() {
        out = await parse3MF(bytes);
      },
      output: () => ({ ...geometryCounts([out]), objects: out.groups?.length ?? 1 }),
      info: () => ({ note: 'parse3MF: unzip + XML into one CPU geometry with a group per object' }),
    };
  },

  async 'p-usdz'(canvas, data, marks) {
    const bytes = await inputBytes(data),
      { parseUSDC } = await timed(marks, () => import('@margoengine/usdz'));
    let out;
    return {
      task() {
        out = parseUSDC(bytes);
      },
      output: () => geometryCounts(out.meshes),
      info: () => ({ note: 'parseUSDC: Crate reader into mesh data (no GPU model)' }),
    };
  },

  async 'p-pcd'(canvas, data, marks) {
    const [pcd, xyz, vtk] = await Promise.all([
        fetchBytes(data.urls[0]),
        fetchBytes(data.urls[1]),
        fetchBytes(data.urls[2]),
      ]),
      { parsePCD, parseXYZ, parseVTK } = await timed(marks, () => import('@margoengine/loaders'));
    let out;
    return {
      task() {
        out = [parsePCD(pcd), parseXYZ(xyz), parseVTK(vtk)];
      },
      output: () => ({
        pcdPoints: out[0].positions.length / 3,
        xyzPoints: out[1].positions.length / 3,
        vtkVertices: out[2].positions.length / 3,
        vtkTriangles: out[2].indices ? out[2].indices.length / 3 : 0,
      }),
      info: () => ({ note: 'parsePCD, parseXYZ, parseVTK: CPU geometry data' }),
    };
  },

  async 'p-collada'(canvas, data, marks) {
    const text = data.text ?? (await fetchText(data.url)),
      [{ parseDAE, bindDAESkin, daeKeyframeClip }, { Skeleton, createKeyframeClip }] = await timed(marks, () =>
        Promise.all([import('@margoengine/loaders'), import('@margoengine/animation')]),
      );
    let out;
    return {
      task() {
        const dae = parseDAE(text),
          binding = bindDAESkin(dae),
          skeleton = new Skeleton(binding.bones, binding.inverseBindMatrices),
          clip = createKeyframeClip(daeKeyframeClip(dae));
        out = { dae, binding, skeleton, clip };
      },
      output: () => ({
        ...geometryCounts(out.dae.geometries),
        materials: out.dae.materials.length,
        bones: out.binding.bones.length,
        animations: 1,
        tracks: out.clip.tracks.length,
      }),
      info: () => ({
        note: 'parseDAE + bindDAESkin + Skeleton + createKeyframeClip(daeKeyframeClip) (CPU; COLLADA channels resampled at 30 fps); texture not fetched',
      }),
    };
  },

  async 'p-svg'(canvas, data, marks) {
    const [{ parseSVG }, { shapeGeometry }] = await timed(marks, () =>
      Promise.all([import('@margoengine/loaders/svg'), import('@margoengine/geometry')]),
    );
    let out;
    return {
      task() {
        out = parseSVG(data.text).paths.map((path) => shapeGeometry(path.toShapes(), 12));
      },
      output: () => ({
        paths: out.length,
        vertices: out.reduce((n, g) => n + g.positions.length / 3, 0),
        triangles: out.reduce((n, g) => n + g.indices.length / 3, 0),
      }),
      info: () => ({ note: 'parseSVG + SVGPath.toShapes + shapeGeometry(shapes, 12 curve segments) per path' }),
    };
  },

  async 'p-vox'(canvas, data, marks) {
    const bytes = await inputBytes(data),
      [{ parseVox, pasteVoxModel }, { BlockTypes, VoxelWorld }, { meshInput, meshChunk, QUAD_WORDS }] = await timed(
        marks,
        () =>
          Promise.all([
            import('@margoengine/voxel/vox'),
            import('@margoengine/voxel'),
            import('@margoengine/voxel/mesher'),
          ]),
      );
    let out;
    return {
      task() {
        const scene = parseVox(bytes),
          world = new VoxelWorld({ blocks: new BlockTypes() }),
          voxels = pasteVoxModel(world, scene, [0, 0, 0]),
          chunks = [];
        for (const key of world.dirty) {
          const input = meshInput(world, key);
          if (input) chunks.push(meshChunk(input));
        }
        out = { voxels, chunks };
      },
      output: () => {
        const quads = out.chunks.reduce(
          (n, m) => n + (m.opaque.length + m.cutout.length + m.translucent.length) / QUAD_WORDS,
          0,
        );
        return { voxels: out.voxels, chunks: out.chunks.length, quads, triangles: quads * 2 };
      },
      info: () => ({
        note: 'parseVox + pasteVoxModel into a VoxelWorld + meshChunk per chunk (greedy quads with AO and light, packed 3 u32 per quad; no GPU upload)',
      }),
    };
  },

  async 'p-texture-formats'(canvas, data, marks) {
    const files = await Promise.all(data.urls.map(fetchBytes)),
      [{ parseTGA }, { parseDDS }, { parseKTX }, { parseTIFF }] = await timed(marks, () =>
        Promise.all([
          import('@margoengine/decoders/tga'),
          import('@margoengine/decoders/dds'),
          import('@margoengine/decoders/ktx'),
          import('@margoengine/decoders/tiff'),
        ]),
      );
    const parse = (url, bytes) =>
      /\.tga$/.test(url)
        ? parseTGA(bytes)
        : /\.dds$/.test(url)
          ? parseDDS(bytes)
          : /\.ktx$/.test(url)
            ? parseKTX(bytes)
            : parseTIFF(bytes);
    let out;
    return {
      task() {
        out = data.urls.map((url, i) => parse(url, files[i]));
      },
      output: () => ({
        textures: out.length,
        sizes: out.map((t) => `${t.width}x${t.height}`).join(' '),
        mips: out.map((t) => t.mipmaps?.length ?? 1).join(' '),
      }),
      info: () => ({ note: 'parseTGA, parseDDS, parseKTX, parseTIFF: texture data, no GPU upload' }),
    };
  },

  async 'p-cube-lut'(canvas, data, marks) {
    const { parseCube } = await timed(marks, () => import('@margoengine/tonemap'));
    let out;
    return {
      task() {
        out = parseCube(data.text);
      },
      output: () => ({ size: out.size, samples: out.data.length / 4 }),
      info: () => ({
        note: 'tonemap parseCube: RGBA Float32 3D LUT data (the GPU 3D texture is made by Tonemap.setLUT, not timed; three makes a CPU Data3DTexture)',
      }),
    };
  },
};
