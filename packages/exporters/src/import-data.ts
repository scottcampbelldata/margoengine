// Shared, self-contained helpers of the engine-import bundles (`./godot`, `./unity`): JSON shape guards, the embedded
// GLB range check, node hierarchy, SHA-256 file digests and the entry type. Geometry stays owned by the native importer.
import { MargoError } from '@margoengine/math/errors';
import type { ZIPEntry } from './archive.js';
import { ACCESSOR_WIDTHS as ARITY, COMPONENT_BYTES, readComponent } from '../../shared/accessor.js';

/** One file of an import bundle: a safe relative POSIX path and its owned bytes. Pass entries to `encodeZIP`. */
export interface BundleEntry extends ZIPEntry {
  data: Uint8Array;
}

/** Size and SHA-256 (lowercase hex) of one bundle file, as listed in a bundle manifest. */
export interface FileDigest {
  name: string;
  bytes: number;
  sha256: string;
}

/** @internal */
export type Json = Record<string, unknown>;

/** @internal */
export const utf8 = new TextEncoder();

/** @internal */
export const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
/** @internal */
export const object = (value: unknown, label: string): Json => {
  if (!isObject(value)) throw new TypeError(`${label} must be an object; pass an encoded Margo GLB`);
  return value;
};
/** @internal An optional glTF array of objects (`[]` when absent). */
export const records = (value: unknown, label: string): Json[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array; repair the GLB`);
  return value.map((entry, i) => object(entry, `${label}[${i}]`));
};
/** @internal An index into an array of `length` entries. */
export const index = (value: unknown, length: number, label: string): number => {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) >= length)
    throw new RangeError(`${label} must reference an existing entry; repair the GLB`);
  return value as number;
};
/** @internal Thrower of the target's `unsupported` errors: `Godot import profile <message>`. */
export const unsupportedFor =
  (target: string) =>
  (message: string): never => {
    throw new MargoError('unsupported', `${target} import profile ${message}`);
  };
/**
 * @internal A bundle folder: `/`-separated ASCII letters, digits, `_` and `-`, starting with `root` when given, with no
 * Windows device name or `reserved` (regex alternatives) segment after the root.
 * @throws TypeError for anything else, naming `example`.
 */
export function bundleFolder(value: unknown, target: string, example: string, root = '', reserved = ''): string {
  const parts = typeof value === 'string' ? value.split('/') : [],
    names = root ? parts.slice(1) : parts,
    bad = new RegExp(`^(?:${reserved}con|prn|aux|nul|com[1-9]|lpt[1-9])$`, 'i');
  if ((root && parts[0] !== root) || !names.length || names.some((p) => !/^[\w-]+$/.test(p) || bad.test(p)))
    throw new TypeError(
      `${target} folder ${JSON.stringify(value)} is not a safe relative path; use one like ${example} (letters, digits, _ and -)`,
    );
  return value as string;
}
/** @internal Pretty JSON plus a final newline, as UTF-8. */
export const encodeJSON = (value: unknown): Uint8Array => utf8.encode(`${JSON.stringify(value, null, 2)}\n`);

/** @internal SHA-256 of `bytes` as lowercase hex. Reads the view in place; never copies it. */
export async function sha256(bytes: Uint8Array, target: string): Promise<string> {
  if (!globalThis.crypto?.subtle)
    unsupportedFor(target)('needs Web Crypto SHA-256; use a secure browser context or a current Node runtime');
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
  let hex = '';
  for (const byte of digest) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/**
 * @internal Digests of `entries`. `known` maps byte arrays already hashed (the GLB, the atlas) to their digest so
 * they are not hashed twice.
 */
export async function digests(
  entries: readonly BundleEntry[],
  target: string,
  known: ReadonlyMap<Uint8Array, string> = new Map(),
): Promise<FileDigest[]> {
  return Promise.all(
    entries.map(async ({ name, data }) => ({
      name,
      bytes: data.length,
      sha256: known.get(data) ?? (await sha256(data, target)),
    })),
  );
}

/** @internal Code-unit order, independent of locale. */
export const byName = (a: { name: string }, b: { name: string }): number =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

/**
 * @internal Parent of each node (-1 for a root).
 * @throws TypeError for non-array children, a node with two parents or a cycle; RangeError for a missing child.
 */
export function nodeParents(nodes: readonly Json[], target: string): number[] {
  const parents = nodes.map(() => -1);
  nodes.forEach((node, i) => {
    if (node.children === undefined) return;
    if (!Array.isArray(node.children))
      throw new TypeError(`${target} node ${i} children must be an array; repair the GLB`);
    for (const child of node.children as unknown[]) {
      const at = index(child, nodes.length, `${target} node ${i} child`);
      if (parents[at] !== -1)
        throw new TypeError(`${target} nodes must have one parent; repair duplicate child references`);
      parents[at] = i;
    }
  });
  const done = new Set<number>();
  for (let i = 0; i < nodes.length; i++) {
    const chain = new Set<number>();
    for (let p = i; p !== -1 && !done.has(p); p = parents[p]) {
      if (chain.has(p)) throw new TypeError(`${target} node graph has a cycle; repair the hierarchy`);
      chain.add(p);
    }
    for (const p of chain) done.add(p);
  }
  return parents;
}

/**
 * @internal Checks that every buffer view, accessor and image range lies inside the owned embedded BIN chunk and that
 * no compression, sparse or external data is used. Never rewrites the GLB. `target` names the profile in messages.
 */
export function validateEmbeddedImportData(document: Json, bin: Uint8Array | null, target: string): void {
  const unsupported = unsupportedFor(target);
  const buffers = records(document.buffers, 'GLB buffers');
  if (buffers.length > 1 || buffers.some((buffer) => buffer.uri !== undefined))
    unsupported('needs only embedded buffer 0; export a self-contained GLB without external or additional buffers');
  if (buffers.length !== (bin ? 1 : 0))
    throw new TypeError(`${target} buffer 0 needs its owned BIN chunk; export a self-contained GLB`);
  const views = records(document.bufferViews, 'GLB bufferViews');
  for (const view of views) {
    if (isObject(view.extensions) && view.extensions.EXT_meshopt_compression !== undefined)
      unsupported('needs ordinary embedded bufferViews; export an uncompressed Margo GLB');
    index(view.buffer, buffers.length, `${target} bufferView buffer`);
    const offset = (view.byteOffset ?? 0) as number,
      length = view.byteLength as number;
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(length) ||
      length < 1 ||
      !Number.isSafeInteger(offset + length) ||
      offset + length > (buffers[0].byteLength as number)
    )
      throw new RangeError(`${target} bufferView exceeds embedded buffer 0; repair the GLB byte range`);
  }
  const accessors = records(document.accessors, 'GLB accessors');
  for (const accessor of accessors) {
    if (accessor.sparse !== undefined) unsupported('needs ordinary embedded accessors; export a nonsparse Margo GLB');
    const view = views[index(accessor.bufferView, views.length, `${target} accessor bufferView`)];
    const componentBytes = COMPONENT_BYTES[String(accessor.componentType)],
      width = ARITY[String(accessor.type)];
    if (!Number.isInteger(accessor.componentType) || !componentBytes || !width)
      throw new TypeError(`${target} accessor needs a valid componentType and type; repair the GLB`);
    if (String(accessor.type).startsWith('MAT') && componentBytes < 4)
      unsupported('needs Float32 matrix accessors; export through the ordinary Margo GLB route');
    const element = componentBytes * width,
      offset = (accessor.byteOffset ?? 0) as number,
      stride = (view.byteStride ?? element) as number,
      count = accessor.count as number,
      end = offset + (count - 1) * stride + element;
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset % componentBytes ||
      (((view.byteOffset ?? 0) as number) + offset) % componentBytes ||
      !Number.isSafeInteger(count) ||
      count < 1 ||
      !Number.isSafeInteger(stride) ||
      stride < element ||
      stride % componentBytes ||
      (view.byteStride !== undefined && stride > 252) ||
      !Number.isSafeInteger(end) ||
      end > (view.byteLength as number)
    )
      throw new RangeError(`${target} accessor exceeds its embedded bufferView; repair count, offset or stride`);
  }
  const accessor = (value: unknown, label: string) => index(value, accessors.length, `${target} ${label} accessor`);
  for (const mesh of records(document.meshes, 'GLB meshes')) {
    for (const primitive of records(mesh.primitives, 'GLB mesh primitives')) {
      if (isObject(primitive.extensions) && primitive.extensions.KHR_draco_mesh_compression !== undefined)
        unsupported('needs ordinary embedded geometry; export an uncompressed Margo GLB');
      for (const reference of Object.values(object(primitive.attributes, `${target} mesh attributes`)))
        accessor(reference, 'mesh attribute');
      if (primitive.indices !== undefined) accessor(primitive.indices, 'mesh index');
      for (const morph of records(primitive.targets, `${target} mesh morph targets`))
        for (const reference of Object.values(morph)) accessor(reference, 'morph');
    }
  }
  for (const skin of records(document.skins, 'GLB skins'))
    if (skin.inverseBindMatrices !== undefined) accessor(skin.inverseBindMatrices, 'inverse bind');
  for (const clip of records(document.animations, 'GLB animations'))
    for (const sampler of records(clip.samplers, `${target} animation samplers`)) {
      accessor(sampler.input, 'animation input');
      accessor(sampler.output, 'animation output');
    }
  for (const image of records(document.images, 'GLB images')) {
    if (image.uri !== undefined || image.mimeType !== 'image/png' || image.bufferView === undefined)
      unsupported('needs embedded PNG images; export self-contained PNG textures without recompression');
    index(image.bufferView, views.length, `${target} image bufferView`);
  }
}

/**
 * @internal Reader of one validated accessor's components: `read(element, component)`. Call only after
 * {@link validateEmbeddedImportData}, which proves every read stays inside `bin`.
 */
export function accessorReader(
  accessor: Json,
  views: readonly Json[],
  bin: Uint8Array,
): (element: number, component: number) => number {
  const view = views[accessor.bufferView as number],
    data = new DataView(bin.buffer, bin.byteOffset, bin.byteLength),
    size = COMPONENT_BYTES[String(accessor.componentType)],
    base = ((view.byteOffset ?? 0) as number) + ((accessor.byteOffset ?? 0) as number),
    stride = (view.byteStride ?? size * ARITY[String(accessor.type)]) as number;
  const type = accessor.componentType as number;
  return (element, component) => readComponent(data, base + element * stride + component * size, type);
}
