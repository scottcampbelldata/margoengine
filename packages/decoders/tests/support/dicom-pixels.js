// Just enough DICOM (PS3.5, explicit VR little endian) to take the pixel data out of the test files.

/** Where the value of the PixelData element (7FE0,0010) starts, and its length (0xffffffff when encapsulated). */
function pixelData(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 132; at + 12 <= bytes.length; at += 2)
    if (view.getUint32(at, true) === 0x00107fe0 && bytes[at + 4] === 0x4f)
      return { view, at: at + 12, length: view.getUint32(at + 8, true) };
  throw new Error('no PixelData element');
}

/** The uncompressed pixel data of a file. */
export function nativePixels(bytes) {
  const { at, length } = pixelData(bytes);
  return bytes.slice(at, at + length);
}

/** The one frame of an encapsulated file: its fragments, after the offset table, joined (PS3.5 A.4). */
export function encapsulatedFrame(bytes) {
  let { view, at } = pixelData(bytes);
  const items = [];
  while (at + 8 <= bytes.length && view.getUint32(at, true) === 0xe000fffe) {
    const length = view.getUint32(at + 4, true);
    items.push(bytes.subarray(at + 8, at + 8 + length));
    at += 8 + length;
  }
  const fragments = items.slice(1),
    frame = new Uint8Array(fragments.reduce((sum, item) => sum + item.length, 0));
  let offset = 0;
  for (const item of fragments) {
    frame.set(item, offset);
    offset += item.length;
  }
  return frame;
}
