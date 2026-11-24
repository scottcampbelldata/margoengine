// BCF, the BIM Collaboration Format, for IFC models: viewpoints as .bcfv XML (BCF 3.0, 2.1 and 1.0) and as BCF-API
// 3.0 JSON, topics with comments, viewpoints, snapshots and documents in .bcf archives, and the bridge to a Margo view:
// camera, visibility, selection, colours, section planes and markup lines in engine axes, components by expressID.
// Written from buildingSMART's BCF-XML 3.0 and 2.1 schemas (visinfo, markup, extensions, project, documents, version)
// and documentation, and the BCF-API 3.0 viewpoint JSON schemas. BCF coordinates are the IFC world in meters, Z up.
import { crc32, LoaderError, readZipDirectory, readZipEntry, type ZipOptions } from '@margoengine/loaders/common';
import { parseXMLDocument, type XMLElement } from '../../shared/xml-document.js';
import { escapeXML } from '../../shared/xml-escape.js';
import { engineToIFC, ifcToEngine, type IFCData } from './data.js';
import { isSubtypeOf } from './schema.js';

type Vec3 = [number, number, number];
/** A component: an IFC GlobalId, or the authoring tool's own ID as a fallback. */
export interface BCFComponent {
  ifcGuid?: string;
  originatingSystem?: string;
  authoringToolId?: string;
}
/** The one camera of a viewpoint, in IFC world meters (Z up). */
export interface BCFCamera {
  type: 'perspective' | 'orthogonal';
  position: Vec3;
  direction: Vec3;
  up: Vec3;
  /** Perspective: the entire vertical field of view in degrees, (0, 180). */
  fieldOfView?: number;
  /** Orthogonal: the visible vertical size in meters. */
  viewToWorldScale?: number;
  /** Width / height. 1 when a BCF 2.x or 1.0 file has none, as BCF 3.0 asks. */
  aspectRatio: number;
}
/** A bitmap placed in the model; `data` holds the image when it was read from an archive or JSON. */
export interface BCFBitmap {
  format: 'png' | 'jpg';
  reference: string;
  location: Vec3;
  normal: Vec3;
  up: Vec3;
  /** Height in meters. */
  height: number;
  data?: Uint8Array;
}
/** One BCF viewpoint (a .bcfv file or a BCF-API viewpoint). */
export interface BCFViewpoint {
  /** Lower-case UUID. */
  guid: string;
  /** Required by BCF 3.0; a 2.x viewpoint may have none. */
  camera?: BCFCamera;
  /** Components to show selected. */
  selection: BCFComponent[];
  /** Visible unless listed in `exceptions` (true), or hidden unless listed (false, the BCF default). */
  defaultVisibility: boolean;
  exceptions: BCFComponent[];
  /** View setup hints, applied after `defaultVisibility` and before `exceptions`. Default false each. */
  spacesVisible: boolean;
  spaceBoundariesVisible: boolean;
  openingsVisible: boolean;
  /** Colours as BCF writes them: `RRGGBB` or `AARRGGBB` hex. */
  coloring: { color: string; components: BCFComponent[] }[];
  lines: { start: Vec3; end: Vec3 }[];
  /** `direction` points into the clipped (invisible) half-space. */
  clippingPlanes: { location: Vec3; direction: Vec3 }[];
  bitmaps: BCFBitmap[];
  snapshot?: { format: 'png' | 'jpg'; data: Uint8Array };
  /** Sort order within its topic. */
  index?: number;
}
/** A comment of a topic; `viewpoint` is the GUID of the one viewpoint it refers to. */
export interface BCFComment {
  guid: string;
  date: string;
  author: string;
  comment?: string;
  viewpoint?: string;
  modifiedDate?: string;
  modifiedAuthor?: string;
}
/** An IFC file a topic refers to (the markup Header). */
export interface BCFFile {
  filename?: string;
  date?: string;
  reference?: string;
  ifcProject?: string;
  ifcSpatialStructureElement?: string;
  /** Default true. */
  isExternal: boolean;
}
/** A topic (an issue) with its comments and viewpoints. Dates are xs:dateTime strings. */
export interface BCFTopic {
  guid: string;
  serverAssignedId?: string;
  type: string;
  status: string;
  title: string;
  priority?: string;
  index?: number;
  labels: string[];
  referenceLinks: string[];
  creationDate: string;
  creationAuthor: string;
  modifiedDate?: string;
  modifiedAuthor?: string;
  dueDate?: string;
  assignedTo?: string;
  stage?: string;
  description?: string;
  files: BCFFile[];
  /** `data` holds the snippet file of an internal snippet read from an archive. */
  bimSnippet?: { type: string; reference: string; referenceSchema: string; isExternal: boolean; data?: Uint8Array };
  /** BCF 3.0 names a document of the archive (`documentGuid`) or a `url`; a BCF 2.1 ReferencedDocument is a `url`. */
  documentReferences: { guid?: string; documentGuid?: string; url?: string; description?: string }[];
  relatedTopics: string[];
  comments: BCFComment[];
  viewpoints: BCFViewpoint[];
}
/** The lists a project allows (BCF 3.0 extensions.xml). */
export interface BCFExtensions {
  topicTypes: string[];
  topicStatuses: string[];
  priorities: string[];
  topicLabels: string[];
  users: string[];
  snippetTypes: string[];
  stages: string[];
}
/** The contents of a .bcf archive. */
export interface BCFArchive {
  /** `3.0`, `2.1`, `2.0` or `1.0` when read; what writeBCF writes is its `version` option. */
  version: string;
  project?: { id: string; name?: string };
  extensions?: BCFExtensions;
  /** BCF 3.0 documents (documents.xml and the Documents folder). */
  documents: { guid: string; filename: string; description?: string; data?: Uint8Array }[];
  topics: BCFTopic[];
}

const F = 'BCF';
const fail = (code: 'syntax' | 'range' | 'unsupported' | 'aborted', message: string): never => {
  throw new LoaderError(F, code, message);
};
const abort = (signal?: AbortSignal) => {
  if (signal?.aborted) fail('aborted', 'aborted; pass a signal that is not aborted to read or write BCF');
};

// XML reading.
const kids = (e: XMLElement | undefined, name: string) => (e ? e.children.filter((c) => c.localName === name) : []);
const kid = (e: XMLElement | undefined, name: string): XMLElement | undefined => kids(e, name)[0];
const text = (e: XMLElement | undefined, name: string): string | undefined => {
  const v = kid(e, name)?.textContent.trim();
  return v ? v : undefined;
};
const attr = (e: XMLElement | undefined, name: string): string | undefined => e?.getAttribute(name) ?? undefined;
const bool = (v: string | undefined, fallback: boolean) => (v === undefined ? fallback : v === 'true' || v === '1');
const number = (e: XMLElement | undefined, name: string, where: string): number => {
  const v = Number(text(e, name));
  return Number.isFinite(v) ? v : fail('syntax', `${where} needs a finite ${name}; export the BCF again`);
};
const vec = (e: XMLElement | undefined, where: string): Vec3 =>
  e ? [number(e, 'X', where), number(e, 'Y', where), number(e, 'Z', where)] : fail('syntax', `${where} is missing; export the BCF again`);
const component = (c: XMLElement): BCFComponent => {
  const out: BCFComponent = {},
    guid = attr(c, 'IfcGuid'),
    system = text(c, 'OriginatingSystem'),
    tool = text(c, 'AuthoringToolId');
  if (guid) out.ifcGuid = guid;
  if (system) out.originatingSystem = system;
  if (tool) out.authoringToolId = tool;
  return out;
};
const components = (e: XMLElement | undefined) => kids(e, 'Component').map(component);
const xml = (source: string | Uint8Array, what: string) =>
  parseXMLDocument(typeof source === 'string' ? source : new TextDecoder().decode(source), {
    fail: (reason) => fail('syntax', `${what} is not well-formed XML (${reason}); export the BCF again`),
  }).documentElement;

/** Reads a .bcfv viewpoint: BCF 3.0, 2.1 (hints on Components, Color without Components, Bitmap elements) or 1.0. */
export function parseBCFViewpoint(source: string | Uint8Array): BCFViewpoint {
  const root = xml(source, 'The viewpoint');
  if (root.localName !== 'VisualizationInfo') fail('syntax', `a viewpoint starts with VisualizationInfo, not ${root.localName}`);
  const c = kid(root, 'Components'),
    visibility = kid(c, 'Visibility'),
    hints = kid(visibility, 'ViewSetupHints') ?? kid(c, 'ViewSetupHints');
  const vp: BCFViewpoint = {
    guid: (attr(root, 'Guid') ?? '').toLowerCase(),
    selection: components(kid(c, 'Selection')),
    defaultVisibility: bool(attr(visibility, 'DefaultVisibility'), false),
    exceptions: components(kid(visibility, 'Exceptions')),
    spacesVisible: bool(attr(hints, 'SpacesVisible'), false),
    spaceBoundariesVisible: bool(attr(hints, 'SpaceBoundariesVisible'), false),
    openingsVisible: bool(attr(hints, 'OpeningsVisible'), false),
    coloring: kids(kid(c, 'Coloring'), 'Color').map((color) => ({
      color: attr(color, 'Color') ?? fail('syntax', 'a Color needs its Color attribute; export the BCF again'),
      components: components(kid(color, 'Components') ?? color),
    })),
    lines: kids(kid(root, 'Lines'), 'Line').map((l) => ({ start: vec(kid(l, 'StartPoint'), 'Line'), end: vec(kid(l, 'EndPoint'), 'Line') })),
    clippingPlanes: kids(kid(root, 'ClippingPlanes'), 'ClippingPlane').map((p) => ({
      location: vec(kid(p, 'Location'), 'ClippingPlane'),
      direction: vec(kid(p, 'Direction'), 'ClippingPlane'),
    })),
    bitmaps: [...kids(kid(root, 'Bitmaps'), 'Bitmap'), ...kids(root, 'Bitmap')].map((b) => ({
      format: (text(b, 'Format') ?? text(b, 'Bitmap') ?? '').toLowerCase() === 'jpg' ? 'jpg' : 'png',
      reference: text(b, 'Reference') ?? '',
      location: vec(kid(b, 'Location'), 'Bitmap'),
      normal: vec(kid(b, 'Normal'), 'Bitmap'),
      up: vec(kid(b, 'Up'), 'Bitmap'),
      height: number(b, 'Height', 'Bitmap'),
    })),
  };
  // BCF 1.0: Components/Component with Selected, Visible and Color attributes.
  const legacy = kids(c, 'Component');
  if (legacy.length && !visibility) {
    vp.defaultVisibility = true;
    for (const e of legacy) {
      const one = component(e);
      if (bool(attr(e, 'Selected'), false)) vp.selection.push(one);
      if (!bool(attr(e, 'Visible'), true)) vp.exceptions.push(one);
      const color = attr(e, 'Color');
      if (color) vp.coloring.push({ color, components: [one] });
    }
  }
  for (const type of ['Perspective', 'Orthogonal'] as const) {
    const cam = kid(root, `${type}Camera`);
    if (!cam || vp.camera) continue;
    const where = `${type}Camera`,
      aspect = text(cam, 'AspectRatio');
    vp.camera = {
      type: type === 'Perspective' ? 'perspective' : 'orthogonal',
      position: vec(kid(cam, 'CameraViewPoint'), where),
      direction: vec(kid(cam, 'CameraDirection'), where),
      up: vec(kid(cam, 'CameraUpVector'), where),
      aspectRatio: aspect === undefined ? 1 : number(cam, 'AspectRatio', where),
    };
    if (type === 'Perspective') vp.camera.fieldOfView = number(cam, 'FieldOfView', where);
    else vp.camera.viewToWorldScale = number(cam, 'ViewToWorldScale', where);
  }
  return vp;
}

// XML writing.
const el = (name: string, body = '', attrs: Record<string, string | number | boolean | undefined> = {}) => {
  const a = Object.entries(attrs)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => ` ${k}="${escapeXML(String(v))}"`)
    .join('');
  return body ? `<${name}${a}>${body}</${name}>` : `<${name}${a}/>`;
};
const opt = (name: string, v: string | number | undefined) => (v === undefined || v === '' ? '' : el(name, escapeXML(v)));
const xyz = (name: string, v: readonly number[]) => {
  if (v.length !== 3 || !v.every(Number.isFinite)) fail('range', `${name} needs three finite numbers`);
  return el(name, el('X', String(v[0])) + el('Y', String(v[1])) + el('Z', String(v[2])));
};
const writeComponent = (c: BCFComponent) =>
  el('Component', opt('OriginatingSystem', c.originatingSystem) + opt('AuthoringToolId', c.authoringToolId), { IfcGuid: c.ifcGuid });
const writeComponents = (list: readonly BCFComponent[]) => list.map(writeComponent).join('');
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const checkGuid = (guid: string, what: string) => {
  if (!GUID.test(guid)) fail('range', `${what} GUID ${JSON.stringify(guid)} must be a lower-case UUID; use newBCFGuid()`);
};

/** Options of the BCF writers. */
export interface BCFWriteOptions {
  /** The BCF version to write. Default `3.0`. */
  version?: '3.0' | '2.1';
}

/** Writes a viewpoint as a .bcfv file of BCF 3.0 (default) or 2.1. */
export function writeBCFViewpoint(vp: BCFViewpoint, options: BCFWriteOptions = {}): string {
  const v3 = (options.version ?? '3.0') === '3.0';
  checkGuid(vp.guid, 'The viewpoint');
  const cam = vp.camera;
  if (v3 && !cam) fail('range', 'a BCF 3.0 viewpoint needs a camera; set viewpoint.camera or write version 2.1');
  const hints = el('ViewSetupHints', '', {
    SpacesVisible: vp.spacesVisible,
    SpaceBoundariesVisible: vp.spaceBoundariesVisible,
    OpeningsVisible: vp.openingsVisible,
  });
  const visibility = el(
    'Visibility',
    (v3 ? hints : '') + (vp.exceptions.length ? el('Exceptions', writeComponents(vp.exceptions)) : ''),
    { DefaultVisibility: vp.defaultVisibility },
  );
  const coloring = vp.coloring.filter((c) => c.components.length);
  for (const c of coloring)
    if (!/^[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/.test(c.color)) fail('range', `colour ${JSON.stringify(c.color)} must be RRGGBB or AARRGGBB hex`);
  const parts =
    (v3 ? '' : hints) +
    (vp.selection.length ? el('Selection', writeComponents(vp.selection)) : '') +
    visibility +
    (coloring.length
      ? el(
          'Coloring',
          coloring
            .map((c) =>
              el('Color', v3 ? el('Components', writeComponents(c.components)) : writeComponents(c.components), {
                Color: c.color.toUpperCase(),
              }),
            )
            .join(''),
        )
      : '');
  let camera = '';
  if (cam) {
    const perspective = cam.type === 'perspective',
      value = perspective ? cam.fieldOfView : cam.viewToWorldScale;
    if (perspective ? !(value! > 0 && value! < 180) : !(value! > 0 && Number.isFinite(value)))
      fail('range', perspective ? 'fieldOfView must be degrees in (0, 180)' : 'viewToWorldScale must be a finite size above 0');
    if (!(cam.aspectRatio > 0 && Number.isFinite(cam.aspectRatio))) fail('range', 'aspectRatio must be a finite width / height above 0');
    camera = el(
      perspective ? 'PerspectiveCamera' : 'OrthogonalCamera',
      xyz('CameraViewPoint', cam.position) +
        xyz('CameraDirection', cam.direction) +
        xyz('CameraUpVector', cam.up) +
        el(perspective ? 'FieldOfView' : 'ViewToWorldScale', String(value)) +
        (v3 ? el('AspectRatio', String(cam.aspectRatio)) : ''),
    );
  }
  const bitmap = (b: BCFBitmap) =>
    el(v3 ? 'Format' : 'Bitmap', b.format) +
    el('Reference', escapeXML(b.reference)) +
    xyz('Location', b.location) +
    xyz('Normal', b.normal) +
    xyz('Up', b.up) +
    el('Height', String(b.height));
  return (
    HEAD +
    el(
      'VisualizationInfo',
      el('Components', parts) +
        camera +
        (vp.lines.length ? el('Lines', vp.lines.map((l) => el('Line', xyz('StartPoint', l.start) + xyz('EndPoint', l.end))).join('')) : '') +
        (vp.clippingPlanes.length
          ? el('ClippingPlanes', vp.clippingPlanes.map((p) => el('ClippingPlane', xyz('Location', p.location) + xyz('Direction', p.direction))).join(''))
          : '') +
        (v3
          ? vp.bitmaps.length
            ? el('Bitmaps', vp.bitmaps.map((b) => el('Bitmap', bitmap(b))).join(''))
            : ''
          : vp.bitmaps.map((b) => el('Bitmap', bitmap(b))).join('')),
      { Guid: vp.guid },
    )
  );
}

// BCF-API JSON.
// biome-ignore lint/suspicious/noExplicitAny: BCF-API JSON is untyped input
type Json = any;
const fromBase64 = (s: string): Uint8Array => {
  if (typeof s !== 'string') fail('syntax', 'base64 data must be a string');
  let binary: string;
  try {
    binary = atob(s);
  } catch {
    return fail('syntax', 'snapshot or bitmap data is not valid base64; encode the image bytes as base64');
  }
  return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
};
const toBase64 = (bytes: Uint8Array) => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};
const jsonVec = (v: Json, where: string): Vec3 => {
  const out: Vec3 = [Number(v?.x), Number(v?.y), Number(v?.z)];
  return out.every(Number.isFinite) ? out : fail('syntax', `${where} needs finite x, y and z`);
};
const jsonComponents = (list: Json): BCFComponent[] =>
  (Array.isArray(list) ? list : []).map((c: Json) => {
    const out: BCFComponent = {};
    if (c?.ifc_guid) out.ifcGuid = String(c.ifc_guid);
    if (c?.originating_system) out.originatingSystem = String(c.originating_system);
    if (c?.authoring_tool_id) out.authoringToolId = String(c.authoring_tool_id);
    return out;
  });
const format = (v: Json): 'png' | 'jpg' => (String(v).toLowerCase() === 'jpg' ? 'jpg' : 'png');

/** Reads a BCF-API 3.0 viewpoint object (snake_case; snapshot and bitmaps as base64). */
export function viewpointFromBCFJSON(json: Json): BCFViewpoint {
  if (!json || typeof json !== 'object') fail('syntax', 'a BCF-API viewpoint is a JSON object');
  const c = json.components ?? {},
    visibility = c.visibility ?? {},
    hints = visibility.view_setup_hints ?? {};
  const vp: BCFViewpoint = {
    guid: String(json.guid ?? '').toLowerCase(),
    selection: jsonComponents(c.selection),
    defaultVisibility: visibility.default_visibility === true,
    exceptions: jsonComponents(visibility.exceptions),
    spacesVisible: hints.spaces_visible === true,
    spaceBoundariesVisible: hints.space_boundaries_visible === true,
    openingsVisible: hints.openings_visible === true,
    coloring: (Array.isArray(c.coloring) ? c.coloring : []).map((x: Json) => ({ color: String(x?.color ?? ''), components: jsonComponents(x?.components) })),
    lines: (json.lines ?? []).map((l: Json) => ({ start: jsonVec(l?.start_point, 'line'), end: jsonVec(l?.end_point, 'line') })),
    clippingPlanes: (json.clipping_planes ?? []).map((p: Json) => ({
      location: jsonVec(p?.location, 'clipping plane'),
      direction: jsonVec(p?.direction, 'clipping plane'),
    })),
    bitmaps: (json.bitmaps ?? []).map((b: Json, i: number) => ({
      format: format(b?.bitmap_type),
      reference: String(b?.reference ?? `bitmap${i}.${format(b?.bitmap_type)}`),
      location: jsonVec(b?.location, 'bitmap'),
      normal: jsonVec(b?.normal, 'bitmap'),
      up: jsonVec(b?.up, 'bitmap'),
      height: Number(b?.height),
      ...(b?.bitmap_data ? { data: fromBase64(b.bitmap_data) } : {}),
    })),
  };
  if (Number.isInteger(json.index)) vp.index = json.index;
  const p = json.perspective_camera,
    o = json.orthogonal_camera,
    cam = p ?? o;
  if (cam) {
    vp.camera = {
      type: p ? 'perspective' : 'orthogonal',
      position: jsonVec(cam.camera_view_point, 'camera_view_point'),
      direction: jsonVec(cam.camera_direction, 'camera_direction'),
      up: jsonVec(cam.camera_up_vector, 'camera_up_vector'),
      aspectRatio: Number.isFinite(cam.aspect_ratio) ? cam.aspect_ratio : 1,
    };
    if (p) vp.camera.fieldOfView = Number(p.field_of_view);
    else vp.camera.viewToWorldScale = Number(o.view_to_world_scale);
  }
  if (json.snapshot?.snapshot_data) vp.snapshot = { format: format(json.snapshot.snapshot_type), data: fromBase64(json.snapshot.snapshot_data) };
  return vp;
}

/** A BCF-API 3.0 viewpoint object (snake_case), ready for JSON.stringify or a POST to a BCF server. */
export function viewpointToBCFJSON(vp: BCFViewpoint): Record<string, unknown> {
  const v = (p: readonly number[]) => ({ x: p[0], y: p[1], z: p[2] });
  const list = (cs: readonly BCFComponent[]) =>
    cs.map((c) => ({
      ifc_guid: c.ifcGuid ?? null,
      ...(c.originatingSystem ? { originating_system: c.originatingSystem } : {}),
      ...(c.authoringToolId ? { authoring_tool_id: c.authoringToolId } : {}),
    }));
  const out: Record<string, unknown> = { guid: vp.guid };
  if (vp.index !== undefined) out.index = vp.index;
  const cam = vp.camera;
  if (cam) {
    const base = { camera_view_point: v(cam.position), camera_direction: v(cam.direction), camera_up_vector: v(cam.up), aspect_ratio: cam.aspectRatio };
    if (cam.type === 'perspective') out.perspective_camera = { ...base, field_of_view: cam.fieldOfView };
    else out.orthogonal_camera = { ...base, view_to_world_scale: cam.viewToWorldScale };
  }
  out.lines = vp.lines.map((l) => ({ start_point: v(l.start), end_point: v(l.end) }));
  out.clipping_planes = vp.clippingPlanes.map((p) => ({ location: v(p.location), direction: v(p.direction) }));
  out.bitmaps = vp.bitmaps.map((b) => ({
    bitmap_type: b.format,
    ...(b.data ? { bitmap_data: toBase64(b.data) } : {}),
    location: v(b.location),
    normal: v(b.normal),
    up: v(b.up),
    height: b.height,
  }));
  if (vp.snapshot) out.snapshot = { snapshot_type: vp.snapshot.format, snapshot_data: toBase64(vp.snapshot.data) };
  out.components = {
    selection: list(vp.selection),
    coloring: vp.coloring.map((c) => ({ color: c.color, components: list(c.components) })),
    visibility: {
      default_visibility: vp.defaultVisibility,
      exceptions: list(vp.exceptions),
      view_setup_hints: {
        spaces_visible: vp.spacesVisible,
        space_boundaries_visible: vp.spaceBoundariesVisible,
        openings_visible: vp.openingsVisible,
      },
    },
  };
  return out;
}

/** A new lower-case UUID (version 4) for a topic, comment, viewpoint or document. */
export function newBCFGuid(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// Archives.
const EXT_LISTS: [keyof BCFExtensions, string, string][] = [
  ['topicTypes', 'TopicTypes', 'TopicType'],
  ['topicStatuses', 'TopicStatuses', 'TopicStatus'],
  ['priorities', 'Priorities', 'Priority'],
  ['topicLabels', 'TopicLabels', 'TopicLabel'],
  ['users', 'Users', 'User'],
  ['snippetTypes', 'SnippetTypes', 'SnippetType'],
  ['stages', 'Stages', 'Stage'],
];
const textsOf = (list: XMLElement[]) => list.map((e) => e.textContent.trim()).filter(Boolean);

function readMarkup(root: XMLElement): Omit<BCFTopic, 'viewpoints'> & { refs: { guid: string; file?: string; snapshot?: string; index?: number }[] } {
  const t = kid(root, 'Topic') ?? fail('syntax', 'markup.bcf has no Topic; export the BCF again');
  const required = (name: string) => text(t, name) ?? fail('syntax', `the topic has no ${name}; export the BCF again`);
  const topic: ReturnType<typeof readMarkup> = {
    guid: (attr(t, 'Guid') ?? '').toLowerCase(),
    type: attr(t, 'TopicType') ?? '',
    status: attr(t, 'TopicStatus') ?? '',
    title: required('Title'),
    labels: textsOf([...kids(kid(t, 'Labels'), 'Label'), ...kids(t, 'Labels').filter((l) => !l.children.length)]),
    referenceLinks: textsOf([...kids(kid(t, 'ReferenceLinks'), 'ReferenceLink'), ...kids(t, 'ReferenceLink')]),
    creationDate: required('CreationDate'),
    creationAuthor: required('CreationAuthor'),
    files: kids(kid(kid(root, 'Header'), 'Files'), 'File')
      .concat(kids(kid(root, 'Header'), 'File'))
      .map((f) => {
        const file: BCFFile = { isExternal: bool(attr(f, 'IsExternal') ?? attr(f, 'isExternal'), true) };
        for (const [key, name] of [['filename', 'Filename'], ['date', 'Date'], ['reference', 'Reference']] as const) {
          const v = text(f, name);
          if (v) file[key] = v;
        }
        const project = attr(f, 'IfcProject'),
          spatial = attr(f, 'IfcSpatialStructureElement');
        if (project) file.ifcProject = project;
        if (spatial) file.ifcSpatialStructureElement = spatial;
        return file;
      }),
    documentReferences: [...kids(kid(t, 'DocumentReferences'), 'DocumentReference'), ...kids(t, 'DocumentReference')].map((d) => {
      const out: BCFTopic['documentReferences'][number] = {};
      const guid = attr(d, 'Guid'),
        doc = text(d, 'DocumentGuid'),
        url = text(d, 'Url') ?? text(d, 'ReferencedDocument'),
        description = text(d, 'Description');
      if (guid) out.guid = guid.toLowerCase();
      if (doc) out.documentGuid = doc.toLowerCase();
      if (url) out.url = url;
      if (description) out.description = description;
      return out;
    }),
    relatedTopics: [...kids(kid(t, 'RelatedTopics'), 'RelatedTopic'), ...kids(t, 'RelatedTopic')]
      .map((r) => (attr(r, 'Guid') ?? '').toLowerCase())
      .filter(Boolean),
    comments: [...kids(kid(t, 'Comments'), 'Comment'), ...kids(root, 'Comment')].map((c) => {
      const out: BCFComment = {
        guid: (attr(c, 'Guid') ?? '').toLowerCase(),
        date: text(c, 'Date') ?? fail('syntax', 'a comment has no Date; export the BCF again'),
        author: text(c, 'Author') ?? fail('syntax', 'a comment has no Author; export the BCF again'),
      };
      const body = text(c, 'Comment'),
        viewpoint = attr(kid(c, 'Viewpoint'), 'Guid'),
        md = text(c, 'ModifiedDate'),
        ma = text(c, 'ModifiedAuthor');
      if (body) out.comment = body;
      if (viewpoint) out.viewpoint = viewpoint.toLowerCase();
      if (md) out.modifiedDate = md;
      if (ma) out.modifiedAuthor = ma;
      return out;
    }),
    refs: [...kids(kid(t, 'Viewpoints'), 'ViewPoint'), ...kids(root, 'Viewpoints')].map((v) => {
      const index = Number(text(v, 'Index'));
      return {
        guid: (attr(v, 'Guid') ?? '').toLowerCase(),
        file: text(v, 'Viewpoint'),
        snapshot: text(v, 'Snapshot'),
        ...(Number.isInteger(index) && text(v, 'Index') !== undefined ? { index } : {}),
      };
    }),
  };
  const optional = ['Priority', 'ModifiedDate', 'ModifiedAuthor', 'DueDate', 'AssignedTo', 'Stage', 'Description'] as const;
  for (const name of optional) {
    const v = text(t, name);
    if (v) (topic as unknown as Record<string, string>)[name[0]!.toLowerCase() + name.slice(1)] = v;
  }
  const index = Number(text(t, 'Index'));
  if (text(t, 'Index') !== undefined && Number.isInteger(index)) topic.index = index;
  const id = attr(t, 'ServerAssignedId');
  if (id) topic.serverAssignedId = id;
  const snippet = kid(t, 'BimSnippet');
  if (snippet)
    topic.bimSnippet = {
      type: attr(snippet, 'SnippetType') ?? '',
      reference: text(snippet, 'Reference') ?? '',
      referenceSchema: text(snippet, 'ReferenceSchema') ?? '',
      isExternal: bool(attr(snippet, 'IsExternal') ?? attr(snippet, 'isExternal'), false),
    };
  return topic;
}

/** Options of readBCF: the zip limits of @margoengine/loaders and an AbortSignal. */
export type BCFReadOptions = ZipOptions;

/**
 * Reads a .bcf (or .bcfzip) archive of BCF 3.0, 2.1, 2.0 or 1.0: version, project, extensions, documents, and every
 * topic folder's markup with its comments, viewpoints (in Index order), snapshots and bitmaps. Unknown files and
 * elements are ignored, as BCF asks.
 */
export async function readBCF(bytes: Uint8Array | ArrayBuffer, options: BCFReadOptions = {}): Promise<BCFArchive> {
  abort(options.signal);
  const entries = readZipDirectory(bytes, options),
    byName = new Map(entries.map((e) => [e.name, e]));
  const read = async (name: string) => {
    const entry = byName.get(name);
    return entry ? readZipEntry(bytes, entry, options) : undefined;
  };
  const readXML = async (name: string) => {
    const data = await read(name);
    return data ? xml(data, name) : undefined;
  };
  const version = attr(await readXML('bcf.version'), 'VersionId') ?? '1.0';
  const archive: BCFArchive = { version, documents: [], topics: [] };
  const project = kid(await readXML('project.bcfp'), 'Project');
  if (project) archive.project = { id: attr(project, 'ProjectId') ?? '', ...(text(project, 'Name') ? { name: text(project, 'Name') } : {}) };
  const extensions = await readXML('extensions.xml');
  if (extensions?.localName === 'Extensions') {
    archive.extensions = {} as BCFExtensions;
    for (const [key, list, item] of EXT_LISTS) archive.extensions[key] = textsOf(kids(kid(extensions, list), item));
  }
  for (const d of kids(kid(await readXML('documents.xml'), 'Documents'), 'Document')) {
    const guid = (attr(d, 'Guid') ?? '').toLowerCase(),
      data = await read(`Documents/${guid}`),
      description = text(d, 'Description');
    archive.documents.push({ guid, filename: text(d, 'Filename') ?? guid, ...(description ? { description } : {}), ...(data ? { data } : {}) });
  }
  for (const entry of entries) {
    const match = /^([^/]+)\/markup\.bcf$/i.exec(entry.name);
    if (!match) continue;
    abort(options.signal);
    const folder = match[1]!;
    const { refs, ...topic } = readMarkup(xml(await readZipEntry(bytes, entry, options), entry.name));
    if (!refs.length && byName.has(`${folder}/viewpoint.bcfv`))
      refs.push({ guid: '', file: 'viewpoint.bcfv', ...(byName.has(`${folder}/snapshot.png`) ? { snapshot: 'snapshot.png' } : {}) });
    const viewpoints: BCFViewpoint[] = [];
    for (const ref of refs) {
      const data = ref.file ? await read(`${folder}/${ref.file}`) : undefined;
      if (!data) continue;
      const vp = parseBCFViewpoint(data);
      // Comments refer to the markup's GUID, so it wins over a .bcfv that names another.
      if (ref.guid) vp.guid = ref.guid;
      if (ref.index !== undefined) vp.index = ref.index;
      const snapshot = ref.snapshot ? await read(`${folder}/${ref.snapshot}`) : undefined;
      if (snapshot) vp.snapshot = { format: /\.jpe?g$/i.test(ref.snapshot!) ? 'jpg' : 'png', data: snapshot };
      for (const b of vp.bitmaps) {
        const image = await read(`${folder}/${b.reference}`);
        if (image) b.data = image;
      }
      viewpoints.push(vp);
    }
    viewpoints.sort((a, b) => (a.index ?? Infinity) - (b.index ?? Infinity));
    if (topic.bimSnippet && !topic.bimSnippet.isExternal) {
      const snippet = await read(`${folder}/${topic.bimSnippet.reference}`);
      if (snippet) topic.bimSnippet.data = snippet;
    }
    archive.topics.push({ ...topic, guid: topic.guid || folder.toLowerCase(), viewpoints });
  }
  return archive;
}

/** Stored (uncompressed) zip with directory entries and forward slashes, as the BCF zip encoding guide asks. */
function zip(files: [string, Uint8Array][]): Uint8Array {
  const encoder = new TextEncoder(),
    dirs = new Set<string>();
  for (const [name] of files) for (let i = name.indexOf('/'); i > 0; i = name.indexOf('/', i + 1)) dirs.add(name.slice(0, i + 1));
  const all: [Uint8Array, Uint8Array][] = [...[...dirs].map((d): [string, Uint8Array] => [d, new Uint8Array()]), ...files].map(([n, d]) => [
    encoder.encode(n),
    d,
  ]);
  let size = 22;
  for (const [n, d] of all) size += 30 + 46 + 2 * n.length + d.length;
  const out = new Uint8Array(size),
    view = new DataView(out.buffer);
  let at = 0;
  const central: number[] = [];
  const header = (signature: number, n: Uint8Array, d: Uint8Array, crc: number, offset?: number) => {
    view.setUint32(at, signature, true);
    let p = at + 4;
    if (offset !== undefined) (view.setUint16(p, 20, true), (p += 2)); // made by
    view.setUint16(p, n[n.length - 1] === 0x2f ? 20 : 10, true); // needed
    view.setUint16(p + 2, 0x800, true); // UTF-8 names
    view.setUint16(p + 4, 0, true); // stored
    view.setUint32(p + 6, (1 << 21) | (1 << 16), true); // 1980-01-01 00:00
    view.setUint32(p + 10, crc, true);
    view.setUint32(p + 14, d.length, true);
    view.setUint32(p + 18, d.length, true);
    view.setUint16(p + 22, n.length, true);
    p += 26;
    if (offset !== undefined) {
      view.setUint32(p + 6, n[n.length - 1] === 0x2f ? 0x10 : 0, true); // external attributes: directory
      view.setUint32(p + 10, offset, true);
      p += 14;
    }
    out.set(n, p);
    at = p + n.length;
  };
  for (const [n, d] of all) {
    central.push(at);
    header(0x04034b50, n, d, crc32(d));
    out.set(d, at);
    at += d.length;
  }
  const start = at;
  all.forEach(([n, d], i) => header(0x02014b50, n, d, crc32(d), central[i]));
  view.setUint32(at, 0x06054b50, true);
  view.setUint16(at + 8, all.length, true);
  view.setUint16(at + 10, all.length, true);
  view.setUint32(at + 12, at - start, true);
  view.setUint32(at + 16, start, true);
  return out;
}

/**
 * Writes a .bcf archive of BCF 3.0 (default) or 2.1: bcf.version, project.bcfp, extensions.xml and documents.xml
 * (3.0), one folder per topic with markup.bcf, its viewpoints (`<guid>.bcfv`), snapshots and bitmap images.
 */
export function writeBCF(archive: Pick<BCFArchive, 'topics'> & Partial<BCFArchive>, options: BCFWriteOptions = {}): Uint8Array {
  const version = options.version ?? '3.0',
    v3 = version === '3.0';
  const encoder = new TextEncoder(),
    files: [string, Uint8Array][] = [];
  const add = (name: string, data: string | Uint8Array) => files.push([name, typeof data === 'string' ? encoder.encode(data) : data]);
  add(
    'bcf.version',
    HEAD + el('Version', v3 ? '' : el('DetailedVersion', version), { VersionId: version }),
  );
  if (archive.project) {
    const project = el('Project', opt('Name', archive.project.name), { ProjectId: archive.project.id });
    add('project.bcfp', HEAD + (v3 ? el('ProjectInfo', project) : el('ProjectExtension', project + el('ExtensionSchema', ''))));
  }
  if (v3) {
    if (archive.extensions)
      add(
        'extensions.xml',
        HEAD +
          el(
            'Extensions',
            EXT_LISTS.map(([key, list, item]) => {
              const values = archive.extensions![key] ?? [];
              return values.length ? el(list, values.map((v) => el(item, escapeXML(v))).join('')) : '';
            }).join(''),
          ),
      );
    if (archive.documents?.length) {
      add(
        'documents.xml',
        HEAD +
          el(
            'DocumentInfo',
            el(
              'Documents',
              archive.documents.map((d) => (checkGuid(d.guid, 'A document'), el('Document', opt('Filename', d.filename) + opt('Description', d.description), { Guid: d.guid }))).join(''),
            ),
          ),
      );
      for (const d of archive.documents) if (d.data) add(`Documents/${d.guid}`, d.data);
    }
  }
  for (const t of archive.topics) {
    checkGuid(t.guid, 'The topic');
    if (!t.title) fail('range', 'every topic needs a title');
    const folder = t.guid;
    const refs = t.viewpoints.map((vp) => {
      const file = `${vp.guid}.bcfv`;
      add(`${folder}/${file}`, writeBCFViewpoint(vp, options));
      const snapshot = vp.snapshot ? `${vp.guid}.${vp.snapshot.format === 'jpg' ? 'jpg' : 'png'}` : undefined;
      if (vp.snapshot) add(`${folder}/${snapshot}`, vp.snapshot.data);
      for (const b of vp.bitmaps) if (b.data) add(`${folder}/${b.reference}`, b.data);
      return el('Viewpoint', escapeXML(file)) + (snapshot ? el('Snapshot', snapshot) : '') + opt('Index', vp.index);
    });
    const comment = (c: BCFComment) => {
      checkGuid(c.guid, 'A comment');
      return el(
        'Comment',
        opt('Date', c.date) +
          opt('Author', c.author) +
          (v3 ? opt('Comment', c.comment) : el('Comment', escapeXML(c.comment ?? ''))) +
          (c.viewpoint ? el('Viewpoint', '', { Guid: c.viewpoint }) : '') +
          opt('ModifiedDate', c.modifiedDate) +
          opt('ModifiedAuthor', c.modifiedAuthor),
        { Guid: c.guid },
      );
    };
    const file = (f: BCFFile) =>
      el('File', opt('Filename', f.filename) + opt('Date', f.date) + opt('Reference', f.reference), {
        IfcProject: f.ifcProject,
        IfcSpatialStructureElement: f.ifcSpatialStructureElement,
        IsExternal: f.isExternal,
      });
    const header = t.files.length ? el('Header', v3 ? el('Files', t.files.map(file).join('')) : t.files.map(file).join('')) : '';
    const wrap = (outer: string, inner: string[]) => (inner.length ? (v3 ? el(outer, inner.join('')) : inner.join('')) : '');
    const docs = t.documentReferences.map((d) =>
      v3
        ? el('DocumentReference', (d.documentGuid ? opt('DocumentGuid', d.documentGuid) : opt('Url', d.url)) + opt('Description', d.description), {
            Guid: d.guid ?? newBCFGuid(),
          })
        : el('DocumentReference', opt('ReferencedDocument', d.url ?? d.documentGuid) + opt('Description', d.description), {
            Guid: d.guid,
            isExternal: d.url !== undefined && /^[a-z][a-z0-9+.-]*:/i.test(d.url),
          }),
    );
    const s = t.bimSnippet;
    if (s?.data && !s.isExternal) add(`${folder}/${s.reference}`, s.data);
    const body =
      wrap('ReferenceLinks', t.referenceLinks.map((l) => el('ReferenceLink', escapeXML(l)))) +
      el('Title', escapeXML(t.title)) +
      opt('Priority', t.priority) +
      opt('Index', t.index) +
      (v3 ? (t.labels.length ? el('Labels', t.labels.map((l) => el('Label', escapeXML(l))).join('')) : '') : t.labels.map((l) => el('Labels', escapeXML(l))).join('')) +
      opt('CreationDate', t.creationDate) +
      opt('CreationAuthor', t.creationAuthor) +
      opt('ModifiedDate', t.modifiedDate) +
      opt('ModifiedAuthor', t.modifiedAuthor) +
      opt('DueDate', t.dueDate) +
      opt('AssignedTo', t.assignedTo) +
      opt('Stage', t.stage) +
      opt('Description', t.description) +
      (s
        ? el('BimSnippet', opt('Reference', s.reference) + opt('ReferenceSchema', s.referenceSchema), {
            SnippetType: s.type,
            [v3 ? 'IsExternal' : 'isExternal']: s.isExternal,
          })
        : '') +
      wrap('DocumentReferences', docs) +
      wrap('RelatedTopics', t.relatedTopics.map((g) => el('RelatedTopic', '', { Guid: g }))) +
      (v3 ? wrap('Comments', t.comments.map(comment)) + wrap('Viewpoints', t.viewpoints.map((vp, i) => el('ViewPoint', refs[i], { Guid: vp.guid }))) : '');
    const topic = el('Topic', body, {
      Guid: t.guid,
      ...(v3 && t.serverAssignedId ? { ServerAssignedId: t.serverAssignedId } : {}),
      TopicType: t.type,
      TopicStatus: t.status,
    });
    add(
      `${folder}/markup.bcf`,
      HEAD +
        el(
          'Markup',
          header + topic + (v3 ? '' : t.comments.map(comment).join('') + t.viewpoints.map((vp, i) => el('Viewpoints', refs[i], { Guid: vp.guid })).join('')),
        ),
    );
  }
  return zip(files);
}

// The bridge to a Margo view. Engine axes are Y up: engine (x, y, z) = IFC (x, z, -y), less the rebased origin.
type Plane = [number, number, number, number];
type RGBA = [number, number, number, number];
const toEngineDir = ([x, y, z]: readonly number[]): Vec3 => unit([x!, z!, -y!]);
const toIFCDir = ([x, y, z]: readonly number[]): Vec3 => unit([x!, -z!, y!]);
function unit(v: Vec3): Vec3 {
  const l = Math.hypot(...v);
  return l > 0 && Number.isFinite(l) ? [v[0] / l, v[1] / l, v[2] / l] : fail('range', 'a direction must be a finite vector longer than 0');
}

/** A viewpoint as a Margo view: engine axes and the model's rebased origin, components as expressIDs. */
export interface BCFView {
  /** `position` and `target` for a core Camera (`fov` in degrees), or `height` for an orthographic CameraProjection. */
  camera?: {
    type: 'perspective' | 'orthogonal';
    position: Vec3;
    target: Vec3;
    /** Unit view direction (target - position, normalized). */
    direction: Vec3;
    up: Vec3;
    /** Perspective: vertical field of view in degrees. */
    fov?: number;
    /** Orthogonal: visible vertical size in meters. */
    height?: number;
    aspect: number;
  };
  /** Every product occurrence (IfcProduct) the viewpoint shows, and every one it hides, in expressID order. */
  visible: number[];
  hidden: number[];
  selected: number[];
  /** sRGB colour and alpha, each 0..1, per element; a container's colour is applied to its parts. */
  colors: Map<number, RGBA>;
  /** Planes for a material's `clippingPlanes`: `a x + b y + c z + d < 0` is cut away. */
  clippingPlanes: Plane[];
  lines: { start: Vec3; end: Vec3 }[];
  /** Components no element of this model matches (another model, or a removed element). */
  unresolved: BCFComponent[];
}
/** Options of viewFromBCF and bcfFromView. */
export interface BCFViewOptions {
  /** The engine-axes origin the geometry was rebased by (`readIFCGeometry`'s `origin`). Default [0, 0, 0]. */
  origin?: readonly number[];
  /** How far ahead of the camera `target` is placed, in meters; BCF has no target. Default 10. */
  targetDistance?: number;
}

function partsOf(data: IFCData): Map<number, number[]> {
  const parts = new Map<number, number[]>();
  for (const e of data.elements.values()) {
    const whole = e.aggregate ?? e.nest,
      type = whole === undefined ? undefined : data.elements.get(whole)?.type;
    // A site, building, storey or space is spatial structure, which BCF visibility never follows.
    if (type === undefined || isSubtypeOf(data, type, 'IfcSpatialStructureElement') || isSubtypeOf(data, type, 'IfcSpatialElement'))
      continue;
    (parts.get(whole!) ?? parts.set(whole!, []).get(whole!)!).push(e.id);
  }
  return parts;
}
const productsOf = (data: IFCData) =>
  [...data.elements.values()].filter((e) => isSubtypeOf(data, e.type, 'IfcProduct')).sort((a, b) => a.id - b.id);

/**
 * Resolves a viewpoint against a model's data: the visibility as BCF 3.0 orders it (DefaultVisibility, then the
 * ViewSetupHints for spaces and openings, then the exceptions), selection and colours, each applied to the parts of
 * a decomposed component (aggregation and nesting, never spatial structure), plus the camera, section planes and
 * lines in engine axes. Components match by IfcGuid, or by AuthoringToolId against the element's Tag.
 */
export function viewFromBCF(vp: BCFViewpoint, data: IFCData, options: BCFViewOptions = {}): BCFView {
  const origin = options.origin ?? [0, 0, 0],
    distance = options.targetDistance ?? 10,
    parts = partsOf(data),
    unresolved: BCFComponent[] = [];
  const byTag = new Map<string, number>();
  for (const e of data.elements.values()) if (e.tag) byTag.set(e.tag, e.id);
  const resolve = (list: readonly BCFComponent[]): Set<number> => {
    const out = new Set<number>();
    for (const c of list) {
      const id = (c.ifcGuid && data.byGlobalId.get(c.ifcGuid)) || (c.authoringToolId ? byTag.get(c.authoringToolId) : undefined);
      if (id === undefined) {
        unresolved.push(c);
        continue;
      }
      for (const stack = [id]; stack.length; ) {
        const at = stack.pop()!;
        if (out.has(at)) continue;
        out.add(at);
        stack.push(...(parts.get(at) ?? []));
      }
    }
    return out;
  };
  const exceptions = resolve(vp.exceptions),
    visible: number[] = [],
    hidden: number[] = [];
  for (const e of productsOf(data)) {
    let shown = vp.defaultVisibility;
    if (isSubtypeOf(data, e.type, 'IfcSpace')) shown = vp.spacesVisible;
    else if (isSubtypeOf(data, e.type, 'IfcOpeningElement')) shown = vp.openingsVisible;
    if (exceptions.has(e.id)) shown = !shown;
    (shown ? visible : hidden).push(e.id);
  }
  const colors = new Map<number, RGBA>();
  for (const c of vp.coloring) {
    const hex = c.color;
    if (!/^[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/.test(hex)) fail('range', `colour ${JSON.stringify(hex)} must be RRGGBB or AARRGGBB hex`);
    const n = (i: number) => parseInt(hex.slice(i, i + 2), 16) / 255,
      a = hex.length === 8;
    const rgba: RGBA = [n(a ? 2 : 0), n(a ? 4 : 2), n(a ? 6 : 4), a ? n(0) : 1];
    for (const id of resolve(c.components)) colors.set(id, rgba);
  }
  const view: BCFView = {
    visible,
    hidden,
    selected: [...resolve(vp.selection)].sort((a, b) => a - b),
    colors,
    clippingPlanes: vp.clippingPlanes.map(({ location, direction }) => {
      const n = toEngineDir(direction).map((x) => -x) as Vec3,
        p = ifcToEngine(location, origin);
      return [n[0], n[1], n[2], -(n[0] * p[0] + n[1] * p[1] + n[2] * p[2])];
    }),
    lines: vp.lines.map((l) => ({ start: ifcToEngine(l.start, origin), end: ifcToEngine(l.end, origin) })),
    unresolved,
  };
  const cam = vp.camera;
  if (cam) {
    const position = ifcToEngine(cam.position, origin),
      direction = toEngineDir(cam.direction);
    view.camera = {
      type: cam.type,
      position,
      target: [position[0] + direction[0] * distance, position[1] + direction[1] * distance, position[2] + direction[2] * distance],
      direction,
      up: toEngineDir(cam.up),
      aspect: cam.aspectRatio,
      ...(cam.type === 'perspective' ? { fov: cam.fieldOfView } : { height: cam.viewToWorldScale }),
    };
  }
  return view;
}

/** What bcfFromView encodes: a camera in engine axes and the elements by expressID. */
export interface BCFViewInput {
  guid?: string;
  camera?: {
    /** Default perspective. */
    type?: 'perspective' | 'orthogonal';
    position: readonly number[];
    /** Either a target or a direction. */
    target?: readonly number[];
    direction?: readonly number[];
    /** Default [0, 1, 0]. */
    up?: readonly number[];
    /** Perspective: vertical field of view in degrees (a core Camera's `fov`). */
    fov?: number;
    /** Orthogonal: visible vertical size in meters. */
    height?: number;
    /** Width / height. Default 1. */
    aspect?: number;
  };
  /** Hidden product occurrences; every other product is visible. Default none. */
  hidden?: Iterable<number>;
  selected?: Iterable<number>;
  /** sRGB colour per element, components 0..1, alpha optional (written as AARRGGBB when below 1). */
  colors?: Map<number, readonly number[]> | Iterable<[number, readonly number[]]>;
  /** Material clipping planes `[a, b, c, d]` (what has `a x + b y + c z + d < 0` is cut away). */
  clippingPlanes?: readonly (readonly number[])[];
  lines?: readonly { start: readonly number[]; end: readonly number[] }[];
  snapshot?: { format: 'png' | 'jpg'; data: Uint8Array };
}

/**
 * Encodes a Margo view as a BCF viewpoint, following BCF 3.0's encoding rules: the shorter of the hidden and visible
 * lists becomes the exceptions, and spaces and openings go to the ViewSetupHints when none of them is visible.
 */
export function bcfFromView(view: BCFViewInput, data: IFCData, options: BCFViewOptions = {}): BCFViewpoint {
  const origin = options.origin ?? [0, 0, 0];
  const component = (id: number): BCFComponent => {
    const guid = data.elements.get(id)?.globalId;
    return guid ? { ifcGuid: guid } : fail('range', `element ${id} has no GlobalId in this model; pass expressIDs of its elements`);
  };
  const hiddenSet = new Set(view.hidden ?? []),
    products = productsOf(data);
  const space = (e: { type: string }) => isSubtypeOf(data, e.type, 'IfcSpace'),
    opening = (e: { type: string }) => isSubtypeOf(data, e.type, 'IfcOpeningElement');
  const spacesShown = products.some((e) => space(e) && !hiddenSet.has(e.id)),
    openingsShown = products.some((e) => opening(e) && !hiddenSet.has(e.id));
  // Spaces or openings that are all hidden are left to the hints; the rest are encoded like any element.
  const regular = products.filter((e) => !((space(e) && !spacesShown) || (opening(e) && !openingsShown)));
  const shown = regular.filter((e) => !hiddenSet.has(e.id)),
    gone = regular.filter((e) => hiddenSet.has(e.id)),
    defaultVisibility = gone.length < shown.length;
  const groups = new Map<string, number[]>();
  for (const [id, c] of view.colors ?? []) {
    if (c.length < 3 || !c.every((x) => x >= 0 && x <= 1)) fail('range', `the colour of element ${id} needs 3 or 4 numbers from 0 to 1`);
    const byte = (x: number) => Math.round(x * 255).toString(16).padStart(2, '0').toUpperCase();
    const hex = (c[3] !== undefined && c[3] < 1 ? byte(c[3]) : '') + byte(c[0]!) + byte(c[1]!) + byte(c[2]!);
    (groups.get(hex) ?? groups.set(hex, []).get(hex)!).push(id);
  }
  const vp: BCFViewpoint = {
    guid: view.guid ?? newBCFGuid(),
    selection: [...(view.selected ?? [])].map(component),
    defaultVisibility,
    exceptions: (defaultVisibility ? gone : shown).map((e) => component(e.id)),
    spacesVisible: spacesShown && defaultVisibility,
    spaceBoundariesVisible: false,
    openingsVisible: openingsShown && defaultVisibility,
    coloring: [...groups].map(([color, ids]) => ({ color, components: ids.map(component) })),
    lines: (view.lines ?? []).map((l) => ({ start: engineToIFC(l.start, origin), end: engineToIFC(l.end, origin) })),
    clippingPlanes: (view.clippingPlanes ?? []).map((p) => {
      const [a, b, c, d] = p as Plane,
        l2 = a * a + b * b + c * c;
      if (p.length !== 4 || !p.every(Number.isFinite) || !(l2 > 0)) fail('range', 'a clipping plane is four finite numbers [a, b, c, d] with a nonzero normal');
      const point = [(-d * a) / l2, (-d * b) / l2, (-d * c) / l2];
      return { location: engineToIFC(point, origin), direction: toIFCDir([-a, -b, -c]) };
    }),
    bitmaps: [],
  };
  if (view.snapshot) vp.snapshot = view.snapshot;
  const cam = view.camera;
  if (cam) {
    const direction = cam.direction ?? (cam.target ? cam.target.map((t, i) => t - cam.position[i]!) : fail('range', 'the camera needs a target or a direction'));
    const type = cam.type ?? 'perspective',
      d = unit(direction as Vec3);
    // BCF wants an up vector that is not parallel to the direction: keep the part of `up` across the view.
    let up = [...(cam.up ?? [0, 1, 0])] as Vec3;
    for (const candidate of [up, [0, 0, -1] as Vec3]) {
      const k = candidate[0] * d[0] + candidate[1] * d[1] + candidate[2] * d[2],
        across: Vec3 = [candidate[0] - k * d[0], candidate[1] - k * d[1], candidate[2] - k * d[2]];
      if (Math.hypot(...across) > 1e-6) {
        up = across;
        break;
      }
    }
    vp.camera = {
      type,
      position: engineToIFC(cam.position, origin),
      direction: toIFCDir(d),
      up: toIFCDir(up),
      aspectRatio: cam.aspect ?? 1,
      ...(type === 'perspective' ? { fieldOfView: cam.fov ?? 60 } : { viewToWorldScale: cam.height ?? fail('range', 'an orthogonal camera needs its height') }),
    };
  }
  return vp;
}
