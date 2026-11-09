// Clean-room glTF 2.0 container packing for the standard reference assets, not a geometry conversion.
import assert from 'node:assert/strict';

/** Pack externally supplied buffers/images into one GLB, retaining geometry, materials and scene graph verbatim. */
export function packGLTF(input, buffers, images) {
  const doc = structuredClone(input),
    parts = [],
    offsets = [];
  let length = 0;
  const append = (bytes) => {
    const data = Buffer.from(bytes),
      offset = length,
      padding = (4 - (data.length % 4)) % 4;
    parts.push(data, Buffer.alloc(padding));
    length += data.length + padding;
    return offset;
  };
  assert.equal(doc.buffers.length, buffers.length, 'Supply every original buffer');
  for (const [index, bytes] of buffers.entries()) {
    assert.equal(bytes.byteLength, doc.buffers[index].byteLength, 'Original buffer length changed');
    offsets.push(append(bytes));
  }
  for (const view of doc.bufferViews ?? []) {
    assert.ok(Number.isInteger(view.buffer) && view.buffer >= 0 && view.buffer < buffers.length);
    assert.ok(Number.isInteger(view.byteOffset ?? 0) && (view.byteOffset ?? 0) >= 0);
    assert.ok(Number.isInteger(view.byteLength) && view.byteLength >= 0);
    assert.ok((view.byteOffset ?? 0) + view.byteLength <= buffers[view.buffer].byteLength);
    view.byteOffset = (view.byteOffset ?? 0) + offsets[view.buffer];
    view.buffer = 0;
  }
  doc.bufferViews ??= [];
  for (const [index, image] of (doc.images ?? []).entries()) {
    if (image.uri === undefined) continue;
    const data = images[index];
    assert.ok(data && ['image/png', 'image/jpeg'].includes(data.mimeType), 'Supply the original image and MIME type');
    image.bufferView =
      doc.bufferViews.push({ buffer: 0, byteOffset: append(data.bytes), byteLength: data.bytes.length }) - 1;
    delete image.uri;
    image.mimeType = data.mimeType;
  }
  doc.buffers = [{ byteLength: length }];
  const text = Buffer.from(JSON.stringify(doc));
  const json = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 32)]);
  const bin = Buffer.concat(parts),
    out = Buffer.alloc(28 + json.length + bin.length);
  out.writeUInt32LE(0x46546c67, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(json.length, 12);
  out.writeUInt32LE(0x4e4f534a, 16);
  json.copy(out, 20);
  out.writeUInt32LE(bin.length, 20 + json.length);
  out.writeUInt32LE(0x004e4942, 24 + json.length);
  bin.copy(out, 28 + json.length);
  return out;
}
