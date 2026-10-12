import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { deflateRawSync, deflateSync } from "node:zlib";
import { crc32 } from "@margoengine/loaders";
import { parseUSDA, parseUSDC, parseUSDZ } from "../dist/index.js";
const source = (await readFile(
  new URL("./fixtures/triangle.usda", import.meta.url),
  "utf8",
)).replace(/\r\n/g, "\n");
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
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.from([0, r, g, b, 255]))),
    chunk("IEND", Buffer.alloc(0)),
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
test("USDA produces typed geometry, hierarchy and PreviewSurface PBR factors", () => {
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
test("synthetic OpenUSD Crate and USDA produce equivalent geometry and materials", async () => {
  const data = await readFile(
      new URL("./fixtures/triangle.usdc", import.meta.url),
    ),
    binary = parseUSDC(data),
    ascii = parseUSDA(source);
  assert.deepEqual(binary.meshes[0].positions, ascii.meshes[0].positions);
  assert.deepEqual(binary.meshes[0].normals, ascii.meshes[0].normals);
  assert.deepEqual(binary.meshes[0].uvs, ascii.meshes[0].uvs);
  assert.deepEqual(
    binary.document.nodes[1].matrix,
    ascii.document.nodes[1].matrix,
  );
  assert.ok(
    Math.abs(
      binary.document.materials[0].pbrMetallicRoughness.metallicFactor - 0.7,
    ) < 1e-6,
  );
  const archive = await parseUSDZ(zip([["scene.usdc", data]], 8));
  assert.deepEqual(archive.meshes[0].positions, binary.meshes[0].positions);
});
test("stored and Deflate archives share geometry, validate CRC and enforce budgets", async () => {
  for (const method of [0, 8]) {
    const archive = zip([["scene.usda", Buffer.from(source)]], method);
    assert.equal((await parseUSDZ(archive)).meshes.length, 1);
    await assert.rejects(parseUSDZ(archive, { maxBytes: 20 }), /budget/);
  }
  const archive = zip([["scene.usda", Buffer.from(source)]]);
  archive[40] ^= 1;
  await assert.rejects(parseUSDZ(archive), /CRC/);
  await assert.rejects(
    parseUSDZ(zip([["../scene.usda", Buffer.from(source)]])),
    /escapes/,
  );
  await assert.rejects(
    parseUSDZ(
      zip([
        ["scene.usda", Buffer.from(source)],
        ["scene.usda", Buffer.from(source)],
      ]),
    ),
    /duplicate/,
  );
  await assert.rejects(
    parseUSDZ(archive, { signal: AbortSignal.abort() }),
    /abort/i,
  );
});
test("PreviewSurface texture channels map to glTF and missing assets fail", async () => {
  const shader = (name, file) =>
    `        def Shader "${name}"\n        {\n            uniform token info:id = "UsdUVTexture"\n            asset inputs:file = @${file}@\n        }\n`;
  const textured = source
    .replace(
      "color3f inputs:diffuseColor = (0.2, 0.4, 0.6)",
      "color3f inputs:diffuseColor.connect = </Root/Material/Diffuse.outputs:rgb>\n            normal3f inputs:normal.connect = </Root/Material/Normal.outputs:rgb>",
    )
    .replace(
      "float inputs:roughness = 0.3",
      "float inputs:roughness.connect = </Root/Material/Roughness.outputs:r>",
    )
    .replace(
      "float inputs:metallic = 0.7",
      "float inputs:metallic.connect = </Root/Material/Metallic.outputs:b>",
    )
    .replace(
      '    def Material "Material"\n    {\n',
      '    def Material "Material"\n    {\n' +
        shader("Diffuse", "color.png") +
        shader("Normal", "normal.png") +
        shader("Roughness", "rough.png") +
        shader("Metallic", "metal.png"),
    );
  const archive = zip(
      [
        ["scene.usda", Buffer.from(textured)],
        ["color.png", png(0, 255, 0)],
        ["normal.png", png(128, 128, 255)],
        ["rough.png", png(128, 0, 0)],
        ["metal.png", png(0, 0, 192)],
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
  await assert.rejects(
    parseUSDZ(zip([["scene.usda", Buffer.from(textured)]])),
    /missing texture/,
  );
  await mkdir("test-results", { recursive: true });
  await writeFile("test-results/usdz-textured.usdz", archive);
});
test("malformed streams, unsupported USD features and Crate table bounds fail explicitly", async () => {
  assert.throws(
    () => parseUSDA(source.replace("[0, 1, 2]", "[0, 1, 9]")),
    /index/,
  );
  assert.throws(() => parseUSDA(source, { maxVertices: 2 }), /limit/);
  assert.throws(
    () => parseUSDA(source.replace('"none"', '"catmullClark"')),
    /subdivision/,
  );
  assert.throws(
    () => parseUSDA(source.replace("def Xform", "over Xform")),
    /no renderable/,
  );
  assert.throws(() => parseUSDA(source + "\n# references"), /composition/);
  const bytes = await readFile(
      new URL("./fixtures/triangle.usdc", import.meta.url),
    ),
    bad = Buffer.from(bytes);
  bad.writeBigUInt64LE(BigInt(bytes.length + 1), 16);
  assert.throws(() => parseUSDC(bad), /TOC/);
  const toc = Number(bytes.readBigUInt64LE(16));
  const count = Buffer.from(bytes);
  count.writeBigUInt64LE(100000000n, toc);
  assert.throws(() => parseUSDC(count), /sections/);
  assert.throws(() => parseUSDC(bytes.subarray(0, 20)), /truncated/);
});
