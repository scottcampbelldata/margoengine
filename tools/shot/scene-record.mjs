// The scene record of a shot's measure (docs/shots.md, Measure, "scene"): what a film pipeline's scene audit judges,
// read from the page engine's own scene graph after the warm-up, never from a per-page report. Lights (the scene's sun
// and ambient, the colour temperature of each by McCamy's formula), every attached plugin with its options (post
// effects inside a PostStack included), every mesh (triangles, vertices, LOD levels, world bounds, the ground under
// its base), every material (glTF metal-rough values, alpha mode, sides, IOR and specular, the extensions that give
// clear coat, sheen or transmission, the tangents of its primitives and the size and format of each map) and the
// frame's draw count. A value the graph does not hold is null, so a judge reads it as unknown.
//
// Version 2 adds: the GPU usage of every texture a plugin keeps, with `attachment` true for a render target
// (GPUTextureUsage.RENDER_ATTACHMENT, WebGPU section 6.1.2), so a judge of texture assets can tell a post pass's
// target from an asset; textures kept in a plain object (a terrain's heightmap, layers and weights) with their `key`;
// options one level deeper (a terrain's layer rules); the local lights of a plugin that lists them (`list`, as
// Clustered keeps them: candela, glTF KHR_lights_punctual units); each mesh's model file (`file`, the URL its glTF was
// loaded from), its texture coordinate span and vertex colours, its open edges (edges of one triangle, positions
// welded), and each map's KHR_texture_transform repeat.
//
// readSceneRecord is one self-contained function: Playwright serialises it into the page (page.evaluate), where
// globalThis.__margoShot is the shot driver. It allocates per call and is run once per measure.

/**
 * @param {{ engine: string, ground: string | null, step: number }} options `engine` and `ground` are the shot's
 * page keys; `step` is the spacing in metres of the ground samples under a piece's base (its corners and centre).
 */
export function readSceneRecord({ engine: engineName, ground: groundName, step }) {
  const driver = globalThis.__margoShot,
    engine = driver.get(engineName),
    ground = groundName ? driver.get(groundName) : null,
    sources = globalThis[Symbol.for('margoengine.mesh-sources.v1')];
  if (!engine?.scene?.meshes) throw new Error(`${engineName} is not an engine: the measure reads its scene graph`);
  const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null),
    list = (v) => (v && typeof v.length === 'number' ? Array.from(v, (x) => finite(Number(x))) : null);
  // McCamy 1992, correlated colour temperature of a linear sRGB colour; null for black or neutral grey.
  const kelvin = (rgb) => {
    const [r, g, b] = rgb;
    if (!(Math.max(r, g, b) > 0) || (Math.abs(r - g) < 1e-3 && Math.abs(g - b) < 1e-3)) return null;
    const X = 0.4124 * r + 0.3576 * g + 0.1805 * b,
      Y = 0.2126 * r + 0.7152 * g + 0.0722 * b,
      Z = 0.0193 * r + 0.1192 * g + 0.9505 * b,
      x = X / (X + Y + Z),
      y = Y / (X + Y + Z),
      n = (x - 0.332) / (0.1858 - y);
    return 449 * n ** 3 + 3525 * n ** 2 + 6823.3 * n + 5520.33;
  };
  const isPlain = (v) =>
    !!v && typeof v === 'object' && !ArrayBuffer.isView(v) && Object.getPrototypeOf(v) === Object.prototype;
  // A plugin's settings: its options (or settings) object's plain values, two levels deep: numbers, strings, booleans,
  // short number lists, plain objects and lists of up to 64 plain objects (a terrain's layer rules).
  const plain = (o, depth = 0) => {
    if (!o || typeof o !== 'object') return null;
    const out = {};
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (typeof v === 'function') out[k] = 'function';
      else if (typeof v === 'number') out[k] = finite(v);
      else if (typeof v === 'string' || typeof v === 'boolean') out[k] = v;
      else if (v && typeof v.length === 'number' && v.length <= 16 && Array.from(v).every((x) => typeof x === 'number'))
        out[k] = list(v);
      else if (depth < 2 && Array.isArray(v) && v.length && v.length <= 64 && v.every(isPlain))
        out[k] = v.map((x) => plain(x, depth + 1));
      else if (isPlain(v)) out[k] = depth < 2 ? plain(v, depth + 1) : {};
    }
    return out;
  };
  // GPUTextureUsage.RENDER_ATTACHMENT (WebGPU, section 6.1.2): the texture is a render target, not an asset.
  const RENDER_ATTACHMENT = 0x10;
  // The GPU textures a plugin keeps in its `textures` field (an array, a map or a plain object, nested ones too): size,
  // format, usage, and the key of the plain object field that holds it.
  const texturesOf = (t, out = [], depth = 0, key = null) => {
    if (!t || typeof t !== 'object' || depth > 3) return out;
    if (typeof t.width === 'number' && typeof t.format === 'string') {
      const usage = finite(t.usage);
      out.push({
        width: t.width,
        height: t.height,
        format: t.format,
        label: typeof t.label === 'string' ? t.label : null,
        usage,
        attachment: usage === null ? null : (usage & RENDER_ATTACHMENT) !== 0,
        key,
      });
      return out;
    }
    if (t instanceof Map) for (const item of t.values()) texturesOf(item, out, depth + 1, key);
    else if (Array.isArray(t)) for (const item of t) texturesOf(item, out, depth + 1, key);
    else if (isPlain(t)) for (const k of Object.keys(t)) texturesOf(t[k], out, depth + 1, k);
    return out;
  };
  const plugin = (p) => ({
    name: String(p.name),
    enabled: typeof p.enabled === 'boolean' ? p.enabled : null,
    options: plain(p.options ?? p.settings),
    textures: texturesOf(p.textures),
    ...(Array.isArray(p.effects) || (p.effects && typeof p.effects.length === 'number')
      ? { effects: Array.from(p.effects, plugin) }
      : {}),
  });

  const L = engine.scene.lighting,
    sunColour = list(L.radiance.subarray(0, 3)),
    ambientColour = list(L.ambient);
  const lights = [
    {
      kind: 'sun',
      label: 'sun',
      direction: list(L.direction.subarray(0, 3)),
      intensity: finite(L.direction[3]),
      colour: sunColour,
      temperature: kelvin(sunColour),
    },
    {
      kind: 'ambient',
      label: 'ambient',
      intensity: finite(L.radiance[3]),
      colour: ambientColour,
      temperature: kelvin(ambientColour.map((c, i) => c * sunColour[i])),
    },
  ];
  // Local lights: every plugin that lists its point and spot lights (`list`, as Clustered keeps the lights last given
  // to setLights). Intensity is luminous intensity in candela (clustered/units, glTF KHR_lights_punctual); decay 2 is
  // inverse square, the package default.
  for (const p of engine.scene.plugins.values()) {
    let given = null;
    try {
      given = p.list;
    } catch {
      given = null;
    }
    if (!Array.isArray(given)) continue;
    given.forEach((l, i) => {
      if (!l || typeof l !== 'object' || !l.position) return;
      const colour = list(l.color ?? [1, 1, 1]),
        spot = !!l.direction;
      lights.push({
        kind: spot ? 'spot' : 'point',
        label: `${String(p.name)} ${i}`,
        plugin: String(p.name),
        position: list(l.position),
        direction: spot ? list(l.direction) : null,
        outerAngle: spot ? finite(l.outerAngle ?? l.angle ?? null) : null,
        range: finite(l.range),
        intensity: finite(l.intensity ?? 1),
        units: 'candela',
        decay: finite(l.decay ?? 2),
        radius: finite(l.radius ?? 0),
        // shadowed by LocalShadows (`castShadow`) or by Clustered's integrated maps (`shadow`)
        castShadow: !!(l.castShadow || l.shadow),
        colour,
        temperature: kelvin(colour),
      });
    });
  }

  // Materials by identity: core PbrMaterial (data: rgb, alpha, roughness, metalness, double-sided) or a glTF material.
  const materials = [],
    materialId = new Map(),
    slots = ['baseColor', 'metallicRoughness', 'normal', 'occlusion', 'emissive'];
  const coreMaterial = (m) => ({
    kind: 'core',
    name: null,
    colour: list(m.data.subarray(0, 3)),
    roughness: finite(m.data[4]),
    metalness: finite(m.data[5]),
    doubleSided: !!m.data[6],
    alphaMode: 'OPAQUE',
    ior: 1.5,
    specular: 1,
    extensions: [],
    maps: [],
  });
  const gltfMaterial = (m, model) => {
    const p = m.pbrMetallicRoughness ?? {},
      e = m.extensions ?? {},
      textures = model?.textures ?? [];
    const maps = [];
    (m.maps ?? []).slice(0, 5).forEach((info, i) => {
      if (!info) return;
      const t = textures[info.index];
      const scale = info.extensions?.KHR_texture_transform?.scale;
      maps.push({
        slot: slots[i],
        index: finite(info.index),
        // KHR_texture_transform's repeat of this map over its texture coordinates (1, 1 without the extension).
        scale: Array.isArray(scale) ? list(scale) : [1, 1],
        width: finite(t?.width),
        height: finite(t?.height),
        format: typeof t?.format === 'string' ? t.format : null,
        label: typeof t?.label === 'string' ? t.label : null,
      });
    });
    return {
      kind: 'gltf',
      name: typeof m.name === 'string' ? m.name : null,
      // The live values the model draws with (base, factors, settings, ext, physical), else the glTF document's.
      colour: list(m.base ?? p.baseColorFactor ?? [1, 1, 1, 1]),
      roughness: finite(m.factors?.[0] ?? p.roughnessFactor ?? 1),
      metalness: finite(m.factors?.[1] ?? p.metallicFactor ?? 1),
      doubleSided: m.settings ? m.settings[2] >= 0.5 && m.settings[2] !== 2 : !!m.doubleSided,
      alphaMode: m.settings ? (['OPAQUE', 'MASK', 'BLEND'][m.settings[0]] ?? null) : (m.alphaMode ?? 'OPAQUE'),
      ior: finite(m.ext?.[1] ?? e.KHR_materials_ior?.ior ?? 1.5),
      specular: finite(m.physical?.[7] ?? e.KHR_materials_specular?.specularFactor ?? 1),
      extensions: Object.keys(e).sort(),
      maps,
    };
  };
  const materialOf = (m, model) => {
    if (!m) return null;
    if (!materialId.has(m)) {
      materialId.set(m, materials.length);
      materials.push(
        m.data instanceof Float32Array && !m.pbrMetallicRoughness ? coreMaterial(m) : gltfMaterial(m, model),
      );
    }
    return materialId.get(m);
  };

  // Local bounds of a core geometry, kept per geometry.
  const local = new Map();
  const geometryBounds = (g) => {
    if (!local.has(g)) {
      const v = g.vertices,
        b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
      for (let i = 0; i < v.length; i += 6)
        for (let a = 0; a < 3; a++) {
          if (v[i + a] < b[a]) b[a] = v[i + a];
          if (v[i + a] > b[a + 3]) b[a + 3] = v[i + a];
        }
      local.set(g, b);
    }
    return local.get(g);
  };
  const world = (b, m) => {
    if (!b || !(b[0] <= b[3]) || !m || m.length < 16) return null;
    const out = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let c = 0; c < 8; c++) {
      const x = c & 1 ? b[3] : b[0],
        y = c & 2 ? b[4] : b[1],
        z = c & 4 ? b[5] : b[2];
      for (let a = 0; a < 3; a++) {
        const w = m[a] * x + m[4 + a] * y + m[8 + a] * z + m[12 + a];
        if (w < out[a]) out[a] = w;
        if (w > out[a + 3]) out[a + 3] = w;
      }
    }
    return out.every(Number.isFinite) ? out : null;
  };
  // Open edges: edges of exactly one triangle, with vertices welded by position (a UV or normal seam splits vertices
  // but not the surface). `parts` is [[vertices, stride, indices]]; null over OPEN_EDGE_TRIANGLES (not measured).
  const OPEN_EDGE_TRIANGLES = 2_000_000;
  const openEdges = (parts) => {
    if (parts.reduce((n, [, , idx]) => n + idx.length / 3, 0) > OPEN_EDGE_TRIANGLES) return null;
    const weld = new Map(),
      edges = new Map();
    let base = 0;
    const id = (v, stride, i) => {
      const k = `${v[i * stride]},${v[i * stride + 1]},${v[i * stride + 2]}`;
      if (!weld.has(k)) weld.set(k, base++);
      return weld.get(k);
    };
    for (const [v, stride, idx] of parts)
      for (let t = 0; t + 2 < idx.length; t += 3) {
        const a = id(v, stride, idx[t]),
          b = id(v, stride, idx[t + 1]),
          c = id(v, stride, idx[t + 2]);
        for (const [x, y] of [
          [a, b],
          [b, c],
          [c, a],
        ]) {
          if (x === y) continue;
          const k = x < y ? x * 4294967296 + y : y * 4294967296 + x;
          edges.set(k, (edges.get(k) ?? 0) + 1);
        }
      }
    let open = 0;
    for (const n of edges.values()) if (n === 1) open++;
    return open;
  };
  // The URL path a model was loaded from (its asset's base URL), decoded, when it is on the page's own origin.
  const fileOf = (model) => {
    const href = model?.asset?.baseURL;
    if (typeof href !== 'string') return null;
    try {
      const url = new URL(href),
        here = globalThis.location?.origin;
      return url.origin === here ? decodeURIComponent(url.pathname) : url.href;
    } catch {
      return href;
    }
  };
  // The levels of every LOD a model holds (MSFT_lod), so a mesh knows how many levels it draws from.
  const levelsOf = new Map();
  const meshes = [];
  for (const mesh of engine.scene.meshes.values()) {
    let source = null;
    try {
      source = sources?.get(mesh) ?? null;
    } catch {
      source = null;
    }
    const model = source?.model && !source.model.disposed ? source.model : null;
    if (model && !levelsOf.has(model))
      for (const lod of model.lods ?? []) for (const level of lod.levels ?? []) levelsOf.set(level, lod.levels.length);
    let triangles = 0,
      vertices = 0,
      bounds = null,
      tangents = null,
      mats = [],
      uvSpan = null,
      vertexColours = null,
      open = null;
    if (mesh.geometry) {
      triangles = mesh.geometry.indices.length / 3;
      vertices = mesh.geometry.vertices.length / 6;
      bounds = vertices ? geometryBounds(mesh.geometry) : null;
      mats = [materialOf(mesh.material)];
      open = openEdges([[mesh.geometry.vertices, 6, mesh.geometry.indices]]);
    } else if (model) {
      const primitives = source.primitives ?? [];
      // Texture coordinate 0 (floats 12 and 13 of a packed vertex): its span is how often a map repeats over the mesh.
      const uv = [Infinity, Infinity, -Infinity, -Infinity];
      for (const p of primitives) {
        const count = p.instances?.count ?? 1;
        triangles += (p.indices.length / 3) * count;
        vertices += p.vertices.length / 20;
        if (p.definition?.attributes?.TEXCOORD_0 !== undefined)
          for (let i = 12; i < p.vertices.length; i += 20) {
            uv[0] = Math.min(uv[0], p.vertices[i]);
            uv[1] = Math.min(uv[1], p.vertices[i + 1]);
            uv[2] = Math.max(uv[2], p.vertices[i]);
            uv[3] = Math.max(uv[3], p.vertices[i + 1]);
          }
      }
      uvSpan = uv[2] >= uv[0] ? [uv[2] - uv[0], uv[3] - uv[1]] : null;
      vertexColours = primitives.some((p) => p.definition?.attributes?.COLOR_0 !== undefined);
      bounds = Array.from(source.bounds ?? []);
      // A primitive's tangents: its own TANGENT attribute (glTF 2.0 3.7.2.1), or none needed without a normal map.
      tangents = primitives.every((p) => p.definition?.attributes?.TANGENT !== undefined || !p.material?.normalTexture);
      mats = [...new Set(primitives.map((p) => materialOf(p.material, model)))];
      open = openEdges(primitives.map((p) => [p.vertices, 20, p.indices]));
    } else continue; // a group node: no geometry of its own (a glTF node without a mesh, a model's root)
    const box = world(bounds, mesh.matrix);
    let under = null;
    if (box && typeof ground === 'function') {
      const cx = (box[0] + box[3]) / 2,
        cz = (box[2] + box[5]) / 2,
        dx = Math.min(step, (box[3] - box[0]) / 2),
        dz = Math.min(step, (box[5] - box[2]) / 2);
      under = [
        [cx, cz],
        [cx - dx, cz - dz],
        [cx + dx, cz - dz],
        [cx - dx, cz + dz],
        [cx + dx, cz + dz],
      ].map(([x, z]) => finite(ground(x, z)));
    }
    meshes.push({
      name: typeof mesh.name === 'string' ? mesh.name : '',
      visible: !!mesh.visible,
      kind: mesh.geometry ? 'core' : 'model',
      model: model ? String(model.name) : null,
      file: fileOf(model),
      triangles,
      vertices,
      instances: model ? Math.max(1, ...(source.primitives ?? []).map((p) => p.instances?.count ?? 1)) : 1,
      lods: levelsOf.get(mesh) ?? 1,
      tangents,
      materials: mats,
      uvSpan,
      vertexColours,
      openEdges: open,
      bounds: box,
      ground: under,
    });
  }
  const stats = engine.scene.stats ?? engine.stats ?? {};
  return {
    version: 2,
    drawCalls: finite(stats.drawCalls),
    visible: finite(stats.visible),
    lights,
    plugins: [...engine.scene.plugins.values()].map(plugin),
    materials,
    meshes,
  };
}
