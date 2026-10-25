// Margo implementation of the parity exporter scenes (../parity.js, area 'exporters'): @margoengine/exporters on plain
// data scenes (the CPU path that carries UVs, as three.js's BoxGeometry does) and @margoengine/environment's EXR
// writer.
import { PALETTE } from '../catalog.js';
import { linear } from '../margo.js';

/** Counts read back from a GLB's JSON chunk (not timed), so both engines can be seen to write the same scene. */
function glbCounts(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    length = view.getUint32(12, true),
    json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + length)));
  return {
    bytes: bytes.byteLength,
    nodes: json.nodes?.length ?? 0,
    meshes: json.meshes?.length ?? 0,
    materials: json.materials?.length ?? 0,
    accessors: json.accessors?.length ?? 0,
  };
}

/** The 1,000 catalog boxes as a plain data scene: one shared box geometry (with UVs), 16 shared materials. */
async function boxScene(data) {
  const { boxGeometry } = await import('@margoengine/geometry'),
    geometry = boxGeometry(data.size, data.size, data.size),
    materials = PALETTE.map((color, i) => ({ name: `paint${i}`, color: linear(color), ...data.material })),
    nodes = data.items.map((b, i) => ({
      name: `box${i}`,
      translation: b.position,
      rotation: [0, Math.sin(b.rotation[1] / 2), 0, Math.cos(b.rotation[1] / 2)],
      geometry,
      material: materials[b.color],
    }));
  return { nodes };
}

export const builders = {
  async 'p-export-gltf'(canvas, data, marks) {
    marks.createMs = 0;
    const s = performance.now(),
      { exportGLB } = await import('@margoengine/exporters'),
      source = await boxScene(data);
    marks.buildMs = +(performance.now() - s).toFixed(1);
    let out = null;
    return {
      task() {
        out = exportGLB(source);
      },
      output: () => glbCounts(out),
    };
  },

  async 'p-export-mesh'(canvas, data, marks) {
    marks.createMs = 0;
    const s = performance.now(),
      [{ exportOBJ, exportSTL, exportPLY }, { computeVertexNormals, geometryData }] = await Promise.all([
        import('@margoengine/exporters'),
        import('@margoengine/geometry'),
      ]),
      g = data.grid,
      v = g.positions.length / 3,
      // Vertex normals computed once (not timed), and given to three.js too, so both writers emit them.
      geometry = computeVertexNormals(
        geometryData(g.positions, new Float32Array(v * 3), new Float32Array(v * 2), g.indices),
      ),
      source = {
        nodes: [
          {
            name: 'grid',
            geometry: { positions: geometry.positions, normals: geometry.normals, indices: geometry.indices },
          },
        ],
      };
    marks.buildMs = +(performance.now() - s).toFixed(1);
    let out = null;
    return {
      task() {
        out = {
          obj: exportOBJ(source).obj,
          stl: exportSTL(source, { binary: true }),
          ply: exportPLY(source, { binary: true }),
        };
      },
      output: () => ({
        objChars: out.obj.length,
        objLines: out.obj.split('\n').filter((l) => /^(v|vn|f) /.test(l)).length,
        stlBytes: out.stl.byteLength,
        plyBytes: out.ply.byteLength,
      }),
    };
  },

  async 'p-export-usdz'(canvas, data, marks) {
    marks.createMs = 0;
    const s = performance.now(),
      { exportUSDZ } = await import('@margoengine/exporters/usdz'),
      source = await boxScene(data);
    marks.buildMs = +(performance.now() - s).toFixed(1);
    let out = null;
    return {
      task() {
        out = exportUSDZ(source);
      },
      output: () => ({ bytes: out.byteLength }),
    };
  },

  async 'p-export-exr'(canvas, data, marks) {
    marks.createMs = 0;
    const s = performance.now(),
      { encodeEXR } = await import('@margoengine/environment/exr-write'),
      { width, height } = data,
      pixels = new Float32Array(width * height * 4);
    // The gradient: red across, green down, blue 0.5 to 2 across (HDR), alpha 1.
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const o = (y * width + x) * 4;
        pixels[o] = x / (width - 1);
        pixels[o + 1] = y / (height - 1);
        pixels[o + 2] = 0.5 + (1.5 * x) / (width - 1);
        pixels[o + 3] = 1;
      }
    const channels = ['R', 'G', 'B', 'A'].map((name, k) => ({
      name,
      type: 'HALF',
      data: pixels,
      offset: k,
      stride: 4,
    }));
    marks.buildMs = +(performance.now() - s).toFixed(1);
    let out = null;
    return {
      async task() {
        out = await encodeEXR({ width, height, channels });
      },
      output: () => ({ width, height, channels: 4, type: 'HALF', compression: 'NONE', bytes: out.byteLength }),
      info: () => ({ note: 'encodeEXR writes uncompressed (NONE) only; three.js writes ZIP' }),
    };
  },
};
