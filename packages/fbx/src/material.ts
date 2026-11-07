import type { MaterialData, TextureData } from '@margoengine/exporters';
import { readResponse } from '../../shared/loading.js';
import { assetURL, checkRedirect } from '../../shared/asset-url.js';
import { findChild, id, property, objectName, type FBXNode } from './document.js';
import { children, type SceneContext } from './scene.js';
import type { MaterialRead } from './extension.js';

const limit = 64 * 1024 * 1024;
export async function attachMaterials(
  ctx: SceneContext,
  resourcePath: string,
  options: { fetch?: typeof fetch; allowedURLs?: readonly string[] } = {},
): Promise<void> {
  const textures = new Map<bigint, Promise<TextureData | undefined>>(),
    materials = new Map<string, Promise<MaterialData>>();
  let bytes = 0;
  const content = (node: FBXNode | undefined): Uint8Array | undefined => {
    const value = node && findChild(node, 'Content')?.properties[0];
    if (value instanceof Uint8Array) return value;
    if (typeof value === 'string' && value) {
      if (value.length > (limit * 4) / 3 + 4)
        throw new RangeError(
          'FBX texture byte budget exceeded; simplify or split the scene, the import limits are listed in the README',
        );
      try {
        return Uint8Array.from(atob(value.replace(/\s/g, '')), (c) => c.charCodeAt(0));
      } catch {
        throw new TypeError('Invalid FBX embedded texture; re-export the file, it looks damaged');
      }
    }
  };
  const hook = ctx.extensions.find((extension) => extension.material),
    converter = ctx.extensions.find((extension) => extension.image),
    /** What each texture could not find, for the material's record. */
    lost = new Map<FBXNode, string>();
  const texture = async (source: FBXNode): Promise<TextureData | undefined> => {
    ctx.signal?.throwIfAborted();
    const videos = children(ctx, id(source.properties[0])).filter((n) => n.name === 'Video');
    if (videos.length > 1) throw new TypeError('Multiple FBX texture videos; keep one per target when exporting');
    const video = videos[0];
    let image = content(video) ?? content(source);
    if (!image) {
      const raw = String(
        findChild(source, 'RelativeFilename')?.properties[0] ??
          findChild(video ?? source, 'RelativeFilename')?.properties[0] ??
          findChild(source, 'FileName')?.properties[0] ??
          findChild(video ?? source, 'Filename')?.properties[0] ??
          '',
      );
      if (!raw) throw new TypeError('Missing FBX texture image; re-export the file, it looks damaged');
      // A full path names a folder on the PC that wrote the file; the image travels beside it, as tools look for it.
      const given = raw.replace(/\\/g, '/'),
        path = /^([a-z]:\/|\/)/i.test(given) ? given.slice(given.lastIndexOf('/') + 1) : given,
        base = resourcePath || globalThis.location?.href;
      let target: URL;
      try {
        target = new URL(path, base);
      } catch {
        throw new TypeError('FBX texture needs an HTTP(S) resourcePath');
      }
      if (!['http:', 'https:'].includes(target.protocol)) throw new TypeError('FBX resources need HTTP(S)');
      const url = assetURL(path, base, options.allowedURLs, 'FBX texture');
      if (!['http:', 'https:'].includes(url.protocol)) throw new TypeError('FBX resources need HTTP(S)');
      const response = checkRedirect(
        await (options.fetch ?? fetch)(url, { signal: ctx.signal }),
        base,
        options.allowedURLs,
        'FBX texture',
      );
      // Files name images that never left the author's PC, and every tool opens them without: the model comes, and the
      // material says which image it lost. Any other failure of the server is an error.
      if (response.status === 404 || response.status === 410) {
        lost.set(source, path);
        return undefined;
      }
      image = await readResponse(response, { maxBytes: limit - bytes, signal: ctx.signal, label: 'FBX texture' });
    }
    bytes += image.byteLength;
    if (bytes > limit)
      throw new RangeError(
        'FBX texture byte budget exceeded; simplify or split the scene, the import limits are listed in the README',
      );
    const isPNG = (bytes: Uint8Array) =>
        bytes.length > 8 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71,
      jpeg = image.length > 3 && image[0] === 255 && image[1] === 216 && image[2] === 255;
    if (!isPNG(image) && !jpeg) {
      const converted = await converter?.image?.(image);
      if (!converted) {
        lost.set(source, objectName(source));
        return undefined;
      }
      image = converted;
    }
    return { name: objectName(source), mimeType: isPNG(image) ? 'image/png' : 'image/jpeg', image };
  };
  // A texture names its UV set; which index that is depends on the mesh.
  const uvSet = (source: FBXNode, names: readonly string[]): 0 | 1 | 2 | 3 => {
    const index = names.indexOf(String(property(source, 'UVSet', '')));
    return index > 0 ? (index as 1 | 2 | 3) : 0;
  };
  const material = async (source: FBXNode, uvNames: readonly string[]): Promise<MaterialData> => {
    const scalar = (name: string, fallback: number) => {
      const value = Number(property(source, name, fallback));
      if (!Number.isFinite(value) || value < 0 || value > 1)
        throw new RangeError(`Invalid FBX material ${name}; re-export the file, it looks damaged`);
      return value;
    };
    const color = (name: string, fallback: unknown, top = 1) => {
      const value = property(source, name, fallback);
      if (
        !Array.isArray(value) ||
        value.length !== 3 ||
        value.some((v) => typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > top)
      )
        throw new RangeError(`Invalid FBX material ${name}; re-export the file, it looks damaged`);
      return value as number[];
    };
    const shininess = Number(property(source, 'Shininess', 0));
    if (!Number.isFinite(shininess) || shininess < 0)
      throw new RangeError('Invalid FBX shininess; re-export the file, it looks damaged');
    const explicitOpacity = property(source, 'Opacity', undefined),
      alpha = explicitOpacity === undefined ? 1 - scalar('TransparencyFactor', 0) : scalar('Opacity', 1),
      factor = scalar('DiffuseFactor', 1),
      diffuse = color('DiffuseColor', property(source, 'Diffuse', [1, 1, 1])),
      // Emission has no top: Max writes pi times its emission colour here.
      emission = color('EmissiveColor', property(source, 'Emissive', [0, 0, 0]), Infinity),
      emissiveFactor = scalar('EmissiveFactor', 1),
      emissive = emission.map((v) => v * emissiveFactor),
      peak = Math.max(1, ...emissive);
    const out: MaterialData = {
      name: objectName(source),
      color: [diffuse[0] * factor, diffuse[1] * factor, diffuse[2] * factor, alpha],
      emissive: emissive.map((v) => v / peak),
      ...(peak > 1 ? { emissiveStrength: peak } : {}),
      metalness: 0,
      // Blinn-Phong exponent n to glTF roughness, the same mapping as @margoengine/materials and the exporters:
      // Beckmann alpha = sqrt(2 / (n + 2)) (Walter et al. 2007, sec. 5.2), roughness = sqrt(alpha); floor 0.045.
      roughness: Math.max(0.045, Math.min(1, (2 / (shininess + 2)) ** 0.25)),
      alphaMode: alpha < 1 ? 'BLEND' : 'OPAQUE',
    };
    const load = async (t: FBXNode): Promise<TextureData | undefined> => {
      const key = id(t.properties[0]);
      let promise = textures.get(key);
      if (!promise) {
        promise = texture(t);
        textures.set(key, promise);
      }
      const set = uvSet(t, uvNames),
        loaded = await promise;
      if (!loaded) names.add(lost.get(t)!);
      return loaded && set ? { ...loaded, texCoord: set } : loaded;
    };
    const names = new Set<string>(),
      links: { property: string; node: FBXNode }[] = [],
      handled = new Set<string>();
    for (const c of ctx.incoming.get(id(source.properties[0])) ?? []) {
      const t = ctx.document.objects.get(c.child)!;
      if (c.kind !== 'OP' || !['Texture', 'LayeredTexture'].includes(t.name)) continue;
      links.push({ property: c.property ?? '', node: t });
      if (!['DiffuseColor', 'NormalMap'].includes(c.property ?? '')) continue;
      if (t.name !== 'Texture') {
        if (hook) continue;
        throw new TypeError('FBX layered texture; pass pbrMaterials from @margoengine/fbx/pbr, or bake it in your 3D tool');
      }
      handled.add(c.property!);
      const key = c.property === 'NormalMap' ? 'normalTexture' : 'baseColorTexture';
      if (out[key])
        throw new TypeError('Multiple FBX textures on one material property; keep one per target when exporting');
      const loaded = await load(t);
      if (loaded) out[key] = loaded;
    }
    const read: MaterialRead = {
      source,
      out,
      links,
      handled,
      texture: load,
      children: (node) => children(ctx, id(node.properties[0])),
    };
    await hook?.material?.(read);
    if (names.size) out.extras = { ...out.extras, fbxMissingTextures: [...names] };
    return out;
  };
  for (const mesh of ctx.meshes) {
    if (mesh.materialIndex === -1) continue;
    ctx.signal?.throwIfAborted();
    const sources = children(ctx, id(mesh.model.properties[0])).filter((n) => n.name === 'Material');
    if (!sources.length) {
      if (mesh.materialIndex > 0)
        throw new RangeError('FBX material index exceeds model materials; re-export the file, it looks damaged');
      continue;
    }
    const source = sources[mesh.materialIndex];
    if (!source)
      throw new RangeError('FBX material index exceeds model materials; re-export the file, it looks damaged');
    const key = `${id(source.properties[0])}/${mesh.uvNames}`;
    let promise = materials.get(key);
    if (!promise) {
      promise = material(source, mesh.uvNames);
      materials.set(key, promise);
    }
    mesh.node.material = await promise;
  }
}
