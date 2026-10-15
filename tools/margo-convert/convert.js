// @ts-check
// margo-convert library: STEP / IGES / BREP -> GLB in Node. OCCT (occt-import-js, the same build machinery's loadCAD
// runs in its worker) tessellates; @margoengine/exporters writes the GLB; machinery's featureEdges bakes edges.
import { createRequire } from 'node:module';
import { Geometry } from '@margoengine/core';
import { exportGLB } from '@margoengine/exporters';
import { featureEdges } from '@margoengine/machinery/edges';
import { Quaternion } from '@margoengine/math/quaternion';

/** Input formats: STEP (.step/.stp), IGES (.iges/.igs) and OCCT BREP (.brep). */
/** @typedef {'step'|'iges'|'brep'} CADFormat */
/** Units of a BREP file (BREP carries none). */
/** @typedef {'mm'|'cm'|'m'|'in'|'ft'} LengthUnit */

/**
 * Conversion options. Tessellation defaults are OCCT's, the same `loadCAD` uses.
 * @typedef {object} ConvertOptions
 * @property {number} [linearDeflection] Largest chord-to-surface distance in millimetres. Default: 0.1% of the
 *   model's average bounding-box size (OCCT's and loadCAD's default).
 * @property {number} [angularDeflection] Largest angle between neighbouring facets in degrees. Default 28.65 (0.5 rad).
 * @property {boolean} [merge] One node per material with world-space geometry instead of the assembly tree.
 * @property {boolean} [instancing] Share one mesh between repeated parts (rigid copies). Default true.
 * @property {number} [edges] Bake feature edges at this dihedral angle in degrees (FeatureEdges' default is 30).
 * @property {LengthUnit} [units] Units of a BREP file. Default 'mm'. STEP and IGES carry their own.
 * @property {string} [generator] glTF `asset.generator`. Default 'margo-convert'.
 */

/**
 * Counts and timings of one conversion.
 * @typedef {object} ConvertStats
 * @property {number} parts B-Rep parts (OCCT meshes).
 * @property {number} meshes Distinct part geometries written.
 * @property {number} instanced Parts that reuse another part's geometry with their own transform.
 * @property {number} triangles Triangles in the scene, every part counted.
 * @property {number} edges Baked edge segments, per distinct geometry.
 * @property {number} initMs OCCT Wasm load and compile; 0 when already loaded in this process.
 * @property {number} tessellateMs OCCT read and tessellation.
 * @property {number} writeMs Hierarchy, instancing, edges and GLB writing.
 */

/**
 * What a conversion produced.
 * @typedef {object} ConvertResult
 * @property {Uint8Array} glb The GLB file.
 * @property {ConvertStats} stats Counts and timings.
 */

/** @typedef {{first: number, last: number, color: number[]|null}} OCCTFace */
/** @typedef {{name: string, color?: number[], brep_faces: OCCTFace[], attributes: {position: {array: number[]}, normal?: {array: number[]}}, index: {array: number[]}}} OCCTMesh */
/** @typedef {{name: string, meshes: number[], children: OCCTNode[]}} OCCTNode */
/** @typedef {{success: boolean, root: OCCTNode, meshes: OCCTMesh[]}} OCCTResult */
/** @typedef {(data: Uint8Array, params: Record<string, string|number>) => OCCTResult} OCCTRead */
/** @typedef {{ReadStepFile: OCCTRead, ReadIgesFile: OCCTRead, ReadBrepFile: OCCTRead}} OCCT */
/** @typedef {import('@margoengine/exporters').ExportNode} ExportNode */
/** @typedef {import('@margoengine/exporters').MaterialData} MaterialData */
/** @typedef {{positions: Float32Array, normals: Float32Array, indices: Uint32Array}} Mesh */
/** A part's geometry relative to `center`, one mesh per colour; `world` and `anchors` serve instance matching. */
/** @typedef {{pieces: Array<{mesh: Mesh, material: MaterialData}>, center: number[], world: Float64Array, indices: Uint32Array, anchors: number[]}} Shape */

const UNITS = { mm: 0.001, cm: 0.01, m: 1, in: 0.0254, ft: 0.3048 };
// machinery's loadCAD material: '#a6b9c8', roughness 0.4, metalness 0.3.
const DEFAULT_COLOR = [166 / 255, 185 / 255, 200 / 255];
const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** @type {Promise<OCCT>|undefined} */
let occt;
/** Loads OCCT once per process (about 0.25 s). Its stdout chatter ("Total number of loaded entities") is muted. */
export function loadOCCT() {
  /** @type {(module: {print: () => void}) => Promise<OCCT>} */
  const factory = createRequire(import.meta.url)('occt-import-js');
  return (occt ??= factory({ print() {} }));
}

/**
 * Format from a file name: .step/.stp, .iges/.igs or .brep.
 * @param {string} file
 * @returns {CADFormat}
 */
export function formatOf(file) {
  const extension = file.toLowerCase().split('.').at(-1);
  if (extension === 'step' || extension === 'stp') return 'step';
  if (extension === 'iges' || extension === 'igs') return 'iges';
  if (extension === 'brep') return 'brep';
  throw new TypeError(`Unsupported CAD file ${file}: expected .step, .stp, .iges, .igs or .brep`);
}

/** @param {number} c sRGB component @returns {number} linear component, clamped to [0, 1] */
const linear = (c) => {
  const v = Math.min(1, Math.max(0, c));
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

/**
 * Splits a part into one mesh per face colour (most parts have one), positions relative to `center`.
 * @param {OCCTMesh} part @param {Float64Array} world @param {number[]} center
 * @param {(rgb: number[]|null|undefined) => MaterialData} material
 * @returns {Array<{mesh: Mesh, material: MaterialData}>}
 */
function pieces(part, world, center, material) {
  const source = part.attributes.normal?.array,
    index = part.index.array,
    triangles = index.length / 3;
  /** @type {Array<number[]|null|undefined>} */
  const colors = new Array(triangles).fill(part.color);
  for (const face of part.brep_faces)
    if (face.color) for (let t = face.first; t <= face.last && t < triangles; t++) colors[t] = face.color;
  /** @type {Map<MaterialData, number[]>} */
  const groups = new Map();
  for (let t = 0; t < triangles; t++) {
    const m = material(colors[t]);
    let list = groups.get(m);
    if (!list) groups.set(m, (list = []));
    list.push(t);
  }
  return [...groups].map(([mat, list]) => {
    const remap = new Int32Array(world.length / 3).fill(-1),
      indices = new Uint32Array(list.length * 3);
    /** @type {number[]} */ const positions = [];
    /** @type {number[]} */ const normals = [];
    list.forEach((t, i) => {
      for (let k = 0; k < 3; k++) {
        const v = index[t * 3 + k];
        if (remap[v] < 0) {
          remap[v] = positions.length / 3;
          // Missing normals stay zero: the exporter replaces them with area-weighted face normals.
          for (let a = 0; a < 3; a++) {
            positions.push(world[v * 3 + a] - center[a]);
            normals.push(source ? source[v * 3 + a] : 0);
          }
        }
        indices[i * 3 + k] = remap[v];
      }
    });
    return {
      mesh: { positions: new Float32Array(positions), normals: new Float32Array(normals), indices },
      material: mat,
    };
  });
}

/** @param {Float64Array} p @returns {number[]} vertex ids: 0, the farthest from it, the one spanning the widest triangle */
function anchorsOf(p) {
  let b = 0,
    c = 0,
    best = 0;
  for (let v = 3; v < p.length; v += 3) {
    const d = Math.hypot(p[v] - p[0], p[v + 1] - p[1], p[v + 2] - p[2]);
    if (d > best) {
      best = d;
      b = v / 3;
    }
  }
  best = 0;
  const u = [p[b * 3] - p[0], p[b * 3 + 1] - p[1], p[b * 3 + 2] - p[2]];
  for (let v = 3; v < p.length; v += 3) {
    const w = [p[v] - p[0], p[v + 1] - p[1], p[v + 2] - p[2]],
      area = Math.hypot(u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]);
    if (area > best) {
      best = area;
      c = v / 3;
    }
  }
  return [0, b, c];
}

/**
 * The rotation R (column-major 3x3) and translation t mapping `shape`'s vertices onto `b`, or null. OCCT reuses one
 * triangulation for every placement of a shape, so vertex order matches; R comes from orthonormal frames on three
 * anchor vertices, and every vertex must land within 1e-6 of the part size (mirrored copies fail).
 * @param {Shape} shape @param {Float64Array} b
 * @returns {{r: number[], t: number[]}|null}
 */
function rigid(shape, b) {
  const a = shape.world,
    [i, j, k] = shape.anchors.map((v) => v * 3);
  /** @param {Float64Array} p @returns {number[]|null} */
  const frame = (p) => {
    const u = [p[j] - p[i], p[j + 1] - p[i + 1], p[j + 2] - p[i + 2]],
      w = [p[k] - p[i], p[k + 1] - p[i + 1], p[k + 2] - p[i + 2]],
      lu = Math.hypot(...u);
    const e1 = u.map((x) => x / lu),
      d = e1[0] * w[0] + e1[1] * w[1] + e1[2] * w[2],
      v = w.map((x, n) => x - d * e1[n]),
      lv = Math.hypot(...v);
    if (!(lv > lu * 1e-6)) return null;
    const e2 = v.map((x) => x / lv);
    return [...e1, ...e2, e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
  };
  const fa = frame(a),
    fb = frame(b);
  if (!fa || !fb) return null;
  const r = new Array(9).fill(0);
  for (let row = 0; row < 3; row++)
    for (let col = 0; col < 3; col++) for (let n = 0; n < 3; n++) r[col * 3 + row] += fb[n * 3 + row] * fa[n * 3 + col];
  const t = [0, 1, 2].map((row) => b[i + row] - (r[row] * a[i] + r[3 + row] * a[i + 1] + r[6 + row] * a[i + 2]));
  const tolerance = Math.hypot(a[j] - a[i], a[j + 1] - a[i + 1], a[j + 2] - a[i + 2]) * 1e-6 + 1e-9;
  for (let v = 0; v < b.length; v += 3) {
    const x = a[v],
      y = a[v + 1],
      z = a[v + 2];
    if (
      Math.hypot(
        r[0] * x + r[3] * y + r[6] * z + t[0] - b[v],
        r[1] * x + r[4] * y + r[7] * z + t[1] - b[v + 1],
        r[2] * x + r[5] * y + r[8] * z + t[2] - b[v + 2],
      ) > tolerance
    )
      return null;
  }
  return { r, t };
}

/** @param {ArrayLike<number>} values @returns {number} FNV-1a over integer values */
function hashInts(values) {
  let h = 0x811c9dc5;
  for (let i = 0; i < values.length; i++) h = Math.imul(h ^ values[i], 0x01000193);
  return h >>> 0;
}

/** @typedef {{nodes: Array<{mesh?: number}>, meshes: Array<{extras?: Record<string, unknown>}>, buffers: Array<{byteLength: number}>, bufferViews: object[], accessors: object[]}} GLTFJson */

/** @param {Uint8Array} glb @returns {{json: GLTFJson, bin: Uint8Array}} */
function readGLB(glb) {
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength),
    length = view.getUint32(12, true);
  return {
    json: JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + length))),
    bin: glb.subarray(28 + length, 28 + length + view.getUint32(20 + length, true)),
  };
}

/** @param {object} json @param {Uint8Array} bin 4-byte multiple @returns {Uint8Array} */
function writeGLB(json, bin) {
  const text = new TextEncoder().encode(JSON.stringify(json)),
    jsonLength = Math.ceil(text.length / 4) * 4;
  const out = new Uint8Array(28 + jsonLength + bin.length),
    view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, out.length, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.set(text, 20);
  out.fill(0x20, 20 + text.length, 20 + jsonLength);
  view.setUint32(20 + jsonLength, bin.length, true);
  view.setUint32(24 + jsonLength, 0x004e4942, true);
  out.set(bin, 28 + jsonLength);
  return out;
}

/**
 * Appends one uint32 SCALAR accessor of vertex index pairs per glTF mesh and references it from
 * `mesh.extras.featureEdges` (indices into primitive 0's POSITION), with the angle in `mesh.extras.featureAngle`.
 * @param {Uint8Array} glb @param {Map<number, Uint32Array>} edges glTF mesh index -> index pairs @param {number} angle
 * @returns {Uint8Array}
 */
function bakeEdges(glb, edges, angle) {
  const { json, bin } = readGLB(glb),
    chunks = [bin];
  let offset = bin.length;
  for (const [mesh, pairs] of edges) {
    if (!pairs.length) continue;
    const view = json.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: pairs.byteLength }) - 1;
    const accessor =
      json.accessors.push({ bufferView: view, componentType: 5125, count: pairs.length, type: 'SCALAR' }) - 1;
    json.meshes[mesh].extras = { ...json.meshes[mesh].extras, featureEdges: accessor, featureAngle: angle };
    chunks.push(new Uint8Array(pairs.buffer, pairs.byteOffset, pairs.byteLength));
    offset += pairs.byteLength;
  }
  const out = new Uint8Array(offset);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  json.buffers[0].byteLength = out.length;
  return writeGLB(json, out);
}

/**
 * Converts STEP, IGES or BREP bytes to a GLB in metres (OCCT converts STEP and IGES from their own unit; BREP uses
 * `units`). Parts keep their names, colours (one material per colour) and the assembly tree; rigid copies of a part
 * share one mesh.
 * @param {Uint8Array} data File contents.
 * @param {CADFormat} format
 * @param {ConvertOptions} [options]
 * @returns {Promise<ConvertResult>}
 */
export async function convert(data, format, options = {}) {
  const {
    linearDeflection,
    angularDeflection,
    merge = false,
    instancing = true,
    edges,
    units = 'mm',
    generator = 'margo-convert',
  } = options;
  if (!['step', 'iges', 'brep'].includes(format))
    throw new TypeError(`Unknown format ${format}: use step, iges or brep`);
  if (!(units in UNITS)) throw new TypeError(`Unknown units ${units}: use mm, cm, m, in or ft`);
  if (linearDeflection !== undefined && !(linearDeflection > 0 && linearDeflection < Infinity))
    throw new RangeError('linearDeflection must be a positive number of millimetres');
  if (angularDeflection !== undefined && !(angularDeflection > 0 && angularDeflection < 180))
    throw new RangeError('angularDeflection must be in (0, 180) degrees');
  if (edges !== undefined && !(edges >= 0 && edges <= 180))
    throw new RangeError('edges must be a dihedral angle in [0, 180] degrees');

  let start = performance.now();
  const loaded = occt !== undefined,
    kernel = await loadOCCT(),
    initMs = loaded ? 0 : performance.now() - start;
  start = performance.now();
  // OCCT ignores linearUnit for BREP: positions come back in file units and are scaled here.
  const scale = format === 'brep' ? UNITS[units] : 1;
  /** @type {Record<string, string|number>} */
  const params = { linearUnit: 'meter' };
  if (linearDeflection !== undefined) {
    params.linearDeflectionType = 'absolute_value';
    params.linearDeflection = linearDeflection / 1000 / scale;
  }
  if (angularDeflection !== undefined) params.angularDeflection = (angularDeflection * Math.PI) / 180;
  const read = format === 'step' ? kernel.ReadStepFile : format === 'iges' ? kernel.ReadIgesFile : kernel.ReadBrepFile;
  const result = read(data, params);
  if (!result.success || !result.meshes.length)
    throw new Error(`OCCT could not read this ${format.toUpperCase()} file (no B-Rep geometry)`);
  const tessellateMs = performance.now() - start;
  start = performance.now();

  /** @type {Map<string, MaterialData>} */
  const materials = new Map();
  /** One material per colour; STEP/IGES colours are sRGB, glTF base colours are linear. @param {number[]|null|undefined} rgb */
  const material = (rgb) => {
    const srgb = rgb ?? DEFAULT_COLOR,
      name =
        '#' +
        srgb
          .map((c) =>
            Math.round(Math.min(1, Math.max(0, c)) * 255)
              .toString(16)
              .padStart(2, '0'),
          )
          .join('');
    let out = materials.get(name);
    if (!out) materials.set(name, (out = { name, color: srgb.map(linear), roughness: 0.4, metalness: 0.3 }));
    return out;
  };

  // Instances: same triangulation and colours, vertices related by a rigid transform.
  /** @type {Map<string, Shape[]>} */
  const buckets = new Map();
  /** @type {Array<{shape: Shape, r: number[], t: number[]}>} */
  const placed = [];
  let instanced = 0,
    triangles = 0;
  for (const part of result.meshes) {
    const p = part.attributes.position.array,
      world = new Float64Array(p.length),
      indices = Uint32Array.from(part.index.array);
    for (let i = 0; i < p.length; i++) world[i] = p[i] * scale;
    triangles += indices.length / 3;
    const key = `${world.length}:${indices.length}:${hashInts(indices)}:${JSON.stringify([part.color, part.brep_faces])}`,
      bucket = buckets.get(key) ?? [];
    let found = null;
    if (instancing && !merge)
      for (const shape of bucket) {
        if (shape.indices.some((v, i) => v !== indices[i])) continue;
        const match = rigid(shape, world);
        if (match) {
          found = { shape, ...match };
          break;
        }
      }
    if (found) {
      instanced++;
      placed.push(found);
      continue;
    }
    const min = [Infinity, Infinity, Infinity],
      max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < world.length; i++) {
      min[i % 3] = Math.min(min[i % 3], world[i]);
      max[i % 3] = Math.max(max[i % 3], world[i]);
    }
    // Vertices relative to the part's bounding-box centre keep float32 precise far from the origin; the node (a JSON
    // double) carries the position.
    const center = merge ? [0, 0, 0] : min.map((v, a) => (v + max[a]) / 2);
    const shape = {
      pieces: pieces(part, world, center, material),
      center,
      world,
      indices,
      anchors: instancing && !merge ? anchorsOf(world) : [],
    };
    bucket.push(shape);
    buckets.set(key, bucket);
    placed.push({ shape, r: IDENTITY, t: [0, 0, 0] });
  }

  /** @type {ExportNode[]} */
  let roots;
  if (merge) {
    /** @type {Map<MaterialData, {positions: number[], normals: number[], indices: number[]}>} */
    const byMaterial = new Map();
    for (const { shape } of placed)
      for (const { mesh, material: mat } of shape.pieces) {
        let out = byMaterial.get(mat);
        if (!out) byMaterial.set(mat, (out = { positions: [], normals: [], indices: [] }));
        const base = out.positions.length / 3;
        for (let i = 0; i < mesh.positions.length; i++) {
          out.positions.push(mesh.positions[i]);
          out.normals.push(mesh.normals[i]);
        }
        for (const i of mesh.indices) out.indices.push(base + i);
      }
    roots = [...byMaterial].map(([mat, m]) => ({ name: mat.name, geometry: m, material: mat }));
  } else {
    /** @param {number} index @returns {ExportNode} */
    const partNode = (index) => {
      const { shape, r, t } = placed[index],
        q = new Quaternion().setFromRotationMatrix({ elements: r }),
        c = shape.center;
      const node = {
        name: result.meshes[index].name || undefined,
        translation: [0, 1, 2].map((row) => r[row] * c[0] + r[3 + row] * c[1] + r[6 + row] * c[2] + t[row]),
        rotation: [q.x, q.y, q.z, q.w],
      };
      const [first, ...rest] = shape.pieces;
      return rest.length
        ? { ...node, children: shape.pieces.map((piece) => ({ geometry: piece.mesh, material: piece.material })) }
        : { ...node, geometry: first.mesh, material: first.material };
    };
    /** @param {OCCTNode} node @returns {ExportNode} */
    const assembly = (node) => ({
      name: node.name || undefined,
      children: [...node.children.map(assembly), ...node.meshes.map(partNode)],
    });
    const top = result.root;
    roots = !top.name && !top.meshes.length ? top.children.map(assembly) : [assembly(top)];
  }

  let glb = exportGLB({ nodes: roots }, { generator }),
    segments = 0;
  if (edges !== undefined) {
    // The exporter writes nodes depth-first in input order, one glTF mesh per geometry and material: map them back.
    const nodes = readGLB(glb).json.nodes;
    /** @type {Map<number, Uint32Array>} */
    const baked = new Map();
    /** @type {Map<object, Uint32Array>} */
    const computed = new Map();
    let index = 0;
    /** @param {ExportNode} node */
    const walk = (node) => {
      const mesh = nodes[index++].mesh,
        geometry = /** @type {Mesh|undefined} */ (node.geometry);
      if (geometry && mesh !== undefined && !baked.has(mesh)) {
        let pairs = computed.get(geometry);
        if (!pairs) {
          computed.set(
            geometry,
            (pairs = featureEdges(new Geometry(geometry.positions, geometry.normals, geometry.indices), edges)),
          );
          segments += pairs.length / 2;
        }
        baked.set(mesh, pairs);
      }
      node.children?.forEach(walk);
    };
    roots.forEach(walk);
    glb = bakeEdges(glb, baked, edges);
  }
  const writeMs = performance.now() - start;
  return {
    glb,
    stats: {
      parts: result.meshes.length,
      meshes: placed.length - instanced,
      instanced,
      triangles,
      edges: segments,
      initMs,
      tessellateMs,
      writeMs,
    },
  };
}
