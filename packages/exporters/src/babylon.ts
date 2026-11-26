// Babylon.js `.babylon` scene writer, from the public description of the file (doc.babylonjs.com, "Babylon file
// format"): a JSON document of transform nodes, meshes with their own vertex arrays and submeshes, materials, cameras
// and lights. Static pose only: skins, morph targets and animation are not written (the base geometry is).
import { LinearToSRGB as toSrgb } from '@margoengine/math/color';
import {
  collect,
  textureFiles,
  token,
  type ExportSource,
  type Geo,
  type Mat,
  type Node,
  type SceneOptions,
  type TextureData,
} from './scene.js';

/** Options of {@link exportBabylon}. */
export interface BabylonOptions extends SceneOptions {
  /**
   * Write Babylon's left-handed space: Z is negated in positions, normals and placements and the winding is swapped, so
   * a scene read back by `parseBabylon` (default `rightHanded`) comes out the same. false writes the engine's
   * right-handed numbers as they are. Default true.
   */
  leftHanded?: boolean;
  /** Embed each texture as a `base64String` data URI (true) or name a file the caller saves from `textures` (false). Default true. */
  embedTextures?: boolean;
  /** Prepended to every texture file name. Default ''. */
  texturePrefix?: string;
  /** Written as `producer.version`. Default 'Margo Engine'. */
  generator?: string;
}

/** What {@link exportBabylon} returns. */
export interface BabylonResult {
  /** The document, ready to save as `.babylon`. */
  text: string;
  /** The same document as an object. */
  json: Record<string, unknown>;
  /** Texture files the document names (empty when textures are embedded), keyed by the name written. */
  textures: Map<string, Uint8Array>;
  meshes: number;
  materials: number;
}

type Json = Record<string, unknown>;
const r = (v: number): number => (Number.isFinite(v) ? +v.toPrecision(9) + 0 : 0); // + 0 turns -0 into 0
const rounded = (a: ArrayLike<number>, out: number[] = []): number[] => {
  for (let i = 0; i < a.length; i++) out.push(r(a[i]));
  return out;
};

function base64(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as unknown as number[]);
  return btoa(text);
}

/**
 * Writes a scene (an engine, or a plain data scene) as a Babylon.js `.babylon` document. Each node becomes a mesh (with
 * its vertices, one submesh and a material id) or a transform node, parented as in the scene; a node with several
 * primitives becomes a transform node with one mesh per primitive. Materials are PBRMetallicRoughness, or Standard for
 * lambert, phong and unlit ones (with their colours in sRGB, which is how Babylon reads them). Camera and light nodes are
 * written at their world placement, looking down the node's -Z. Texture rotation, skins, morph targets and animation are
 * not written.
 */
export function exportBabylon(source: ExportSource, options: BabylonOptions = {}): BabylonResult {
  const left = options.leftHanded ?? true,
    embed = options.embedTextures ?? true;
  if (typeof left !== 'boolean' || typeof embed !== 'boolean')
    throw new TypeError('leftHanded and embedTextures must be boolean');
  const files = textureFiles(options.texturePrefix ?? '');
  const roots = collect(source, options, undefined, 'baseColor', []);
  const z = left ? -1 : 1;

  const materials: Json[] = [],
    materialIds = new Map<Mat, string>(),
    ids = new Set<string>();
  const uniqueId = (name: string | undefined, fallback: string): string => {
    const base = token(name, fallback);
    let id = base;
    for (let n = 2; ids.has(id); n++) id = `${base}_${n}`;
    ids.add(id);
    return id;
  };
  const texture = (t: TextureData | undefined, transform?: { offset?: readonly number[]; scale?: readonly number[] }): Json | undefined => {
    if (!t) return undefined;
    const name = files.name(t);
    const out: Json = {
      name,
      level: 1,
      hasAlpha: t.mimeType === 'image/png',
      coordinatesMode: 0,
      coordinatesIndex: 0,
      uOffset: transform?.offset?.[0] ?? 0,
      vOffset: transform?.offset?.[1] ?? 0,
      uScale: transform?.scale?.[0] ?? 1,
      vScale: transform?.scale?.[1] ?? 1,
      wAng: 0,
      wrapU: t.wrapS === 'clamp' ? 0 : t.wrapS === 'mirror' ? 2 : 1,
      wrapV: t.wrapT === 'clamp' ? 0 : t.wrapT === 'mirror' ? 2 : 1,
      // glTF's v runs down the image, which is what invertY false means to Babylon.
      invertY: false,
    };
    if (embed) out.base64String = `data:${t.mimeType};base64,${base64(t.image)}`;
    return out;
  };
  const materialId = (m: Mat | undefined): string | undefined => {
    if (!m) return undefined;
    let id = materialIds.get(m);
    if (id) return id;
    id = uniqueId(m.name, `material_${materials.length}`);
    materialIds.set(m, id);
    const alpha = m.color[3] ?? 1;
    const base: Json = { name: m.name ?? id, id, alpha: r(alpha), backFaceCulling: !m.doubleSided, doubleSided: m.doubleSided };
    const rgb = (c: number[], srgb: boolean) => c.slice(0, 3).map((v) => r(srgb ? toSrgb(v) : v));
    const ctx = (key: string, t: Json | undefined) => {
      if (t) base[key] = t;
    };
    if (m.shading === 'standard' && !m.unlit) {
      Object.assign(base, {
        customType: 'BABYLON.PBRMetallicRoughnessMaterial',
        baseColor: rgb(m.color, false),
        metallic: r(m.metalness),
        roughness: r(m.roughness),
        emissive: rgb(m.emissive.map((v) => v * m.emissiveStrength), false),
        transparencyMode: m.alphaMode === 'MASK' ? 1 : m.alphaMode === 'BLEND' ? 2 : 0,
        ...(m.alphaMode === 'MASK' ? { alphaCutoff: r(m.alphaCutoff ?? 0.5) } : {}),
      });
      ctx('baseTexture', texture(m.baseColorTexture, m.baseColorTextureTransform));
      ctx('metallicRoughnessTexture', texture(m.metallicRoughnessTexture, m.metallicRoughnessTextureTransform));
      ctx('normalTexture', texture(m.normalTexture, m.normalTextureTransform));
      ctx('emissiveTexture', texture(m.emissiveTexture, m.emissiveTextureTransform));
      ctx('ambientTexture', texture(m.occlusionTexture, m.occlusionTextureTransform));
    } else {
      Object.assign(base, {
        customType: 'BABYLON.StandardMaterial',
        diffuse: m.unlit ? [0, 0, 0] : rgb(m.color, true),
        specular: m.shading === 'phong' ? rgb(m.specular, true) : [0, 0, 0],
        specularPower: r(m.shininess),
        emissive: m.unlit ? rgb(m.color, true) : rgb(m.emissive, true),
        disableLighting: !!m.unlit,
      });
      ctx('diffuseTexture', texture(m.baseColorTexture, m.baseColorTextureTransform));
      ctx('bumpTexture', texture(m.normalTexture, m.normalTextureTransform));
      ctx('emissiveTexture', texture(m.emissiveTexture, m.emissiveTextureTransform));
      ctx('ambientTexture', texture(m.occlusionTexture, m.occlusionTextureTransform));
    }
    materials.push(base);
    return id;
  };

  const placement = (n: Node): Json => {
    const [x, y, zz] = n.t,
      q = n.r;
    return {
      position: [r(x), r(y), r(zz * z)],
      rotationQuaternion: left ? [r(-q[0]), r(-q[1]), r(q[2]), r(q[3])] : rounded(q),
      scaling: rounded(n.s),
    };
  };
  const vertexData = (g: Geo): Json => {
    const out: Json = {},
      count = g.count;
    const positions: number[] = [],
      normals: number[] = [];
    for (let i = 0; i < count; i++) {
      positions.push(r(g.positions[i * 3]), r(g.positions[i * 3 + 1]), r(g.positions[i * 3 + 2] * z));
      normals.push(r(g.normals[i * 3]), r(g.normals[i * 3 + 1]), r(g.normals[i * 3 + 2] * z));
    }
    out.positions = positions;
    out.normals = normals;
    if (g.uvs) out.uvs = rounded(g.uvs);
    if (g.uvs1) out.uvs2 = rounded(g.uvs1);
    if (g.colors) {
      const colors: number[] = [];
      for (let i = 0; i < count; i++)
        colors.push(r(g.colors[i * g.colorSize]), r(g.colors[i * g.colorSize + 1]), r(g.colors[i * g.colorSize + 2]), g.colorSize === 4 ? r(g.colors[i * 4 + 3]) : 1);
      out.colors = colors;
      out.hasVertexAlpha = g.colorSize === 4;
    }
    const indices: number[] = [];
    for (let i = 0; i < g.indices.length; i += 3)
      indices.push(g.indices[i], g.indices[i + (left ? 2 : 1)], g.indices[i + (left ? 1 : 2)]);
    out.indices = indices;
    out.subMeshes = [{ materialIndex: 0, verticesStart: 0, verticesCount: count, indexStart: 0, indexCount: indices.length }];
    return out;
  };

  const transformNodes: Json[] = [],
    meshes: Json[] = [],
    cameras: Json[] = [],
    lights: Json[] = [];
  const mesh = (n: Node, id: string, name: string, parentId: string | undefined, part: { geometry: Geo; material?: Mat }, own: boolean) => {
    const out: Json = {
      name,
      id,
      ...(parentId ? { parentId } : {}),
      ...(own ? placement(n) : { position: [0, 0, 0], rotationQuaternion: [0, 0, 0, 1], scaling: [1, 1, 1] }),
      isEnabled: true,
      isVisible: true,
      checkCollisions: false,
      billboardMode: 0,
      receiveShadows: false,
      ...vertexData(part.geometry),
    };
    const material = materialId(part.material);
    if (material) out.materialId = material;
    meshes.push(out);
  };
  const forward = (w: Float64Array): number[] => {
    const f = [-w[8], -w[9], -w[10]],
      len = Math.hypot(f[0], f[1], f[2]) || 1;
    return [f[0] / len, f[1] / len, (f[2] / len) * z];
  };
  const walk = (n: Node, parentId: string | undefined): void => {
    const parts = n.primitives ?? (n.geometry ? [{ geometry: n.geometry, material: n.material }] : []);
    const name = n.name ?? 'node';
    let id: string | undefined;
    if (parts.length === 1) {
      id = uniqueId(n.name, `mesh_${meshes.length}`);
      mesh(n, id, name, parentId, parts[0], true);
    } else if (parts.length > 1 || n.children.length || (!n.camera && !n.light)) {
      id = uniqueId(n.name, `node_${transformNodes.length}`);
      transformNodes.push({ name, id, ...(parentId ? { parentId } : {}), ...placement(n), isEnabled: true, isVisible: true });
      parts.forEach((part, i) => mesh(n, uniqueId(`${id}_${i}`, `mesh_${meshes.length}`), `${name}_${i}`, id, part, false));
    }
    const w = n.world;
    if (n.camera) {
      const c = n.camera,
        f = forward(w),
        p = [r(w[12]), r(w[13]), r(w[14] * z)];
      const cid = uniqueId(c.name ?? n.name, `camera_${cameras.length}`);
      const cam: Json = {
        name: c.name ?? name,
        id: cid,
        type: 'FreeCamera',
        position: p,
        target: [r(p[0] + f[0]), r(p[1] + f[1]), r(p[2] + f[2])],
        rotation: [r(Math.atan2(-f[1], Math.hypot(f[0], f[2]))), r(Math.atan2(f[0], f[2])), 0],
        fov: r(c.perspective?.yfov ?? 0.8),
        minZ: r(c.perspective?.znear ?? c.orthographic?.znear ?? 0.1),
        maxZ: r(c.perspective?.zfar ?? c.orthographic?.zfar ?? 10000),
        mode: c.type === 'orthographic' ? 1 : 0,
      };
      if (c.type === 'orthographic' && c.orthographic)
        Object.assign(cam, {
          orthoLeft: r(-c.orthographic.xmag),
          orthoRight: r(c.orthographic.xmag),
          orthoTop: r(c.orthographic.ymag),
          orthoBottom: r(-c.orthographic.ymag),
        });
      cameras.push(cam);
    }
    if (n.light) {
      const l = n.light,
        f = forward(w),
        lid = uniqueId(l.name ?? n.name, `light_${lights.length}`),
        color = rounded(l.color.slice(0, 3));
      const light: Json = {
        name: l.name ?? name,
        id: lid,
        type: l.type === 'point' ? 0 : l.type === 'directional' ? 1 : 2,
        diffuse: color,
        specular: color,
        intensity: r(l.intensity),
      };
      if (l.type !== 'directional') light.position = [r(w[12]), r(w[13]), r(w[14] * z)];
      if (l.type !== 'point') light.direction = rounded(f);
      if (l.range !== undefined) light.range = r(l.range);
      if (l.type === 'spot') {
        light.angle = r(2 * (l.outerConeAngle ?? Math.PI / 4));
        light.innerAngle = r(2 * (l.innerConeAngle ?? 0));
        light.exponent = 1;
      }
      lights.push(light);
    }
    for (const child of n.children) walk(child, id ?? parentId);
  };
  for (const root of roots) walk(root, undefined);

  const json: Json = {
    producer: { name: 'Margo Engine', version: options.generator ?? 'Margo Engine', exporter_version: '1', file: 'scene.babylon' },
    autoClear: true,
    clearColor: [0.2, 0.2, 0.3],
    ambientColor: [0, 0, 0],
    gravity: [0, -9.81, 0],
    materials,
    multiMaterials: [],
    transformNodes,
    meshes,
    cameras,
    lights,
    skeletons: [],
  };
  if (cameras.length) json.activeCameraID = cameras[0].id;
  return { text: JSON.stringify(json), json, textures: embed ? new Map() : files.files, meshes: meshes.length, materials: materials.length };
}
