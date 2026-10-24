import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Reference results for createMTLMaterials / prepareOBJMesh / loadOBJ, checked against a recording stand-in of
// @margoengine/materials: its Material keeps the options it was built with, its slots, bumpScale and UV transforms.
// Run with --experimental-test-module-mocks.
const vectors = JSON.parse(readFileSync(new URL('./fixtures/mtl-vectors.json', import.meta.url), 'utf8'));

class Texture {
  disposed = false;
  constructor(url, options) {
    this.url = url;
    this.options = options;
  }
  dispose() {
    this.disposed = true;
  }
}
class Material {
  map = null;
  alphaMap = null;
  bumpMap = null;
  normalMap = null;
  emissiveMap = null;
  bumpScale = 1;
  uvTransforms = [];
  disposed = false;
  constructor(options = {}) {
    this.options = options;
  }
  setUVTransform(t, slot) {
    this.uvTransforms.push({ slot, offset: t.offset, scale: t.scale });
    return this;
  }
  dispose() {
    this.disposed = true;
  }
}
const meshCalls = [];
function createMesh(engine, geometry, materials, options) {
  if (engine?.fail) throw new TypeError('stand-in engine cannot draw');
  const mesh = { geometry, materials, options, destroyed: false, destroy: () => (mesh.destroyed = true) };
  meshCalls.push(mesh);
  return mesh;
}
mock.module('@margoengine/materials', {
  namedExports: {
    Material,
    Texture,
    createMesh,
    loadTexture: async () => {
      throw new Error('pass loadTexture');
    },
  },
});
const { createMTLMaterials, prepareOBJMesh, loadOBJ } = await import('../dist/mtl.js');
const { parseMTL, parseOBJ, LoaderError } = await import('../dist/index.js');

function recorder() {
  const requests = [];
  const load = async (url, options) => {
    requests.push({ url, colorSpace: options.colorSpace, wrapS: options.wrapS, wrapT: options.wrapT });
    if (url.includes('missing')) throw new Error('404');
    return new Texture(url, options);
  };
  return { requests, load };
}

function near(actual, expected, label) {
  if (Array.isArray(expected) || ArrayBuffer.isView(expected)) {
    assert.equal(actual.length, expected.length, `${label} length`);
    for (let i = 0; i < expected.length; i++) near(actual[i], expected[i], `${label}[${i}]`);
  } else if (typeof expected === 'number')
    assert.ok(Math.abs(actual - expected) <= 1e-6, `${label}: ${actual} != ${expected}`);
  else if (expected && typeof expected === 'object') {
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), `${label} keys`);
    for (const key of Object.keys(expected)) near(actual[key], expected[key], `${label}.${key}`);
  } else assert.equal(actual, expected, label);
}

/** The subject of a warning: its first word, plus the URL for texture failures. */
const subject = (w) => (w.startsWith('texture ') ? w.split(' ').slice(0, 2).join(' ') : w.split(' ')[0]);
function sameWarnings(actual, expected, label) {
  assert.deepEqual(actual.map(subject).sort(), expected.map(subject).sort(), `${label} warnings ${actual}`);
}

const BASE = 'https://example.com/models/scene.mtl';
const caseOptions = {
  'bad-bump-option': { bump: 'height map' },
  'relative-base-url-with-maps': { baseUrl: 'relative/a.mtl' },
};

test('createMTLMaterials: reference material options, slots, UV transforms, requests and warnings', async () => {
  for (const c of vectors.cases) {
    const { requests, load } = recorder(),
      options = { baseUrl: BASE, ...(caseOptions[c.name] ?? c.options), loadTexture: load },
      run = createMTLMaterials(parseMTL(c.mtl), options);
    if (c.throws) {
      await assert.rejects(run, globalThis[c.throws.name], c.name);
      continue;
    }
    const set = await run;
    assert.deepEqual([...set.materials.keys()], Object.keys(c.materials), `${c.name} names`);
    for (const [name, e] of Object.entries(c.materials)) {
      const m = set.materials.get(name),
        label = `${c.name}/${name}`;
      near(m.options, e.options, `${label} options`);
      const slots = {};
      for (const slot of Object.keys(e.slots)) slots[slot] = m[slot] ? m[slot].url : null;
      assert.deepEqual(slots, e.slots, `${label} slots`);
      assert.equal(m.bumpScale, e.bumpScale, `${label} bumpScale`);
      assert.deepEqual(m.uvTransforms, e.uvTransforms, `${label} uvTransforms`);
    }
    assert.deepEqual(requests, c.requests, `${c.name} requests`);
    assert.equal(set.textures.length, c.textureCount, `${c.name} textures`);
    sameWarnings(set.warnings, c.warnings, c.name);
    set.dispose();
    for (const m of set.materials.values()) assert.ok(m.disposed);
    for (const t of set.textures) assert.ok(t.disposed);
  }
});

test('createMTLMaterials: reference argument and abort errors; abort disposes what was built', async () => {
  const [stringInput, notFunction, abort] = vectors.argErrors;
  await assert.rejects(createMTLMaterials('newmtl a'), globalThis[stringInput.throws]);
  await assert.rejects(createMTLMaterials([], { loadTexture: 'x' }), globalThis[notFunction.throws]);
  const controller = new AbortController(),
    late = [];
  const run = createMTLMaterials(parseMTL('newmtl a\nmap_Kd x.png\nnewmtl b\nmap_Kd y.png\n'), {
    baseUrl: BASE,
    signal: controller.signal,
    // x.png arrives at once, y.png never settles: the abort must not wait for it.
    loadTexture: async (url) => {
      if (url.endsWith('y.png')) return new Promise(() => {});
      const t = new Texture(url);
      late.push(t);
      return t;
    },
  });
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(run, (e) => e instanceof LoaderError && e.code === abort.code);
  assert.ok(late.length === 1 && late[0].disposed, 'a texture that arrived is disposed on abort');
});

const fakeOBJ = (positions, indices, positionIndices, extra = {}) => ({
  kind: 'mesh',
  positions: Float32Array.from(positions),
  indices: Uint32Array.from(indices),
  positionIndices: Uint32Array.from(positionIndices),
  groups: [],
  warnings: [],
  ...extra,
});

test('prepareOBJMesh: reference slots, groups, UVs, normals, colours, sharing and smooth normals', async () => {
  const v = vectors.objVectors,
    obj = await parseOBJ(v.obj, { resolve: async () => v.lib }),
    { requests, load } = recorder(),
    set = await createMTLMaterials(obj.materials, {
      baseUrl: 'https://example.com/models/scene.obj',
      loadTexture: load,
    });
  assert.deepEqual(
    requests.map((r) => r.url),
    v.requests,
  );
  const fallback = new Material(),
    { geometry, materials } = prepareOBJMesh(obj, set, { fallback });
  const names = new Map([...set.materials].map(([n, m]) => [m, n]).concat([[fallback, 'fallback']]));
  assert.deepEqual(
    materials.map((m) => names.get(m)),
    v.materialsInSlotOrder,
  );
  assert.deepEqual(geometry.groups, v.groups);
  near(geometry.uvs, v.uvs, 'uvs');
  near(obj.uvs, v.objUvs, 'obj uvs untouched');
  near(geometry.normals, v.normals, 'normals');
  near(geometry.colors, v.colors, 'colors');
  assert.deepEqual([...obj.positionIndices], v.positionIndices);
  assert.equal(geometry.indices === obj.indices, v.sharesIndices);
  assert.equal(geometry.positions === obj.positions, v.sharesPositions);
  const plain = prepareOBJMesh(obj, new Map([['red', set.materials.get('red')]]));
  assert.equal(plain.materials.length, v.plainSlotCount);
  assert.deepEqual(plain.materials[1].options, v.plainFallbackOptions);
  assert.deepEqual(
    plain.geometry.groups.map((g) => g.materialIndex),
    v.plainGroups,
  );
  // Two triangles bent along an edge, a UV seam at position 0 (vertices 0, 3, 5) and a degenerate triangle.
  const bent = fakeOBJ([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0], v.bentIndices, v.bentPositionIndices);
  near(prepareOBJMesh(bent, new Map()).geometry.normals, v.bentNormals, 'smooth normals');
  const given = fakeOBJ([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2], [0, 1, 2], {
    normals: Float32Array.from([0, 0, 2, 0, 0, 0, 0, 0, 5]),
  });
  near(prepareOBJMesh(given, new Map()).geometry.normals, v.givenNormalsNormalised, 'given normals');
  const noGroups = fakeOBJ([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2, 0, 1, 2, 0, 1, 2], [0, 1, 2]);
  assert.deepEqual(prepareOBJMesh(noGroups, new Map()).geometry.groups, v.noGroupsObj);
  // Every normal is unit length.
  const n = prepareOBJMesh(bent, new Map()).geometry.normals;
  for (let i = 0; i < n.length; i += 3) near(Math.hypot(n[i], n[i + 1], n[i + 2]), 1, 'unit normal');
  set.dispose();
});

test('prepareOBJMesh / loadOBJ: reference errors, fetch order, cleanup on mesh failure, dispose', async () => {
  const v = vectors.loadVectors,
    o = vectors.objVectors,
    files = { 'https://example.com/models/scene.obj': o.obj, 'https://example.com/models/mats/lib.mtl': o.lib },
    fetched = [];
  const fetch = async (url) => {
    fetched.push(String(url));
    return files[String(url)] === undefined ? new Response('', { status: 404 }) : new Response(files[String(url)]);
  };
  const errors = Object.fromEntries(vectors.meshErrors.map((e) => [e.label, e]));
  const cloud = await parseOBJ('v 0 0 0\nv 1 0 0\n');
  assert.throws(
    () => prepareOBJMesh(cloud, new Map()),
    (e) => e instanceof LoaderError && e.code === errors['point cloud'].code,
  );
  assert.throws(
    () => prepareOBJMesh(fakeOBJ([0, 0, 0], [0, 0, 0], [0]), {}),
    globalThis[errors['materials {}'].throws],
  );
  assert.throws(
    () => prepareOBJMesh(null, new Map()),
    (e) => e instanceof LoaderError && e.code === errors['null obj'].code,
  );

  let { requests, load } = recorder();
  const loaded = await loadOBJ({}, 'https://example.com/models/scene.obj', {
    fetch,
    loadTexture: load,
    renderOrder: 3,
  });
  assert.deepEqual(fetched, v.fetched.slice(0, 2));
  assert.deepEqual(requests, v.textureRequests);
  sameWarnings(loaded.warnings, v.warnings, 'loadOBJ');
  assert.deepEqual({ renderOrder: loaded.mesh.options.renderOrder }, v.meshOptions);
  assert.equal(loaded.mesh.materials.length, v.slotCount);
  assert.deepEqual(loaded.mesh.geometry.groups, v.groups);
  const fallback = loaded.mesh.materials[2];
  loaded.dispose();
  assert.ok(loaded.mesh.destroyed);
  assert.deepEqual(
    [...loaded.materials.materials.values()].map((m) => m.disposed),
    v.disposedAfter.materials,
  );
  assert.equal(fallback.disposed, v.disposedAfter.fallbackMadeByLoadOBJ);
  assert.deepEqual(
    loaded.materials.textures.map((t) => t.disposed),
    v.disposedAfter.textures,
  );

  // The mesh fails: every texture, material and the fallback loadOBJ made are disposed; a caller's fallback is kept.
  ({ requests, load } = recorder());
  const made = [];
  const keep = new Material();
  await assert.rejects(
    loadOBJ({ fail: true }, 'https://example.com/models/scene.obj', {
      fetch,
      loadTexture: async (url, options) => {
        const t = await load(url, options);
        made.push(t);
        return t;
      },
      fallback: keep,
    }),
    TypeError,
  );
  assert.equal(made.length, 2);
  assert.ok(made.every((t) => t.disposed));
  assert.equal(keep.disposed, false);

  fetched.length = 0;
  await assert.rejects(
    loadOBJ({}, 'https://example.com/models/none.obj', { fetch }),
    (e) => e instanceof LoaderError && e.code === errors['404 obj'].code,
  );
  assert.deepEqual(fetched, v.fetched.slice(2));
  await assert.rejects(loadOBJ({}, 'relative.obj'), globalThis[errors['relative url without page'].throws]);

  // A library that cannot be read becomes warnings, not an error.
  const lonely = await loadOBJ({}, 'https://example.com/models/scene.obj', {
    fetch: async (url) => (String(url).endsWith('.obj') ? new Response(o.obj) : new Response('', { status: 404 })),
    loadTexture: recorder().load,
  });
  sameWarnings(lonely.warnings, v.missingLibraryWarnings, 'missing library');
  lonely.dispose();
});
