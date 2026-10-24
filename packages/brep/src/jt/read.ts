// A JT file as parts placed in an assembly: the scene graph walked from its root (transforms multiplied down, the
// finest LOD alternative and a switch's selected child taken, ignored nodes skipped), each part node's exact B-rep
// read from its XT B-rep segment (Parasolid neutral binary, through the XT reader) or, for a subordinate XT element,
// its bodies from the file's MultiXT segment, and its shapes' LOD segments listed. Coordinates come out in metres, as
// STEP models do.
//
// This software reads the JT Data Format as described in the Siemens JT File Format Reference and ISO 14306. Copyright
// in the JT data structures and operators is owned by Siemens Product Lifecycle Management Software Inc. (Siemens
// Digital Industries Software) and they are used under the Siemens JT Data Format Reference Intellectual Property
// License Terms. US 8,019,788, US 2011/0199382 and corresponding foreign patents are licensed royalty-free under the
// Siemens JT Data Format Reference Patent Clarification Notice. JT and Parasolid are trademarks of Siemens; they are
// named here only to identify the format. This software is not endorsed by or affiliated with Siemens.
import type { STEPModel, STEPOptions } from '../index.js';
import { STEPFile, stepText } from '../step/file.js';
import { readStructure } from '../step/structure.js';
import { xtToSTEP } from '../xt/step.js';
import { int32Packet } from './codec.js';
import { fail, JTContainer, type JTElement, type JTReader, readElement } from './file.js';
import { JT_TYPES, type JTLateLoaded, type JTSceneGraph, type JTShapeKind, readSceneGraph } from './lsg.js';
import { type JTMesh, readTriStripLOD } from './mesh.js';
import { multiplyMatrices as multiply } from '@margoengine/math/mat4';

/** A shape of a part: a tessellated representation stored in shape LOD segments. */
export interface JTShape {
  /** The shape node's object ID. */
  readonly node: number;
  readonly kind: JTShapeKind;
  /** Column-major 4x4 from the shape's coordinates (in the file's unit) to its part's, translation in metres. */
  readonly matrix: Float64Array;
  /** Its late-loaded shape LOD segments (segment types 6 to 16), finest first. */
  readonly lods: readonly JTLateLoaded[];
  /** The finest LOD's triangles (tri-strip set shapes of JT 9 files), in the part's coordinates in metres. */
  readonly mesh?: JTMesh;
}

/** A part: one part node (or a shape outside any part), however many times the assembly places it. */
export interface JTPart {
  /** The part node's object ID. */
  readonly node: number;
  readonly name: string;
  /**
   * The exact B-rep from the part's XT B-rep segment (or, for a subordinate one, its bodies in the file's MultiXT
   * segment), read like a Parasolid file; undefined without one.
   */
  readonly brep?: STEPModel;
  readonly shapes: readonly JTShape[];
}

/** One placement of a part. */
export interface JTInstance {
  /** Index into `parts`. */
  readonly part: number;
  /** Column-major 4x4 from the part's coordinates in metres to the model's, in metres. */
  readonly matrix: Float64Array;
  /** The diffuse colour of the nearest material above the part, if any. */
  readonly color?: readonly [number, number, number, number];
  /** Names of the nodes from the root down to the part. */
  readonly path: readonly string[];
}

/** Options of {@link parseJT}. */
export interface JTOptions extends STEPOptions {
  /** Read each part's XT B-rep segment (default true). */
  readonly brep?: boolean;
  /** Decode each shape's finest LOD into `mesh` (default true). */
  readonly meshes?: boolean;
}

/** A parsed JT file. */
export interface JTModel {
  /** Format version, e.g. 9.5 or 10. */
  readonly version: number;
  readonly versionText: string;
  /** Metres per unit of the file's coordinates (from JT_PROP_MEASUREMENT_UNITS). */
  readonly unit: number;
  readonly sceneGraph: JTSceneGraph;
  readonly parts: readonly JTPart[];
  readonly instances: readonly JTInstance[];
  /** What the reader left out or assumed. */
  readonly warnings: readonly string[];
}

const UNITS: Readonly<Record<string, number>> = {
  millimeters: 0.001,
  millimetres: 0.001,
  centimeters: 0.01,
  centimetres: 0.01,
  decimeters: 0.1,
  decimetres: 0.1,
  meters: 1,
  metres: 1,
  kilometers: 1000,
  kilometres: 1000,
  micrometers: 1e-6,
  micrometres: 1e-6,
  inches: 0.0254,
  feet: 0.3048,
  yards: 0.9144,
  miles: 1609.344,
  mils: 2.54e-5,
};

const IDENTITY = () => new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

const isLate = (v: unknown): v is JTLateLoaded =>
  typeof v === 'object' && v !== null && 'segment' in v && 'segmentType' in v;

/**
 * Reads a JT file (ISO 14306; JT 9.5 and later) into its parts, their placements, names and colours, each part's exact
 * B-rep from its XT B-rep segment (meshed with {@link tessellateJT}) and the shape LOD segments of its tessellated
 * representation. Coordinates are in metres. Throws a TypeError for a malformed file and a RangeError for a JT version
 * before 9.5.
 * @example
 * const model = parseJT(await (await fetch('/assembly.jt')).arrayBuffer());
 * for (const instance of model.instances) console.log(instance.path.join('/'), model.parts[instance.part].brep?.bodies.length);
 */
export function parseJT(input: ArrayBuffer | ArrayBufferView, options: JTOptions = {}): JTModel {
  const bytes =
      input instanceof ArrayBuffer
        ? new Uint8Array(input)
        : new Uint8Array(input.buffer, input.byteOffset, input.byteLength),
    container = new JTContainer(bytes),
    graph = readSceneGraph(container),
    warnings: string[] = [],
    warn = (message: string) => {
      if (warnings.length < 200) warnings.push(message);
    };
  const property = (id: number, key: string) => graph.properties.get(id)?.get(key);
  const nameOf = (id: number): string => {
    const value = property(id, 'JT_PROP_NAME');
    // "Name;version;revision:" for parts, assemblies and instances.
    return typeof value === 'string' ? value.split(';')[0].replace(/:$/, '') : '';
  };
  const unitOf = (id: number): number | undefined => {
    const value = property(id, 'JT_PROP_MEASUREMENT_UNITS');
    if (typeof value !== 'string') return undefined;
    const unit = UNITS[value.trim().toLowerCase()];
    if (unit === undefined) warn(`unknown JT_PROP_MEASUREMENT_UNITS "${value}" on node ${id}; kept the unit above it`);
    return unit;
  };
  let fileUnit: number | undefined;
  for (const id of graph.nodes.keys()) {
    fileUnit = unitOf(id);
    if (fileUnit !== undefined) break;
  }
  if (fileUnit === undefined) warn('the file names no JT_PROP_MEASUREMENT_UNITS; read it as millimetres');
  const unit = fileUnit ?? 0.001;

  /** A node's own transform (translation scaled to metres) and material. */
  const local = (id: number, nodeUnit: number) => {
    const node = graph.nodes.get(id);
    let matrix: Float64Array | undefined, color: readonly [number, number, number, number] | undefined;
    for (const a of node?.attributes ?? []) {
      const attribute = graph.attributes.get(a);
      if (attribute?.kind === 'transform' && attribute.matrix) {
        const m = Float64Array.from(attribute.matrix);
        m[12] *= nodeUnit;
        m[13] *= nodeUnit;
        m[14] *= nodeUnit;
        matrix = matrix ? multiply(matrix, m) : m;
      } else if (attribute?.kind === 'material' && attribute.diffuse) color = attribute.diffuse;
    }
    return { matrix, color };
  };
  /** The children a traversal takes: an LOD node's finest alternative, a switch's selected child, else all. */
  const taken = (id: number): readonly number[] => {
    const node = graph.nodes.get(id);
    if (!node) return [];
    if (node.kind === 'lod' || node.kind === 'range-lod') return node.children.slice(0, 1);
    if (node.kind === 'switch')
      return node.selected !== undefined && node.selected >= 0 ? [node.children[node.selected]] : [];
    return node.children;
  };

  const parts: JTPart[] = [],
    partIndex = new Map<number, number>(),
    instances: JTInstance[] = [],
    external = new Set<string>(),
    multiXT = new Map<string, MultiXT>();

  /** The shapes below part node `id`, placed relative to it. */
  const shapesOf = (id: number, nodeUnit: number): JTShape[] => {
    const shapes: JTShape[] = [];
    const walk = (n: number, matrix: Float64Array, u: number, depth: number) => {
      const node = graph.nodes.get(n);
      if (!node || node.ignore || depth > 256) return;
      const here = unitOf(n) ?? u,
        own = n === id ? undefined : local(n, here).matrix,
        m = own ? multiply(matrix, own) : matrix;
      if (node.kind === 'shape') {
        const lods = [...(graph.properties.get(n)?.values() ?? [])]
          .filter(isLate)
          .filter((v) => v.segmentType >= 6 && v.segmentType <= 16)
          .sort((a, b) => a.segmentType - b.segmentType);
        let mesh: JTMesh | undefined;
        if (options.meshes !== false && node.shape === 'tri-strip' && lods.length)
          try {
            mesh = readTriStripLOD(container, lods[0].segment, here);
          } catch (error) {
            warn(`part ${nameOf(id) || id}: shape ${n} was not decoded (${(error as Error).message})`);
          }
        shapes.push({ node: n, kind: node.shape ?? 'shape', matrix: m, lods, mesh });
        return;
      }
      for (const child of taken(n)) walk(child, m, here, depth + 1);
    };
    walk(id, IDENTITY(), nodeUnit, 0);
    return shapes;
  };

  // A part without a name of its own takes the nearest one above it (JT 10 writers name the instance node).
  const partOf = (id: number, nodeUnit: number, above: string): number => {
    const known = partIndex.get(id);
    if (known !== undefined) return known;
    const shapes = shapesOf(id, nodeUnit);
    let brep: STEPModel | undefined;
    if (options.brep !== false) {
      const late = [...(graph.properties.get(id)?.values() ?? [])].filter(isLate),
        xt = late.find((v) => v.segmentType === 17),
        multi = late.find((v) => v.segmentType === 30)?.segment;
      if (xt) {
        try {
          const source = (segment: string) => {
            let m = multiXT.get(segment);
            if (!m) multiXT.set(segment, (m = readMultiXT(container, segment)));
            return m;
          };
          brep = readXTSegment(container, xt.segment, multi, source, options, warn, id);
        } catch (error) {
          warn(`part ${nameOf(id) || id}: its XT B-rep could not be read (${(error as Error).message})`);
        }
      }
    }
    const index = parts.push({ node: id, name: nameOf(id) || above, brep, shapes }) - 1;
    partIndex.set(id, index);
    return index;
  };

  const visit = (
    id: number,
    matrix: Float64Array,
    color: readonly [number, number, number, number] | undefined,
    path: readonly string[],
    u: number,
    depth: number,
  ) => {
    const node = graph.nodes.get(id);
    if (!node || node.ignore) return;
    if (depth > 256) {
      warn(`the scene graph is deeper than 256 nodes at node ${id}; stopped there`);
      return;
    }
    const here = unitOf(id) ?? u,
      own = local(id, here),
      m = own.matrix ? multiply(matrix, own.matrix) : matrix,
      c = own.color ?? color,
      name = nameOf(id),
      p = name ? [...path, name] : path;
    if (node.kind === 'partition' && node.file && depth > 0) {
      external.add(node.file);
      return;
    }
    if (node.kind === 'part' || node.kind === 'shape') {
      instances.push({ part: partOf(id, here, p[p.length - 1] ?? ''), matrix: m, color: c, path: p });
      return;
    }
    for (const child of taken(id)) visit(child, m, c, p, here, depth + 1);
  };
  if (graph.root !== undefined) visit(graph.root, IDENTITY(), undefined, [], unit, 0);
  if (external.size)
    warn(
      `${external.size} referenced JT files were not read (open them on their own): ${[...external].slice(0, 5).join(', ')}`,
    );

  return {
    version: container.version,
    versionText: container.versionText,
    unit,
    sceneGraph: graph,
    parts,
    instances,
    warnings,
  };
}

/** A MultiXT segment: one Parasolid file holding several parts' bodies, and each body's identifier, in order. */
interface MultiXT {
  readonly ids: Int32Array;
  readonly xt: Uint8Array;
}

/**
 * The Parasolid data after the reader's position: the I32 length followed by Parasolid's own start ("PS" and two zero
 * bytes for neutral binary, or the "**" text header), found within the first 4 KiB.
 */
function findXT(d: JTReader): Uint8Array | undefined {
  const b = d.bytes,
    view = new DataView(b.buffer, b.byteOffset);
  for (let k = d.at; k + 8 <= d.end && k < d.at + 4096; k++) {
    const n = view.getInt32(k, d.little),
      s = k + 4;
    const ps = b[s] === 0x50 && b[s + 1] === 0x53 && b[s + 2] === 0 && b[s + 3] === 0,
      header = b[s] === 0x2a && b[s + 1] === 0x2a;
    if ((ps || header) && n > 4 && s + n <= d.end) return b.subarray(s, s + n);
  }
  return undefined;
}

/**
 * Reads a MultiXT segment (type 30; not in the published texts). Its element, as JT 10.5 files write it: U8 version,
 * I32 Parasolid major, minor and build, one more byte, U32 body count, the bodies' identifiers (an Int32 packet), then
 * the I32 length and the Parasolid data, which holds the bodies in the same order.
 */
function readMultiXT(container: JTContainer, segment: string): MultiXT {
  const element = readElement(container.data(segment));
  if (!element || element.type !== JT_TYPES.multiXTBRep) fail(`segment ${segment} holds no MultiXT element`);
  const d = (element as JTElement).data;
  d.need(14);
  const count = d.u32(),
    ids = int32Packet(d, true);
  if (ids.length !== count) fail(`MultiXT lists ${ids.length} of ${count} bodies`);
  return { ids, xt: findXT(d) ?? fail(`segment ${segment} holds no Parasolid data`) };
}

/** Reads an XT B-rep segment's Parasolid data into a STEP model (geometry in metres, as Parasolid stores it). */
function readXTSegment(
  container: JTContainer,
  segment: string,
  multi: string | undefined,
  source: (segment: string) => MultiXT,
  options: STEPOptions,
  warn: (message: string) => void,
  part: number,
): STEPModel | undefined {
  const r = container.data(segment),
    element = readElement(r);
  if (!element || element.type !== JT_TYPES.xtBRep) {
    warn(`part ${part}: segment ${segment} holds no XT B-rep element`);
    return undefined;
  }
  const d = element.data;
  let xt: Uint8Array | undefined, bodies: number[] | undefined;
  if (container.version < 10) {
    // Version, Parasolid major, minor and build, then the data's length and the data.
    d.i32();
    d.i32();
    d.i32();
    d.i32();
    const n = d.count(1),
      at = d.need(n);
    xt = d.bytes.subarray(at, at + n);
  } else {
    d.u8(); // version
    if (d.u8() !== 0) {
      // A subordinate element: U32 body count and the bodies' identifiers; the Parasolid data is the MultiXT
      // segment's, whose own list of identifiers gives each body's place in it.
      const count = d.u32(),
        ids = int32Packet(d, true);
      if (ids.length !== count) fail(`XT element lists ${ids.length} of ${count} bodies`);
      if (!multi) {
        warn(`part ${part}: its XT B-rep is a subordinate element and the part names no MultiXT segment`);
        return undefined;
      }
      const m = source(multi);
      bodies = [...ids].map((id) => m.ids.indexOf(id)).filter((i) => i >= 0);
      if (bodies.length < ids.length)
        warn(`part ${part}: ${ids.length - bodies.length} of its bodies are not in the MultiXT segment`);
      if (!bodies.length) return undefined;
      xt = m.xt;
    } else {
      // JT 10 adds body identifier fields ahead of the data.
      xt = findXT(d);
      if (!xt) {
        warn(`part ${part}: the JT 10 XT B-rep element's data was not found`);
        return undefined;
      }
    }
  }
  const conversion = xtToSTEP(xt, { parts: bodies }),
    file = new STEPFile(stepText(conversion.step)),
    structure = readStructure(file, options);
  for (const w of conversion.warnings) warn(`part ${part}: ${w}`);
  return { header: file.header, file, ...structure };
}
