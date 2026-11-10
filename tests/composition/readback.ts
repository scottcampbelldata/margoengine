/** Copy actual texture values on either device backend, including an XR eye's array layer. */
export async function readTexture(device: GPUDevice, texture: GPUTexture, layer = 0) {
  const row = Math.ceil((texture.width * 4) / 256) * 256;
  const buffer = device.createBuffer({ size: row * texture.height, usage: 1 | 8 });
  try {
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer(
      {
        texture,
        origin: [0, 0, layer],
        ...(texture.format === 'depth32float' ? { aspect: 'depth-only' as const } : {}),
      },
      { buffer, bytesPerRow: row },
      [texture.width, texture.height],
    );
    device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(1);
    const copy = buffer.getMappedRange().slice(0),
      floats = new Float32Array(copy),
      bytes = new Uint8Array(copy);
    return {
      depth: (x: number, y: number) => floats[(y * row) / 4 + x],
      rgba: (x: number, y: number) =>
        [0, 1, 2, 3].map((c) => bytes[y * row + x * 4 + (texture.format.startsWith('bgra') && c < 3 ? 2 - c : c)]),
    };
  } finally {
    buffer.destroy();
  }
}
