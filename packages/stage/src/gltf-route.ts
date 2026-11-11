import type { GLTFDocument } from '../../shared/gltf.js';
import { glbChunks, isGLB } from '../../shared/glb.js';
import { parseJSON } from '../../shared/json.js';
import { readResponse } from '../../shared/loading.js';
import { fault, typeError } from '../../shared/errors.js';
import { rejectLFSPointer } from '../../shared/lfs.js';
import { optionalPackage } from './feature.js';

/** Inspect the container's feature declarations; the selected loader owns validation and external resources. */
export async function gltfRoute(target: URL, signal: AbortSignal) {
  if (!['http:', 'https:'].includes(target.protocol)) throw typeError('glTF URL must use HTTP(S)', 'arguments');
  const get = globalThis.fetch,
    response = await get(target, { signal }),
    // gltf-pro's default download budget: a file the advanced loader takes is not refused here first.
    bytes = await readResponse(response, { maxBytes: 512 * 1024 * 1024, signal, label: 'glTF download' });
  // A pointer from a clone without Git LFS would otherwise fail below as invalid JSON.
  rejectLFSPointer(bytes, target.href);
  const doc = parseJSON<GLTFDocument>(
      new TextDecoder('utf-8', { fatal: true }).decode(isGLB(bytes) ? glbChunks(bytes)[0].data : bytes),
    );
  let feature = '',
    animation = '',
    vertices = 0;
  if (doc.animations?.length) animation = 'animation clips';
  if (doc.skins?.length) animation = 'skins';
  for (const mesh of doc.meshes ?? [])
    for (const primitive of mesh.primitives ?? []) {
      if (primitive.targets?.length) animation = 'morph targets';
      if ((primitive.mode ?? 4) !== 4) feature = 'points or lines';
      if (Object.keys(primitive.attributes ?? {}).some((key) => /^(COLOR|JOINTS|WEIGHTS)_/.test(key)))
        feature = 'vertex colors or skin attributes';
      for (const name of ['POSITION', 'NORMAL']) {
        const id = primitive.attributes?.[name],
          accessor = id === undefined ? undefined : doc.accessors?.[id];
        if (accessor && (accessor.componentType !== 5126 || accessor.normalized)) feature = 'quantized attributes';
      }
      const id =
        primitive.attributes?.NORMAL === undefined
          ? (primitive.indices ?? primitive.attributes?.POSITION)
          : primitive.attributes?.POSITION;
      vertices += (id === undefined ? undefined : doc.accessors?.[id]?.count) ?? 0;
      if (vertices > 1_000_000) feature = 'more than one million vertices';
    }
  for (const material of doc.materials ?? []) {
    const pbr = material.pbrMetallicRoughness ?? {};
    if ((material.alphaMode ?? 'OPAQUE') !== 'OPAQUE' || (pbr.baseColorFactor?.[3] ?? 1) !== 1)
      feature = 'transparency';
    if (material.emissiveFactor?.some((value) => value !== 0)) feature = 'emission';
    if (
      [
        pbr.baseColorTexture,
        pbr.metallicRoughnessTexture,
        material.normalTexture,
        material.occlusionTexture,
        material.emissiveTexture,
      ].some(Boolean)
    )
      feature = 'textures';
  }
  // Extension payloads can occur at any schema level. Ignore extras, which are application data.
  const pending: unknown[] = [doc];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== 'object') continue;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'extensions' && child && typeof child === 'object') feature = Object.keys(child)[0] ?? feature;
      else if (key !== 'extras') pending.push(child);
    }
  }
  // The light loader reads at most 64 MiB.
  if (bytes.length > 1 << 26) feature ||= 'files over 64 MiB';
  feature = animation || doc.extensionsRequired?.[0] || feature;
  // Replay the bounded root response once, preserving its redirect URL. External resources use the original fetch.
  let root = true;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    if (!root) return get(input, init);
    root = false;
    const cached = new Response(bytes, { headers: response.headers });
    Object.defineProperty(cached, 'url', { value: response.url });
    return cached;
  };
  return { feature, animation, fetch };
}

/** Import one selected loader, retaining the feature in missing-package diagnostics. */
export async function gltfPackage<T>(name: string, feature: string, load: () => Promise<T>, signal: AbortSignal) {
  try {
    return await optionalPackage(name, load, signal);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'state')
      throw fault('state', `glTF ${feature} requires ${name}; ${error.message}`, 'install');
    throw error;
  }
}
