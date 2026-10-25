// Builds examples/assets/scifi-helmet.glb from the Khronos SciFiHelmet sample (CC0 1.0) in
// examples/assets/khronos/SciFiHelmet: one GLB with 1024x1024 JPEG textures, about the size of a typical
// web model. Used by tests and benchmarks that need a textured PBR model with tangents.
// Run: node scripts/build-scifi-helmet.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';

const dir = new URL('../examples/assets/khronos/SciFiHelmet/', import.meta.url);
const out = new URL('../examples/assets/scifi-helmet.glb', import.meta.url);
const gltf = JSON.parse(readFileSync(new URL('SciFiHelmet.gltf', dir), 'utf8'));
const bin = readFileSync(new URL(gltf.buffers[0].uri, dir));

const align = (n) => (n + 3) & ~3;
const chunks = [];
let offset = 0;
const push = (bytes) => {
  const start = offset;
  chunks.push(bytes);
  offset += bytes.length;
  const pad = align(offset) - offset;
  if (pad) {
    chunks.push(Buffer.alloc(pad));
    offset += pad;
  }
  return start;
};

push(bin);
for (const image of gltf.images) {
  const jpeg = await sharp(readFileSync(new URL(image.uri, dir)))
    .resize(1024, 1024)
    .jpeg({ quality: 90, chromaSubsampling: '4:4:4' })
    .toBuffer();
  const byteOffset = push(jpeg);
  image.bufferView = gltf.bufferViews.push({ buffer: 0, byteOffset, byteLength: jpeg.length }) - 1;
  image.mimeType = 'image/jpeg';
  delete image.uri;
}

gltf.asset = {
  version: '2.0',
  generator: 'margoengine scripts/build-scifi-helmet.mjs',
  copyright: 'Michael Pavlovic, Norbert Nopper (CC0 1.0)',
};
gltf.nodes = [gltf.nodes.find((node) => node.mesh === 0)];
gltf.scenes = [{ nodes: [0] }];
gltf.buffers = [{ byteLength: offset }];

let json = Buffer.from(JSON.stringify(gltf));
json = Buffer.concat([json, Buffer.alloc(align(json.length) - json.length, 0x20)]);
const body = Buffer.concat(chunks);
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0);
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + json.length + 8 + body.length, 8);
const chunk = (length, type) => {
  const b = Buffer.alloc(8);
  b.writeUInt32LE(length, 0);
  b.writeUInt32LE(type, 4);
  return b;
};
writeFileSync(out, Buffer.concat([header, chunk(json.length, 0x4e4f534a), json, chunk(body.length, 0x004e4942), body]));
console.log(`wrote ${out.pathname} (${12 + 16 + json.length + body.length} bytes)`);
