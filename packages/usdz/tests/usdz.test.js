import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { deflateRawSync, deflateSync } from 'node:zlib';
import { crc32 } from '@margoengine/loaders';
import { parseUSDA, parseUSDC, parseUSDZ } from '../dist/index.js';
const source = (await readFile(new URL('./fixtures/triangle.usda', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
function png(r, g, b) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  const chunk = (type, data) => {
    const name = Buffer.from(type),
      size = Buffer.alloc(4),
      crc = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
    return Buffer.concat([size, name, data, crc]);
  };
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, r, g, b, 255]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
function zip(files, method = 0) {
  let offset = 0;
  const locals = [],
    directory = [];
  for (const [name, data] of files) {
    const filename = Buffer.from(name),
      compressed = method === 8 ? deflateRawSync(data) : data,
      header = Buffer.alloc(30),
      central = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(method, 8);
    header.writeUInt32LE(crc32(data), 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(filename.length, 26);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(header, filename, compressed);
    directory.push(central, filename);
    offset += header.length + filename.length + compressed.length;
  }
  const cd = Buffer.concat(directory),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
test('USDA produces typed geometry, hierarchy and PreviewSurface PBR factors', () => {
  const asset = parseUSDA(source),
    mesh = asset.meshes[0];
  assert.ok(mesh.positions instanceof Float32Array);
  assert.ok(mesh.normals instanceof Float32Array);
  assert.deepEqual(Array.from(mesh.uvs), [0, 0, 1, 0, 0, 1]);
  assert.deepEqual(Array.from(mesh.indices), [0, 1, 2]);
  assert.deepEqual(asset.document.nodes[1].matrix.slice(12, 15), [1, 2, 3]);
  const material = asset.document.materials[0].pbrMetallicRoughness;
  assert.equal(material.roughnessFactor, 0.3);
  assert.equal(material.metallicFactor, 0.7);
  assert.deepEqual(material.baseColorFactor, [0.2, 0.4, 0.6, 1]);
});
test('synthetic OpenUSD Crate and USDA produce equivalent geometry and materials', async () => {
  const data = await readFile(new URL('./fixtures/triangle.usdc', import.meta.url)),
    binary = parseUSDC(data),
    ascii = parseUSDA(source);
  assert.deepEqual(binary.meshes[0].positions, ascii.meshes[0].positions);
  assert.deepEqual(binary.meshes[0].normals, ascii.meshes[0].normals);
  assert.deepEqual(binary.meshes[0].uvs, ascii.meshes[0].uvs);
  assert.deepEqual(binary.document.nodes[1].matrix, ascii.document.nodes[1].matrix);
  assert.ok(Math.abs(binary.document.materials[0].pbrMetallicRoughness.metallicFactor - 0.7) < 1e-6);
  const archive = await parseUSDZ(zip([['scene.usdc', data]], 8));
  assert.deepEqual(archive.meshes[0].positions, binary.meshes[0].positions);
});
test('stored and Deflate archives share geometry, validate CRC and enforce budgets', async () => {
  for (const method of [0, 8]) {
    const archive = zip([['scene.usda', Buffer.from(source)]], method);
    assert.equal((await parseUSDZ(archive)).meshes.length, 1);
    await assert.rejects(parseUSDZ(archive, { maxBytes: 20 }), /budget/);
  }
  const archive = zip([['scene.usda', Buffer.from(source)]]);
  archive[40] ^= 1;
  await assert.rejects(parseUSDZ(archive), /CRC/);
  await assert.rejects(parseUSDZ(zip([['../scene.usda', Buffer.from(source)]])), /escapes/);
  await assert.rejects(
    parseUSDZ(
      zip([
        ['scene.usda', Buffer.from(source)],
        ['scene.usda', Buffer.from(source)],
      ]),
    ),
    /duplicate/,
  );
  await assert.rejects(parseUSDZ(archive, { signal: AbortSignal.abort() }), /abort/i);
});
test('PreviewSurface texture channels map to glTF and missing assets fail', async () => {
  const shader = (name, file) =>
    `        def Shader "${name}"\n        {\n            uniform token info:id = "UsdUVTexture"\n            asset inputs:file = @${file}@\n        }\n`;
  const textured = source
    .replace(
      'color3f inputs:diffuseColor = (0.2, 0.4, 0.6)',
      'color3f inputs:diffuseColor.connect = </Root/Material/Diffuse.outputs:rgb>\n            normal3f inputs:normal.connect = </Root/Material/Normal.outputs:rgb>',
    )
    .replace('float inputs:roughness = 0.3', 'float inputs:roughness.connect = </Root/Material/Roughness.outputs:r>')
    .replace('float inputs:metallic = 0.7', 'float inputs:metallic.connect = </Root/Material/Metallic.outputs:b>')
    .replace(
      '    def Material "Material"\n    {\n',
      '    def Material "Material"\n    {\n' +
        shader('Diffuse', 'color.png') +
        shader('Normal', 'normal.png') +
        shader('Roughness', 'rough.png') +
        shader('Metallic', 'metal.png'),
    );
  const archive = zip(
      [
        ['scene.usda', Buffer.from(textured)],
        ['color.png', png(0, 255, 0)],
        ['normal.png', png(128, 128, 255)],
        ['rough.png', png(128, 0, 0)],
        ['metal.png', png(0, 0, 192)],
      ],
      8,
    ),
    asset = await parseUSDZ(archive),
    material = asset.document.materials[0],
    pbr = material.pbrMetallicRoughness;
  assert.deepEqual(pbr.baseColorFactor, [1, 1, 1, 1]);
  assert.equal(pbr.baseColorTexture.index, 0);
  assert.equal(material.normalTexture.index, 1);
  assert.equal(pbr.metallicRoughnessTexture.index, 2);
  assert.equal(pbr.roughnessFactor, 1);
  assert.equal(pbr.metallicFactor, 1);
  await assert.rejects(parseUSDZ(zip([['scene.usda', Buffer.from(textured)]])), /missing texture/);
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/usdz-textured.usdz', archive);
});
// Regression: the glTF document took st as uvs unflipped (textures drew upside down) and ignored UsdTransform2d and
// wrap modes. st (0, 0) is the image's bottom left; glTF uv (0, 0) its top left.
test('the glTF document flips st to uvs and keeps UsdTransform2d and wrap modes', async () => {
  const placed = (rotation) =>
    source
      .replace(
        'color3f inputs:diffuseColor = (0.2, 0.4, 0.6)',
        'color3f inputs:diffuseColor.connect = </Root/Material/Diffuse.outputs:rgb>',
      )
      .replace(
        '    def Material "Material"\n    {\n',
        '    def Material "Material"\n    {\n' +
          '        def Shader "UV"\n        {\n            uniform token info:id = "UsdPrimvarReader_float2"\n' +
          '            string inputs:varname = "st"\n            float2 outputs:result\n        }\n' +
          '        def Shader "Place"\n        {\n            uniform token info:id = "UsdTransform2d"\n' +
          '            float2 inputs:in.connect = </Root/Material/UV.outputs:result>\n' +
          (rotation === undefined ? '' : `            float inputs:rotation = ${rotation}\n`) +
          '            float2 inputs:scale = (4, 2)\n            float2 inputs:translation = (1, -0.5)\n' +
          '            float2 outputs:result\n        }\n' +
          '        def Shader "Diffuse"\n        {\n            uniform token info:id = "UsdUVTexture"\n' +
          '            asset inputs:file = @color.png@\n' +
          '            float2 inputs:st.connect = </Root/Material/Place.outputs:result>\n' +
          '            token inputs:wrapS = "mirror"\n            token inputs:wrapT = "clamp"\n        }\n',
      );
  const read = (layer) =>
    parseUSDZ(
      zip([
        ['scene.usda', Buffer.from(layer)],
        ['color.png', png(0, 255, 0)],
      ]),
    );
  const asset = await read(placed(30)),
    doc = asset.document,
    accessor = doc.meshes[0].primitives[0].attributes.TEXCOORD_0,
    uvs = asset.buffers[doc.accessors[accessor].bufferView];
  // st [(0, 0), (1, 0), (0, 1)] stays as authored on the mesh; the document's uvs are (s, 1 - t).
  assert.deepEqual(Array.from(asset.meshes[0].uvs), [0, 0, 1, 0, 0, 1]);
  assert.deepEqual(Array.from(uvs), [0, 1, 1, 1, 0, 0]);
  const info = doc.materials[0].pbrMetallicRoughness.baseColorTexture,
    t = info.extensions.KHR_texture_transform,
    r = Math.PI / 6;
  assert.deepEqual(doc.extensionsUsed, ['KHR_texture_transform']);
  assert.ok(Math.abs(t.rotation - r) < 1e-12);
  assert.deepEqual(t.scale, [4, 2]);
  // Offset (tx - sin(r) sy, 1 - cos(r) sy - ty), so glTF uv' = O + R S uv, R = [[c, s], [-s, c]], equals
  // (s', 1 - t') of UsdTransform2d's st' = R_ccw S st + T at every point.
  for (const [s0, t0] of [
    [0, 0],
    [1, 0],
    [0.3, 0.8],
    [-2, 5],
  ]) {
    const c = Math.cos(r),
      n = Math.sin(r),
      st = [c * 4 * s0 - n * 2 * t0 + 1, n * 4 * s0 + c * 2 * t0 - 0.5],
      u = s0,
      v = 1 - t0,
      uv = [c * 4 * u + n * 2 * v + t.offset[0], -n * 4 * u + c * 2 * v + t.offset[1]];
    assert.ok(Math.abs(uv[0] - st[0]) < 1e-9 && Math.abs(uv[1] - (1 - st[1])) < 1e-9, `at (${s0}, ${t0})`);
  }
  assert.deepEqual(doc.samplers[doc.textures[info.index].sampler], { wrapS: 33648, wrapT: 33071 });
  // No rotation authored: rotation 0, offset (tx, 1 - sy - ty).
  const plain = (await read(placed())).document.materials[0].pbrMetallicRoughness.baseColorTexture.extensions
    .KHR_texture_transform;
  assert.deepEqual(plain, { offset: [1, 1 - 2 + 0.5], rotation: 0, scale: [4, 2] });
  // Untransformed, repeat-wrapped textures stay plain glTF texture infos.
  const untouched = parseUSDA(source).document;
  assert.equal(untouched.samplers, undefined);
  assert.equal(untouched.extensionsUsed, undefined);
});
test('malformed streams, unsupported USD features and Crate table bounds fail explicitly', async () => {
  assert.throws(() => parseUSDA(source.replace('[0, 1, 2]', '[0, 1, 9]')), /index/);
  assert.throws(() => parseUSDA(source, { maxVertices: 2 }), /limit/);
  assert.throws(() => parseUSDA(source.replace('"none"', '"catmullClark"')), /subdivision/);
  assert.throws(() => parseUSDA(source.replace('def Xform', 'over Xform')), /no renderable/);
  assert.throws(() => parseUSDA(source + '\n# references'), /composition/);
  const bytes = await readFile(new URL('./fixtures/triangle.usdc', import.meta.url)),
    bad = Buffer.from(bytes);
  bad.writeBigUInt64LE(BigInt(bytes.length + 1), 16);
  assert.throws(() => parseUSDC(bad), /TOC/);
  const toc = Number(bytes.readBigUInt64LE(16));
  const count = Buffer.from(bytes);
  count.writeBigUInt64LE(100000000n, toc);
  assert.throws(() => parseUSDC(count), /sections/);
  assert.throws(() => parseUSDC(bytes.subarray(0, 20)), /truncated/);
});

test('malformed layers throw a LoaderError for format USD with a code to branch on', () => {
  const caught = (run) => {
    try {
      run();
    } catch (error) {
      return error;
    }
    return assert.fail('expected an error');
  };
  const truncated = caught(() => parseUSDC(new Uint8Array(20)));
  assert.equal(truncated.name, 'LoaderError');
  assert.equal(truncated.format, 'USD');
  assert.equal(truncated.code, 'syntax');
  assert.match(truncated.message, /^USD: /);
  assert.equal(caught(() => parseUSDA(source, { maxBytes: 8 })).code, 'limit');
});

const painted = (surface, primvars = '') => `#usda 1.0
(
  metersPerUnit = 1
  upAxis = "Y"
)
def Mesh "M" (apiSchemas = ["MaterialBindingAPI"]) {
  point3f[] points = [(0,0,0),(1,0,0),(0,1,0)]
  int[] faceVertexCounts = [3]
  int[] faceVertexIndices = [0,1,2]
  uniform token subdivisionScheme = "none"
  ${primvars}
  rel material:binding = </Paint>
}
def Material "Paint" {
  token outputs:surface.connect = </Paint/Surface.outputs:surface>
  def Shader "Surface" {
    uniform token info:id = "UsdPreviewSurface"
    ${surface}
    token outputs:surface
  }
  def Shader "Color" {
    uniform token info:id = "UsdPrimvarReader_float3"
    string inputs:varname = "displayColor"
    float3 inputs:fallback = (0.5, 0.25, 1)
    float3 outputs:result
  }
  def Shader "Opacity" {
    uniform token info:id = "UsdPrimvarReader_float"
    string inputs:varname = "displayOpacity"
    float inputs:fallback = 1
    float outputs:result
  }
  def Shader "Other" {
    uniform token info:id = "UsdPrimvarReader_float3"
    string inputs:varname = "wetness"
    float3 outputs:result
  }
  def Shader "Map" {
    uniform token info:id = "UsdUVTexture"
    asset inputs:file = @tile.png@
    float3 outputs:rgb
    float outputs:a
  }
  def Shader "Second" {
    uniform token info:id = "UsdUVTexture"
    asset inputs:file = @other.png@
    float outputs:a
  }
}
`;
const toColor = 'color3f inputs:diffuseColor.connect = </Paint/Color.outputs:result>';
const toOpacity = 'float inputs:opacity.connect = </Paint/Opacity.outputs:result>';
const colorsOf = (asset) => [...asset.meshes[0].colors].map((v) => Number(v.toFixed(3)));

test('vertex colors read through a UsdPrimvarReader load as COLOR_0', () => {
  const asset = parseUSDA(
      painted(toColor, 'color3f[] primvars:displayColor = [(1,0,0),(0,1,0),(0,0,1)] (interpolation = "vertex")'),
    ),
    { document } = asset,
    primitive = document.meshes[0].primitives[0];
  assert.deepEqual(colorsOf(asset), [1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1]);
  assert.equal(document.accessors[primitive.attributes.COLOR_0].type, 'VEC4');
  assert.equal(document.accessors[primitive.attributes.COLOR_0].count, 3);
  assert.deepEqual(document.materials[0].pbrMetallicRoughness.baseColorFactor, [1, 1, 1, 1]);
  assert.equal(document.materials[0].alphaMode, 'OPAQUE');
});

test('vertex opacity blends, indexed primvars resolve and a mesh without the primvar takes the fallback', () => {
  const asset = parseUSDA(
    painted(
      `${toColor}\n${toOpacity}`,
      `color3f[] primvars:displayColor = [(1,0,0),(0,0,1)] (interpolation = "vertex")
  int[] primvars:displayColor:indices = [1,0,1]
  float[] primvars:displayOpacity = [0.5,0.25,1] (interpolation = "vertex")`,
    ),
  );
  assert.deepEqual(colorsOf(asset), [0, 0, 1, 0.5, 1, 0, 0, 0.25, 0, 0, 1, 1]);
  assert.equal(asset.document.materials[0].alphaMode, 'BLEND');
  assert.deepEqual(colorsOf(parseUSDA(painted(toColor))).slice(0, 4), [0.5, 0.25, 1, 1]);
  assert.throws(
    () => parseUSDA(painted(toColor, 'int[] primvars:displayColor:indices = [0,0,9]\n  color3f[] primvars:displayColor = [(1,0,0)]')),
    /index outside stream/,
  );
});

test('a reader of any other primvar stays refused', () => {
  assert.throws(
    () => parseUSDA(painted('color3f inputs:diffuseColor.connect = </Paint/Other.outputs:result>')),
    /unsupported primvar reader/,
  );
});

test('opacity from the base colour map and a threshold keep the alpha mode', async () => {
  const map = 'color3f inputs:diffuseColor.connect = </Paint/Map.outputs:rgb>\n float inputs:opacity.connect = </Paint/Map.outputs:a>',
    packed = (layer) =>
      zip([
        ['scene.usda', Buffer.from(layer)],
        ['tile.png', png(1, 2, 3)],
        ['other.png', png(4, 5, 6)],
      ]),
    blend = (await parseUSDZ(packed(painted(map)))).document.materials[0],
    mask = (await parseUSDZ(packed(painted(`${map}\n float inputs:opacityThreshold = 0.25`)))).document.materials[0],
    constant = parseUSDA(painted('float inputs:opacity = 0.5\n float inputs:opacityThreshold = 0.75')).document.materials[0];
  assert.equal(blend.alphaMode, 'BLEND');
  assert.equal(mask.alphaMode, 'MASK');
  assert.equal(mask.alphaCutoff, 0.25);
  assert.equal(constant.alphaMode, 'MASK');
  await assert.rejects(
    parseUSDZ(packed(painted(`${map.split('\n')[0]}\n float inputs:opacity.connect = </Paint/Second.outputs:a>`))),
    /unsupported opacity texture/,
  );
});
