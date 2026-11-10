/** Data-scene material extension and variant authoring, kept out of the ordinary writer entry. */
import { writeGLB, type GLBOptions } from './gltf.js';
import {
  checkTexture,
  normalizeMaterial,
  type ExportScene,
  type ExportNode,
  type ExportPrimitive,
  type MaterialData,
  type TextureData,
  type Node,
} from './scene.js';
import { copyExtras } from './extras.js';
import { useExtension, type JSONObject } from './glb-pack.js';

/** Texture information inside a material extension. All other fields use the glTF spelling and units. */
export interface MaterialTextureInfo {
  /** Image, sampler and UV set, shared by identity with ordinary material textures. */
  texture: TextureData;
  /** Overrides the texture's UV set. Default texture.texCoord or zero. */
  texCoord?: number;
  /** Normal texture scale. Default one. */
  scale?: number;
  /** Extension data, including KHR_texture_transform. */
  extensions?: Readonly<Record<string, unknown>>;
}

/** Material data with glTF-shaped KHR_materials_* extension payloads. Texture fields use MaterialTextureInfo. */
export interface ExtendedMaterialData extends MaterialData {
  /** Explicit payloads preserve defaults and zero values. Ordinary material factors supply the fallback. */
  extensions?: Readonly<Record<`KHR_materials_${string}`, Readonly<Record<string, unknown>>>>;
}

/** One primitive's variant name to alternate material mapping. */
export interface MaterialPrimitive extends Omit<ExportPrimitive, 'material'> {
  /** Default material. */
  material?: ExtendedMaterialData;
  /** Named alternate materials, applied to this primitive only. Default none. */
  variants?: Readonly<Record<string, ExtendedMaterialData>>;
}

/** A data-scene node with physical material extensions and per-primitive variants. */
export interface MaterialNode extends Omit<ExportNode, 'material' | 'children' | 'primitives'> {
  /** Default material for a single geometry. */
  material?: ExtendedMaterialData;
  /** Alternate materials for a single geometry. Default none. */
  variants?: Readonly<Record<string, ExtendedMaterialData>>;
  /** Independent primitive defaults and variants. */
  primitives?: readonly MaterialPrimitive[];
  /** Child hierarchy. */
  children?: readonly MaterialNode[];
}

/** Plain scene with extension materials and named variants. */
export interface MaterialScene extends Omit<ExportScene, 'nodes'> {
  /** Root nodes. */
  nodes: readonly MaterialNode[];
  /** Optional ordered variant definitions; otherwise names are discovered in traversal order. */
  variants?: readonly { name: string; extras?: Readonly<Record<string, unknown>> }[];
}

/** Export settings for extension materials. */
export interface MaterialExportOptions extends GLBOptions {
  /** Stop before collection and between material writes. */
  signal?: AbortSignal;
}

/**
 * Export a data scene with every glTF-shaped KHR material extension and KHR_materials_variants. Payloads use the
 * specification's field names, so newly ratified material extensions need no exporter upgrade. Texture references
 * are objects carrying actual TextureData, never caller-guessed glTF indices.
 * @throws {TypeError} For malformed extension payloads or variants; use glTF-shaped objects and named materials.
 * @throws {RangeError} For invalid numeric data or UV sets; use finite values and exported texture coordinates.
 */
export function exportMaterialGLB(scene: MaterialScene, options: MaterialExportOptions = {}): Uint8Array {
  options.signal?.throwIfAborted();
  let roots: Node[] = [];
  return writeGLB(
    scene,
    options,
    (collected) => {
      roots = collected;
    },
    (writer) => {
      const json = writer.json as JSONObject,
        written = new Map<ExtendedMaterialData, number>(),
        textureCoordinates = new Map<number, Set<number>>(),
        names = new Map<string, number>(),
        definitions: JSONObject[] = [];
      const variant = (name: string, extras?: Readonly<Record<string, unknown>>): number => {
        if (typeof name !== 'string' || !name.length)
          throw new TypeError('MARGO_EXPORT_VARIANT_NAME: use a nonempty variant name. See docs/limits.md');
        let index = names.get(name);
        if (index === undefined) {
          index = definitions.length;
          names.set(name, index);
          definitions.push({ name, ...(extras ? { extras: copyExtras(extras, 'Variant extras') } : {}) });
        }
        return index;
      };
      for (const definition of scene.variants ?? []) {
        if (names.has(definition.name))
          throw new TypeError('MARGO_EXPORT_VARIANT_DUPLICATE: use unique variant names. See docs/limits.md');
        variant(definition.name, definition.extras);
      }
      const write = (source: ExtendedMaterialData): number => {
        options.signal?.throwIfAborted();
        const known = written.get(source);
        if (known !== undefined) return known;
        const index = writer.materialSources.get(source)?.index ?? writer.material(normalizeMaterial(source)),
          material = json.materials[index],
          coordinates = new Set<number>();
        written.set(source, index);
        textureCoordinates.set(index, coordinates);
        const path = new Set<object>();
        const payload = (value: unknown, field = ''): unknown => {
          if (field.endsWith('Texture') && value !== undefined) {
            const info = value as MaterialTextureInfo,
              texture = checkTexture(info?.texture, field);
            if (!texture)
              throw new TypeError(
                'MARGO_EXPORT_MATERIAL_TEXTURE: provide { texture: TextureData } for each texture field. See docs/limits.md',
              );
            const { texture: _, ...rest } = info,
              copy = copyExtras(rest, 'Material texture info') as JSONObject,
              texCoord = info.texCoord ?? texture.texCoord ?? 0;
            if (!Number.isSafeInteger(texCoord) || texCoord < 0 || texCoord > 3)
              throw new RangeError('MARGO_EXPORT_MATERIAL_UV: use a texCoord from 0 to 3. See docs/limits.md');
            const transformed = copy.extensions?.KHR_texture_transform?.texCoord ?? texCoord;
            if (!Number.isSafeInteger(transformed) || transformed < 0 || transformed > 3)
              throw new RangeError(
                'MARGO_EXPORT_MATERIAL_UV: use a transform texCoord from 0 to 3. See docs/limits.md',
              );
            coordinates.add(transformed);
            if (copy.extensions) for (const name of Object.keys(copy.extensions)) useExtension(json, name, false);
            return { ...copy, index: writer.texture(texture), ...(texCoord ? { texCoord } : {}) };
          }
          if (value && typeof value === 'object') {
            if (path.has(value) || path.size >= 64)
              throw new TypeError(
                'MARGO_EXPORT_MATERIAL_TREE: remove cycles or excessive nesting from material data. See docs/limits.md',
              );
            path.add(value);
            const out = Array.isArray(value)
              ? value.map((item) => payload(item))
              : Object.fromEntries(
                  Object.entries(value)
                    .filter(([, item]) => item !== undefined)
                    .map(([key, item]) => [key, payload(item, key)]),
                );
            path.delete(value);
            return out;
          }
          if (typeof value === 'number' && !Number.isFinite(value))
            throw new RangeError('MARGO_EXPORT_MATERIAL_NUMBER: use finite material values. See docs/limits.md');
          if (value !== null && !['number', 'boolean', 'string'].includes(typeof value))
            throw new TypeError('MARGO_EXPORT_MATERIAL_VALUE: use JSON material values. See docs/limits.md');
          return value;
        };
        for (const [name, value] of Object.entries(source.extensions ?? {})) {
          if (!/^KHR_materials_[A-Za-z0-9_]+$/.test(name) || name === 'KHR_materials_variants')
            throw new TypeError(
              'MARGO_EXPORT_MATERIAL_EXTENSION: use KHR_materials_* payloads on materials and variants on primitives. See docs/limits.md',
            );
          if (!value || typeof value !== 'object' || Array.isArray(value))
            throw new TypeError(
              'MARGO_EXPORT_MATERIAL_PAYLOAD: use an object for each material extension. See docs/limits.md',
            );
          (material.extensions ??= {})[name] = payload(value);
          useExtension(json, name, false);
        }
        return index;
      };
      // Base materials were written during collection. Their source identities are already retained by the writer.
      for (const source of writer.materialSources.keys()) write(source as ExtendedMaterialData);
      let nodeIndex = 0;
      const visit = (node: Node): void => {
        const out = json.nodes[nodeIndex++],
          source = node.source as MaterialNode | undefined;
        const mappings = source?.primitives?.map((p) => p.variants) ?? [source?.variants];
        if (mappings.some(Boolean) && out.mesh !== undefined) {
          const mesh = structuredClone(json.meshes[out.mesh]);
          for (const [i, variants] of mappings.entries()) {
            const assignments = new Map<number, number[]>();
            for (const [name, alternate] of Object.entries(variants ?? {})) {
              const v = variant(name),
                m = write(alternate);
              if (!assignments.has(m)) assignments.set(m, []);
              assignments.get(m)!.push(v);
            }
            if (assignments.size)
              (mesh.primitives[i].extensions ??= {}).KHR_materials_variants = {
                mappings: [...assignments].map(([material, variants]) => ({ material, variants })),
              };
          }
          out.mesh = json.meshes.push(mesh) - 1;
        }
        for (const child of node.children) visit(child);
      };
      const hasVariants = (node: Node): boolean => {
        const s = node.source as MaterialNode | undefined;
        return !!(s?.variants || s?.primitives?.some((p) => p.variants) || node.children.some(hasVariants));
      };
      if (options.flatten && (scene.variants?.length || roots.some(hasVariants)))
        throw new TypeError(
          'MARGO_EXPORT_VARIANT_FLATTEN: keep flatten false when writing variants. See docs/limits.md',
        );
      if (!options.flatten) for (const node of roots) visit(node);
      if (definitions.length) {
        (json.extensions ??= {}).KHR_materials_variants = { variants: definitions };
        useExtension(json, 'KHR_materials_variants', false);
      }
      for (const mesh of json.meshes ?? [])
        for (const p of mesh.primitives) {
          const materials = [
            p.material,
            ...(p.extensions?.KHR_materials_variants?.mappings ?? []).map((m: JSONObject) => m.material),
          ];
          for (const material of materials)
            for (const uv of textureCoordinates.get(material) ?? [])
              if (p.attributes[`TEXCOORD_${uv}`] === undefined)
                throw new TypeError(
                  'MARGO_EXPORT_MATERIAL_UV_MISSING: provide geometry UVs for every extension texture. See docs/limits.md',
                );
        }
      // Alternate-only materials may have appended images, samplers and extension declarations after document().
      if (writer.length) json.buffers = [{ byteLength: writer.length }];
      for (const name of writer.used) useExtension(json, name, writer.required.has(name));
    },
  );
}
