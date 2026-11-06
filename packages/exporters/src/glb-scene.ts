// A GLB as an ExportScene: what the writers of formats with no GLB step of their own read. Materials keep what those formats
// can hold, and the nodes, skins and clips keep the file's own objects, so a skin's joints are the nodes the clips drive.
import { readAccessor, splitGLB, type AccessorValues, type GLBParts } from './glb.js';
import type { JSONObject } from './glb-pack.js';
import type {
  AnimationChannelData,
  AnimationData,
  ExportNode,
  ExportPrimitive,
  ExportScene,
  GeometryData,
  MaterialData,
  SkinData,
  TextureData,
} from './scene.js';

/** Something of the file {@link sceneOfGLB} left out. */
export interface GLBSceneSkip {
  /**
   * What it was: `'primitive'` not triangles or with no position, `'texture'` not PNG or JPEG, `'colors'` under a base colour
   * texture, `'channel'` an animation channel with no node, such as one of KHR_animation_pointer.
   */
  kind: 'primitive' | 'texture' | 'colors' | 'channel';
  /** Index of the mesh, material or animation it belongs to. */
  index: number;
}

const WRAPS: Record<number, 'clamp' | 'mirror' | 'repeat'> = { 33071: 'clamp', 33648: 'mirror', 10497: 'repeat' };
const MOST: Record<number, number> = { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 };

/** An accessor's values as floats: normalized integers divided as the spec says, anything else as stored. */
function floats(accessor: AccessorValues): Float32Array {
  const { values, normalized, componentType } = accessor;
  if (values instanceof Float32Array) return values;
  if (!normalized) return Float32Array.from(values);
  const most = MOST[componentType];
  return Float32Array.from(values, (v) => Math.max(v / most, -1));
}

/**
 * Reads a GLB as a scene. What the scene's writers cannot hold goes in `skipped`.
 * @throws TypeError for bytes that are not a GLB, a file that needs Draco or meshopt decoded first, or more than four skin
 * influences; RangeError for data past its buffer.
 */
export function sceneOfGLB(bytes: Uint8Array): { scene: ExportScene; skipped: GLBSceneSkip[] } {
  const parts: GLBParts = splitGLB(bytes),
    json = parts.json as JSONObject,
    compressed = (json.extensionsRequired ?? []).find((name: string) => /draco|meshopt/i.test(name));
  if (compressed)
    throw new TypeError(`This GLB needs ${compressed} decoded; export from the uncompressed file, before compressing`);
  const skipped: GLBSceneSkip[] = [],
    images = new Map<number, Uint8Array>(),
    imageOf = (index: number): Uint8Array => {
      let data = images.get(index);
      if (!data) {
        const view = json.bufferViews[json.images[index].bufferView],
          start = view.byteOffset ?? 0;
        images.set(index, (data = parts.bin!.subarray(start, start + view.byteLength)));
      }
      return data;
    },
    texture = (info: JSONObject | undefined, material: number): TextureData | undefined => {
      if (!info) return undefined;
      const { source, sampler } = json.textures[info.index],
        { mimeType, bufferView } = json.images?.[source] ?? {},
        { wrapS = 10497, wrapT = 10497 } = json.samplers?.[sampler] ?? {};
      if (bufferView === undefined || (mimeType !== 'image/png' && mimeType !== 'image/jpeg')) {
        skipped.push({ kind: 'texture', index: material });
        return undefined;
      }
      return {
        image: imageOf(source),
        mimeType,
        wrapS: WRAPS[wrapS],
        wrapT: WRAPS[wrapT],
        texCoord: info.texCoord ?? 0,
      };
    };
  const materials = new Map<number, MaterialData>(),
    fallback: MaterialData = { color: [1, 1, 1, 1], roughness: 1, metalness: 1 },
    materialOf = (index: number | undefined): MaterialData => {
      if (index === undefined) return fallback;
      let data = materials.get(index);
      if (data) return data;
      const m = json.materials[index],
        pbr = m.pbrMetallicRoughness ?? {},
        transform = pbr.baseColorTexture?.extensions?.KHR_texture_transform;
      data = {
        name: m.name,
        color: pbr.baseColorFactor ?? [1, 1, 1, 1],
        roughness: pbr.roughnessFactor ?? 1,
        metalness: pbr.metallicFactor ?? 1,
        doubleSided: m.doubleSided ?? false,
        emissive: m.emissiveFactor ?? [0, 0, 0],
        alphaMode: m.alphaMode ?? 'OPAQUE',
        ...(m.alphaMode === 'MASK' ? { alphaCutoff: m.alphaCutoff ?? 0.5 } : {}),
        normalScale: m.normalTexture?.scale ?? 1,
        occlusionStrength: m.occlusionTexture?.strength ?? 1,
      };
      const slots = [
        ['baseColorTexture', pbr.baseColorTexture],
        ['metallicRoughnessTexture', pbr.metallicRoughnessTexture],
        ['normalTexture', m.normalTexture],
        ['occlusionTexture', m.occlusionTexture],
        ['emissiveTexture', m.emissiveTexture],
      ] as const;
      for (const [slot, info] of slots) {
        const read = texture(info, index);
        if (read) data[slot] = read;
      }
      if (transform && data.baseColorTexture)
        data.baseColorTextureTransform = {
          offset: transform.offset ?? [0, 0],
          scale: transform.scale ?? [1, 1],
          rotation: transform.rotation ?? 0,
        };
      materials.set(index, data);
      return data;
    };

  const geometries = new Map<string, GeometryData | null>(),
    geometryOf = (mesh: number, at: number): GeometryData | null => {
      const key = `${mesh}:${at}`,
        known = geometries.get(key);
      if (known !== undefined) return known;
      const primitive = json.meshes[mesh].primitives[at],
        attributes = primitive.attributes ?? {},
        { POSITION, NORMAL, TEXCOORD_0, TEXCOORD_1, COLOR_0, JOINTS_0, WEIGHTS_0, JOINTS_1 } = attributes;
      if ((primitive.mode ?? 4) !== 4 || POSITION === undefined) {
        skipped.push({ kind: 'primitive', index: mesh });
        geometries.set(key, null);
        return null;
      }
      if (JOINTS_1 !== undefined)
        throw new TypeError('This GLB has more than four skin influences per vertex; bake it down to four first');
      const positions = floats(readAccessor(parts, POSITION)),
        count = positions.length / 3,
        indices =
          primitive.indices === undefined
            ? Uint32Array.from({ length: count - (count % 3) }, (_, i) => i)
            : readAccessor(parts, primitive.indices).values,
        data: GeometryData = {
          positions,
          // Zero normals are the collector's sign to take them from the faces.
          normals: NORMAL === undefined ? new Float32Array(positions.length) : floats(readAccessor(parts, NORMAL)),
          indices,
        };
      if (TEXCOORD_0 !== undefined) data.uvs = floats(readAccessor(parts, TEXCOORD_0));
      if (TEXCOORD_1 !== undefined) data.uvs1 = floats(readAccessor(parts, TEXCOORD_1));
      if (COLOR_0 !== undefined) data.colors = floats(readAccessor(parts, COLOR_0));
      if (JOINTS_0 !== undefined && WEIGHTS_0 !== undefined) {
        data.joints = readAccessor(parts, JOINTS_0).values;
        data.weights = floats(readAccessor(parts, WEIGHTS_0));
      }
      geometries.set(key, data);
      return data;
    };

  // Every node first, so a skin and a clip can name any of them; the tree and the skins after.
  const records: JSONObject[] = json.nodes ?? [],
    nodes: ExportNode[] = records.map((record) => {
      const node: { -readonly [K in keyof ExportNode]: ExportNode[K] } = {};
      if (record.name !== undefined) node.name = record.name;
      if (record.matrix) node.matrix = record.matrix;
      else {
        if (record.translation) node.translation = record.translation;
        if (record.rotation) node.rotation = record.rotation;
        if (record.scale) node.scale = record.scale;
      }
      return node;
    }),
    skins: SkinData[] = (json.skins ?? []).map((skin: JSONObject): SkinData => {
      const count = skin.joints.length;
      return {
        joints: skin.joints.map((joint: number) => nodes[joint]),
        inverseBindMatrices:
          skin.inverseBindMatrices === undefined
            ? Float32Array.from({ length: count * 16 }, (_, i) => ((i % 16) % 5 === 0 ? 1 : 0))
            : floats(readAccessor(parts, skin.inverseBindMatrices)),
      };
    });
  records.forEach((record, index) => {
    const node = nodes[index] as { -readonly [K in keyof ExportNode]: ExportNode[K] };
    if (record.children) node.children = record.children.map((child: number) => nodes[child]);
    if (record.mesh === undefined) return;
    const primitives: ExportPrimitive[] = [];
    (json.meshes[record.mesh].primitives as JSONObject[]).forEach((primitive, at) => {
      const geometry = geometryOf(record.mesh, at);
      if (!geometry) return;
      const material = materialOf(primitive.material);
      if (geometry.colors && material.baseColorTexture) {
        skipped.push({ kind: 'colors', index: record.mesh });
        delete geometry.colors;
      }
      primitives.push({ geometry, material });
    });
    if (!primitives.length) return;
    node.primitives = primitives;
    if (record.skin !== undefined) node.skin = skins[record.skin];
  });
  const animations: AnimationData[] = (json.animations ?? []).map(
    (animation: JSONObject, index: number): AnimationData => ({
      ...(animation.name === undefined ? {} : { name: animation.name }),
      channels: (animation.channels as JSONObject[]).flatMap((channel): AnimationChannelData[] => {
        const { node, path } = channel.target ?? {};
        if (node === undefined) {
          skipped.push({ kind: 'channel', index });
          return [];
        }
        const sampler = animation.samplers[channel.sampler];
        return [
          {
            node: nodes[node],
            path,
            interpolation: sampler.interpolation ?? 'LINEAR',
            times: floats(readAccessor(parts, sampler.input)),
            values: floats(readAccessor(parts, sampler.output)),
          },
        ];
      }),
    }),
  );
  const roots: number[] = json.scenes?.[json.scene ?? 0]?.nodes ?? [];
  return { scene: { nodes: roots.map((root) => nodes[root]), animations }, skipped };
}
