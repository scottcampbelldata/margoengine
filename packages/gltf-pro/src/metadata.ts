// KHR_xmp_json_ld (Complete, Ratified by the Khronos Group), from its README on KhronosGroup/glTF main, last changed in
// 736150dc of 2022-01-04. Metadata has no effect on rendering, so every loader carries it as plain data and this entry
// reads it: packets stay as written, and properties resolve through each packet's @context by namespace URI, not prefix.
import type { GLTFDocument } from '../../shared/gltf.js';
import type { GLTFAsset } from './asset.js';
import type { PBRModel } from './index.js';

const extension = 'KHR_xmp_json_ld';
const dc = 'http://purl.org/dc/elements/1.1/',
  xmp = 'http://ns.adobe.com/xap/1.0/',
  xmpRights = 'http://ns.adobe.com/xap/1.0/rights/',
  cc = 'http://creativecommons.org/ns#',
  rdf = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
/** The namespaces `fields` reads, by their usual prefix. */
export const xmpNamespaces = { dc, xmp, xmpRights, cc, rdf } as const;
// Adobe Substance 3D Stager writes xmp:CreatorTool with no xmp entry in @context, so a prefix the packet leaves undefined
// falls back to its usual meaning. A prefix the packet does define always means what the packet says.
const usual = new Map<string, string>(Object.entries(xmpNamespaces));
// XMP structures nest a few levels; a file nesting past this is hostile, and the walk below recurses.
const maxDepth = 64;

/** Text in a stated language, from a value object or a local `@context`. */
export interface XMPText {
  readonly text: string;
  readonly language?: string;
}
/** An `rdf:Alt`: the same text in several languages, in `rdf:_N` order. */
export interface XMPAlternatives {
  readonly alternatives: readonly XMPText[];
}
/** An XMP structure. */
export interface XMPStructure {
  readonly properties: readonly XMPProperty[];
}
/** One XMP value: `@list` and `@set` become arrays; the packet's `raw` keeps which one the file used. */
export type XMPValue = string | number | boolean | XMPText | XMPAlternatives | XMPStructure | readonly XMPValue[];
/** One property of a packet or structure. */
export interface XMPProperty {
  /** Namespace URI, from `@context`; unset for a prefix nothing defines. */
  readonly namespace?: string;
  /** The prefix as written in this packet. */
  readonly prefix?: string;
  readonly name: string;
  readonly value: XMPValue;
}
/** What attribution and asset pipelines ask for. Unset or empty when the metadata does not say. */
export interface GLTFMetadataFields {
  /** `dc:title`. */
  readonly title: string | undefined;
  /** `dc:description`. */
  readonly description: string | undefined;
  /** `dc:creator`, in the file's order. */
  readonly authors: readonly string[];
  /** `dc:contributor`. */
  readonly contributors: readonly string[];
  /** `dc:publisher`. */
  readonly publishers: readonly string[];
  /** The first `dc:date`, as written. */
  readonly date: string | undefined;
  /** `dc:source`. */
  readonly source: string | undefined;
  /** `xmp:CreatorTool`; for the whole file, else glTF `asset.generator`. */
  readonly tool: string | undefined;
  /** `dc:rights` as written: XMP's one free-text rights statement, which files use for a copyright line or a licence name. */
  readonly rights: string | undefined;
  /** `cc:license`, else `xmpRights:UsageTerms`, else `xmpRights:WebStatement`, else `rights`. */
  readonly license: string | undefined;
  /** For the whole file glTF `asset.copyright`, else `rights`; for an object its own `rights`, else the whole file's. */
  readonly copyright: string | undefined;
}
/** One entry of the file's `packets` array. */
export interface XMPPacket {
  /** Its index in `packets`. */
  readonly index: number;
  /** The packet as written in the file. */
  readonly raw: Readonly<Record<string, unknown>>;
  /** Prefix to namespace URI, as in `@context`. */
  readonly namespaces: ReadonlyMap<string, string>;
  /** `@id`, the AboutURI, usually empty. */
  readonly about: string | undefined;
  readonly properties: readonly XMPProperty[];
  /** This packet alone, with nothing inherited. Packets no object lists, such as credits for a sound, read here. */
  readonly fields: GLTFMetadataFields;
  /** A property by namespace URI and name, whichever prefix the packet gave that namespace. */
  get(namespace: string, name: string): XMPValue | undefined;
}
/** The glTF objects a packet can sit on, besides `asset`. */
export type GLTFMetadataKind = 'scene' | 'node' | 'mesh' | 'material' | 'image' | 'animation';
/** One glTF object with its own packet. */
export interface GLTFMetadataObject {
  readonly kind: GLTFMetadataKind;
  /** Index in the file's array for `kind`. */
  readonly index: number;
  /** The object's glTF `name`. */
  readonly name: string | undefined;
  /** Index of its packet. */
  readonly packet: number;
  /** Its packet over the whole file's fields. */
  readonly fields: GLTFMetadataFields;
}
/** Everything `readGLTFMetadata` found. */
export interface GLTFMetadata {
  /** Every packet of the file, referenced or not. */
  readonly packets: readonly XMPPacket[];
  /** The packet on glTF `asset`, which applies to the whole file, with `asset.copyright` and `asset.generator`. */
  readonly asset: GLTFMetadataFields;
  /** Each object with its own packet, in the order scenes, nodes, meshes, materials, images, animations. */
  readonly objects: readonly GLTFMetadataObject[];
  /** The fields that apply to one object: its packet property by property over the whole file's. */
  fieldsOf(kind: GLTFMetadataKind, index: number): GLTFMetadataFields;
}
/** Options of `readGLTFMetadata`. */
export interface GLTFMetadataOptions {
  /** BCP 47 tag to prefer among language alternatives, such as `it` or `it-it`. Default: `x-default`, else the first listed. */
  language?: string;
}

const lists: Record<GLTFMetadataKind, 'scenes' | 'nodes' | 'meshes' | 'materials' | 'images' | 'animations'> = {
  scene: 'scenes',
  node: 'nodes',
  mesh: 'meshes',
  material: 'materials',
  image: 'images',
  animation: 'animations',
};
const invalid = (what: string): TypeError =>
  new TypeError(
    `Invalid ${extension} ${what}; the file is not valid glTF 2.0, re-export it and check it with the glTF Validator`,
  );
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
// Keys come from the file, so `constructor` or `__proto__` must read as absent, never through the prototype.
const own = (value: Record<string, unknown>, key: string): unknown =>
  Object.hasOwn(value, key) ? value[key] : undefined;

function namespaceOf(prefix: string, namespaces: ReadonlyMap<string, string>): string | undefined {
  return namespaces.get(prefix) ?? usual.get(prefix);
}
function splitName(key: string, namespaces: ReadonlyMap<string, string>) {
  const colon = key.indexOf(':');
  if (colon < 0) return { name: key };
  const prefix = key.slice(0, colon);
  return { namespace: namespaceOf(prefix, namespaces), prefix, name: key.slice(colon + 1) };
}
function isAlternatives(value: Record<string, unknown>, namespaces: ReadonlyMap<string, string>): boolean {
  const type = own(value, '@type');
  if (typeof type !== 'string') return false;
  const { namespace, name } = splitName(type, namespaces);
  return namespace === rdf && name === 'Alt';
}
function alternativesOf(
  value: Record<string, unknown>,
  namespaces: ReadonlyMap<string, string>,
  language: string | undefined,
  depth: number,
): XMPText[] {
  const members: { order: number; text: XMPText }[] = [];
  for (const key of Object.keys(value)) {
    const { namespace, name } = splitName(key, namespaces),
      order = /^_(\d+)$/.exec(name)?.[1];
    if (namespace !== rdf || order === undefined) continue;
    const member = readValue(own(value, key), namespaces, language, depth + 1),
      text = plainText(member);
    if (text !== undefined)
      members.push({
        order: Number(order),
        text: isText(member) && member.language !== undefined ? { text, language: member.language } : { text },
      });
  }
  return members.sort((a, b) => a.order - b.order).map((member) => member.text);
}
function readValue(
  value: unknown,
  namespaces: ReadonlyMap<string, string>,
  language: string | undefined,
  depth: number,
): XMPValue | undefined {
  if (depth > maxDepth) throw invalid(`packet: values nest deeper than ${maxDepth} levels`);
  if (typeof value === 'string') return language === undefined ? value : { text: value, language };
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return readItems(value, namespaces, language, depth);
  // JSON-LD reads null as no value.
  if (!isRecord(value)) return undefined;
  const context = own(value, '@context'),
    local = isRecord(context) ? own(context, '@language') : undefined,
    scope = typeof local === 'string' ? local : language;
  for (const key of ['@list', '@set'])
    if (Object.hasOwn(value, key)) {
      const items = own(value, key);
      return readItems(Array.isArray(items) ? items : [items], namespaces, scope, depth);
    }
  if (Object.hasOwn(value, '@value')) {
    const inner = own(value, '@value'),
      tag = own(value, '@language');
    return readValue(inner, namespaces, typeof tag === 'string' ? tag : scope, depth + 1);
  }
  if (isAlternatives(value, namespaces))
    return { alternatives: alternativesOf(value, namespaces, scope, depth) };
  return { properties: readProperties(value, namespaces, scope, depth + 1) };
}
function readItems(
  items: readonly unknown[],
  namespaces: ReadonlyMap<string, string>,
  language: string | undefined,
  depth: number,
): XMPValue[] {
  const out: XMPValue[] = [];
  for (const item of items) {
    const value = readValue(item, namespaces, language, depth + 1);
    if (value !== undefined) out.push(value);
  }
  return out;
}
function readProperties(
  source: Record<string, unknown>,
  namespaces: ReadonlyMap<string, string>,
  language: string | undefined,
  depth: number,
): XMPProperty[] {
  const out: XMPProperty[] = [];
  for (const key of Object.keys(source)) {
    if (key.startsWith('@')) continue;
    const value = readValue(own(source, key), namespaces, language, depth);
    if (value !== undefined) out.push({ ...splitName(key, namespaces), value });
  }
  return out;
}

const isText = (value: XMPValue | undefined): value is XMPText =>
  isRecord(value) && typeof (value as Partial<XMPText>).text === 'string';
const plainText = (value: XMPValue | undefined): string | undefined =>
  typeof value === 'string'
    ? value
    : typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : isText(value)
        ? value.text
        : undefined;
// Exact tag first, then the same language in another region (`en` for `en-us`, `en-gb` for `en-us`), then x-default,
// then the first listed: a reader always gets the file's text, in the nearest language it has.
function pick(alternatives: readonly XMPText[], language: string | undefined): string | undefined {
  const tag = (value: XMPText) => value.language?.toLowerCase(),
    wanted = language?.toLowerCase(),
    primary = wanted?.split('-')[0];
  const found =
    (wanted && alternatives.find((value) => tag(value) === wanted)) ||
    (primary && alternatives.find((value) => tag(value)?.split('-')[0] === primary)) ||
    alternatives.find((value) => tag(value) === 'x-default') ||
    alternatives[0];
  return found?.text;
}
function texts(value: XMPValue | undefined, language: string | undefined): string[] {
  if (Array.isArray(value)) return (value as readonly XMPValue[]).flatMap((item) => texts(item, language));
  const single =
    isRecord(value) && 'alternatives' in value
      ? pick((value as unknown as XMPAlternatives).alternatives, language)
      : plainText(value);
  return single === undefined ? [] : [single];
}
function packetFields(packet: Pick<XMPPacket, 'get'>, language: string | undefined): GLTFMetadataFields {
  const all = (namespace: string, name: string) => texts(packet.get(namespace, name), language),
    one = (namespace: string, name: string): string | undefined => all(namespace, name)[0],
    rights = one(dc, 'rights');
  return {
    title: one(dc, 'title'),
    description: one(dc, 'description'),
    authors: all(dc, 'creator'),
    contributors: all(dc, 'contributor'),
    publishers: all(dc, 'publisher'),
    date: one(dc, 'date'),
    source: one(dc, 'source'),
    tool: one(xmp, 'CreatorTool'),
    rights,
    license: one(cc, 'license') ?? one(xmpRights, 'UsageTerms') ?? one(xmpRights, 'WebStatement') ?? rights,
    copyright: rights,
  };
}
function readPacket(raw: unknown, index: number, language: string | undefined): XMPPacket {
  if (!isRecord(raw)) throw invalid(`packet ${index}: it is not an object`);
  const context = own(raw, '@context');
  if (!isRecord(context)) throw invalid(`packet ${index}: it has no @context`);
  const namespaces = new Map<string, string>();
  for (const prefix of Object.keys(context)) {
    const uri = own(context, prefix);
    if (typeof uri !== 'string') throw invalid(`packet ${index}: @context entry ${prefix} is not a string`);
    namespaces.set(prefix, uri);
  }
  const id = own(raw, '@id'),
    properties = readProperties(raw, namespaces, undefined, 0),
    get = (namespace: string, name: string) =>
      properties.find((property) => property.namespace === namespace && property.name === name)?.value;
  return {
    index,
    raw,
    namespaces,
    about: typeof id === 'string' ? id : undefined,
    properties,
    fields: packetFields({ get }, language),
    get,
  };
}
function over(top: GLTFMetadataFields, base: GLTFMetadataFields): GLTFMetadataFields {
  const list = (a: readonly string[], b: readonly string[]) => (a.length ? a : b);
  return {
    title: top.title ?? base.title,
    description: top.description ?? base.description,
    authors: list(top.authors, base.authors),
    contributors: list(top.contributors, base.contributors),
    publishers: list(top.publishers, base.publishers),
    date: top.date ?? base.date,
    source: top.source ?? base.source,
    tool: top.tool ?? base.tool,
    rights: top.rights ?? base.rights,
    license: top.license ?? base.license,
    copyright: top.copyright ?? base.copyright,
  };
}
const empty: GLTFMetadataFields = packetFields({ get: () => undefined }, undefined);

/**
 * Reads a file's KHR_xmp_json_ld metadata: author, licence, copyright and every other XMP property, for the whole file
 * and per object. Metadata on an object takes precedence over metadata on `asset`, property by property, as the
 * extension says. A file without the extension gives no packets and whatever glTF `asset` itself states.
 * @param source A loaded model, a `GLTFAsset` or a glTF document.
 * @throws TypeError for a packet list or `packet` reference that is not valid glTF.
 */
export function readGLTFMetadata(
  source: PBRModel | GLTFAsset | GLTFDocument,
  options: GLTFMetadataOptions = {},
): GLTFMetadata {
  const holder = source as { asset?: { doc?: GLTFDocument }; doc?: GLTFDocument },
    doc = holder.asset?.doc ?? holder.doc ?? (source as GLTFDocument),
    root = doc.extensions?.[extension] as { packets?: unknown } | undefined,
    { language } = options;
  if (root !== undefined && !Array.isArray(root?.packets)) throw invalid('extension: packets is not an array');
  const packets = ((root?.packets ?? []) as unknown[]).map((raw, index) => readPacket(raw, index, language));
  const packetOn = (object: unknown, label: string): XMPPacket | undefined => {
    const reference = isRecord(object) && isRecord(object.extensions) ? own(object.extensions, extension) : undefined;
    if (reference === undefined) return undefined;
    const index = isRecord(reference) ? own(reference, 'packet') : undefined;
    if (!Number.isInteger(index) || !packets[index as number])
      throw invalid(`reference on ${label}: it names no entry of packets`);
    return packets[index as number];
  };
  const onAsset = packetOn(doc.asset, 'asset')?.fields ?? empty,
    asset: GLTFMetadataFields = {
      ...onAsset,
      tool: onAsset.tool ?? plainText(doc.asset?.generator as XMPValue | undefined),
      copyright: plainText(doc.asset?.copyright as XMPValue | undefined) ?? onAsset.copyright,
    };
  const objects: GLTFMetadataObject[] = [];
  const byObject = new Map<string, GLTFMetadataFields>();
  for (const kind of Object.keys(lists) as GLTFMetadataKind[])
    (doc[lists[kind]] ?? []).forEach((object: { name?: string }, index: number) => {
      const packet = packetOn(object, `${kind} ${index}`);
      if (!packet) return;
      const fields = over(packet.fields, asset);
      byObject.set(`${kind} ${index}`, fields);
      objects.push({ kind, index, name: object?.name, packet: packet.index, fields });
    });
  return {
    packets,
    asset,
    objects,
    fieldsOf(kind, index) {
      const list = lists[kind];
      if (!list) throw new RangeError(`Unknown glTF object kind ${String(kind)}; pass ${Object.keys(lists).join(', ')}`);
      if (!Number.isInteger(index) || index < 0 || index >= (doc[list]?.length ?? 0))
        throw new RangeError(`No glTF ${kind} ${String(index)}; pass an index below ${doc[list]?.length ?? 0}`);
      return byObject.get(`${kind} ${index}`) ?? asset;
    },
  };
}
