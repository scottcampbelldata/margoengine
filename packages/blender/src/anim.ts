// @margoengine/blender/anim: animated .margo files (armatures, skins, shape keys, sampled actions) as glTF 2.0 over
// the file's own bytes, so glTF Pro draws them and @margoengine/animation plays them. FORMAT.md, "Animated files".
import { checkCount, countLimit } from "../../shared/limits.js";
import { readResponse } from "../../shared/loading.js";
import { validatePreparedGeometry } from "../../shared/prepared-geometry.js";
import type { EngineKernel } from "@margoengine/core";
import {
  parseGLTF,
  type GLTFDocument,
  type PBRModel,
} from "@margoengine/gltf-pro/model";
import {
  decodeImages,
  expandCompact,
  maxBytes,
  pngSize,
  readContainer,
  type MargoSection,
} from "./container.js";
import type { MargoOptions } from "./index.js";

/** A `.margo` file as a glTF 2.0 document whose one buffer is the file itself. */
export interface MargoGLTF {
  /** glTF 2.0 JSON: buffer 0 is `buffer`; vertices, indices, images and animation data are views into it. */
  readonly document: GLTFDocument;
  /** The file's bytes (no copy). Keep them alive and unmodified while the document or a model of it is used. */
  readonly buffer: Uint8Array<ArrayBuffer>;
  /** Embedded PNG files, in the order of `document.images`. */
  readonly images: readonly Uint8Array<ArrayBuffer>[];
}

type Json = Record<string, unknown>;
const record = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const fail = (what: string): never => {
  throw new TypeError(
    `Invalid animated .margo ${what}; re-export the file with the Margo Blender add-on`,
  );
};
const index = (value: unknown, length: number, what: string) =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value < length
    ? value
    : fail(what);
const skinAttributes = new Set([
  "JOINTS_0",
  "JOINTS_1",
  "WEIGHTS_0",
  "WEIGHTS_1",
]);

/**
 * Converts `.margo` bytes, animated or static, to a glTF 2.0 document over the same bytes (no copy). Checks the
 * container and geometry as `decodeMargo` does; glTF Pro checks the accessors, skins and clips when it loads them.
 *
 * @example
 * const { document } = margoToGLTF(await (await fetch('/hero.margo')).arrayBuffer());
 * console.log(document.animations?.map((clip) => clip.name));
 */
export function margoToGLTF(
  input: ArrayBuffer | ArrayBufferView,
  { maxNodes = 100_000 }: MargoOptions = {},
): MargoGLTF {
  countLimit("maxNodes", maxNodes);
  const { buffer, base, length, flags, sections, manifest } = readContainer(
      input,
      true,
    ),
    doc = manifest;
  if (
    !record(doc) ||
    !record(doc.asset) ||
    doc.asset.version !== "2.0" ||
    !Array.isArray(doc.meshes) ||
    !doc.meshes.length ||
    !Array.isArray(doc.nodes) ||
    !doc.nodes.length
  )
    throw new TypeError(
      "Invalid .margo scene; it needs glTF asset version 2.0 plus at least one mesh and one node, so re-export it from Blender",
    );
  checkCount("Too many .margo nodes", doc.nodes.length, maxNodes, "maxNodes");
  for (const key of ["buffers", "extensionsRequired"])
    if (doc[key] !== undefined)
      throw new TypeError(
        `Unsupported .margo ${key}; remove it from the scene`,
      );
  for (const key of ["bufferViews", "accessors", "skins", "animations"])
    if (doc[key] !== undefined && (!flags || !Array.isArray(doc[key])))
      throw new TypeError(
        `Unsupported .margo ${key}; only an animated .margo (header flag 1) carries ${key}, as an array, so re-export the file`,
      );
  const section = (id: unknown, type: number, what: string): MargoSection => {
    const found = sections[index(id, sections.length, what)];
    return found.type === type && found !== sections[0] ? found : fail(what);
  };
  const views: Json[] = ((doc.bufferViews ?? []) as unknown[]).map((view) => {
    if (!record(view)) return fail("buffer view");
    const data = section(view.section, 5, "buffer view section"),
      offset = view.byteOffset ?? 0,
      size = view.byteLength;
    if (
      typeof offset !== "number" ||
      typeof size !== "number" ||
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(size) ||
      offset < 0 ||
      size < 1 ||
      offset + size > data.bytes.byteLength
    )
      return fail("buffer view bounds");
    const out: Json = {
      buffer: 0,
      byteOffset: data.offset + offset,
      byteLength: size,
    };
    if (view.byteStride !== undefined) out.byteStride = view.byteStride;
    return out;
  });
  const accessors: Json[] = ((doc.accessors ?? []) as unknown[]).map(
    (accessor) => (record(accessor) ? { ...accessor } : fail("accessor")),
  );
  const ownAccessors = accessors.length,
    view = (target: MargoSection, stride?: number) => {
      views.push({
        buffer: 0,
        byteOffset: target.offset,
        byteLength: target.bytes.byteLength,
        ...(stride && { byteStride: stride }),
      });
      return views.length - 1;
    },
    accessor = (fields: Json) => accessors.push(fields) - 1;
  const shared = new Map<string, Json>();
  let geometryBytes = 0;
  const meshes = doc.meshes.map((mesh) => {
    if (
      !record(mesh) ||
      !Array.isArray(mesh.primitives) ||
      !mesh.primitives.length
    )
      throw new TypeError(
        "Invalid .margo primitives; every mesh needs at least one primitive, so re-export the file from Blender",
      );
    const primitives = mesh.primitives.map((p: unknown) => {
      if (!record(p) || p.extensions || (p.mode !== undefined && p.mode !== 4))
        return fail("primitive");
      const vertices = section(p.vertices, 2, "vertex section"),
        indices = section(p.indices, 3, "index section"),
        key = `${p.vertices}:${p.indices}`;
      let geometry = shared.get(key);
      if (!geometry) {
        const count = vertices.bytes.byteLength / vertices.stride,
          floats = new Float32Array(
            buffer,
            base + vertices.offset,
            vertices.bytes.byteLength / 4,
          ),
          wide = indices.stride === 4,
          raw = wide
            ? new Uint32Array(
                buffer,
                base + indices.offset,
                indices.bytes.byteLength / 4,
              )
            : Uint32Array.from(
                new Uint16Array(
                  buffer,
                  base + indices.offset,
                  indices.bytes.byteLength / 2,
                ),
              );
        geometryBytes += count * 80 + raw.length * 4;
        if (count < 3 || count > 1_000_000 || geometryBytes > maxBytes)
          throw new RangeError(
            ".margo geometry exceeds decoded size limit; split the scene into smaller files (3 to 1,000,000 vertices per mesh)",
          );
        const packed =
          vertices.stride === 24 ? expandCompact(floats, count) : floats;
        validatePreparedGeometry({ vertices: packed, indices: raw });
        const min = [Infinity, Infinity, Infinity],
          max = [-Infinity, -Infinity, -Infinity];
        let tangents = true;
        for (let i = 0; i < count; i++) {
          for (let axis = 0; axis < 3; axis++) {
            const value = packed[i * 20 + axis];
            min[axis] = Math.min(min[axis], value);
            max[axis] = Math.max(max[axis], value);
          }
          if (packed[i * 20 + 11] === 0) tangents = false;
        }
        const stride = vertices.stride,
          at = view(vertices, stride),
          float = (byteOffset: number, type: string, extra: Json = {}) =>
            accessor({
              bufferView: at,
              byteOffset,
              componentType: 5126,
              count,
              type,
              ...extra,
            });
        const attributes: Json = {
          POSITION: float(0, "VEC3", { min, max }),
          NORMAL: float(stride === 24 ? 12 : 16, "VEC3"),
        };
        if (stride === 80) {
          if (tangents) attributes.TANGENT = float(32, "VEC4");
          attributes.TEXCOORD_0 = float(48, "VEC2");
          attributes.TEXCOORD_1 = float(56, "VEC2");
          attributes.COLOR_0 = float(64, "VEC4");
        }
        geometry = {
          attributes,
          indices: accessor({
            bufferView: view(indices),
            componentType: wide ? 5125 : 5123,
            count: raw.length,
            type: "SCALAR",
          }),
        };
        shared.set(key, geometry);
      }
      const out: Json = {
        attributes: { ...(geometry.attributes as Json) },
        indices: geometry.indices,
        mode: 4,
      };
      if (p.material !== undefined) out.material = p.material;
      if (p.attributes !== undefined) {
        if (!flags || !record(p.attributes))
          return fail("primitive attributes");
        for (const [name, id] of Object.entries(p.attributes)) {
          if (!skinAttributes.has(name)) return fail(`attribute ${name}`);
          (out.attributes as Json)[name] = index(
            id,
            ownAccessors,
            `attribute ${name}`,
          );
        }
      }
      if (p.targets !== undefined) {
        if (!flags || !Array.isArray(p.targets) || !p.targets.length)
          return fail("morph targets");
        out.targets = p.targets.map((target: unknown) => {
          if (!record(target)) return fail("morph target");
          const own: Json = {};
          for (const [name, id] of Object.entries(target)) {
            if (name !== "POSITION" && name !== "NORMAL")
              return fail(`morph attribute ${name}`);
            own[name] = index(id, ownAccessors, `morph attribute ${name}`);
          }
          return own;
        });
      }
      return out;
    });
    const out: Json = { primitives };
    for (const key of ["name", "weights", "extras"])
      if (mesh[key] !== undefined) out[key] = mesh[key];
    return out;
  });
  let decoded = 0;
  const pngs: Uint8Array<ArrayBuffer>[] = [];
  const images = ((doc.images ?? []) as unknown[]).map((image) => {
    if (
      !record(image) ||
      image.mimeType !== "image/png" ||
      image.uri !== undefined
    )
      throw new TypeError(
        ".margo images must be embedded PNG; export textures as embedded PNG sections, not URIs",
      );
    const png = section(image.section, 4, "image section"),
      [width, height] = pngSize(png.bytes);
    decoded += width * height * 4;
    if (decoded > maxBytes)
      throw new RangeError(
        ".margo images exceed decoded size limit; use textures of at most 4096 x 4096 pixels",
      );
    pngs.push(png.bytes);
    return { bufferView: view(png), mimeType: "image/png" };
  });
  const document: Json = {
    ...doc,
    buffers: [{ byteLength: length }],
    bufferViews: views,
    accessors,
    meshes,
  };
  if (images.length) document.images = images;
  else delete document.images;
  // Untrusted metadata past the container, section and geometry checks; glTF Pro validates the rest on load.
  return {
    document: document as GLTFDocument,
    buffer: new Uint8Array(buffer, base, length),
    images: pngs,
  };
}

/**
 * Decodes an animated (or static) `.margo` file and attaches it to `engine` as a glTF Pro `PBRModel` with its skins,
 * morph targets and clips, ready for `Animation.attach(model)` from `@margoengine/animation`. WebGPU only.
 *
 * @example
 * const model = await parseAnimatedMargo(engine, await file.arrayBuffer(), { signal });
 */
export async function parseAnimatedMargo(
  engine: EngineKernel,
  input: ArrayBuffer | ArrayBufferView,
  { signal, maxNodes }: MargoOptions & { signal?: AbortSignal } = {},
): Promise<PBRModel> {
  signal?.throwIfAborted();
  const asset = margoToGLTF(input, { maxNodes }),
    images = await decodeImages(asset.images, signal);
  try {
    signal?.throwIfAborted();
    return parseGLTF(
      engine,
      asset.document,
      [asset.buffer],
      images,
      {},
      { maxNodes },
    );
  } catch (error) {
    for (const image of images) image.close();
    throw error;
  }
}

/**
 * Fetches an animated `.margo` file over HTTP(S) and parses it like parseAnimatedMargo.
 *
 * @example
 * import { Animation } from '@margoengine/animation';
 * const model = await loadAnimatedMargo(engine, '/hero.margo');
 * Animation.attach(model).play(0);
 */
export async function loadAnimatedMargo(
  engine: EngineKernel,
  url: string | URL,
  {
    signal,
    maxNodes,
    fetch: get = globalThis.fetch,
  }: MargoOptions & { signal?: AbortSignal; fetch?: typeof fetch } = {},
): Promise<PBRModel> {
  signal?.throwIfAborted();
  const target = new URL(url, globalThis.location?.href);
  if (!["http:", "https:"].includes(target.protocol))
    throw new TypeError(
      ".margo URL must use HTTP(S); pass an http: or https: URL, or read the file yourself and call parseAnimatedMargo",
    );
  const bytes = await readResponse(await get(target, { signal }), {
    maxBytes,
    signal,
    label: ".margo download",
  });
  return parseAnimatedMargo(engine, bytes, { signal, maxNodes });
}
