// PNG encoding for exportModel, loaded with import() only when a texture has no encoded bytes or must shrink.

const raw = (s: any): boolean => s?.data instanceof Uint8Array || s?.data instanceof Uint8ClampedArray;
const crcTable = /* @__PURE__ */ Int32Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n;
});

/**
 * RGBA8 PNG (Sub filter, zlib from CompressionStream) of a texture source, at most `max` pixels on its longer side.
 * Raw `{data, width, height}` rows encode directly (anywhere) and never flip, as @margoengine/materials uploads them;
 * other sources and resizing draw through an OffscreenCanvas.
 */
export async function png(source: any, max: number, flipY: boolean): Promise<Uint8Array> {
  flipY &&= !raw(source);
  const w = source.videoWidth ?? source.displayWidth ?? source.naturalWidth ?? source.width,
    h = source.videoHeight ?? source.displayHeight ?? source.naturalHeight ?? source.height;
  const scale = Math.min(1, max / Math.max(w, h)),
    W = Math.max(1, Math.round(w * scale)),
    H = Math.max(1, Math.round(h * scale));
  let rgba: Uint8Array | Uint8ClampedArray = source.data;
  if (!raw(source) || scale < 1) {
    if (typeof OffscreenCanvas !== 'function')
      throw new TypeError('Encoding this texture needs OffscreenCanvas (a browser or worker)');
    let image = source;
    if (raw(source)) {
      image = new OffscreenCanvas(w, h);
      image
        .getContext('2d')
        .putImageData(new ImageData(new Uint8ClampedArray(source.data.subarray(0, w * h * 4)), w, h), 0, 0);
    }
    const context = new OffscreenCanvas(W, H).getContext('2d')!;
    if (flipY) {
      context.translate(0, H);
      context.scale(1, -1);
    }
    context.drawImage(image, 0, 0, W, H);
    rgba = context.getImageData(0, 0, W, H).data;
  }
  const stride = W * 4,
    rows = new Uint8Array((stride + 1) * H);
  for (let y = 0; y < H; y++) {
    const o = y * (stride + 1),
      i = y * stride;
    rows[o] = 1;
    for (let x = 0; x < stride; x++) rows[o + 1 + x] = rgba[i + x] - (x < 4 ? 0 : rgba[i + x - 4]);
  }
  const zlib = new Uint8Array(
    await new Response(new Blob([rows]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer(),
  );
  const parts: Uint8Array[] = [Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10)],
    header = new DataView(new ArrayBuffer(13));
  header.setUint32(0, W);
  header.setUint32(4, H);
  header.setUint8(8, 8);
  header.setUint8(9, 6);
  for (const [type, data] of [
    ['IHDR', new Uint8Array(header.buffer)],
    ['IDAT', zlib],
    ['IEND', new Uint8Array()],
  ] as const) {
    const chunk = new Uint8Array(data.length + 12),
      view = new DataView(chunk.buffer);
    view.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) chunk[4 + i] = type.charCodeAt(i);
    chunk.set(data, 8);
    let c = -1;
    for (let i = 4; i < data.length + 8; i++) c = crcTable[(c ^ chunk[i]) & 255] ^ (c >>> 8);
    view.setUint32(data.length + 8, ~c >>> 0);
    parts.push(chunk);
  }
  return new Uint8Array(await new Blob(parts as Uint8Array<ArrayBuffer>[]).arrayBuffer());
}
