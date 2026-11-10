// Native canvas codecs, decoded by the browser, with GLB source/fallback metadata checked independently.
export async function textureBrowserChecks() {
  const { encodeTexture, textureFormatSupported, transformTextures } = await import('@margoengine/exporters/textures');
  const { exportGLB, splitGLB } = await import('@margoengine/exporters');
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const source = { width: 16, height: 8, data: Uint8Array.from({ length: 16 * 8 * 4 }, (_, i) => [180, 90, 30, 255][i % 4]) };
  const png = await encodeTexture(source, { format: 'png' });
  const glb = exportGLB({ nodes: [{
    geometry: { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), uvs: new Float32Array([0, 0, 1, 0, 0, 1]), indices: [0, 1, 2] },
    material: { baseColorTexture: { image: png.data, mimeType: 'image/png' } },
  }] });
  const result = {};
  for (const format of ['webp', 'avif']) {
    const supported = await textureFormatSupported(format);
    if (!supported) {
      const error = await encodeTexture(source, { format }).catch(error => error);
      assert(error.code === 'unsupported' && error.message.includes(`image/${format}`), `${format}: missing encoder must be named`);
      result[format] = { supported: false, code: error.code };
      continue;
    }
    const output = await encodeTexture(source, { format, maxSize: 8, quality: 1 });
    const bitmap = await createImageBitmap(new Blob([output.data], { type: output.mimeType }));
    assert(bitmap.width === 8 && bitmap.height === 4, `${format}: native decoder dimensions`);
    const context = new OffscreenCanvas(8, 4).getContext('2d');
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    const value = context.getImageData(4, 2, 1, 1).data;
    for (let c = 0; c < 3; c++) assert(Math.abs(value[c] - source.data[c]) <= 3, `${format}: solid colour fidelity ${value}`);
    const processed = await transformTextures(glb, { format, maxSize: 8, fallback: 'png' });
    const { json, bin } = splitGLB(processed.glb), texture = json.textures[0], extension = `EXT_texture_${format}`;
    assert(processed.transformed === 1 && json.images.length === 2, `${format}: GLB image count`);
    assert(json.extensionsUsed.includes(extension) && !json.extensionsRequired?.includes(extension), `${format}: optional fallback flags`);
    for (const index of [texture.source, texture.extensions[extension].source]) {
      const image = json.images[index], view = json.bufferViews[image.bufferView];
      const bytes = bin.slice(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
      const decoded = await createImageBitmap(new Blob([bytes], { type: image.mimeType }));
      assert(decoded.width === 8 && decoded.height === 4, `${format}: fallback and extension dimensions match`);
      decoded.close();
    }
    const required = splitGLB((await transformTextures(glb, { format })).glb).json;
    assert(required.extensionsRequired.includes(extension) && required.textures[0].source === undefined, `${format}: required without fallback`);
    result[format] = { supported: true, bytes: output.data.length, glbBytes: processed.glb.length };
  }
  assert(result.webp.supported, 'Chromium WebP encoder must be exercised');
  // Exercise DOM canvas fallback in the same runtime, including an unsupported type substitution.
  const native = globalThis.OffscreenCanvas;
  try {
    globalThis.OffscreenCanvas = undefined;
    const dom = await encodeTexture(source, { format: 'webp' });
    assert(dom.mimeType === 'image/webp' && dom.data.length > 0, 'DOM toBlob WebP');
    result.domWebP = dom.data.length;
  } finally { globalThis.OffscreenCanvas = native; }
  return result;
}
