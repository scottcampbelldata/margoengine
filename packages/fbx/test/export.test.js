// exportFBX round trips through the package's own importer: every file written here is read back with convertFBX and
// compared on the GLB accessors. Fixtures are built in the test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { exportFBX } from '../dist/export.js';
import { convertFBX } from '../dist/index.js';

function readGLB(buffer) {
  const view = new DataView(buffer),
    jsonLength = view.getUint32(12, true),
    json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, jsonLength))),
    binary = 28 + jsonLength;
  const accessor = (index) => {
    const a = json.accessors[index],
      b = json.bufferViews[a.bufferView],
      size = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[a.type],
      kinds = { 5126: Float32Array, 5125: Uint32Array, 5123: Uint16Array, 5121: Uint8Array },
      Kind = kinds[a.componentType],
      out = new Kind(a.count * size),
      data = new DataView(buffer, binary + (b.byteOffset ?? 0) + (a.byteOffset ?? 0));
    const stride = b.byteStride ?? size * Kind.BYTES_PER_ELEMENT;
    for (let i = 0; i < a.count; i++)
      for (let k = 0; k < size; k++) {
        const at = i * stride + k * Kind.BYTES_PER_ELEMENT;
        out[i * size + k] =
          Kind === Float32Array
            ? data.getFloat32(at, true)
            : Kind === Uint32Array
              ? data.getUint32(at, true)
              : Kind === Uint16Array
                ? data.getUint16(at, true)
                : data.getUint8(at);
      }
    return out;
  };
  return { json, accessor };
}
const close = (actual, expected, message, tolerance = 1e-5) => {
  assert.equal(actual.length, expected.length, `${message}: length`);
  for (let i = 0; i < actual.length; i++)
    assert.ok(
      Math.abs(actual[i] - expected[i]) <= tolerance * Math.max(1, Math.abs(expected[i])),
      `${message}[${i}]: ${actual[i]} vs ${expected[i]}`,
    );
};
/** Triangle corners as sorted text, so vertex order and splitting do not matter. */
function cornerSet(positions, normals, uvs, indices, round = 4) {
  const out = [];
  for (const v of indices) {
    const item = [
      ...positions.slice(v * 3, v * 3 + 3),
      ...normals.slice(v * 3, v * 3 + 3),
      ...(uvs ? uvs.slice(v * 2, v * 2 + 2) : []),
    ];
    out.push(item.map((x) => (x + 0).toFixed(round).replace(/^-0\.0+$/, (m) => m.slice(1))).join());
  }
  return out.sort();
}
const quad = () => ({
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
  uvs: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]),
  indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
});
const forms = [
  ['binary', false],
  ['ascii', true],
];
const convert = async (scene, ascii, options = {}) => {
  const { fbx } = await exportFBX(scene, { ascii, ...options });
  return readGLB(await convertFBX(fbx));
};

for (const [form, ascii] of forms) {
  test(`${form}: mesh positions, indices, normals and UVs come back within float32`, async () => {
    const geometry = quad(),
      { json, accessor } = await convert(
        { nodes: [{ name: 'Quad', translation: [1, 2, 3], scale: [2, 2, 2], geometry }] },
        ascii,
      ),
      node = json.nodes.find((n) => n.name === 'Quad'),
      attributes = json.meshes[node.mesh].primitives[0];
    close(node.translation, [1, 2, 3], 'translation');
    close(node.scale, [2, 2, 2], 'scale');
    const back = attributes.attributes,
      got = cornerSet(
        accessor(back.POSITION),
        accessor(back.NORMAL),
        accessor(back.TEXCOORD_0),
        accessor(attributes.indices),
      ),
      want = cornerSet(geometry.positions, geometry.normals, geometry.uvs, geometry.indices);
    assert.deepEqual(got, want);
  });

  test(`${form}: node clips come back at their key times, with the slerp between keys kept`, async () => {
    const root = { name: 'Root', children: [] },
      child = { name: 'Child', translation: [0, 1, 0], geometry: quad() },
      s = Math.SQRT1_2;
    root.children = [child];
    const rotation = new Float32Array([0, 0, 0, 1, s, 0, 0, s, s, s * 0, s, 0]),
      { json, accessor } = await convert(
        {
          nodes: [root],
          animations: [
            {
              name: 'Walk',
              channels: [
                {
                  node: child,
                  path: 'translation',
                  times: new Float32Array([0, 1]),
                  values: new Float32Array([0, 1, 0, 2, 3, 4]),
                },
                { node: child, path: 'rotation', times: new Float32Array([0, 1, 2]), values: rotation },
              ],
            },
          ],
        },
        ascii,
      );
    const clip = json.animations[0];
    assert.equal(clip.name, 'Walk');
    const nodeIndex = json.nodes.findIndex((n) => n.name === 'Child');
    const channel = (path) => {
      const found = clip.channels.find((c) => c.target.node === nodeIndex && c.target.path === path);
      assert.ok(found, `${path} channel`);
      const sampler = clip.samplers[found.sampler];
      return { times: accessor(sampler.input), values: accessor(sampler.output) };
    };
    const translation = channel('translation');
    const atKey = (track, time, width) => {
      const i = [...track.times].findIndex((t) => Math.abs(t - time) < 1e-5);
      assert.ok(i >= 0, `key at ${time}`);
      return [...track.values.slice(i * width, i * width + width)];
    };
    close(atKey(translation, 0, 3), [0, 1, 0], 'translation at 0');
    close(atKey(translation, 1, 3), [2, 3, 4], 'translation at 1');
    const turn = channel('rotation'),
      same = (a, b) => assert.ok(Math.abs(Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]) - 1) < 1e-6);
    same(atKey(turn, 0, 4), [0, 0, 0, 1]);
    same(atKey(turn, 1, 4), [s, 0, 0, s]);
    same(atKey(turn, 2, 4), [s, 0, s, 0]);
    // Between keys 1 and 2 the turn is about a tilted axis: straight Euler lines would leave the arc.
    const expected = (alpha) => {
      const angle = Math.PI / 3,
        x = Math.sin((1 - alpha) * angle) / Math.sin(angle),
        y = Math.sin(alpha * angle) / Math.sin(angle);
      return [s * x + s * y, 0, s * y, s * x];
    };
    const samples = [...turn.times].map((t, i) => [t, i]).filter(([t]) => t > 1 && t < 2);
    assert.ok(samples.length, 'keys added between the rotation keys');
    for (const [t, i] of samples) {
      const got = turn.values.slice(i * 4, i * 4 + 4),
        want = expected(t - 1);
      assert.ok(
        Math.abs(Math.abs(got[0] * want[0] + got[1] * want[1] + got[2] * want[2] + got[3] * want[3]) - 1) < 1e-5,
      );
    }
  });

  test(`${form}: skins keep joints, weights and bind matrices`, async () => {
    const hip = { name: 'Hip', translation: [0, 1, 0] },
      knee = { name: 'Knee', translation: [0, 1, 0] };
    hip.children = [knee];
    const geometry = {
        positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 2, 0]),
        normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
        indices: new Uint32Array([0, 1, 2]),
        joints: new Uint16Array([0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0]),
        weights: new Float32Array([1, 0, 0, 0, 0.25, 0.75, 0, 0, 1, 0, 0, 0]),
      },
      inverseBindMatrices = new Float32Array([
        1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -1, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -2, 0, 1,
      ]),
      mesh = { name: 'Leg', geometry, skin: { name: 'Rig', joints: [hip, knee], inverseBindMatrices } },
      { json, accessor } = await convert({ nodes: [hip, mesh] }, ascii),
      skin = json.skins[0];
    assert.deepEqual(
      skin.joints.map((j) => json.nodes[j].name),
      ['Hip', 'Knee'],
    );
    close(accessor(skin.inverseBindMatrices), inverseBindMatrices, 'inverse bind');
    const primitive = json.meshes[json.nodes.find((n) => n.name === 'Leg').mesh].primitives[0],
      positions = accessor(primitive.attributes.POSITION),
      joints = accessor(primitive.attributes.JOINTS_0),
      weights = accessor(primitive.attributes.WEIGHTS_0);
    for (let v = 0; v < positions.length / 3; v++) {
      const original = [0, 1, 2].find(
        (o) =>
          Math.abs(geometry.positions[o * 3] - positions[v * 3]) < 1e-5 &&
          Math.abs(geometry.positions[o * 3 + 1] - positions[v * 3 + 1]) < 1e-5,
      );
      const want = new Map();
      for (let k = 0; k < 4; k++)
        if (geometry.weights[original * 4 + k])
          want.set(geometry.joints[original * 4 + k], geometry.weights[original * 4 + k]);
      for (let k = 0; k < 4; k++)
        if (weights[v * 4 + k]) assert.ok(Math.abs(want.get(joints[v * 4 + k]) - weights[v * 4 + k]) < 1e-5);
    }
  });

  test(`${form}: morph targets and animated weights come back`, async () => {
    const geometry = {
        ...quad(),
        morphs: [{ name: 'Up', positions: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0]) }],
      },
      node = { name: 'Face', geometry, morphWeights: [0.25] },
      { json, accessor } = await convert(
        {
          nodes: [node],
          animations: [
            {
              name: 'Blink',
              channels: [{ node, path: 'weights', times: new Float32Array([0, 1]), values: new Float32Array([0, 1]) }],
            },
          ],
        },
        ascii,
      );
    const out = json.nodes.find((n) => n.name === 'Face'),
      primitive = json.meshes[out.mesh].primitives[0];
    close(out.weights ?? json.meshes[out.mesh].weights, [0.25], 'weights');
    const deltas = accessor(primitive.targets[0].POSITION),
      positions = accessor(primitive.attributes.POSITION);
    for (let v = 0; v < positions.length / 3; v++)
      assert.equal(deltas[v * 3 + 2], positions[v * 3 + 1] === 0 ? 1 : 0, `delta of vertex ${v}`);
    const clip = json.animations[0],
      sampler = clip.samplers[clip.channels[0].sampler];
    assert.equal(clip.channels[0].target.path, 'weights');
    close(accessor(sampler.output), [0, 1], 'weight keys');
  });

  test(`${form}: multi-material nodes, Phong values and embedded textures come back`, async () => {
    const image = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]),
      red = {
        name: 'Red',
        color: [1, 0, 0, 0.5],
        roughness: 0.5,
        alphaMode: 'BLEND',
        baseColorTexture: { image, mimeType: 'image/png', name: 'skin' },
      },
      blue = { name: 'Blue', color: [0, 0, 1, 1], roughness: 1 },
      geometry = quad(),
      { json, accessor } = await convert(
        {
          nodes: [
            {
              name: 'Two',
              primitives: [
                { geometry: { ...geometry, indices: new Uint32Array([0, 1, 2]) }, material: red },
                { geometry: { ...geometry, indices: new Uint32Array([0, 2, 3]) }, material: blue },
              ],
            },
          ],
        },
        ascii,
      );
    const names = json.materials.map((m) => m.name).sort();
    assert.deepEqual(names, ['Blue', 'Red']);
    const material = json.materials.find((m) => m.name === 'Red');
    close(material.pbrMetallicRoughness.baseColorFactor, [1, 0, 0, 0.5], 'base color');
    close([material.pbrMetallicRoughness.roughnessFactor], [0.5], 'roughness');
    assert.equal(material.alphaMode, 'BLEND');
    const stored = json.images[0],
      view = json.bufferViews[stored.bufferView];
    assert.equal(stored.mimeType, 'image/png');
    assert.equal(view.byteLength, image.length);
    let triangles = 0;
    for (const mesh of json.meshes) for (const p of mesh.primitives) triangles += accessor(p.indices).length / 3;
    assert.equal(triangles, 2);
  });
}

test('binary layout: header, 7400 records, deflated arrays, footer', async () => {
  const { fbx } = await exportFBX({ nodes: [{ name: 'Big', geometry: quad() }] }),
    text = new TextDecoder('latin1').decode(fbx),
    view = new DataView(fbx.buffer, fbx.byteOffset, fbx.byteLength);
  assert.equal(text.slice(0, 23), 'Kaydara FBX Binary  \0\x1a\0');
  assert.equal(view.getUint32(23, true), 7400);
  assert.equal((fbx.length - 140) % 16, 0, 'the version, 120 zeros and the end id follow a 16-byte boundary');
  assert.deepEqual([...fbx.subarray(fbx.length - 16, fbx.length - 12)], [0xf8, 0x5a, 0x8c, 0x6a]);
  // Every top-level record's end offset lands on the next record, up to the closing zero record.
  let at = 27,
    names = [];
  while (view.getUint32(at, true)) {
    const length = fbx[at + 12];
    names.push(text.slice(at + 13, at + 13 + length));
    at = view.getUint32(at, true);
  }
  assert.deepEqual(names, [
    'FBXHeaderExtension',
    'FileId',
    'CreationTime',
    'Creator',
    'GlobalSettings',
    'Documents',
    'References',
    'Definitions',
    'Objects',
    'Connections',
    'Takes',
  ]);
});

test('a long array is deflated, and the output is byte for byte repeatable', async () => {
  const positions = new Float32Array(3000),
    normals = new Float32Array(3000),
    indices = new Uint32Array(3000);
  for (let i = 0; i < 1000; i++) {
    positions.set([i % 7, i % 11, i % 13], i * 3);
    normals[i * 3 + 2] = 1;
    indices[i] = i;
  }
  const geometry = { positions, normals, indices: indices.slice(0, 3) },
    a = await exportFBX({ nodes: [{ geometry }] }),
    b = await exportFBX({ nodes: [{ geometry }] });
  assert.deepEqual(a.fbx, b.fbx);
  const raw = 1000 * 3 * 8 + 3000 * 8;
  assert.ok(a.fbx.length < raw, `${a.fbx.length} bytes against ${raw} raw`);
});

test('control points weld: a seam keeps one point with two UV corners', async () => {
  const geometry = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]),
      normals: new Float32Array(18).map((_, i) => (i % 3 === 2 ? 1 : 0)),
      uvs: new Float32Array([0, 0, 1, 0, 0, 1, 0.5, 0, 0, 0.5, 1, 1]),
      indices: new Uint32Array([0, 1, 2, 3, 5, 4]),
    },
    { fbx } = await exportFBX({ nodes: [{ name: 'Seam', geometry }] }, { ascii: true }),
    text = new TextDecoder().decode((await exportFBX({ nodes: [{ name: 'Seam', geometry }] }, { ascii: true })).fbx);
  assert.ok(fbx.length);
  assert.match(text, /Vertices: \*12 /, 'four control points from six vertices');
  assert.match(text, /a: 0,1,-3,1,3,-3/);
  const { json, accessor } = readGLB(await convertFBX(fbx)),
    primitive = json.meshes[0].primitives[0];
  assert.equal(accessor(primitive.attributes.POSITION).length / 3, 6, 'the importer splits the seam again');
});

test('quads stay four-sided polygons', async () => {
  const text = new TextDecoder().decode(
    (await exportFBX({ nodes: [{ geometry: { ...quad(), faceSizes: [4] } }] }, { ascii: true })).fbx,
  );
  assert.match(text, /PolygonVertexIndex: \*4 \{\s+a: 0,1,2,-4/);
});

test('GlobalSettings say centimetres and Y up, positions scale to match', async () => {
  const text = new TextDecoder().decode((await exportFBX({ nodes: [{ geometry: quad() }] }, { ascii: true })).fbx);
  assert.match(text, /"UnitScaleFactor", "double", "Number", "", 1\b/);
  assert.match(text, /"UpAxis", "int", "Integer", "", 1\b/);
  assert.match(text, /Vertices: \*12 \{\s+a: 0,0,0,100,0,0,100,100,0,0,100,0/);
});

test('STEP keys keep their flag; CUBICSPLINE is sampled through its tangents', async () => {
  const node = { name: 'Cel', geometry: quad() },
    { json, accessor } = await convert(
      {
        nodes: [node],
        animations: [
          {
            channels: [
              {
                node,
                path: 'translation',
                interpolation: 'STEP',
                times: new Float32Array([0, 1]),
                values: new Float32Array([0, 0, 0, 1, 1, 1]),
              },
            ],
          },
        ],
      },
      false,
    );
  const clip = json.animations[0],
    sampler = clip.samplers.find((s) => s.interpolation === 'STEP');
  assert.ok(sampler, 'a STEP sampler');
  close(accessor(sampler.output), [0, 0, 0, 1, 1, 1], 'STEP keys');

  const eased = { name: 'Eased', geometry: quad() },
    cubic = await convert(
      {
        nodes: [eased],
        animations: [
          {
            channels: [
              {
                node: eased,
                path: 'translation',
                interpolation: 'CUBICSPLINE',
                times: new Float32Array([0, 1]),
                // in, value, out per key: flat ends, so the middle is the smooth 0.5 and a quarter is 0.15625.
                values: new Float32Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0]),
              },
            ],
          },
        ],
      },
      false,
    ),
    track = cubic.json.animations[0].samplers[0],
    times = cubic.accessor(track.input),
    values = cubic.accessor(track.output);
  const at = (t) => values[[...times].findIndex((x) => Math.abs(x - t) < 1e-5) * 3];
  assert.ok(Math.abs(at(0.5) - 0.5) < 1e-5);
  assert.ok(Math.abs(at(0.25) - 0.15625) < 1e-5);
});

test('embedTextures: false names the texture and returns its bytes', async () => {
  const image = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 9]),
    material = { name: 'M', color: [1, 1, 1, 1], baseColorTexture: { image, mimeType: 'image/png', name: 'wood' } },
    { fbx, textures } = await exportFBX(
      { nodes: [{ geometry: quad(), material }] },
      { ascii: true, embedTextures: false },
    ),
    text = new TextDecoder().decode(fbx);
  assert.deepEqual([...textures.keys()], ['wood.png']);
  assert.deepEqual(textures.get('wood.png'), image);
  assert.match(text, /RelativeFilename: "wood\.png"/);
  assert.doesNotMatch(text, /Content:/);
  const embedded = await exportFBX({ nodes: [{ geometry: quad(), material }] }, { ascii: true });
  assert.equal(embedded.textures.size, 0);
  assert.match(new TextDecoder().decode(embedded.fbx), /Content: "iVBORw0KGgkJ"|Content: "iVBORw0KGgo/);
});

test('a name with a separator or a quote stays one object name in both forms', async () => {
  const name = 'Rig::Arm "left"\u0001x';
  for (const [, ascii] of forms) {
    const { json } = await convert({ nodes: [{ name, geometry: quad() }] }, ascii);
    assert.equal(json.nodes.length, 1);
    assert.ok(json.nodes[0].name.includes('Rig::Arm'), json.nodes[0].name);
  }
});

test('nodes under an uneven parent scale ask for the plain parent x local product', async () => {
  const child = { name: 'Child', geometry: quad() },
    parent = { name: 'Parent', scale: [1, 2, 3], children: [child] },
    plain = { name: 'Plain', scale: [2, 2, 2], children: [{ name: 'Kid', geometry: quad() }] },
    text = new TextDecoder().decode((await exportFBX({ nodes: [parent, plain] }, { ascii: true })).fbx),
    block = (name) =>
      text.slice(text.indexOf(`"Model::${name}"`), text.indexOf('Culling', text.indexOf(`"Model::${name}"`)));
  assert.match(block('Child'), /"InheritType", "enum", "", "", 1/);
  assert.doesNotMatch(block('Parent'), /InheritType/);
  assert.doesNotMatch(block('Kid'), /InheritType/);
});

test('joints are LimbNodes with a Skeleton attribute, plain empties are Nulls', async () => {
  const joint = { name: 'Bone' },
    empty = { name: 'Empty' },
    mesh = {
      name: 'Skin',
      geometry: {
        ...quad(),
        joints: new Uint16Array(16),
        weights: new Float32Array(16).map((_, i) => (i % 4 ? 0 : 1)),
      },
      skin: {
        joints: [joint],
        inverseBindMatrices: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
      },
    },
    text = new TextDecoder().decode((await exportFBX({ nodes: [joint, empty, mesh] }, { ascii: true })).fbx);
  assert.match(text, /"Model::Bone", "LimbNode"/);
  assert.match(text, /"Model::Empty", "Null"/);
  assert.match(text, /"Model::Skin", "Mesh"/);
  assert.match(text, /TypeFlags: "Skeleton"/);
});

test('shared geometry is written once for plain nodes', async () => {
  const geometry = quad(),
    text = new TextDecoder().decode(
      (
        await exportFBX(
          {
            nodes: [
              { name: 'A', geometry },
              { name: 'B', geometry },
            ],
          },
          { ascii: true },
        )
      ).fbx,
    );
  assert.equal(text.match(/Geometry: \d+, /g).length, 1);
});

test('limits: bad options, malformed keys, targets outside the scene, maxBytes', async () => {
  const node = { geometry: quad() };
  await assert.rejects(exportFBX({ nodes: [node] }, { ascii: 'yes' }), TypeError);
  await assert.rejects(exportFBX({ nodes: [node] }, { maxBytes: 0 }), RangeError);
  await assert.rejects(exportFBX({ nodes: [node] }, { maxBytes: 2 ** 32 }), RangeError);
  await assert.rejects(exportFBX({ nodes: [node] }, { maxBytes: 100 }), /raise maxBytes/);
  await assert.rejects(exportFBX({ nodes: [node] }, { ascii: true, maxBytes: 100 }), /raise maxBytes/);
  const bad = (channel) =>
    exportFBX({ nodes: [node], animations: [{ channels: [{ node, path: 'translation', ...channel }] }] });
  await assert.rejects(bad({ times: [0], values: [0, 0] }), /values per key/);
  await assert.rejects(bad({ times: [1, 0], values: [0, 0, 0, 0, 0, 0] }), /strictly increasing/);
  await assert.rejects(
    bad({ node: { name: 'Elsewhere' }, times: [0], values: [0, 0, 0] }),
    /not an exported scene node/,
  );
  const skinned = {
    geometry: { ...quad(), joints: new Uint16Array(16), weights: new Float32Array(16).fill(0.25) },
    skin: { joints: [{ name: 'Outside' }], inverseBindMatrices: new Float32Array(16) },
  };
  await assert.rejects(exportFBX({ nodes: [skinned] }), /not an exported scene node/);
  await assert.rejects(
    exportFBX({ nodes: [{ ...skinned, skin: { joints: [], inverseBindMatrices: new Float32Array(16) } }] }),
    /inverse bind matrix/,
  );
  await assert.rejects(
    exportFBX({
      nodes: [node],
      animations: [{ channels: [{ node, path: 'weights', times: [0], values: [0] }] }],
    }),
    /no morph targets/,
  );
});

test('AbortSignal stops the export, before and during the walk', async () => {
  const stop = new AbortController();
  stop.abort(new Error('stopped'));
  await assert.rejects(exportFBX({ nodes: [{ geometry: quad() }] }, { signal: stop.signal }), /stopped/);
  const late = new AbortController(),
    pending = exportFBX({ nodes: [{ geometry: quad() }] }, { signal: late.signal });
  late.abort(new Error('late'));
  await assert.rejects(pending, /late/);
});

// Regression tests for bugs the writer's round trip found in the importer.
test('a binary name holding :: keeps its namespace (importer cut it at the separator)', async () => {
  const { json } = await convert({ nodes: [{ name: 'Rig::Arm', geometry: quad() }] }, false);
  assert.equal(json.nodes[0].name, 'Rig::Arm');
});

test('the d|DeformPercent curve property reads as the weight curve (importer rejected it as an axis)', async () => {
  const node = {
      name: 'Face',
      geometry: { ...quad(), morphs: [{ positions: new Float32Array(12).fill(1) }] },
      morphWeights: [0],
    },
    { json } = await convert(
      { nodes: [node], animations: [{ channels: [{ node, path: 'weights', times: [0, 1], values: [0, 1] }] }] },
      false,
    );
  assert.equal(json.animations[0].channels[0].target.path, 'weights');
});
