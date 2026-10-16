import { materialQuad } from './materials-fixture.js';

/** Existing five-attribute quad, with one independently selectable PBR texture channel. */
export function textureQuad(
  channel = 'base',
  transform,
  { bake = false, texCoord = 0, tangents = true, required = false } = {},
) {
  const fixture = materialQuad(),
    { doc, buffers } = fixture,
    material = doc.materials[0];
  material.pbrMetallicRoughness.baseColorFactor = [0.6, 0.5, 0.4, 1];
  material.pbrMetallicRoughness.metallicFactor = 0.6;
  material.pbrMetallicRoughness.roughnessFactor = 0.7;
  material.emissiveFactor = channel === 'emissive' ? [0.5, 0.5, 0.5] : [0, 0, 0];
  const info = {
    index: 0,
    texCoord,
    ...(transform ? { extensions: { KHR_texture_transform: structuredClone(transform) } } : {}),
  };
  const pbr = material.pbrMetallicRoughness;
  if (channel === 'base') pbr.baseColorTexture = info;
  else if (channel === 'metalRough') pbr.metallicRoughnessTexture = info;
  else if (channel === 'normal') material.normalTexture = info;
  else if (channel === 'occlusion') material.occlusionTexture = info;
  else if (channel === 'emissive') material.emissiveTexture = info;
  else throw new TypeError('Unknown fixture texture channel');
  doc.images = [{ uri: 'checker.png' }];
  doc.textures = [{ source: 0, sampler: 0 }];
  doc.samplers = [{ magFilter: 9728, minFilter: 9728, wrapS: 10497, wrapT: 10497 }];
  const attributes = doc.meshes[0].primitives[0].attributes;
  if (!tangents) delete attributes.TANGENT;
  if (transform && required) {
    doc.extensionsUsed = ['KHR_texture_transform'];
    doc.extensionsRequired = ['KHR_texture_transform'];
  }
  if (transform && bake) {
    const effective = transform.texCoord ?? texCoord,
      index = attributes['TEXCOORD_' + effective],
      uv = buffers[index];
    const [sx, sy] = transform.scale ?? [1, 1],
      [ox, oy] = transform.offset ?? [0, 0],
      rotation = transform.rotation ?? 0,
      c = Math.cos(rotation),
      s = Math.sin(rotation);
    // KHR_texture_transform uses the glTF upper-left UV origin: positive rotation
    // sends the positive U axis toward negative V before the offset is applied.
    const a = Math.fround(c * sx),
      b = Math.fround(s * sy),
      d = Math.fround(-s * sx),
      e = Math.fround(c * sy);
    for (let i = 0; i < uv.length; i += 2) {
      const u = uv[i],
        v = uv[i + 1];
      uv[i] = a * u + b * v + ox;
      uv[i + 1] = d * u + e * v + oy;
    }
    info.texCoord = effective;
    delete info.extensions;
    delete doc.extensionsUsed;
    delete doc.extensionsRequired;
    // A transformed normal reconstructs its tangent basis from transformed UV derivatives.
    if (channel === 'normal') delete attributes.TANGENT;
  }
  return fixture;
}

/** Deterministic linear/sRGB marker image; each PBR channel varies across both UV axes. */
export const texturePixels = Uint8Array.from(
  Array.from({ length: 16 }, (_, i) => {
    const x = i % 4,
      y = Math.floor(i / 4);
    return [64 + x * 48, 48 + y * 48, 176 + ((x + y) % 3) * 32, 255];
  }).flat(),
);

/** A real BasisU glTF path with data-URI geometry and optional ordinary-image fallback. */
export function basisTextureQuad({ colorURI, normalURI, fallbackURI } = {}) {
  const fixture = materialQuad(),
    { doc, buffers } = fixture;
  for (let i = 0; i < buffers.length; i++)
    doc.buffers[i].uri =
      'data:application/octet-stream;base64,' +
      Buffer.from(buffers[i].buffer, buffers[i].byteOffset, buffers[i].byteLength).toString('base64');
  doc.extensionsUsed = ['KHR_texture_basisu'];
  doc.extensionsRequired = ['KHR_texture_basisu'];
  doc.images = [];
  doc.textures = [];
  doc.samplers = [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }];
  const add = (uri) => {
    const source = doc.images.length;
    doc.images.push({ uri, mimeType: 'image/ktx2' });
    return source;
  };
  if (colorURI) {
    const fallback = fallbackURI === undefined ? undefined : doc.images.push({ uri: fallbackURI }) - 1;
    const source = add(colorURI);
    doc.textures.push({
      sampler: 0,
      ...(fallback === undefined ? {} : { source: fallback }),
      extensions: { KHR_texture_basisu: { source } },
    });
    doc.materials[0].pbrMetallicRoughness.baseColorFactor = [1, 1, 1, 1];
    doc.materials[0].pbrMetallicRoughness.baseColorTexture = { index: 0 };
  }
  if (normalURI) {
    const source = add(normalURI),
      index = doc.textures.length;
    doc.textures.push({ sampler: 0, extensions: { KHR_texture_basisu: { source } } });
    doc.materials[0].normalTexture = { index };
  }
  return fixture;
}
