// @ts-check
// Model optimisation passes for margo-convert: prune unused data, dedupe, weld vertices, merge static meshes and
// quantise vertex attributes (KHR_mesh_quantization). Each pass edits a Model from gltf-io.js in place and adds to the
// counts in `stats`. Written from the glTF 2.0 specification and the KHR_mesh_quantization extension text.
import { createHash } from 'node:crypto';
import { weldVertices } from '@margoengine/exporters/optimize';
import { optimizeOverdraw, optimizeVertexCache, vertexFetchRemap } from '@margoengine/geometry/optimize';
import { countOf, withoutDegenerate } from './gltf-io.js';

/** @typedef {import('./gltf-io.js').Model} Model */
/** @typedef {import('./gltf-io.js').Attr} Attr */
/** @typedef {import('./gltf-io.js').Geo} Geo */

/**
 * Counts the passes report.
 * @typedef {object} ModelStats
 * @property {number} verticesBefore
 * @property {number} verticesAfter
 * @property {number} trianglesBefore
 * @property {number} trianglesAfter
 * @property {number} removedAttributes
 * @property {number} removedNodes
 * @property {number} removedMeshes
 * @property {number} removedMaterials
 * @property {number} removedTextures
 * @property {number} removedImages
 * @property {number} dedupedMaterials
 * @property {number} dedupedTextures
 * @property {number} dedupedImages
 * @property {number} dedupedMeshes
 * @property {number} mergedPrimitives
 * @property {number} quantizedAttributes
 * @property {number} imageBytesBefore
 * @property {number} imageBytesAfter
 * @property {number} imagesProcessed
 * @property {string[]} notes
 */

/** @returns {ModelStats} */
export function newStats() {
  return {
    verticesBefore: 0,
    verticesAfter: 0,
    trianglesBefore: 0,
    trianglesAfter: 0,
    removedAttributes: 0,
    removedNodes: 0,
    removedMeshes: 0,
    removedMaterials: 0,
    removedTextures: 0,
    removedImages: 0,
    dedupedMaterials: 0,
    dedupedTextures: 0,
    dedupedImages: 0,
    dedupedMeshes: 0,
    mergedPrimitives: 0,
    reorderedPrimitives: 0,
    quantizedAttributes: 0,
    imageBytesBefore: 0,
    imageBytesAfter: 0,
    imagesProcessed: 0,
    notes: [],
  };
}

/** Every primitive of every mesh. @param {Model} model @returns {any[]} */
const primitives = (model) => (model.json.meshes ?? []).flatMap((/** @type {any} */ m) => m.primitives);

/** @param {Geo} geo @returns {number} */
const vertexCount = (geo) => countOf(geo.attributes.POSITION ?? Object.values(geo.attributes)[0]);

/** Counts triangles and vertices before or after the passes. @param {Model} model @returns {{vertices: number, triangles: number}} */
export function measure(model) {
  let vertices = 0,
    triangles = 0;
  for (const prim of primitives(model)) {
    const geo = /** @type {Geo} */ (prim.$geo);
    const n = vertexCount(geo);
    vertices += n;
    const mode = prim.mode ?? 4;
    if (mode === 4) triangles += (geo.indices ? geo.indices.values.length : n) / 3;
  }
  return { vertices, triangles };
}

// ------------------------------------------------------------------------------------------------ references

/**
 * Calls `visit(textureInfo, slot)` for every texture reference of a material, extensions included: any `*Texture`
 * member that holds an integer `index`; `slot` is its member name (`baseColorTexture`).
 * @param {any} material @param {(info: any, slot: string) => void} visit
 */
export function eachTextureInfo(material, visit) {
  const walk = (/** @type {any} */ value) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (
        child &&
        typeof child === 'object' &&
        /Texture$/.test(key) &&
        Number.isInteger(/** @type {any} */ (child).index)
      )
        visit(child, key);
      else if (key !== 'extras') walk(child);
    }
  };
  walk(material);
}

/** Materials a primitive can draw: its own and every KHR_materials_variants mapping. @param {any} prim @returns {number[]} */
function materialsOf(prim) {
  const list = prim.material === undefined ? [] : [prim.material];
  for (const mapping of prim.extensions?.KHR_materials_variants?.mappings ?? []) list.push(mapping.material);
  return list;
}

/**
 * Rebuilds an array keeping the entries in `keep` (in order) and returns old index -> new index.
 * @param {any[]} list @param {Set<number>} keep @returns {{list: any[], map: Map<number, number>}}
 */
function compact(list, keep) {
  /** @type {Map<number, number>} */ const map = new Map();
  const out = [];
  for (let i = 0; i < list.length; i++)
    if (keep.has(i)) {
      map.set(i, out.length);
      out.push(list[i]);
    }
  return { list: out, map };
}

/** @param {Model} model @param {Map<number, number>} map @param {(prim: any) => void} [extra] */
function remapMaterials(model, map, extra) {
  for (const prim of primitives(model)) {
    if (prim.material !== undefined) prim.material = map.get(prim.material);
    for (const mapping of prim.extensions?.KHR_materials_variants?.mappings ?? [])
      mapping.material = map.get(mapping.material);
    extra?.(prim);
  }
}

/** @param {any} texture @returns {number[]} every image a texture can show (core source and extension sources) */
export function imagesOf(texture) {
  const list = texture.source === undefined ? [] : [texture.source];
  for (const ext of Object.values(texture.extensions ?? {}))
    if (Number.isInteger(/** @type {any} */ (ext)?.source)) list.push(/** @type {any} */ (ext).source);
  return list;
}

/** @param {any} texture @param {(i: number) => number | undefined} map */
function remapImages(texture, map) {
  if (texture.source !== undefined) texture.source = map(texture.source);
  for (const ext of Object.values(texture.extensions ?? {}))
    if (Number.isInteger(/** @type {any} */ (ext)?.source))
      /** @type {any} */ (ext).source = map(/** @type {any} */ (ext).source);
}

// ------------------------------------------------------------------------------------------------ prune

/**
 * Removes unused vertex attributes (texture coordinate sets no material reads, tangents without a normal map) and
 * then everything nothing refers to: nodes, meshes, materials, textures, samplers, images, skins and cameras.
 * @param {Model} model @param {ModelStats} stats @param {{emptyNodes?: boolean}} [options]
 */
export function prune(model, stats, options = {}) {
  const json = model.json;
  const materials = json.materials ?? [];
  // Per material: texture coordinate sets read and whether a normal map exists.
  const reads = materials.map((/** @type {any} */ material) => {
    /** @type {Set<number>} */ const sets = new Set();
    let normal = false;
    eachTextureInfo(material, (info) => {
      sets.add(info.extensions?.KHR_texture_transform?.texCoord ?? info.texCoord ?? 0);
    });
    if (material.normalTexture) normal = true;
    return { sets, normal };
  });
  for (const prim of primitives(model)) {
    const geo = /** @type {Geo} */ (prim.$geo);
    const sets = new Set(),
      mats = materialsOf(prim);
    let normal = false;
    for (const m of mats) {
      for (const s of reads[m]?.sets ?? []) sets.add(s);
      normal ||= reads[m]?.normal ?? false;
    }
    for (const name of Object.keys(geo.attributes)) {
      const uv = /^TEXCOORD_(\d+)$/.exec(name);
      if ((uv && !sets.has(Number(uv[1]))) || (name === 'TANGENT' && !normal)) {
        delete geo.attributes[name];
        for (const target of geo.targets) delete target[name];
        stats.removedAttributes++;
      }
    }
  }

  // Nodes: keep what a scene reaches, what animations or skins name, and their ancestors and descendants.
  const nodes = json.nodes ?? [];
  const parent = new Map();
  nodes.forEach((/** @type {any} */ n, /** @type {number} */ i) => {
    for (const c of n.children ?? []) parent.set(c, i);
  });
  /** @type {Set<number>} */ const referenced = new Set();
  for (const a of json.animations ?? [])
    for (const c of a.channels ?? []) if (c.target?.node !== undefined) referenced.add(c.target.node);
  for (const s of json.skins ?? []) {
    for (const j of s.joints ?? []) referenced.add(j);
    if (s.skeleton !== undefined) referenced.add(s.skeleton);
  }
  /** @type {Set<number>} */ const keepNodes = new Set();
  const down = (/** @type {number} */ i) => {
    if (keepNodes.has(i)) return;
    keepNodes.add(i);
    for (const c of nodes[i].children ?? []) down(c);
  };
  for (const scene of json.scenes ?? []) for (const n of scene.nodes ?? []) down(n);
  for (const r of referenced) {
    down(r);
    for (let p = parent.get(r); p !== undefined; p = parent.get(p)) keepNodes.add(p);
  }
  if (!(json.scenes ?? []).length) for (let i = 0; i < nodes.length; i++) keepNodes.add(i);
  if (options.emptyNodes) {
    // Leaves that carry nothing, repeatedly (a parent may become a leaf).
    for (let changed = true; changed; ) {
      changed = false;
      for (const i of [...keepNodes]) {
        const n = nodes[i];
        const bare =
          n.mesh === undefined &&
          n.skin === undefined &&
          n.camera === undefined &&
          !n.extensions &&
          !(n.children ?? []).some((/** @type {number} */ c) => keepNodes.has(c));
        if (bare && !referenced.has(i)) {
          keepNodes.delete(i);
          changed = true;
        }
      }
    }
  }
  if (keepNodes.size !== nodes.length) {
    const { list, map } = compact(nodes, keepNodes);
    stats.removedNodes += nodes.length - list.length;
    for (const n of list)
      if (n.children)
        n.children = n.children
          .filter((/** @type {number} */ c) => map.has(c))
          .map((/** @type {number} */ c) => map.get(c));
    for (const n of list) if (n.children && !n.children.length) delete n.children;
    for (const s of json.scenes ?? [])
      s.nodes = (s.nodes ?? [])
        .filter((/** @type {number} */ c) => map.has(c))
        .map((/** @type {number} */ c) => map.get(c));
    for (const sk of json.skins ?? []) {
      sk.joints = sk.joints.map((/** @type {number} */ j) => map.get(j));
      if (sk.skeleton !== undefined) sk.skeleton = map.get(sk.skeleton);
    }
    for (const a of json.animations ?? [])
      a.channels = (a.channels ?? [])
        .filter((/** @type {any} */ c) => c.target?.node === undefined || map.has(c.target.node))
        .map((/** @type {any} */ c) => {
          if (c.target?.node !== undefined) c.target.node = map.get(c.target.node);
          return c;
        });
    json.nodes = list;
  }

  // Meshes, skins, cameras used by remaining nodes.
  const used = (/** @type {string} */ key) =>
    new Set(
      /** @type {number[]} */ (
        (json.nodes ?? []).map((/** @type {any} */ n) => n[key]).filter((/** @type {any} */ v) => v !== undefined)
      ),
    );
  if (json.meshes) {
    const keep = used('mesh');
    if (keep.size !== json.meshes.length) {
      const { list, map } = compact(json.meshes, keep);
      stats.removedMeshes += json.meshes.length - list.length;
      for (const n of json.nodes ?? []) if (n.mesh !== undefined) n.mesh = map.get(n.mesh);
      json.meshes = list;
    }
  }
  for (const key of ['skin', 'camera']) {
    const list = json[`${key}s`];
    if (!list) continue;
    const keep = used(key);
    if (keep.size === list.length) continue;
    const c = compact(list, keep);
    for (const n of json.nodes ?? []) if (n[key] !== undefined) n[key] = c.map.get(n[key]);
    json[`${key}s`] = c.list;
    if (!c.list.length) delete json[`${key}s`];
  }

  // Materials, textures, samplers, images.
  if (json.materials) {
    const keep = new Set(primitives(model).flatMap(materialsOf));
    if (keep.size !== json.materials.length) {
      const { list, map } = compact(json.materials, keep);
      stats.removedMaterials += json.materials.length - list.length;
      remapMaterials(model, map);
      json.materials = list;
    }
    if (!json.materials.length) delete json.materials;
  }
  if (json.textures) {
    /** @type {Set<number>} */ const keep = new Set();
    for (const material of json.materials ?? []) eachTextureInfo(material, (info) => keep.add(info.index));
    if (keep.size !== json.textures.length) {
      const { list, map } = compact(json.textures, keep);
      stats.removedTextures += json.textures.length - list.length;
      for (const material of json.materials ?? [])
        eachTextureInfo(material, (info) => (info.index = map.get(info.index)));
      json.textures = list;
    }
    if (!json.textures.length) delete json.textures;
  }
  if (json.samplers) {
    const keep = new Set(
      (json.textures ?? []).map((/** @type {any} */ t) => t.sampler).filter((/** @type {any} */ v) => v !== undefined),
    );
    if (keep.size !== json.samplers.length) {
      const { list, map } = compact(json.samplers, keep);
      for (const t of json.textures ?? []) if (t.sampler !== undefined) t.sampler = map.get(t.sampler);
      json.samplers = list;
    }
    if (!json.samplers.length) delete json.samplers;
  }
  if (json.images) {
    const keep = new Set((json.textures ?? []).flatMap(imagesOf));
    if (keep.size !== json.images.length) {
      const { list, map } = compact(json.images, keep);
      stats.removedImages += json.images.length - list.length;
      model.images = model.images.filter((_, i) => keep.has(i));
      for (const t of json.textures ?? []) remapImages(t, (i) => map.get(i));
      json.images = list;
    }
    if (!json.images.length) delete json.images;
  }
}

// ------------------------------------------------------------------------------------------------ dedupe

/** @param {Uint8Array} bytes @returns {string} */
const digest = (bytes) => createHash('sha1').update(bytes).digest('hex');

/** @param {Attr} a @returns {string} */
const attrKey = (a) =>
  `${a.type}:${a.componentType}:${a.normalized}:${digest(new Uint8Array(a.values.buffer, a.values.byteOffset, a.values.byteLength))}`;

/**
 * Merges identical images, samplers, textures, materials (same name and values) and meshes (same primitives).
 * @param {Model} model @param {ModelStats} stats
 */
export function dedupe(model, stats) {
  const json = model.json;
  if (json.images) {
    /** @type {Map<string, number>} */ const seen = new Map();
    const to = json.images.map((/** @type {any} */ image, /** @type {number} */ i) => {
      const key = `${model.images[i].mimeType}:${digest(model.images[i].bytes)}:${image.name ?? ''}`;
      const first = seen.get(key);
      if (first !== undefined) return first;
      seen.set(key, i);
      return i;
    });
    const dups = to.filter((/** @type {number} */ v, /** @type {number} */ i) => v !== i).length;
    if (dups) {
      stats.dedupedImages += dups;
      for (const t of json.textures ?? []) remapImages(t, (i) => to[i]);
    }
  }
  if (json.samplers && json.textures) {
    /** @type {Map<string, number>} */ const seen = new Map();
    const to = json.samplers.map((/** @type {any} */ s, /** @type {number} */ i) => {
      const key = JSON.stringify(s);
      const first = seen.get(key);
      if (first !== undefined) return first;
      seen.set(key, i);
      return i;
    });
    for (const t of json.textures) if (t.sampler !== undefined) t.sampler = to[t.sampler];
  }
  if (json.textures && json.materials) {
    /** @type {Map<string, number>} */ const seen = new Map();
    const to = json.textures.map((/** @type {any} */ t, /** @type {number} */ i) => {
      const key = JSON.stringify(t);
      const first = seen.get(key);
      if (first !== undefined) return first;
      seen.set(key, i);
      return i;
    });
    const dups = to.filter((/** @type {number} */ v, /** @type {number} */ i) => v !== i).length;
    if (dups) {
      stats.dedupedTextures += dups;
      for (const material of json.materials) eachTextureInfo(material, (info) => (info.index = to[info.index]));
    }
  }
  if (json.materials) {
    /** @type {Map<string, number>} */ const seen = new Map();
    const to = json.materials.map((/** @type {any} */ m, /** @type {number} */ i) => {
      const key = JSON.stringify(m);
      const first = seen.get(key);
      if (first !== undefined) return first;
      seen.set(key, i);
      return i;
    });
    const dups = to.filter((/** @type {number} */ v, /** @type {number} */ i) => v !== i).length;
    if (dups) {
      stats.dedupedMaterials += dups;
      remapMaterials(model, new Map(to.map((/** @type {number} */ v, /** @type {number} */ i) => [i, v])));
    }
  }
  if (json.meshes) {
    /** @type {Map<string, number>} */ const seen = new Map();
    const to = json.meshes.map((/** @type {any} */ mesh, /** @type {number} */ i) => {
      const key = JSON.stringify([
        mesh.weights,
        mesh.primitives.map((/** @type {any} */ p) => {
          const { $geo, ...rest } = p;
          const g = /** @type {Geo} */ ($geo);
          return [
            rest,
            Object.entries(g.attributes).map(([n, a]) => [n, attrKey(a)]),
            g.indices && attrKey(g.indices),
            g.targets.map((t) => Object.entries(t).map(([n, a]) => [n, attrKey(a)])),
          ];
        }),
      ]);
      const first = seen.get(key);
      if (first !== undefined) return first;
      seen.set(key, i);
      return i;
    });
    const dups = to.filter((/** @type {number} */ v, /** @type {number} */ i) => v !== i).length;
    if (dups) {
      stats.dedupedMeshes += dups;
      for (const n of json.nodes ?? []) if (n.mesh !== undefined) n.mesh = to[n.mesh];
    }
  }
}

// ------------------------------------------------------------------------------------------------ weld

/**
 * Merges identical vertices of triangle primitives (every attribute and morph target equal), drops unreferenced
 * vertices and degenerate triangles, and numbers vertices in order of first use.
 * @param {Model} model @param {ModelStats} stats
 */
export function weld(model, stats) {
  for (const prim of primitives(model)) {
    if ((prim.mode ?? 4) !== 4) continue;
    const geo = /** @type {Geo} */ (prim.$geo);
    const n = vertexCount(geo);
    /** @type {ArrayLike<number>} */
    let indices;
    if (geo.indices) indices = withoutDegenerate(geo.indices.values);
    else {
      const flat = new Uint32Array(n - (n % 3));
      for (let i = 0; i < flat.length; i++) flat[i] = i;
      indices = flat;
    }
    const attrs = [...Object.values(geo.attributes), ...geo.targets.flatMap((t) => Object.values(t))];
    const { keep, indices: finalIndices } = weldVertices(attrs, indices, n);
    const gatherFrom = (/** @type {Attr} */ a) => {
      const w = a.width,
        values = new /** @type {any} */ (a.values.constructor)(keep.length * w);
      for (let i = 0; i < keep.length; i++) for (let k = 0; k < w; k++) values[i * w + k] = a.values[keep[i] * w + k];
      return { ...a, values };
    };
    geo.attributes = Object.fromEntries(Object.entries(geo.attributes).map(([name, a]) => [name, gatherFrom(a)]));
    geo.targets = geo.targets.map((t) =>
      Object.fromEntries(Object.entries(t).map(([name, a]) => [name, gatherFrom(a)])),
    );
    geo.indices = { values: finalIndices, width: 1, componentType: 5125, normalized: false, type: 'SCALAR' };
  }
}

// ------------------------------------------------------------------------------------------------ reorder

/**
 * Puts indexed triangle primitives in the order a GPU reads fastest: triangles for the vertex cache and early depth
 * rejection, then vertices in order of first use (every attribute and morph target move together). A `BLEND` primitive
 * keeps its triangle order, which decides how it layers. Vertices no triangle uses are dropped.
 * @param {Model} model @param {ModelStats} stats
 */
export function reorder(model, stats) {
  const materials = model.json.materials ?? [];
  for (const prim of primitives(model)) {
    const geo = /** @type {Geo} */ (prim.$geo);
    if ((prim.mode ?? 4) !== 4 || !geo.indices?.values.length || !geo.attributes.POSITION) continue;
    if (materials[prim.material]?.alphaMode === 'BLEND') continue;
    const n = vertexCount(geo),
      order = optimizeOverdraw(optimizeVertexCache(geo.indices.values, n), geo.attributes.POSITION.values),
      remap = vertexFetchRemap(order, n);
    let used = 0;
    for (let v = 0; v < n; v++) if (remap[v] !== 0xffffffff) used++;
    const gather = (/** @type {Attr} */ a) => {
      const w = a.width,
        values = new /** @type {any} */ (a.values.constructor)(used * w);
      for (let v = 0; v < n; v++)
        if (remap[v] !== 0xffffffff) for (let k = 0; k < w; k++) values[remap[v] * w + k] = a.values[v * w + k];
      return { ...a, values };
    };
    geo.attributes = Object.fromEntries(Object.entries(geo.attributes).map(([name, a]) => [name, gather(a)]));
    geo.targets = geo.targets.map((t) => Object.fromEntries(Object.entries(t).map(([name, a]) => [name, gather(a)])));
    geo.indices = { ...geo.indices, values: order.map((v) => remap[v]), componentType: 5125 };
    stats.reorderedPrimitives++;
  }
}

// ------------------------------------------------------------------------------------------------ transforms

/** @typedef {Float64Array} Mat4 column-major */

/** @param {any} node @returns {Mat4} */
function localMatrix(node) {
  if (node.matrix) return Float64Array.from(node.matrix);
  const [qx, qy, qz, qw] = node.rotation ?? [0, 0, 0, 1],
    [sx, sy, sz] = node.scale ?? [1, 1, 1],
    [tx, ty, tz] = node.translation ?? [0, 0, 0];
  const m = new Float64Array(16);
  m[0] = (1 - 2 * (qy * qy + qz * qz)) * sx;
  m[1] = 2 * (qx * qy + qz * qw) * sx;
  m[2] = 2 * (qx * qz - qy * qw) * sx;
  m[4] = 2 * (qx * qy - qz * qw) * sy;
  m[5] = (1 - 2 * (qx * qx + qz * qz)) * sy;
  m[6] = 2 * (qy * qz + qx * qw) * sy;
  m[8] = 2 * (qx * qz + qy * qw) * sz;
  m[9] = 2 * (qy * qz - qx * qw) * sz;
  m[10] = (1 - 2 * (qx * qx + qy * qy)) * sz;
  m[12] = tx;
  m[13] = ty;
  m[14] = tz;
  m[15] = 1;
  return m;
}

/** @param {Mat4} a @param {Mat4} b @returns {Mat4} a * b */
function multiply(a, b) {
  const out = new Float64Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = s;
    }
  return out;
}

/** @param {Mat4} m @returns {number} determinant of the upper 3x3 */
const det3 = (m) =>
  m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);

/** The inverse transpose of the upper 3x3, row-major in 9 numbers. @param {Mat4} m @returns {Float64Array} */
function normalMatrix(m) {
  const a = m[0],
    b = m[4],
    c = m[8],
    d = m[1],
    e = m[5],
    f = m[9],
    g = m[2],
    h = m[6],
    i = m[10];
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g) || 1;
  // Cofactor matrix / det is the inverse transpose.
  return Float64Array.from([
    (e * i - f * h) / det,
    -(d * i - f * g) / det,
    (d * h - e * g) / det,
    -(b * i - c * h) / det,
    (a * i - c * g) / det,
    -(a * h - b * g) / det,
    (b * f - c * e) / det,
    -(a * f - c * d) / det,
    (a * e - b * d) / det,
  ]);
}

/**
 * Merges static, unskinned triangle meshes that share a material and attribute layout into one primitive per group
 * in world space. Safe means: no animation on the node or an ancestor, no skin, no morph targets, no node
 * extensions, and the mesh used by one node only (shared meshes stay instanced).
 * @param {Model} model @param {ModelStats} stats
 */
export function mergeMeshes(model, stats) {
  const json = model.json;
  const nodes = json.nodes ?? [];
  if (!nodes.length || !json.meshes) return;
  const animated = new Set();
  for (const a of json.animations ?? [])
    for (const c of a.channels ?? []) if (c.target?.node !== undefined) animated.add(c.target.node);
  const refs = new Map();
  for (const n of nodes) if (n.mesh !== undefined) refs.set(n.mesh, (refs.get(n.mesh) ?? 0) + 1);
  /** @type {Map<string, {scene: number, parts: {geo: Geo, world: Mat4, mesh: number, prim: any}[], material: number|undefined}>} */
  const groups = new Map();
  /** @type {Set<number>} */ const claimed = new Set();
  const sceneRoots = json.scenes ?? [];
  sceneRoots.forEach((/** @type {any} */ scene, /** @type {number} */ si) => {
    const visit = (/** @type {number} */ i, /** @type {Mat4} */ parentWorld, /** @type {boolean} */ blocked) => {
      if (claimed.has(i)) return;
      claimed.add(i);
      const node = nodes[i];
      const world = multiply(parentWorld, localMatrix(node));
      const block = blocked || animated.has(i);
      const mergeable =
        !block &&
        node.mesh !== undefined &&
        node.skin === undefined &&
        !node.extensions &&
        node.weights === undefined &&
        refs.get(node.mesh) === 1;
      if (mergeable) {
        const mesh = json.meshes[node.mesh];
        const ok = mesh.primitives.every(
          (/** @type {any} */ p) =>
            (p.mode ?? 4) === 4 &&
            !p.$geo.targets.length &&
            p.$geo.attributes.POSITION?.componentType === 5126 &&
            !p.extensions,
        );
        if (ok)
          for (const prim of mesh.primitives) {
            const g = /** @type {Geo} */ (prim.$geo);
            const layout = Object.entries(g.attributes)
              .map(([n, a]) => `${n}:${a.type}:${a.componentType}:${a.normalized}`)
              .sort()
              .join(',');
            const key = `${si}|${prim.material ?? ''}|${layout}`;
            let group = groups.get(key);
            if (!group) groups.set(key, (group = { scene: si, parts: [], material: prim.material }));
            group.parts.push({ geo: g, world, mesh: node.mesh, prim });
          }
      }
      for (const c of node.children ?? []) visit(c, world, block);
    };
    const identity = Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    for (const r of scene.nodes ?? []) visit(r, identity, false);
  });

  // A mesh merges only when every one of its primitives lands in a group of two or more; settle that to a fixpoint.
  /** @type {Set<number>} */ const excluded = new Set();
  for (let changed = true; changed; ) {
    changed = false;
    for (const group of groups.values()) {
      const live = group.parts.filter((p) => !excluded.has(p.mesh));
      if (live.length < 2)
        for (const p of live) {
          excluded.add(p.mesh);
          changed = true;
        }
    }
  }
  /** @type {Set<number>} */ const consumed = new Set();
  for (const full of groups.values()) {
    const group = { ...full, parts: full.parts.filter((p) => !excluded.has(p.mesh)) };
    if (group.parts.length < 2) continue;
    const names = Object.keys(group.parts[0].geo.attributes);
    let total = 0,
      indexTotal = 0;
    for (const p of group.parts) {
      total += vertexCount(p.geo);
      indexTotal += p.geo.indices ? p.geo.indices.values.length : vertexCount(p.geo);
    }
    const merged = /** @type {Record<string, Attr>} */ ({});
    for (const name of names) {
      const first = group.parts[0].geo.attributes[name];
      merged[name] = { ...first, values: new /** @type {any} */ (first.values.constructor)(total * first.width) };
    }
    const indices = new Uint32Array(indexTotal);
    let vOffset = 0,
      iOffset = 0;
    for (const { geo, world } of group.parts) {
      const count = vertexCount(geo);
      const flip = det3(world) < 0;
      const nm = normalMatrix(world);
      for (const name of names) {
        const src = geo.attributes[name],
          dst = merged[name].values,
          w = src.width,
          base = vOffset * w;
        if (name === 'POSITION') {
          for (let v = 0; v < count; v++) {
            const x = src.values[v * 3],
              y = src.values[v * 3 + 1],
              z = src.values[v * 3 + 2];
            dst[base + v * 3] = world[0] * x + world[4] * y + world[8] * z + world[12];
            dst[base + v * 3 + 1] = world[1] * x + world[5] * y + world[9] * z + world[13];
            dst[base + v * 3 + 2] = world[2] * x + world[6] * y + world[10] * z + world[14];
          }
        } else if ((name === 'NORMAL' || name === 'TANGENT') && src.componentType === 5126) {
          for (let v = 0; v < count; v++) {
            const x = src.values[v * w],
              y = src.values[v * w + 1],
              z = src.values[v * w + 2];
            // Normals follow the inverse transpose; tangents are directions and follow the matrix itself.
            const m =
              name === 'NORMAL'
                ? nm
                : [world[0], world[4], world[8], world[1], world[5], world[9], world[2], world[6], world[10]];
            let nx = m[0] * x + m[1] * y + m[2] * z,
              ny = m[3] * x + m[4] * y + m[5] * z,
              nz = m[6] * x + m[7] * y + m[8] * z;
            const len = Math.hypot(nx, ny, nz) || 1;
            nx /= len;
            ny /= len;
            nz /= len;
            dst[base + v * w] = nx;
            dst[base + v * w + 1] = ny;
            dst[base + v * w + 2] = nz;
            if (w === 4) dst[base + v * w + 3] = flip ? -src.values[v * w + 3] : src.values[v * w + 3];
          }
        } else dst.set(src.values, base);
      }
      const idx = geo.indices ? geo.indices.values : null;
      const tri = (idx ? idx.length : count) / 3;
      for (let t = 0; t < tri; t++) {
        const a = idx ? idx[t * 3] : t * 3,
          b = idx ? idx[t * 3 + 1] : t * 3 + 1,
          c = idx ? idx[t * 3 + 2] : t * 3 + 2;
        indices[iOffset++] = a + vOffset;
        indices[iOffset++] = (flip ? c : b) + vOffset;
        indices[iOffset++] = (flip ? b : c) + vOffset;
      }
      vOffset += count;
    }
    const meshIndex = json.meshes.length;
    const material = group.material === undefined ? {} : { material: group.material };
    json.meshes.push({
      name: `merged_${group.material ?? 'default'}`,
      primitives: [
        {
          ...material,
          $geo: {
            attributes: merged,
            indices: { values: indices, width: 1, componentType: 5125, normalized: false, type: 'SCALAR' },
            targets: [],
          },
        },
      ],
    });
    json.nodes.push({ name: `merged_${group.material ?? 'default'}`, mesh: meshIndex });
    json.scenes[group.scene].nodes.push(json.nodes.length - 1);
    stats.mergedPrimitives += group.parts.length;
    for (const part of group.parts) consumed.add(part.mesh);
  }
  // Detach merged meshes from their nodes. A mesh whose primitives went to different groups is detached once.
  if (consumed.size) for (const node of nodes) if (node.mesh !== undefined && consumed.has(node.mesh)) delete node.mesh;
}

// ------------------------------------------------------------------------------------------------ quantise

/**
 * Options for {@link quantize}.
 * @typedef {object} QuantizeOptions
 * @property {boolean} [position] POSITION as normalised int16 with the mesh bounds folded into the node
 * @property {8|16|false} [normal] bits for NORMAL and TANGENT (normalised integers)
 * @property {boolean} [uv] TEXCOORD as normalised uint16 when every value is in 0..1
 * @property {boolean} [color] COLOR as normalised uint8
 * @property {boolean} [weights] WEIGHTS as normalised uint8
 */

/** @param {number} v @param {number} max @returns {number} */
const clampRound = (v, max) => Math.max(-max, Math.min(max, Math.round(v * max)));

/**
 * Quantises float vertex attributes to normalised integers (KHR_mesh_quantization). Meshes with morph targets are
 * left alone; skinned meshes keep float positions (a skin ignores its node's transform).
 * @param {Model} model @param {QuantizeOptions} options @param {ModelStats} stats
 */
export function quantize(model, options, stats) {
  const json = model.json;
  const nodes = json.nodes ?? [];
  const animated = new Set();
  for (const a of json.animations ?? [])
    for (const c of a.channels ?? []) if (c.target?.node !== undefined) animated.add(c.target.node);
  const users = new Map();
  nodes.forEach((/** @type {any} */ n, /** @type {number} */ i) => {
    if (n.mesh !== undefined) (users.get(n.mesh) ?? users.set(n.mesh, []).get(n.mesh)).push(i);
  });
  json.meshes?.forEach((/** @type {any} */ mesh, /** @type {number} */ mi) => {
    if (mesh.primitives.some((/** @type {any} */ p) => p.$geo.targets.length)) return;
    const owners = /** @type {number[]} */ (users.get(mi) ?? []);
    const skinned = owners.some((i) => nodes[i].skin !== undefined);
    const plain = owners.length > 0 && owners.every((i) => !nodes[i].extensions);

    // Position: shared bounds over the mesh's primitives, folded into every node that draws the mesh.
    if (
      options.position &&
      !skinned &&
      plain &&
      mesh.primitives.every((/** @type {any} */ p) => p.$geo.attributes.POSITION?.componentType === 5126)
    ) {
      const min = [Infinity, Infinity, Infinity],
        max = [-Infinity, -Infinity, -Infinity];
      for (const p of mesh.primitives) {
        const v = p.$geo.attributes.POSITION.values;
        for (let i = 0; i < v.length; i += 3)
          for (let k = 0; k < 3; k++) {
            if (v[i + k] < min[k]) min[k] = v[i + k];
            if (v[i + k] > max[k]) max[k] = v[i + k];
          }
      }
      if (min.every(Number.isFinite)) {
        // One scale for all axes: a non-uniform scale on the node would skew the normals (a renderer transforms
        // them by the node matrix's inverse transpose), and the shorter axes only use part of the 16-bit range.
        const c = min.map((lo, k) => (lo + max[k]) / 2),
          half = Math.max(...min.map((lo, k) => (max[k] - lo) / 2)) || 1,
          h = [half, half, half];
        for (const p of mesh.primitives) {
          const a = p.$geo.attributes.POSITION,
            q = new Int16Array(a.values.length);
          for (let i = 0; i < q.length; i += 3)
            for (let k = 0; k < 3; k++) q[i + k] = clampRound((a.values[i + k] - c[k]) / h[k], 32767);
          p.$geo.attributes.POSITION = { values: q, width: 3, componentType: 5122, normalized: true, type: 'VEC3' };
          stats.quantizedAttributes++;
        }
        for (const i of owners) dequantize(json, nodes, i, c, h, animated.has(i));
      }
    }

    for (const p of mesh.primitives) {
      const g = /** @type {Geo} */ (p.$geo);
      for (const [name, a] of Object.entries(g.attributes)) {
        if (a.componentType !== 5126) continue;
        if ((name === 'NORMAL' || name === 'TANGENT') && options.normal) {
          const max = options.normal === 8 ? 127 : 32767,
            q = options.normal === 8 ? new Int8Array(a.values.length) : new Int16Array(a.values.length);
          for (let i = 0; i < q.length; i++) q[i] = clampRound(a.values[i], max);
          g.attributes[name] = {
            values: q,
            width: a.width,
            componentType: options.normal === 8 ? 5120 : 5122,
            normalized: true,
            type: a.type,
          };
          stats.quantizedAttributes++;
        } else if (/^TEXCOORD_\d+$/.test(name) && options.uv) {
          let ok = true;
          for (let i = 0; i < a.values.length && ok; i++) ok = a.values[i] >= -1e-6 && a.values[i] <= 1 + 1e-6;
          if (!ok) continue;
          const q = new Uint16Array(a.values.length);
          for (let i = 0; i < q.length; i++) q[i] = Math.max(0, Math.min(65535, Math.round(a.values[i] * 65535)));
          g.attributes[name] = { values: q, width: 2, componentType: 5123, normalized: true, type: 'VEC2' };
          stats.quantizedAttributes++;
        } else if (/^COLOR_\d+$/.test(name) && options.color) {
          const n = a.values.length / a.width,
            q = new Uint8Array(n * 4);
          for (let v = 0; v < n; v++) {
            for (let k = 0; k < 3; k++)
              q[v * 4 + k] = Math.max(0, Math.min(255, Math.round(a.values[v * a.width + k] * 255)));
            q[v * 4 + 3] = a.width === 4 ? Math.max(0, Math.min(255, Math.round(a.values[v * 4 + 3] * 255))) : 255;
          }
          g.attributes[name] = { values: q, width: 4, componentType: 5121, normalized: true, type: 'VEC4' };
          stats.quantizedAttributes++;
        } else if (/^WEIGHTS_\d+$/.test(name) && options.weights && a.width === 4) {
          const n = a.values.length / 4,
            q = new Uint8Array(n * 4);
          for (let v = 0; v < n; v++) {
            let sum = 0,
              big = 0;
            for (let k = 0; k < 4; k++) {
              q[v * 4 + k] = Math.max(0, Math.min(255, Math.round(a.values[v * 4 + k] * 255)));
              sum += q[v * 4 + k];
              if (q[v * 4 + k] > q[v * 4 + big]) big = k;
            }
            // Weights must sum to 1: put the rounding error on the largest one (an all-zero vertex stays zero).
            if (sum > 0) q[v * 4 + big] = Math.max(0, Math.min(255, q[v * 4 + big] + 255 - sum));
          }
          g.attributes[name] = { values: q, width: 4, componentType: 5121, normalized: true, type: 'VEC4' };
          stats.quantizedAttributes++;
        }
      }
    }
  });
}

/**
 * Applies the dequantisation `p = c + h * q` to node `i`: folded into its transform when nothing else depends on it,
 * otherwise the mesh moves to a new child node that carries the transform.
 * @param {any} json @param {any[]} nodes @param {number} i @param {number[]} c @param {number[]} h @param {boolean} animated
 */
function dequantize(json, nodes, i, c, h, animated) {
  const node = nodes[i];
  if (!animated && !(node.children && node.children.length)) {
    if (node.matrix) {
      const d = Float64Array.from([h[0], 0, 0, 0, 0, h[1], 0, 0, 0, 0, h[2], 0, c[0], c[1], c[2], 1]);
      node.matrix = Array.from(multiply(Float64Array.from(node.matrix), d));
    } else {
      const [qx, qy, qz, qw] = node.rotation ?? [0, 0, 0, 1],
        s = node.scale ?? [1, 1, 1],
        t = node.translation ?? [0, 0, 0];
      // T' = T + R (S * c), S' = S * h.
      const v = [s[0] * c[0], s[1] * c[1], s[2] * c[2]];
      const cx = qy * v[2] - qz * v[1] + qw * v[0],
        cy = qz * v[0] - qx * v[2] + qw * v[1],
        cz = qx * v[1] - qy * v[0] + qw * v[2];
      const rx = v[0] + 2 * (qy * cz - qz * cy),
        ry = v[1] + 2 * (qz * cx - qx * cz),
        rz = v[2] + 2 * (qx * cy - qy * cx);
      node.translation = [t[0] + rx, t[1] + ry, t[2] + rz];
      node.scale = [s[0] * h[0], s[1] * h[1], s[2] * h[2]];
    }
    return;
  }
  nodes.push({ mesh: node.mesh, translation: c, scale: h, ...(node.name ? { name: `${node.name}_mesh` } : {}) });
  delete node.mesh;
  (node.children ??= []).push(nodes.length - 1);
}
