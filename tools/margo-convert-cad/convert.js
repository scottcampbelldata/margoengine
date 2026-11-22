// @ts-check
// margo-convert-cad library: STEP / IGES / ACIS SAT / Parasolid XT / JT -> GLB in Node. Margo's own B-rep kernel
// (@margoengine/brep, the same one loadCAD runs in its worker) reads and tessellates; @margoengine/exporters writes
// the GLB; machinery's featureEdges bakes edges.
import { Geometry } from '@margoengine/core';
import { exportGLB } from '@margoengine/exporters';
import { invertMatrix, multiplyMatrices } from '@margoengine/math/mat4';
import { featureEdges } from '@margoengine/machinery/edges';
import { parseIGES, parseJT, parseSAT, parseSTEP, parseXT, Tessellator } from '@margoengine/brep';

/** Input formats: STEP (.step/.stp), IGES (.iges/.igs), ACIS SAT (.sat), Parasolid XT (.x_t/.x_b/.xmt_txt) and JT. */
/** @typedef {'step'|'iges'|'sat'|'xt'|'jt'} CADFormat */

/**
 * Conversion options. Tessellation defaults are the kernel's, the same `loadCAD` uses.
 * @typedef {object} ConvertOptions
 * @property {number} [linearDeflection] Largest chord-to-surface distance in millimetres. Default: 0.1% of each body's
 *   bounding-box diagonal (the kernel's and loadCAD's default).
 * @property {number} [angularDeflection] Largest turn between neighbouring edge samples in degrees. Default 28.65
 *   (0.5 rad).
 * @property {boolean} [merge] One node per material with world-space geometry instead of the assembly tree.
 * @property {boolean} [instancing] Share one mesh between the placements of a body. Default true.
 * @property {number} [edges] Bake feature edges at this dihedral angle in degrees (FeatureEdges' default is 30).
 * @property {string} [generator] glTF `asset.generator`. Default 'margo-convert-cad'.
 */

/**
 * Counts and timings of one conversion.
 * @typedef {object} ConvertStats
 * @property {number} parts Placed bodies (a body placed twice counts twice).
 * @property {number} meshes Distinct body geometries written.
 * @property {number} instanced Placements that reuse another placement's geometry with their own transform.
 * @property {number} triangles Triangles in the scene, every placement counted.
 * @property {number} edges Baked edge segments, per distinct geometry.
 * @property {number} failedFaces Faces the kernel could not mesh (each left out of its body).
 * @property {number} initMs Always 0: the kernel is plain JavaScript, with no Wasm to load (kept for older callers).
 * @property {number} tessellateMs Kernel read and tessellation.
 * @property {number} writeMs Hierarchy, instancing, edges and GLB writing.
 */

/**
 * What a conversion produced.
 * @typedef {object} ConvertResult
 * @property {Uint8Array} glb The GLB file.
 * @property {ConvertStats} stats Counts and timings.
 * @property {string[]} warnings What the reader left out or assumed.
 */

/** @typedef {import('@margoengine/exporters').ExportNode} ExportNode */
/** @typedef {import('@margoengine/exporters').MaterialData} MaterialData */
/** @typedef {import('@margoengine/brep').STEPModel} STEPModel */
/** @typedef {import('@margoengine/brep').BodyMesh} BodyMesh */
/** @typedef {{positions: Float32Array, normals: Float32Array, indices: Uint32Array}} Mesh */
/** One body's meshes, one per colour, in the body's frame in metres. */
/** @typedef {Array<{mesh: Mesh, material: MaterialData}>} Pieces */

// loadCAD's material: '#a6b9c8', roughness 0.4, metalness 0.3.
const DEFAULT_COLOR = [166 / 255, 185 / 255, 200 / 255];
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
/** @type {Record<string, CADFormat>} */
const EXTENSIONS = {
  step: 'step',
  stp: 'step',
  iges: 'iges',
  igs: 'iges',
  sat: 'sat',
  x_t: 'xt',
  x_b: 'xt',
  xmt_txt: 'xt',
  xmt_bin: 'xt',
  jt: 'jt',
};

/**
 * Format from a file name: .step/.stp, .iges/.igs, .sat, .x_t/.x_b/.xmt_txt/.xmt_bin or .jt. The .brep
 * format is not read: it is the native format of the earlier importer's kernel, with no published specification.
 * @param {string} file
 * @returns {CADFormat}
 */
export function formatOf(file) {
  const extension = file.toLowerCase().split('.').at(-1) ?? '';
  if (Object.hasOwn(EXTENSIONS, extension)) return EXTENSIONS[extension];
  throw new TypeError(
    `Unsupported CAD file ${file}: expected .step, .stp, .iges, .igs, .sat, .x_t, .x_b, .xmt_txt, .xmt_bin or .jt`,
  );
}

/** @param {number} c sRGB component @returns {number} linear component, clamped to [0, 1] */
const linear = (c) => {
  const v = Math.min(1, Math.max(0, c));
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

/**
 * Splits a body mesh into one mesh per face colour (most bodies have one), positions in metres in the body's frame.
 * @param {BodyMesh} body @param {readonly number[]|undefined} bodyColor
 * @param {(rgb: readonly number[]|undefined) => MaterialData} material
 * @returns {Pieces}
 */
function pieces(body, bodyColor, material) {
  /** @type {Map<MaterialData, Array<{first: number, count: number}>>} */
  const groups = new Map();
  for (const face of body.faces) {
    const m = material(face.color ?? bodyColor);
    let list = groups.get(m);
    if (!list) groups.set(m, (list = []));
    list.push({ first: face.first, count: face.count });
  }
  const p = body.positions,
    n = body.normals,
    t = body.indices,
    u = body.unit;
  return [...groups].map(([mat, list]) => {
    const remap = new Int32Array(p.length / 3).fill(-1),
      indices = [];
    /** @type {number[]} */ const positions = [];
    /** @type {number[]} */ const normals = [];
    for (const { first, count } of list)
      for (let i = first; i < first + count; i++) {
        const v = t[i];
        if (remap[v] < 0) {
          remap[v] = positions.length / 3;
          positions.push(p[v * 3] * u, p[v * 3 + 1] * u, p[v * 3 + 2] * u);
          normals.push(n[v * 3], n[v * 3 + 1], n[v * 3 + 2]);
        }
        indices.push(remap[v]);
      }
    return {
      mesh: {
        positions: new Float32Array(positions),
        normals: new Float32Array(normals),
        indices: Uint32Array.from(indices),
      },
      material: mat,
    };
  });
}

/** A copy of `piece`'s mesh with column-major `m` (metres to metres) applied (normals by its cofactor matrix). */
/** @param {Mesh} mesh @param {ArrayLike<number>} m @returns {Mesh} */
function transformed(mesh, m) {
  const c = [
      m[5] * m[10] - m[6] * m[9],
      m[6] * m[8] - m[4] * m[10],
      m[4] * m[9] - m[5] * m[8],
      m[2] * m[9] - m[1] * m[10],
      m[0] * m[10] - m[2] * m[8],
      m[1] * m[8] - m[0] * m[9],
      m[1] * m[6] - m[2] * m[5],
      m[2] * m[4] - m[0] * m[6],
      m[0] * m[5] - m[1] * m[4],
    ],
    p = mesh.positions,
    n = mesh.normals,
    positions = new Float32Array(p.length),
    normals = new Float32Array(n.length);
  for (let i = 0; i < p.length; i += 3) {
    const [x, y, z] = [p[i], p[i + 1], p[i + 2]],
      [a, b, d] = [n[i], n[i + 1], n[i + 2]];
    positions[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
    positions[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    positions[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
    const nx = c[0] * a + c[1] * b + c[2] * d,
      ny = c[3] * a + c[4] * b + c[5] * d,
      nz = c[6] * a + c[7] * b + c[8] * d,
      l = Math.hypot(nx, ny, nz) || 1;
    normals[i] = nx / l;
    normals[i + 1] = ny / l;
    normals[i + 2] = nz / l;
  }
  return { positions, normals, indices: mesh.indices.slice() };
}

/** `world` relative to `parent` (both column-major, model to world): inverse(parent) * world. */
/** @param {ArrayLike<number>|undefined} parent @param {ArrayLike<number>} world @returns {number[]} */
function local(parent, world) {
  const inverse = parent && invertMatrix(parent);
  return Array.from(inverse ? multiplyMatrices(inverse, world) : world);
}

/** Whether `m` is the identity within 1e-12. @param {ArrayLike<number>} m */
const isIdentity = (m) => IDENTITY.every((v, i) => Math.abs(m[i] - v) <= 1e-12);

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
 * Converts STEP, IGES, SAT, XT or JT bytes to a GLB in metres (each format from its own unit). Bodies keep their names
 * and colours (one material per colour), assemblies their tree; every placement of a body shares one mesh.
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
    generator = 'margo-convert-cad',
  } = options;
  if (!['step', 'iges', 'sat', 'xt', 'jt'].includes(format))
    throw new TypeError(`Unknown format ${format}: use step, iges, sat, xt or jt`);
  if ('units' in options)
    throw new TypeError(
      'The units option was for .brep files, which are no longer read; STEP, IGES, SAT, XT and JT carry their own units',
    );
  if (linearDeflection !== undefined && !(linearDeflection > 0 && linearDeflection < Infinity))
    throw new RangeError('linearDeflection must be a positive number of millimetres');
  if (angularDeflection !== undefined && !(angularDeflection > 0 && angularDeflection < 180))
    throw new RangeError('angularDeflection must be in (0, 180) degrees');
  if (edges !== undefined && !(edges >= 0 && edges <= 180))
    throw new RangeError('edges must be a dihedral angle in [0, 180] degrees');

  let start = performance.now();
  /** @type {import('@margoengine/brep').TessellationOptions} */
  const tessellation = {
    ...(linearDeflection === undefined ? {} : { deflection: linearDeflection / 1000 }),
    ...(angularDeflection === undefined ? {} : { angle: (angularDeflection * Math.PI) / 180 }),
  };
  /** @type {string[]} */
  const warnings = [];
  /** @type {Map<string, MaterialData>} */
  const materials = new Map();
  /** One material per colour; STEP colours are sRGB, glTF base colours are linear. @param {readonly number[]|undefined} rgb */
  const material = (rgb) => {
    const srgb = rgb ?? DEFAULT_COLOR,
      name =
        '#' +
        [0, 1, 2]
          .map((k) =>
            Math.round(Math.min(1, Math.max(0, srgb[k])) * 255)
              .toString(16)
              .padStart(2, '0'),
          )
          .join('');
    let out = materials.get(name);
    if (!out)
      materials.set(
        name,
        (out = { name, color: [0, 1, 2].map((k) => linear(srgb[k])), roughness: 0.4, metalness: 0.3 }),
      );
    return out;
  };

  // Each body is tessellated once, the first time a placement needs it.
  /** @type {Map<STEPModel, Tessellator>} */
  const tessellators = new Map();
  /** @type {Map<STEPModel, Map<number, BodyMesh|null>>} */
  const meshed = new Map();
  let failedFaces = 0;
  /** @param {STEPModel} model @param {number} index @returns {BodyMesh|null} */
  const bodyMesh = (model, index) => {
    let byBody = meshed.get(model);
    if (!byBody) meshed.set(model, (byBody = new Map()));
    if (byBody.has(index)) return /** @type {BodyMesh|null} */ (byBody.get(index));
    let tessellator = tessellators.get(model);
    if (!tessellator)
      tessellators.set(model, (tessellator = new Tessellator(model.file, model.faceColors, tessellation)));
    const body = model.bodies[index];
    /** @type {BodyMesh|null} */
    let mesh = null;
    try {
      mesh = tessellator.body(body);
      failedFaces += mesh.failures.length;
    } catch (error) {
      failedFaces += Math.max(1, body.faces.length);
      warnings.push(`Body ${body.name || index} was left out: ${error instanceof Error ? error.message : error}`);
    }
    byBody.set(index, mesh);
    return mesh;
  };

  /**
   * Every placed body, with its tree position: `parent` is the node list it joins, `world` its model matrix.
   * @type {Array<{model: STEPModel, body: number, color: readonly number[]|undefined, name: string, world: ArrayLike<number>, node: ExportNode}>}
   */
  const placements = [];
  /**
   * The nodes of one STEP-like model: its occurrences as assembly nodes and its placed bodies under them.
   * @param {STEPModel} model @param {ArrayLike<number>} outer model to world @param {readonly number[]|undefined} color
   * @returns {ExportNode[]}
   */
  const tree = (model, outer, color) => {
    const world = (/** @type {ArrayLike<number>} */ m) => (isIdentity(outer) ? m : multiplyMatrices(outer, m)),
      /** @type {Array<ExportNode & {children: ExportNode[]}>} */
      occurrences = model.occurrences.map((o) => ({
        name: model.products[o.product]?.name || undefined,
        children: [],
      })),
      /** @type {ExportNode[]} */
      roots = [];
    model.occurrences.forEach((o, i) => {
      const node = occurrences[i],
        parent = o.parent >= 0 ? model.occurrences[o.parent].matrix : undefined,
        matrix = local(parent, o.matrix);
      if (!isIdentity(matrix)) Object.assign(node, { matrix });
      (o.parent >= 0 ? occurrences[o.parent].children : roots).push(node);
    });
    for (const instance of model.instances) {
      const body = model.bodies[instance.body],
        occurrence = instance.occurrence >= 0 ? model.occurrences[instance.occurrence] : undefined,
        product = instance.product >= 0 ? model.products[instance.product]?.name : '',
        matrix = local(occurrence?.matrix, instance.matrix),
        /** @type {ExportNode} */
        node = { name: body.name || product || undefined };
      if (!isIdentity(matrix)) Object.assign(node, { matrix });
      (occurrence ? occurrences[instance.occurrence].children : roots).push(node);
      placements.push({
        model,
        body: instance.body,
        color: body.color ?? color,
        name: node.name ?? '',
        world: world(instance.matrix),
        node,
      });
    }
    // A part node holding one unmoved body takes the body's mesh itself (as CAD tools write a part).
    for (const node of occurrences)
      if (node.children.length === 1 && !node.children[0].matrix && !node.children[0].children) {
        const [only] = node.children,
          placement = placements.find((p) => p.node === only);
        if (placement) {
          placement.node = node;
          delete (/** @type {ExportNode} */ (node).children);
        }
      }
    return roots;
  };

  /** @type {ExportNode[]} */
  let roots = [];
  if (format === 'jt') {
    const jt = parseJT(data);
    warnings.push(...jt.warnings);
    for (const instance of jt.instances) {
      const part = jt.parts[instance.part];
      if (!part.brep) continue;
      const children = tree(part.brep, instance.matrix, instance.color),
        /** @type {ExportNode} */
        node = { name: instance.path.at(-1) || part.name || undefined, children };
      if (!isIdentity(instance.matrix)) node.matrix = [...instance.matrix];
      roots.push(node);
    }
    if (!placements.length && jt.parts.some((part) => part.shapes.some((shape) => shape.mesh)))
      throw new Error(
        'This JT file has triangle LODs but no exact B-rep; margo-convert-cad reads the exact B-rep only',
      );
  } else {
    const parse = { step: parseSTEP, iges: parseIGES, sat: parseSAT, xt: parseXT }[format],
      model = parse(data);
    warnings.push(...model.warnings);
    roots = tree(model, IDENTITY, undefined);
  }
  for (const p of placements) bodyMesh(p.model, p.body);
  if (!placements.some((p) => bodyMesh(p.model, p.body)?.indices.length))
    throw new Error(`The kernel could not read this ${format.toUpperCase()} file (no B-rep geometry it could mesh)`);
  const tessellateMs = performance.now() - start;
  start = performance.now();

  /** @type {Map<BodyMesh, Pieces>} */
  const shared = new Map();
  let instanced = 0,
    meshes = 0,
    triangles = 0;
  /** @param {{model: STEPModel, body: number, color: readonly number[]|undefined}} p @returns {Pieces} */
  const piecesOf = (p) => {
    const mesh = bodyMesh(p.model, p.body);
    if (!mesh) return [];
    triangles += mesh.indices.length / 3;
    const known = instancing ? shared.get(mesh) : undefined;
    if (known) {
      instanced++;
      return known;
    }
    const made = pieces(mesh, p.color, material);
    shared.set(mesh, made);
    meshes++;
    return made;
  };

  if (merge) {
    /** @type {Map<MaterialData, {positions: number[], normals: number[], indices: number[]}>} */
    const byMaterial = new Map();
    for (const p of placements)
      for (const { mesh, material: mat } of piecesOf(p)) {
        const moved = transformed(mesh, p.world);
        let out = byMaterial.get(mat);
        if (!out) byMaterial.set(mat, (out = { positions: [], normals: [], indices: [] }));
        const base = out.positions.length / 3;
        for (let i = 0; i < moved.positions.length; i++) {
          out.positions.push(moved.positions[i]);
          out.normals.push(moved.normals[i]);
        }
        for (const i of moved.indices) out.indices.push(base + i);
      }
    roots = [...byMaterial].map(([mat, m]) => ({ name: mat.name, geometry: m, material: mat }));
  } else
    for (const p of placements) {
      const made = piecesOf(p);
      if (made.length === 1) Object.assign(p.node, { geometry: made[0].mesh, material: made[0].material });
      else if (made.length)
        p.node.children = [
          ...(p.node.children ?? []),
          ...made.map((piece) => ({ geometry: piece.mesh, material: piece.material })),
        ];
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
      parts: placements.length,
      meshes,
      instanced,
      triangles,
      edges: segments,
      failedFaces,
      initMs: 0,
      tessellateMs,
      writeMs,
    },
    warnings,
  };
}
