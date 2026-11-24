// The scene record of a shot's measure (docs/shots.md, Measure, "scene"): what a film pipeline's scene audit judges,
// read from the page engine's own scene graph after the warm-up, never from a per-page report. Lights (the scene's sun
// and ambient, the colour temperature of each by McCamy's formula), every attached plugin with its options (post
// effects inside a PostStack included), every mesh (triangles, vertices, LOD levels, world bounds, the ground under
// its base), every material (glTF metal-rough values, alpha mode, sides, IOR and specular, the extensions that give
// clear coat, sheen or transmission, the tangents of its primitives and the size and format of each map) and the
// frame's draw count. A value the graph does not hold is null, so a judge reads it as unknown.
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
  // A plugin's settings: its options (or settings) object's plain values, one level deep.
  const plain = (o) => {
    if (!o || typeof o !== 'object') return null;
    const out = {};
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (typeof v === 'function') out[k] = 'function';
      else if (typeof v === 'number') out[k] = finite(v);
      else if (typeof v === 'string' || typeof v === 'boolean') out[k] = v;
      else if (v && typeof v.length === 'number' && v.length <= 16 && Array.from(v).every((x) => typeof x === 'number'))
        out[k] = list(v);
      else if (v && typeof v === 'object' && !ArrayBuffer.isView(v) && Object.getPrototypeOf(v) === Object.prototype) {
        const inner = {};
        for (const j of Object.keys(v))
          if (['number', 'string', 'boolean'].includes(typeof v[j]))
            inner[j] = typeof v[j] === 'number' ? finite(v[j]) : v[j];
        out[k] = inner;
      }
    }
    return out;
  };
  // The GPU textures a plugin keeps in its `textures` field (an array or a map, nested maps too): size and format.
  const texturesOf = (t, out = [], depth = 0) => {
    if (!t || typeof t !== 'object' || depth > 3) return out;
    if (typeof t.width === 'number' && typeof t.format === 'string') {
      out.push({
        width: t.width,
        height: t.height,
        format: t.format,
        label: typeof t.label === 'string' ? t.label : null,
      });
      return out;
    }
    const items = t instanceof Map ? [...t.values()] : Array.isArray(t) ? t : [];
    for (const item of items) texturesOf(item, out, depth + 1);
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
      maps.push({
        slot: slots[i],
        index: finite(info.index),
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
      mats = [];
    if (mesh.geometry) {
      triangles = mesh.geometry.indices.length / 3;
      vertices = mesh.geometry.vertices.length / 6;
      bounds = vertices ? geometryBounds(mesh.geometry) : null;
      mats = [materialOf(mesh.material)];
    } else if (model) {
      const primitives = source.primitives ?? [];
      for (const p of primitives) {
        const count = p.instances?.count ?? 1;
        triangles += (p.indices.length / 3) * count;
        vertices += p.vertices.length / 20;
      }
      bounds = Array.from(source.bounds ?? []);
      // A primitive's tangents: its own TANGENT attribute (glTF 2.0 3.7.2.1), or none needed without a normal map.
      tangents = primitives.every((p) => p.definition?.attributes?.TANGENT !== undefined || !p.material?.normalTexture);
      mats = [...new Set(primitives.map((p) => materialOf(p.material, model)))];
    } else continue;
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
      triangles,
      vertices,
      instances: model ? Math.max(1, ...(source.primitives ?? []).map((p) => p.instances?.count ?? 1)) : 1,
      lods: levelsOf.get(mesh) ?? 1,
      tangents,
      materials: mats,
      bounds: box,
      ground: under,
    });
  }
  const stats = engine.scene.stats ?? engine.stats ?? {};
  return {
    version: 1,
    drawCalls: finite(stats.drawCalls),
    visible: finite(stats.visible),
    lights,
    plugins: [...engine.scene.plugins.values()].map(plugin),
    materials,
    meshes,
  };
}
