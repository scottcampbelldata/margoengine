import test from 'node:test';
import assert from 'node:assert/strict';
import { box, PbrMaterial } from '@margoengine/core';
import { exportUSDZ } from '../dist/usdz.js';
import { exportGLB } from '../dist/index.js';
import { parseUSDZ, readZipDirectory, readZipEntry } from '@margoengine/loaders';
import { parseUSDZ as readUSD } from '@margoengine/usdz';
import { textureTransform } from '@margoengine/gltf-pro';
import { headlessEngine } from './helpers.js';

// A unit quad in the XY plane with glTF uvs (v down).
const quad = {
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
  uvs: new Float32Array([0, 1, 1, 1, 1, 0, 0.25, 0]),
  indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
};
const pngBytes = (seed) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, seed, seed + 1, seed + 2]);
const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
const usda = async (archive) => new TextDecoder().decode(await readZipEntry(archive, readZipDirectory(archive)[0]));
/** Every stored entry's data offset, read from its local header. */
const dataOffsets = (archive) => {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  return readZipDirectory(archive).map((entry) => {
    const at = entry.headerOffset;
    assert.equal(view.getUint32(at, true), 0x04034b50);
    return { name: entry.name, offset: at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true), entry };
  });
};
const shader = (source, name) => {
  const start = source.indexOf(`def Shader "${name}"`);
  assert.ok(start >= 0, `shader ${name}`);
  return source.slice(start, source.indexOf('\n    }', start));
};

test('USDZ packages world-space reflected hierarchy and PreviewSurface colors', async () => {
  const engine = await headlessEngine();
  const parent = engine.createMesh().setPosition([1, 2, 3]).setScale([-2, 1, 1]);
  const mesh = engine
    .createMesh(parent)
    .setGeometry(box())
    .setPosition([0.5, 0, 0])
    .setMaterial(new PbrMaterial({ color: '#ff0000', roughness: 0.25, metalness: 0.5 }));
  mesh.name = 'Quoted "mesh"';
  engine.createMesh().setGeometry(box()).visible = false;
  const archive = exportUSDZ(engine),
    entries = readZipDirectory(archive);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, 'scene.usda');
  assert.equal(entries[0].method, 0);
  const view = new DataView(archive.buffer),
    offset = 30 + view.getUint16(26, true) + view.getUint16(28, true);
  assert.equal(offset % 64, 0);
  const source = new TextDecoder().decode(await readZipEntry(archive, entries[0]));
  assert.match(source, /defaultPrim = "Margo"/);
  assert.match(source, /UsdPreviewSurface/);
  assert.match(source, /inputs:roughness = 0.25/);
  const parsed = await parseUSDZ(archive);
  assert.equal(parsed.groups.length, 1);
  assert.equal(parsed.groups[0].name, mesh.name);
  assert.ok(Math.abs(parsed.groups[0].color[0] - 1) < 1e-6);
  assert.equal(parsed.indices.length, 36);
  const xs = Array.from(parsed.positions).filter((_, i) => i % 3 === 0);
  assert.equal(Math.min(...xs), -1);
  assert.equal(Math.max(...xs), 1);
  engine.dispose();
});

test('USDZ rejects an empty scene, out-of-range positions and textures it cannot sample', () => {
  assert.throws(() => exportUSDZ({ nodes: [] }), /at least one mesh/);
  const jpeg = { image: jpegBytes, mimeType: 'image/jpeg' };
  assert.throws(
    () => exportUSDZ({ nodes: [{ geometry: box(), material: { normalTexture: jpeg } }] }),
    (error) => error instanceof TypeError && /normalTexture samples uvs, which its geometry lacks/.test(error.message),
  );
  assert.throws(
    () => exportUSDZ({ nodes: [{ geometry: quad, material: { baseColorTexture: { ...jpeg, texCoord: 1 } } }] }),
    /samples uvs1/,
  );
  assert.throws(
    () =>
      exportUSDZ({
        nodes: [{ geometry: { ...quad, colors: new Float32Array(12).fill(1) }, material: { baseColorTexture: jpeg } }],
      }),
    (error) => error instanceof TypeError && /cannot multiply/.test(error.message),
  );
  assert.throws(
    () => exportUSDZ({ nodes: [{ geometry: quad, material: { baseColorTexture: jpeg } }] }, { texturePrefix: '../x' }),
    (error) => error instanceof TypeError && /leaves the archive/.test(error.message),
  );
  assert.throws(
    () =>
      exportUSDZ({
        nodes: [{ scale: [1e30, 1e30, 1e30], children: [{ geometry: box(), scale: [1e30, 1e30, 1e30] }] }],
      }),
    /Float32/,
  );
});

test('USDZ preserves linear AO vertex colors and alpha in connected PreviewSurface primvars', async () => {
  const geometry = {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    colors: new Float32Array([1, 0.5, 0.25, 1, 0.25, 0.5, 1, 0.5, 0, 1, 0.5, 0]),
  };
  const archive = exportUSDZ({
    nodes: [
      {
        name: 'parent',
        translation: [4, 0, 0],
        children: [
          {
            name: 'AO',
            geometry,
            material: {
              color: [0.5, 0.25, 1, 0.5],
              alphaMode: 'BLEND',
              roughness: 0.2,
              metalness: 0.3,
              emissive: [0.1, 0.2, 0.3],
            },
          },
        ],
      },
    ],
  });
  const [entry] = readZipDirectory(archive);
  const source = new TextDecoder().decode(await readZipEntry(archive, entry));
  const values = (name) =>
    [...source.match(new RegExp(`${name} = \\[([^\\]]+)\\]`))[1].matchAll(/[-+]?\d*\.?\d+(?:e[-+]?\d+)?/g)].map((v) =>
      Number(v[0]),
    );
  assert.deepEqual(values('primvars:displayColor'), [0.5, 0.125, 0.25, 0.125, 0.125, 1, 0, 0.25, 0.5]);
  assert.deepEqual(values('primvars:displayOpacity'), [0.5, 0.25, 0]);
  assert.match(source, /primvars:displayColor = .*\(interpolation = "vertex"\)/);
  assert.match(source, /info:id = "UsdPrimvarReader_float3"/);
  assert.match(source, /string inputs:varname = "displayColor"/);
  assert.match(source, /inputs:diffuseColor.connect = <\/Margo\/Material_0\/Color.outputs:result>/);
  assert.match(source, /inputs:opacity.connect = <\/Margo\/Material_0\/Opacity.outputs:result>/);
  assert.match(source, /inputs:roughness = 0.2/);
  assert.match(source, /inputs:metallic = 0.3/);
  assert.deepEqual(values('points'), [4, 0, 0, 5, 0, 0, 4, 1, 0]);
  assert.deepEqual([...geometry.colors], [1, 0.5, 0.25, 1, 0.25, 0.5, 1, 0.5, 0, 1, 0.5, 0]);
  const parsed = await parseUSDZ(archive);
  const linear = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const expected = [0.5, 0.125, 0.25, 0.125, 0.125, 1, 0, 0.25, 0.5];
  parsed.colors.forEach((v, i) => assert.ok(Math.abs(linear(v) - expected[i]) < 1e-6));
  assert.deepEqual([...parsed.attributes.opacity], [0.5, 0.25, 0]);
  assert.equal(parsed.groups[0].color, undefined, 'precombined vertex color must not be tinted twice');
});

test('USDZ writes a UsdPreviewSurface texture graph with embedded, 64-byte-aligned images', async () => {
  const base = { image: pngBytes(1), mimeType: 'image/png', name: 'albedo.png', wrapS: 'clamp', wrapT: 'mirror' },
    orm = { image: jpegBytes, mimeType: 'image/jpeg', name: 'orm' },
    archive = exportUSDZ({
      nodes: [
        {
          name: 'Textured',
          geometry: quad,
          material: {
            color: [0.5, 0.25, 1, 0.75],
            alphaMode: 'BLEND',
            roughness: 0.4,
            metalness: 0.6,
            emissive: [1, 0.5, 0],
            emissiveStrength: 2,
            normalScale: 0.5,
            occlusionStrength: 0.25,
            baseColorTexture: base,
            baseColorTextureTransform: { offset: [0.25, 0.5], scale: [2, 3] },
            metallicRoughnessTexture: orm,
            occlusionTexture: orm,
            normalTexture: { image: pngBytes(7), mimeType: 'image/png', name: 'normal' },
            emissiveTexture: { image: pngBytes(9), mimeType: 'image/png', name: 'glow' },
          },
        },
      ],
    });
  const source = await usda(archive);
  // The surface reads every map from its UsdUVTexture outputs.
  const surface = shader(source, 'Surface'),
    m = '/Margo/Material_0';
  assert.match(surface, new RegExp(`color3f inputs:diffuseColor.connect = <${m}/BaseColorTexture.outputs:rgb>`));
  assert.match(surface, new RegExp(`float inputs:opacity.connect = <${m}/BaseColorTexture.outputs:a>`));
  assert.match(surface, new RegExp(`float inputs:roughness.connect = <${m}/MetallicRoughnessTexture.outputs:g>`));
  assert.match(surface, new RegExp(`float inputs:metallic.connect = <${m}/MetallicRoughnessTexture.outputs:b>`));
  assert.match(surface, new RegExp(`normal3f inputs:normal.connect = <${m}/NormalTexture.outputs:rgb>`));
  assert.match(surface, new RegExp(`float inputs:occlusion.connect = <${m}/OcclusionTexture.outputs:r>`));
  assert.match(surface, new RegExp(`color3f inputs:emissiveColor.connect = <${m}/EmissiveTexture.outputs:rgb>`));
  assert.doesNotMatch(surface, /opacityThreshold/);
  // Factors as scale and bias, color spaces and wrap modes.
  const albedo = shader(source, 'BaseColorTexture');
  assert.match(albedo, /uniform token info:id = "UsdUVTexture"/);
  assert.match(albedo, /asset inputs:file = @textures\/albedo.png@/);
  assert.match(albedo, /float4 inputs:scale = \(0.5, 0.25, 1, 0.75\)/);
  assert.match(albedo, /token inputs:sourceColorSpace = "sRGB"/);
  assert.match(albedo, /token inputs:wrapS = "clamp"/);
  assert.match(albedo, /token inputs:wrapT = "mirror"/);
  assert.match(albedo, new RegExp(`float2 inputs:st.connect = <${m}/BaseColorTransform.outputs:result>`));
  const transform = shader(source, 'BaseColorTransform');
  assert.match(transform, /info:id = "UsdTransform2d"/);
  assert.match(transform, new RegExp(`float2 inputs:in.connect = <${m}/UV.outputs:result>`));
  assert.match(transform, /float2 inputs:scale = \(2, 3\)/);
  // glTF offset (0.25, 0.5) with scale 3 in v becomes t' = 3 t + (1 - 3 - 0.5) in st space.
  assert.match(transform, /float2 inputs:translation = \(0.25, -2.5\)/);
  const metalRough = shader(source, 'MetallicRoughnessTexture');
  assert.match(metalRough, /asset inputs:file = @textures\/orm.jpg@/);
  assert.match(metalRough, /float4 inputs:scale = \(1, 0.4, 0.6, 1\)/);
  assert.match(metalRough, /token inputs:sourceColorSpace = "raw"/);
  assert.match(metalRough, new RegExp(`float2 inputs:st.connect = <${m}/UV.outputs:result>`));
  const normal = shader(source, 'NormalTexture');
  assert.match(normal, /float4 inputs:scale = \(1, 1, 2, 1\)/);
  assert.match(normal, /float4 inputs:bias = \(-0.5, -0.5, -1, 0\)/);
  assert.match(normal, /sourceColorSpace = "raw"/);
  assert.match(
    shader(source, 'OcclusionTexture'),
    /scale = \(0.25, 0.25, 0.25, 1\)[\s\S]*bias = \(0.75, 0.75, 0.75, 0\)/,
  );
  assert.match(
    shader(source, 'EmissiveTexture'),
    /sourceColorSpace = "sRGB"[\s\S]*float4 inputs:scale = \(2, 1, 0, 1\)/,
  );
  const uv = shader(source, 'UV');
  assert.match(uv, /info:id = "UsdPrimvarReader_float2"/);
  assert.match(uv, /string inputs:varname = "st"/);
  assert.match(
    source,
    /texCoord2f\[\] primvars:st = \[\(0, 0\), \(1, 0\), \(1, 1\), \(0.25, 1\)\] \(interpolation = "vertex"\)/,
  );
  // Archive: the layer first, each image once (shared ORM JPEG), stored, every file's data 64-byte aligned.
  const offsets = dataOffsets(archive);
  assert.deepEqual(
    offsets.map((e) => e.name),
    ['scene.usda', 'textures/albedo.png', 'textures/orm.jpg', 'textures/normal.png', 'textures/glow.png'],
  );
  for (const { name, offset, entry } of offsets) {
    assert.equal(offset % 64, 0, `${name} data offset ${offset}`);
    assert.equal(entry.method, 0);
  }
  const bytes = (name) => {
    const { offset, entry } = offsets.find((e) => e.name === name);
    return archive.subarray(offset, offset + entry.size);
  };
  assert.deepEqual(bytes('textures/albedo.png'), base.image);
  assert.deepEqual(bytes('textures/orm.jpg'), jpegBytes);
  for (const { entry } of offsets) assert.deepEqual(await readZipEntry(archive, entry), bytes(entry.name));
  // Round trip through @margoengine/usdz: texture paths, metal-rough channels and V-flipped st.
  const asset = await readUSD(archive),
    material = asset.document.materials[0],
    images = asset.sources;
  assert.equal(images[material.pbrMetallicRoughness.baseColorTexture.index].path, 'textures/albedo.png');
  assert.equal(images[material.normalTexture.index].path, 'textures/normal.png');
  const packed = images[material.pbrMetallicRoughness.metallicRoughnessTexture.index];
  assert.deepEqual(packed.roughness, { path: 'textures/orm.jpg', channel: 1 });
  assert.deepEqual(packed.metallic, { path: 'textures/orm.jpg', channel: 2 });
  const [mesh] = asset.meshes;
  assert.equal(mesh.indices.length, 6);
  for (let corner = 0; corner < 6; corner++) {
    const p = Array.from(mesh.positions.subarray(corner * 3, corner * 3 + 3)),
      v = [0, 1, 2, 3].find((i) => p.every((x, k) => x === quad.positions[i * 3 + k]));
    assert.ok(Math.abs(mesh.uvs[corner * 2] - quad.uvs[v * 2]) < 1e-6);
    assert.ok(Math.abs(mesh.uvs[corner * 2 + 1] - (1 - quad.uvs[v * 2 + 1])) < 1e-6);
  }
});

test('USDZ alpha masks set opacityThreshold from alphaCutoff', async () => {
  const texture = { image: pngBytes(3), mimeType: 'image/png' },
    masked = await usda(
      exportUSDZ({
        nodes: [{ geometry: quad, material: { alphaMode: 'MASK', alphaCutoff: 0.3, baseColorTexture: texture } }],
      }),
    );
  assert.match(masked, /float inputs:opacity.connect = <\/Margo\/Material_0\/BaseColorTexture.outputs:a>/);
  assert.match(masked, /float inputs:opacityThreshold = 0.3/);
  assert.match(masked, /asset inputs:file = @textures\/texture_0.png@/);
  const plain = await usda(
    exportUSDZ({ nodes: [{ geometry: quad, material: { alphaMode: 'MASK', color: [1, 1, 1, 0.4] } }] }),
  );
  assert.match(plain, /float inputs:opacity = 0.4/);
  assert.match(plain, /float inputs:opacityThreshold = 0.5/);
  // A cutoff of 0 keeps every texel: an opaque surface, since a USD threshold of 0 would blend instead.
  const all = await usda(
    exportUSDZ({
      nodes: [{ geometry: quad, material: { alphaMode: 'MASK', alphaCutoff: 0, baseColorTexture: texture } }],
    }),
  );
  assert.match(all, /float inputs:opacity = 1/);
  assert.doesNotMatch(all, /opacityThreshold|outputs:a>/);
  // Opaque materials ignore the texture's alpha.
  const opaque = await usda(exportUSDZ({ nodes: [{ geometry: quad, material: { baseColorTexture: texture } }] }));
  assert.match(opaque, /float inputs:opacity = 1/);
});

test('USDZ samples texCoord 1 from primvars:st1 and textures engine meshes through materialData', async () => {
  const lightmapped = await usda(
    exportUSDZ({
      nodes: [
        {
          geometry: { ...quad, uvs1: new Float32Array([0, 0, 0.5, 0, 0.5, 0.5, 0, 0.5]) },
          material: { occlusionTexture: { image: pngBytes(5), mimeType: 'image/png', texCoord: 1 } },
        },
      ],
    }),
  );
  assert.match(shader(lightmapped, 'UV1'), /string inputs:varname = "st1"/);
  assert.match(lightmapped, /texCoord2f\[\] primvars:st1 = \[\(0, 1\), \(0.5, 1\), \(0.5, 0.5\), \(0, 0.5\)\]/);
  assert.doesNotMatch(lightmapped, /primvars:st =/);
  const engine = await headlessEngine(),
    geometry = box(),
    material = new PbrMaterial({ color: '#ffffff' }),
    count = geometry.vertices.length / 6,
    rich = {
      positions: Float32Array.from({ length: count * 3 }, (_, i) => geometry.vertices[Math.floor(i / 3) * 6 + (i % 3)]),
      normals: Float32Array.from(
        { length: count * 3 },
        (_, i) => geometry.vertices[Math.floor(i / 3) * 6 + 3 + (i % 3)],
      ),
      uvs: new Float32Array(count * 2).fill(0.5),
      indices: geometry.indices,
    };
  engine.createMesh().setGeometry(geometry).setMaterial(material);
  const archive = exportUSDZ(engine, {
    geometryData: new Map([[geometry, rich]]),
    materialData: new Map([
      [material, { baseColorTexture: { image: jpegBytes, mimeType: 'image/jpeg', name: 'crate' } }],
    ]),
    texturePrefix: 'maps/',
  });
  assert.deepEqual(
    readZipDirectory(archive).map((e) => e.name),
    ['scene.usda', 'maps/crate.jpg'],
  );
  for (const { offset } of dataOffsets(archive)) assert.equal(offset % 64, 0);
  const asset = await readUSD(archive);
  assert.equal(
    asset.sources[asset.document.materials[0].pbrMetallicRoughness.baseColorTexture.index].path,
    'maps/crate.jpg',
  );
  engine.dispose();
});

// KHR_texture_transform rotation (radians) into UsdTransform2d. gltf-pro's rows are the reference: through the V flip
// (st = (u, 1 - v)) the USD transform must sample the texel gltf-pro samples at every uv. UsdTransform2d per the
// UsdPreviewSurface spec: scale, then a counter-clockwise rotation in degrees (t up), then translation.
const transformInputs = (source) => {
  const text = shader(source, 'BaseColorTransform'),
    pair = (name) => {
      const m = text.match(new RegExp(`float2 inputs:${name} = \\(([^,]+), ([^)]+)\\)`));
      assert.ok(m, `inputs:${name}`);
      return [Number(m[1]), Number(m[2])];
    },
    rotation = text.match(/float inputs:rotation = (\S+)/);
  return { rotation: rotation ? Number(rotation[1]) : 0, scale: pair('scale'), translation: pair('translation') };
};
const rotatedScene = (transform, wrapT = 'repeat') => ({
  nodes: [
    {
      geometry: quad,
      material: {
        baseColorTexture: { image: pngBytes(3), mimeType: 'image/png', name: 'f', wrapS: 'repeat', wrapT },
        baseColorTextureTransform: transform,
      },
    },
  ],
});
/** UsdTransform2d on st, as the spec defines it. */
const usdST = ({ rotation, scale, translation }, s, t) => {
  const r = (rotation * Math.PI) / 180,
    a = scale[0] * s,
    b = scale[1] * t;
  return [Math.cos(r) * a - Math.sin(r) * b + translation[0], Math.sin(r) * a + Math.cos(r) * b + translation[1]];
};
/** gltf-pro's KHR_texture_transform rows (what its shader reads) applied to a uv. */
const gltfUV = (rows, u, v) => [rows[0] * u + rows[1] * v + rows[2], rows[4] * u + rows[5] * v + rows[6]];
const inverse2 = ([a, b, c, d]) => {
  const det = a * d - b * c;
  return [d / det, -b / det, -c / det, a / det];
};
const glbJSON = (glb) =>
  JSON.parse(
    new TextDecoder().decode(glb.subarray(20, 20 + new DataView(glb.buffer, glb.byteOffset).getUint32(12, true))),
  );

test('USDZ writes texture rotation that samples the texels gltf-pro samples (0, +-30, 90, 180 degrees)', async () => {
  const offset = [0.25, -0.4],
    scale = [2, 3];
  for (const degrees of [0, 30, -30, 90, 180]) {
    const rotation = (degrees * Math.PI) / 180,
      source = await usda(exportUSDZ(rotatedScene({ offset, scale, rotation }))),
      usd = transformInputs(source);
    // The angle keeps its sign, in degrees; no rotation input at 0.
    assert.equal(usd.rotation, degrees, `${degrees}: rotation`);
    if (!degrees) assert.doesNotMatch(source, /inputs:rotation/);
    assert.deepEqual(usd.scale, scale);
    // Derived translation: (ox + sin(r) sy, 1 - cos(r) sy - oy), written as Float32 text.
    const expected = [offset[0] + Math.sin(rotation) * scale[1], 1 - Math.cos(rotation) * scale[1] - offset[1]];
    for (let k = 0; k < 2; k++)
      assert.ok(Math.abs(usd.translation[k] - expected[k]) < 1e-6, `${degrees}: translation ${usd.translation}`);
    // Every sampled coordinate agrees: st' = (u', 1 - v').
    const rows = textureTransform({ offset, scale, rotation });
    for (let i = 0; i <= 8; i++)
      for (let j = 0; j <= 8; j++) {
        const u = i / 8 - 0.3,
          v = j / 8 + 0.1,
          [gu, gv] = gltfUV(rows, u, v),
          [s, t] = usdST(usd, u, 1 - v);
        assert.ok(Math.abs(s - gu) < 1e-5 && Math.abs(t - (1 - gv)) < 1e-5, `${degrees} deg at (${u}, ${v})`);
      }
    // The image's up (texture -v, st +t) as seen on the surface: a positive angle leans it clockwise (top to the right).
    const lean = Math.sign(Math.round(Math.sin(rotation) * 1e9)),
      r = (usd.rotation * Math.PI) / 180,
      upGLTF = inverse2([rows[0], rows[1], rows[4], rows[5]]),
      upUSD = inverse2([
        Math.cos(r) * usd.scale[0],
        -Math.sin(r) * usd.scale[1],
        Math.sin(r) * usd.scale[0],
        Math.cos(r) * usd.scale[1],
      ]);
    assert.equal(Math.sign(Math.round(-upGLTF[1] * 1e9)), lean, `${degrees}: glTF lean`); // u of M^-1 (0, -1)
    assert.equal(Math.sign(Math.round(upUSD[1] * 1e9)), lean, `${degrees}: USD lean`); // s of M^-1 (0, 1)
  }
});

test('USDZ rotation with offset, scale and mirror wrap samples the same texels of an F as gltf-pro', async () => {
  // An 8 x 8 "F" (row 0 at the top, glTF v down): no symmetry, so any turn or flip changes what is sampled.
  const F = ['........', '.#####..', '.#......', '.####...', '.#......', '.#......', '.#......', '........'];
  const repeat = (a) => a - Math.floor(a),
    mirror = (a) => 1 - Math.abs(a - 2 * Math.floor(a / 2) - 1),
    texel = (x, y) => F[Math.min(7, Math.floor(y * 8))][Math.min(7, Math.floor(x * 8))];
  const transform = { offset: [0.5, 0.1], scale: [4, 2], rotation: Math.PI / 6 },
    usd = transformInputs(await usda(exportUSDZ(rotatedScene(transform, 'mirror')))),
    rows = textureTransform(transform);
  assert.equal(usd.rotation, 30);
  let compared = 0;
  for (let i = 0; i < 64; i++)
    for (let j = 0; j < 64; j++) {
      const u = (i + 0.5) / 64,
        v = (j + 0.5) / 64,
        [gu, gv] = gltfUV(rows, u, v),
        [s, t] = usdST(usd, u, 1 - v),
        gx = repeat(gu),
        gy = mirror(gv),
        // USD: st (0, 0) is the image's bottom left, so the image row is 1 - t.
        ux = repeat(s),
        uy = 1 - mirror(t);
      // Skip samples within Float32 text precision of a texel edge.
      if ([gx, gy, ux, uy].some((c) => Math.abs(c * 8 - Math.round(c * 8)) < 1e-4)) continue;
      assert.equal(texel(ux, uy), texel(gx, gy), `texel at (${u}, ${v})`);
      compared++;
    }
  assert.ok(compared > 4000, `${compared} samples compared`);
});

test("USDZ rotation reproduces KHR_texture_transform's own example without gltf-pro: lower-left quarter, turned clockwise", async () => {
  // The extension's example: offset (0, 1), rotation pi/2, scale 0.5 "utilizes only the lower left quadrant of the
  // source image, rotated clockwise 90 degrees". Image points below are (x right, y down) fractions of the image.
  const usd = transformInputs(
    await usda(exportUSDZ(rotatedScene({ offset: [0, 1], scale: [0.5, 0.5], rotation: Math.PI / 2 }))),
  );
  assert.equal(usd.rotation, 90);
  const imagePoint = (u, v) => {
    const [s, t] = usdST(usd, u, 1 - v); // the exporter's V flip, then UsdTransform2d per the spec
    return [s, 1 - t].map((c) => Math.round(c * 1e5) / 1e5 + 0); // st (0, 0) is the image's bottom left
  };
  // The quad's top edge shows the quarter's left edge (read bottom to top): a clockwise turn.
  assert.deepEqual(imagePoint(0, 0), [0, 1]); // surface top left: the image's bottom-left corner
  assert.deepEqual(imagePoint(1, 0), [0, 0.5]); // surface top right: the quarter's top left
  assert.deepEqual(imagePoint(0, 1), [0.5, 1]); // surface bottom left: the quarter's bottom right
  assert.deepEqual(imagePoint(1, 1), [0.5, 0.5]); // surface bottom right: the image's centre
});

test('texture rotation reaches glTF as given, is validated, and leaves the archive readable', async () => {
  const transform = { offset: [0.5, 0.1], scale: [4, 2], rotation: -Math.PI / 6 };
  assert.deepEqual(
    glbJSON(exportGLB(rotatedScene(transform))).materials[0].pbrMetallicRoughness.baseColorTexture.extensions
      .KHR_texture_transform,
    { ...transform, offset: [0.5, Math.fround(0.1)] }, // offset and scale are Float32; the angle is written as given
  );
  const plain = glbJSON(exportGLB(rotatedScene({ offset: [0, 0], scale: [1, 1] })));
  assert.ok(!('rotation' in plain.materials[0].pbrMetallicRoughness.baseColorTexture.extensions.KHR_texture_transform));
  for (const rotation of [NaN, Infinity, 1e40, '0.5'])
    assert.throws(
      () => exportUSDZ(rotatedScene({ offset: [0, 0], scale: [1, 1], rotation })),
      (e) => e instanceof RangeError && /rotation/.test(e.message),
      String(rotation),
    );
  // Our own USD reader still opens the rotated archive (it does not read texture transforms).
  const asset = await readUSD(exportUSDZ(rotatedScene(transform)));
  assert.equal(asset.meshes.length, 1);
});
