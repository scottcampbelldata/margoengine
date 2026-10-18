// The JT Logical Scene Graph segment (JT File Format Reference 9.5, 7.2.1; ISO 14306, 6): graph elements (nodes and
// attributes) up to an end-of-elements marker, property atom elements up to another, then the property table that
// attaches key/value atoms to nodes and attributes. Each element's base type data comes first, so an element type
// this reader does not know is still read as a node or attribute through its base type, and skipped by its length.
//
// This software reads the JT Data Format as described in the Siemens JT File Format Reference and ISO 14306. Copyright
// in the JT data structures and operators is owned by Siemens Product Lifecycle Management Software Inc. (Siemens
// Digital Industries Software) and they are used under the Siemens JT Data Format Reference Intellectual Property
// License Terms. US 8,019,788, US 2011/0199382 and corresponding foreign patents are licensed royalty-free under the
// Siemens JT Data Format Reference Patent Clarification Notice. JT and Parasolid are trademarks of Siemens; they are
// named here only to identify the format. This software is not endorsed by or affiliated with Siemens.
import { type JTContainer, type JTElement, type JTReader, readElement } from './file.js';

/** Object type IDs (JT File Format Reference Appendix A; ISO 14306 Annex A). */
export const JT_TYPES = {
  baseNode: '10dd1035-2ac8-11d1-9b6b-0080c7bb5997',
  group: '10dd101b-2ac8-11d1-9b6b-0080c7bb5997',
  instance: '10dd102a-2ac8-11d1-9b6b-0080c7bb5997',
  lod: '10dd102c-2ac8-11d1-9b6b-0080c7bb5997',
  metaData: 'ce357245-38fb-11d1-a506-006097bdc6e1',
  part: 'ce357244-38fb-11d1-a506-006097bdc6e1',
  partition: '10dd103e-2ac8-11d1-9b6b-0080c7bb5997',
  rangeLod: '10dd104c-2ac8-11d1-9b6b-0080c7bb5997',
  switch: '10dd10f3-2ac8-11d1-9b6b-0080c7bb5997',
  material: '10dd1030-2ac8-11d1-9b6b-0080c7bb5997',
  transform: '10dd1083-2ac8-11d1-9b6b-0080c7bb5997',
  baseProperty: '10dd104b-2ac8-11d1-9b6b-0080c7bb5997',
  stringProperty: '10dd106e-2ac8-11d1-9b6b-0080c7bb5997',
  integerProperty: '10dd102b-2ac8-11d1-9b6b-0080c7bb5997',
  floatProperty: '10dd1019-2ac8-11d1-9b6b-0080c7bb5997',
  referenceProperty: '10dd1004-2ac8-11d1-9b6b-0080c7bb5997',
  dateProperty: 'ce357246-38fb-11d1-a506-006097bdc6e1',
  lateLoadedProperty: 'e0b05be5-fbbd-11d1-a3a7-00aa00d10954',
  vector4Property: '2e7db4be-c71a-4b18-9d07-c7227e9fef76',
  xtBRep: '873a70e0-2ac9-11d1-9b6b-0080c7bb5997',
} as const;

/** Shape node object type IDs and the representation each holds. */
const SHAPES: Readonly<Record<string, JTShapeKind>> = {
  '10dd1059-2ac8-11d1-9b6b-0080c7bb5997': 'shape',
  '10dd1077-2ac8-11d1-9b6b-0080c7bb5997': 'tri-strip',
  '10dd1048-2ac8-11d1-9b6b-0080c7bb5997': 'polygon',
  '10dd1046-2ac8-11d1-9b6b-0080c7bb5997': 'polyline',
  '98134716-0010-0818-1998-080009835d5a': 'point',
  'e40373c1-1ad9-11d3-9daf-00a0c9c7ddc2': 'primitive',
  '10dd107f-2ac8-11d1-9b6b-0080c7bb5997': 'vertex',
  'd239e7b6-dd77-4289-a07d-b0ee79f79494': 'null',
};

/** What a shape node draws. */
export type JTShapeKind = 'shape' | 'tri-strip' | 'polygon' | 'polyline' | 'point' | 'primitive' | 'vertex' | 'null';

/** How a node's children are used. */
export type JTNodeKind =
  | 'node'
  | 'group'
  | 'partition'
  | 'instance'
  | 'part'
  | 'meta-data'
  | 'lod'
  | 'range-lod'
  | 'switch'
  | 'shape';

/** A node of the scene graph. */
export interface JTNode {
  readonly id: number;
  /** Object type ID. */
  readonly type: string;
  readonly kind: JTNodeKind;
  /** For a shape node, what it draws. */
  readonly shape?: JTShapeKind;
  /** The node's ignore flag: traversals skip it and everything below it. */
  readonly ignore: boolean;
  /** Attribute object IDs (transforms, materials and others), in order. */
  readonly attributes: readonly number[];
  /** Child node object IDs, in order (an instance node's one child; an LOD node's alternatives, finest first). */
  readonly children: readonly number[];
  /** A switch node's selected child index (-1 for none). */
  readonly selected?: number;
  /** A partition node's file name, relative to this file (empty for the file's own root partition). */
  readonly file?: string;
}

/** An attribute of the scene graph. */
export interface JTAttribute {
  readonly id: number;
  readonly type: string;
  readonly kind: 'transform' | 'material' | 'other';
  /** A transform's 4x4 matrix as stored: row-major for row vectors (p' = p A), which is column-major for column vectors. */
  readonly matrix?: readonly number[];
  /** A material's diffuse colour and alpha. */
  readonly diffuse?: readonly [number, number, number, number];
}

/** A late-loaded property: data in another segment. */
export interface JTLateLoaded {
  readonly segment: string;
  readonly segmentType: number;
  readonly payload: number;
}

/** A property value. */
export type JTPropertyValue =
  | string
  | number
  | readonly number[]
  | JTLateLoaded
  | { readonly object: number }
  | { readonly date: string };

/** The scene graph: nodes and attributes by object ID, and each element's properties. */
export interface JTSceneGraph {
  readonly nodes: ReadonlyMap<number, JTNode>;
  readonly attributes: ReadonlyMap<number, JTAttribute>;
  /** Properties by node or attribute object ID, keyed by the key atom's value (usually a string). */
  readonly properties: ReadonlyMap<number, ReadonlyMap<string, JTPropertyValue>>;
  /** The first graph element (the file's root partition node). */
  readonly root: number | undefined;
}

/** Reads the LSG segment of a JT file. Throws a TypeError for malformed data. */
export function readSceneGraph(container: JTContainer): JTSceneGraph {
  const r = container.data(container.lsg),
    jt10 = container.version >= 10,
    version = (d: JTReader) => (jt10 ? d.u8() : d.i16()),
    nodes = new Map<number, JTNode>(),
    attributes = new Map<number, JTAttribute>();
  let root: number | undefined;

  const baseNode = (d: JTReader) => {
    version(d);
    const flags = d.u32(),
      n = d.count(4),
      attrs: number[] = [];
    for (let i = 0; i < n; i++) attrs.push(d.i32());
    return { ignore: (flags & 1) !== 0, attributes: attrs };
  };
  const groupNode = (d: JTReader) => {
    const base = baseNode(d);
    version(d);
    const n = d.count(4),
      children: number[] = [];
    for (let i = 0; i < n; i++) children.push(d.i32());
    return { ...base, children };
  };
  const baseAttribute = (d: JTReader) => {
    version(d);
    d.u8(); // state flags
    d.u32(); // field inhibit flags
    if (jt10) d.u32(); // field final flags
  };

  const graphElement = (e: JTElement) => {
    const d = e.data,
      node = (kind: JTNodeKind, data: { ignore: boolean; attributes: number[]; children?: number[] }, extra = {}) => {
        nodes.set(e.id, { id: e.id, type: e.type, kind, children: [], ...data, ...extra });
        root ??= e.id;
      };
    const shape = SHAPES[e.type];
    if (shape) return node('shape', baseNode(d), { shape });
    switch (e.type) {
      case JT_TYPES.partition: {
        const group = groupNode(d);
        if (jt10) d.u8(); // local version flag
        d.i32(); // partition flags
        return node('partition', group, { file: d.mbString() });
      }
      case JT_TYPES.group:
        return node('group', groupNode(d));
      case JT_TYPES.instance: {
        const base = baseNode(d);
        version(d);
        return node('instance', { ...base, children: [d.i32()] });
      }
      case JT_TYPES.part:
      case JT_TYPES.metaData: {
        const group = groupNode(d);
        version(d);
        return node(e.type === JT_TYPES.part ? 'part' : 'meta-data', group);
      }
      case JT_TYPES.lod:
      case JT_TYPES.rangeLod:
        return node(e.type === JT_TYPES.lod ? 'lod' : 'range-lod', groupNode(d));
      case JT_TYPES.switch: {
        const group = groupNode(d);
        version(d);
        return node('switch', group, { selected: d.i32() });
      }
      case JT_TYPES.transform: {
        baseAttribute(d);
        version(d);
        let mask = d.u16();
        const matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
        for (let i = 0; i < 16; i++, mask <<= 1) if (mask & 0x8000) matrix[i] = d.f32();
        attributes.set(e.id, { id: e.id, type: e.type, kind: 'transform', matrix });
        return;
      }
      case JT_TYPES.material: {
        baseAttribute(d);
        version(d);
        d.u16(); // data flags
        d.f32s(4); // ambient
        const [r, g, b, a] = d.f32s(4);
        attributes.set(e.id, { id: e.id, type: e.type, kind: 'material', diffuse: [r, g, b, a] });
        return;
      }
    }
    // Known by base type only.
    if (e.baseType === 0) node('node', baseNode(d));
    else if (e.baseType === 1) node('group', groupNode(d));
    else if (e.baseType === 2) node('shape', baseNode(d), { shape: 'shape' });
    else if (e.baseType === 3) attributes.set(e.id, { id: e.id, type: e.type, kind: 'other' });
  };

  for (let e = readElement(r); e; e = readElement(r)) graphElement(e);

  // Property atoms.
  const atoms = new Map<number, JTPropertyValue>();
  for (let e = readElement(r); e; e = readElement(r)) {
    const d = e.data;
    version(d);
    d.u32(); // state flags
    const v = () => version(d);
    switch (e.type) {
      case JT_TYPES.stringProperty:
        v();
        atoms.set(e.id, d.mbString());
        break;
      case JT_TYPES.integerProperty:
        v();
        atoms.set(e.id, d.i32());
        break;
      case JT_TYPES.floatProperty:
        v();
        atoms.set(e.id, d.f32());
        break;
      case JT_TYPES.referenceProperty:
        v();
        atoms.set(e.id, { object: d.i32() });
        break;
      case JT_TYPES.dateProperty: {
        v();
        const [year, month, day, hour, minute, second] = [d.i16(), d.i16(), d.i16(), d.i16(), d.i16(), d.i16()],
          two = (n: number) => String(n).padStart(2, '0');
        // Months are stored from 0.
        atoms.set(e.id, {
          date: `${year}-${two(month + 1)}-${two(day)}T${two(hour)}:${two(minute)}:${two(second)}`,
        });
        break;
      }
      case JT_TYPES.lateLoadedProperty: {
        v();
        const segment = d.guid(),
          segmentType = d.i32(),
          payload = d.i32();
        atoms.set(e.id, { segment, segmentType, payload });
        break;
      }
      case JT_TYPES.vector4Property:
        v();
        atoms.set(e.id, d.f32s(4));
        break;
    }
  }

  // The property table: per element, key/value atom pairs ending with key 0.
  const properties = new Map<number, Map<string, JTPropertyValue>>();
  if (r.left >= 6) {
    r.i16(); // version
    const tables = r.count(8);
    for (let t = 0; t < tables; t++) {
      const element = r.i32(),
        map = properties.get(element) ?? new Map<string, JTPropertyValue>();
      properties.set(element, map);
      for (let key = r.i32(); key !== 0; key = r.i32()) {
        const value = r.i32(),
          k = atoms.get(key),
          val = atoms.get(value);
        if (k !== undefined && val !== undefined) map.set(typeof k === 'string' ? k : JSON.stringify(k), val);
      }
    }
  }
  return { nodes, attributes, properties, root };
}
