import test from 'node:test';
import assert from 'node:assert/strict';
import { convertFBX, parseFBX } from '../dist/index.js';
import { ascii as toAscii, binary as toBinary, rich, L } from './fixtures.js';
import validator from 'gltf-validator';
// Test-only reference: the previous Three.js FBXLoader + GLTFExporter bridge (three stays a root devDependency).
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { MeshStandardMaterial, Matrix4, Matrix3, Vector3, Quaternion } from 'three';
globalThis.FileReader = class {
  async readAsArrayBuffer(blob) {
    this.result = await blob.arrayBuffer();
    this.onloadend?.();
  }
};
const ascii = `; FBX 7.4.0 project fixture
FBXHeaderExtension: {
\tFBXVersion: 7400
}
Objects: {
\tGeometry: 1, "Geometry::Triangle", "Mesh" {
\t\tVertices: *9 {
\t\t\ta: 0,0,0,1,0,0,0,1,0
\t\t}
\t\tPolygonVertexIndex: *3 {
\t\t\ta: 0,1,-3
\t\t}
\t}
\tModel: 2, "Model::Triangle", "Mesh" {
\t}
}
Connections: {
\tC: "OO",1,2
\tC: "OO",2,0
}
`;
const triangle = [
  [
    'Objects',
    [],
    [
      [
        'Geometry',
        [L(1), 'Geometry::Triangle', 'Mesh'],
        [
          ['Vertices', [{ array: 'd', values: [0, 0, 0, 1, 0, 0, 0, 1, 0] }]],
          ['PolygonVertexIndex', [{ array: 'i', values: [0, 1, -3] }]],
        ],
      ],
      ['Model', [L(2), 'Model::Triangle', 'Mesh']],
    ],
  ],
  [
    'Connections',
    [],
    [
      ['C', ['OO', L(1), L(2)]],
      ['C', ['OO', L(2), L(0)]],
    ],
  ],
];
const json = (glb) => {
  const view = new DataView(glb);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(glb, 20, view.getUint32(12, true))));
};
async function valid(glb) {
  const report = await validator.validateBytes(new Uint8Array(glb));
  assert.equal(report.issues.numErrors, 0, JSON.stringify(report.issues.messages.filter((m) => m.severity === 0)));
}
test('binary and ASCII FBX convert into validated triangle GLB', async () => {
  for (const bytes of [
    new TextEncoder().encode(ascii),
    toBinary(triangle),
    toBinary(triangle, { compress: true, version: 7500 }),
  ]) {
    const result = await convertFBX(bytes),
      view = new DataView(result);
    assert.equal(view.getUint32(0, true), 0x46546c67);
    const doc = json(result);
    assert.equal(doc.meshes.length, 1);
    assert.equal(doc.accessors[doc.meshes[0].primitives[0].attributes.POSITION].count, 3);
    await valid(result);
  }
  await assert.rejects(convertFBX(new ArrayBuffer(2)), /budget/);
  await assert.rejects(convertFBX(new ArrayBuffer(32), { resourcePath: 'file:///secret' }), /HTTP/);
  await assert.rejects(convertFBX(new ArrayBuffer(32), { signal: AbortSignal.abort() }), { name: 'AbortError' });
});
test('FBX animation curves survive as timed glTF translation channels', async () => {
  const animated = ascii
    .replace(
      '\n}\nConnections:',
      `\n\tAnimationStack: 10, "AnimStack::Move", "" {\n\t}\n\tAnimationLayer: 11, "AnimLayer::Base", "" {\n\t}\n\tAnimationCurveNode: 12, "AnimCurveNode::T", "" {\n\t}\n\tAnimationCurve: 13, "AnimCurve::X", "" {\n\t\tKeyTime: *2 {\n\t\t\ta: 0,46186158000\n\t\t}\n\t\tKeyValueFloat: *2 {\n\t\t\ta: 0,2\n\t\t}\n\t}\n}\nConnections:`,
    )
    .replace(
      '\tC: "OO",2,0',
      '\tC: "OO",2,0\n\tC: "OO",11,10\n\tC: "OO",12,11\n\tC: "OP",12,2,"Lcl Translation"\n\tC: "OP",13,12,"d|X"',
    );
  const result = await convertFBX(new TextEncoder().encode(animated)),
    view = new DataView(result),
    length = view.getUint32(12, true),
    doc = json(result);
  assert.equal(doc.animations.length, 1);
  assert.equal(doc.animations[0].name, 'Move');
  const channel = doc.animations[0].channels[0];
  assert.equal(channel.target.path, 'translation');
  const sampler = doc.animations[0].samplers[channel.sampler],
    accessor = (id) => {
      const a = doc.accessors[id],
        b = doc.bufferViews[a.bufferView];
      return new Float32Array(
        result,
        28 + length + (b.byteOffset ?? 0) + (a.byteOffset ?? 0),
        a.count * (a.type === 'VEC3' ? 3 : 1),
      );
    };
  assert.deepEqual([...accessor(sampler.input)], [0, 1]);
  assert.deepEqual([...accessor(sampler.output)], [0, 0, 0, 2, 0, 0]);
  await valid(result);
});

// Equivalence harness: flattens a GLB into world-space corners, node world matrices, materials, skins and clips.
async function threeGLB(bytes) {
  const warn = console.warn;
  console.warn = () => {};
  try {
    const scene = new FBXLoader().parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), ''),
      converted = new Map();
    scene.traverse((o) => {
      if (!o.isMesh) return;
      const pbr = (m) => {
        let p = converted.get(m);
        if (!p) {
          p = new MeshStandardMaterial({
            color: m.color,
            map: m.map ?? null,
            normalMap: m.normalMap ?? null,
            opacity: m.opacity,
            transparent: m.transparent,
            side: m.side,
            roughness: Math.max(0.045, Math.min(1, Math.sqrt(2 / ((m.shininess ?? 0) + 2)))),
          });
          p.name = m.name;
          converted.set(m, p);
        }
        return p;
      };
      o.material = Array.isArray(o.material) ? o.material.map(pbr) : pbr(o.material);
    });
    return await new GLTFExporter().parseAsync(scene, { binary: true, animations: scene.animations });
  } finally {
    console.warn = warn;
  }
}
function flatten(glb, { flipV }) {
  const doc = json(glb),
    bin = 28 + new DataView(glb).getUint32(12, true),
    sizes = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
  const read = (i) => {
    const a = doc.accessors[i],
      v = doc.bufferViews[a.bufferView],
      T = { 5126: Float32Array, 5123: Uint16Array, 5125: Uint32Array }[a.componentType];
    return Array.from(
      new T(
        glb.slice(
          bin + (v.byteOffset ?? 0) + (a.byteOffset ?? 0),
          bin + (v.byteOffset ?? 0) + (a.byteOffset ?? 0) + a.count * sizes[a.type] * T.BYTES_PER_ELEMENT,
        ),
      ),
    );
  };
  const world = new Map(),
    names = new Map(),
    corners = [],
    out = { nodes: new Map(), materials: new Map(), skins: new Map(), clips: new Map() };
  const visit = (i, parent) => {
    const n = doc.nodes[i],
      m = n.matrix
        ? new Matrix4().fromArray(n.matrix)
        : new Matrix4().compose(
            new Vector3(...(n.translation ?? [0, 0, 0])),
            new Quaternion(...(n.rotation ?? [0, 0, 0, 1])),
            new Vector3(...(n.scale ?? [1, 1, 1])),
          );
    world.set(i, parent.clone().multiply(m));
    names.set(i, n.name ?? '');
    if (n.name) out.nodes.set(n.name, world.get(i).elements);
    for (const c of n.children ?? []) visit(c, world.get(i));
  };
  for (const r of doc.scenes[doc.scene].nodes) visit(r, new Matrix4());
  for (const [i, n] of doc.nodes.entries()) {
    if (n.mesh === undefined) continue;
    const W = world.get(i),
      N = new Matrix3().getNormalMatrix(W),
      L = new Matrix3().setFromMatrix4(W);
    for (const p of doc.meshes[n.mesh].primitives) {
      const a = p.attributes,
        P = read(a.POSITION),
        count = P.length / 3,
        idx = p.indices === undefined ? [...Array(count).keys()] : read(p.indices),
        mat = doc.materials[p.material],
        get = (k) => (a[k] === undefined ? undefined : read(a[k])),
        Nn = get('NORMAL'),
        U0 = get('TEXCOORD_0'),
        U1 = get('TEXCOORD_1'),
        Cc = get('COLOR_0'),
        M = (p.targets ?? []).map((t) => read(t.POSITION));
      out.materials.set(mat.name ?? '', [
        ...(mat.pbrMetallicRoughness.baseColorFactor ?? [1, 1, 1, 1]),
        mat.pbrMetallicRoughness.roughnessFactor,
        mat.pbrMetallicRoughness.metallicFactor,
        mat.alphaMode ?? 'OPAQUE',
      ]);
      for (const k of idx) {
        const v = new Vector3(P[k * 3], P[k * 3 + 1], P[k * 3 + 2]).applyMatrix4(W),
          values = [v.x, v.y, v.z];
        if (Nn) {
          const q = new Vector3(Nn[k * 3], Nn[k * 3 + 1], Nn[k * 3 + 2]).applyMatrix3(N).normalize();
          values.push(q.x, q.y, q.z);
        }
        for (const [U, flip] of [
          [U0, flipV],
          [U1, flipV],
        ])
          if (U) values.push(U[k * 2], flip ? 1 - U[k * 2 + 1] : U[k * 2 + 1]);
        if (Cc) values.push(Cc[k * 3], Cc[k * 3 + 1], Cc[k * 3 + 2]);
        for (const T of M) {
          const d = new Vector3(T[k * 3], T[k * 3 + 1], T[k * 3 + 2]).applyMatrix3(L);
          values.push(d.x, d.y, d.z);
        }
        corners.push({ key: names.get(i) + '|' + (mat.name ?? ''), values });
      }
    }
    if (n.skin !== undefined) {
      const s = doc.skins[n.skin];
      out.skins.set(n.name, { joints: s.joints.map((j) => doc.nodes[j].name), ibm: read(s.inverseBindMatrices) });
    }
  }
  for (const clip of doc.animations ?? [])
    for (const c of clip.channels) {
      const s = clip.samplers[c.sampler];
      out.clips.set(clip.name + '/' + doc.nodes[c.target.node].name + '.' + c.target.path, {
        input: read(s.input),
        output: read(s.output),
        path: c.target.path,
      });
    }
  out.corners = corners;
  return out;
}
const close = (a, b, tol, label) => {
  assert.equal(a.length, b.length, label + ' length');
  a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) <= tol, `${label}[${i}] ${v} vs ${b[i]}`));
};
function equivalent(mine, reference) {
  const a = flatten(mine, { flipV: true }),
    b = flatten(reference, { flipV: false });
  assert.deepEqual([...a.nodes.keys()].sort(), [...b.nodes.keys()].sort());
  for (const [k, m] of a.nodes) close(m, b.nodes.get(k), 1e-4, 'node ' + k);
  assert.deepEqual([...a.materials.keys()].sort(), [...b.materials.keys()].sort());
  for (const [k, m] of a.materials) {
    close(m.slice(0, 6), b.materials.get(k).slice(0, 6), 1e-6, 'material ' + k);
    assert.equal(m[6], b.materials.get(k)[6]);
  }
  assert.equal(a.corners.length, b.corners.length, 'corner count');
  const unused = [...b.corners];
  for (const c of a.corners) {
    const i = unused.findIndex(
      (d) =>
        d.key === c.key &&
        d.values.length === c.values.length &&
        d.values.every((v, k) => Math.abs(v - c.values[k]) < 1e-4),
    );
    assert.ok(i >= 0, 'unmatched corner ' + c.key + ' ' + c.values.map((v) => v.toFixed(4)));
    unused.splice(i, 1);
  }
  assert.deepEqual([...a.skins.keys()], [...b.skins.keys()]);
  for (const [k, s] of a.skins) {
    assert.deepEqual(s.joints, b.skins.get(k).joints);
    close(s.ibm, b.skins.get(k).ibm, 1e-4, 'ibm ' + k);
  }
  assert.deepEqual([...a.clips.keys()].sort(), [...b.clips.keys()].sort());
  for (const [k, c] of a.clips) {
    const r = b.clips.get(k);
    close(c.input, r.input, 1e-6, k + ' times');
    if (c.path !== 'rotation') close(c.output, r.output, 1e-5, k);
    else
      for (let i = 0; i < c.output.length; i += 4) {
        const q = c.output.slice(i, i + 4),
          p = r.output.slice(i, i + 4),
          s = Math.sign(q.reduce((t, v, j) => t + v * p[j], 0)) || 1;
        close(
          q.map((v) => v * s),
          p,
          1e-5,
          k + ' quaternion',
        );
      }
  }
  return a;
}
test('native conversion matches the previous Three.js path on hierarchy, pivots, n-gons, layers, materials, skin, blend shape and clips', async () => {
  const tree = rich(),
    text = new TextEncoder().encode(toAscii(tree));
  for (const bytes of [
    text,
    toBinary(tree),
    toBinary(tree, { compress: true }),
    toBinary(tree, { compress: true, version: 7500 }),
  ]) {
    const reference = await threeGLB(bytes),
      mine = await convertFBX(bytes),
      summary = equivalent(mine, reference);
    assert.ok(summary.corners.length >= 24 && summary.skins.size === 1 && summary.clips.size === 3);
    await valid(mine);
  }
  const doc = json(await convertFBX(text));
  assert.deepEqual(doc.nodes[0].rotation, [-Math.SQRT1_2, 0, 0, Math.SQRT1_2]);
  assert.deepEqual(doc.meshes.find((m) => m.extras).extras.targetNames, ['Smile']);
  assert.equal(doc.meshes[0].primitives.length, 2, 'one primitive per material');
});
test('blend shape DeformPercent curves become glTF weights channels', async () => {
  const result = await convertFBX(toBinary(rich({ morphAnimation: true }), { compress: true })),
    doc = json(result),
    clip = doc.animations[0],
    channel = clip.channels.find((c) => c.target.path === 'weights');
  assert.ok(channel);
  assert.equal(doc.nodes[channel.target.node].name, 'SkinMesh');
  const bin = 28 + new DataView(result).getUint32(12, true),
    read = (i) => {
      const a = doc.accessors[i],
        v = doc.bufferViews[a.bufferView];
      return [...new Float32Array(result.slice(bin + v.byteOffset, bin + v.byteOffset + a.count * 4))];
    };
  assert.deepEqual(read(clip.samplers[channel.sampler].output), [0, 1]);
  await valid(result);
});
test('malformed FBX fails with explicit errors', async () => {
  const good = toBinary(rich(), { compress: true });
  await assert.rejects(convertFBX(good.subarray(0, 400)), /FBX/);
  const bad = Buffer.from(good),
    at = bad.indexOf(Buffer.from([0x78, 0x9c]));
  bad[at + 5] ^= 0xff;
  await assert.rejects(convertFBX(bad));
  await assert.rejects(convertFBX(new TextEncoder().encode(ascii.replace('7400', '6100'))), /not supported/);
  await assert.rejects(convertFBX(new TextEncoder().encode(ascii.replace('0,1,-3', '0,1,-9'))), /outside/);
  await assert.rejects(
    convertFBX(new TextEncoder().encode(ascii.replace('a: 0,0,0,1,0,0,0,1,0', 'a: 0,0,0,1,0,0,0,1,x'))),
    /FBX/,
  );
});

/** Triangle meshes that each use their own material with an embedded (or referenced) diffuse texture. */
function textured(count, { embedded = true, file = 'tex.png' } = {}) {
  const objects = [
      [
        'Geometry',
        [L(1), 'Geometry::Tri', 'Mesh'],
        [
          ['Vertices', [{ array: 'd', values: [0, 0, 0, 1, 0, 0, 0, 1, 0] }]],
          ['PolygonVertexIndex', [{ array: 'i', values: [0, 1, -3] }]],
        ],
      ],
    ],
    links = [];
  for (let i = 0; i < count; i++) {
    objects.push(
      ['Model', [L(100 + i), 'Model::M' + i, 'Mesh']],
      ['Material', [L(200 + i), 'Material::Mat' + i, ''], [['ShadingModel', ['phong']]]],
      ['Texture', [L(300 + i), 'Texture::T' + i, ''], [['FileName', [file]]]],
      [
        'Video',
        [L(400 + i), 'Video::V' + i, 'Clip'],
        [
          ['RelativeFilename', [file]],
          ...(embedded ? [['Content', [Buffer.from([137, 80, 78, 71, i]).toString('base64')]]] : []),
        ],
      ],
    );
    links.push(
      ['C', ['OO', L(100 + i), L(0)]],
      ['C', ['OO', L(1), L(100 + i)]],
      ['C', ['OO', L(200 + i), L(100 + i)]],
      ['C', ['OP', L(300 + i), L(200 + i), 'DiffuseColor']],
      ['C', ['OO', L(400 + i), L(300 + i)]],
    );
  }
  return new TextEncoder().encode(
    toAscii([
      ['Objects', [], objects],
      ['Connections', [], links],
    ]),
  );
}
async function withBitmaps(stub, run) {
  const bitmap = globalThis.createImageBitmap;
  globalThis.createImageBitmap = stub;
  try {
    await run();
  } finally {
    globalThis.createImageBitmap = bitmap;
  }
}
test('embedded and referenced textures are carried into the GLB', async () => {
  const doc = json(await convertFBX(textured(2)));
  assert.equal(doc.images.length, 2);
  assert.equal(doc.materials[0].pbrMetallicRoughness.baseColorTexture.index, 0);
  assert.equal(doc.images[0].mimeType, 'image/png');
  const fetched = [],
    fetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    fetched.push(String(url));
    return new Response(new Uint8Array([1, 2, 3]));
  };
  try {
    const result = await convertFBX(textured(1, { embedded: false, file: 'C:\\art\\wood.png' }), {
      resourcePath: 'https://example.test/assets/',
    });
    assert.deepEqual(fetched, ['https://example.test/assets/wood.png']);
    assert.equal(json(result).images.length, 1);
  } finally {
    globalThis.fetch = fetch;
  }
  globalThis.fetch = async () => new Response('', { status: 404 });
  try {
    await assert.rejects(
      convertFBX(textured(1, { embedded: false }), { resourcePath: 'https://example.test/' }),
      /texture failed/,
    );
  } finally {
    globalThis.fetch = fetch;
  }
});
test('FBX texture pixel accounting reads each decoded image once', () =>
  withBitmaps(
    async () => {
      throw new Error('replaced below');
    },
    async () => {
      const controller = new AbortController(),
        reason = new Error('stop before PBR attachment');
      let decoded = 0,
        dimensionReads = 0,
        closed = 0;
      globalThis.createImageBitmap = async () => {
        if (++decoded === 12) controller.abort(reason);
        return {
          get width() {
            dimensionReads++;
            return 2;
          },
          get height() {
            dimensionReads++;
            return 3;
          },
          close() {
            closed++;
          },
        };
      };
      await assert.rejects(parseFBX({}, textured(12), { signal: controller.signal }), (error) => error === reason);
      assert.equal(decoded, 12);
      assert.equal(dimensionReads, 24, 'Pixel budgets must use linear per-image accounting');
      assert.equal(closed, 12);
    },
  ));
test('FBX cancellation stops before decoding another image and closes the completed image', () =>
  withBitmaps(null, async () => {
    const controller = new AbortController(),
      reason = new Error('cancel texture decoding');
    let decoded = 0,
      closed = 0;
    globalThis.createImageBitmap = async () => {
      decoded++;
      controller.abort(reason);
      return {
        width: 2,
        height: 3,
        close() {
          closed++;
        },
      };
    };
    await assert.rejects(parseFBX({}, textured(4), { signal: controller.signal }), (error) => error === reason);
    assert.equal(decoded, 1);
    assert.equal(closed, 1);
  }));
test('FBX cumulative texture pixel limits still reject and close every decoded image', () =>
  withBitmaps(null, async () => {
    let decoded = 0,
      closed = 0;
    globalThis.createImageBitmap = async () => ({
      width: 8_000_000 + (decoded++ ? 1 : 0),
      height: 1,
      close() {
        closed++;
      },
    });
    await assert.rejects(parseFBX({}, textured(3)), /texture pixel budget/);
    assert.equal(decoded, 2);
    assert.equal(closed, 2);
  }));
