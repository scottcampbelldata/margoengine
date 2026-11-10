import { LoaderError } from './types.js';
import { limits, resolvePath, throwIfAborted, type BinaryInput } from './util.js';
import { read3MFMaterials, type ThreeMFMaterials } from './threemf-materials.js';
import type { ThreeMFExtension, ThreeMFModel, ThreeMFOptions } from './threemf.js';
import { readXMLTree, decodeXML } from './xml.js';
const F = '3MF';
/** One beam's native tapered-frustum geometry and endpoint properties, in file units. */
export interface ThreeMFBeam {
  v1: number;
  v2: number;
  r1: number;
  r2: number;
  cap1: 'sphere' | 'hemisphere' | 'butt';
  cap2: 'sphere' | 'hemisphere' | 'butt';
  pid?: string;
  p1?: number;
  p2?: number;
}
/** One explicit or effective ball at a lattice vertex. */
export interface ThreeMFBall {
  vertex: number;
  radius: number;
  pid?: string;
  property?: number;
}
/** Named beam/ball subsets, retaining original source indices. */
export interface ThreeMFBeamSet {
  name?: string;
  identifier?: string;
  beams: Uint32Array;
  balls: Uint32Array;
}
/** Native lattice semantics, including clipping/representation references without flattening into a preview. */
export interface ThreeMFBeamLattice {
  radius: number;
  minLength: number;
  cap: 'sphere' | 'hemisphere' | 'butt';
  ballMode: 'none' | 'mixed' | 'all';
  ballRadius?: number;
  clippingMode: 'none' | 'inside' | 'outside';
  clippingMesh?: string;
  representationMesh?: string;
  pid?: string;
  property?: number;
  beams: ThreeMFBeam[];
  balls: ThreeMFBall[];
  sets: ThreeMFBeamSet[];
  /** Indices of beams satisfying minlength; ignored beams retain their original metadata indices. */
  activeBeams: Uint32Array;
  /** Effective balls after ballmode and beam-end membership, including implicit balls in all mode. */
  effectiveBalls: ThreeMFBall[];
}
/** A property-gradient segment of a slice contour. */
export interface ThreeMFSliceSegment {
  vertex: number;
  pid?: string;
  p1?: number;
  p2?: number;
}
/** Source slice contour. Closure is explicit in the final segment. */
export interface ThreeMFSlicePolygon {
  start: number;
  segments: ThreeMFSliceSegment[];
}
/** One layer in source units, including void layers. */
export interface ThreeMFSlice {
  top: number;
  vertices: Float64Array;
  polygons: ThreeMFSlicePolygon[];
}
/** Slice resources with resolved external references and unmodified source layers. */
export interface ThreeMFSliceStack {
  part: string;
  id: string;
  bottom: number;
  slices: ThreeMFSlice[];
  references: { part: string; id: string }[];
  /** Resolved, monotonically increasing layers; the stack's bottom supplies the first slab boundary. */
  layers: ThreeMFSlice[];
}
/** Original property resources, with typed composite/multi rows and resolved color tables. */
export interface ThreeMFNativeProperty {
  part: string;
  id: string;
  kind: string;
  attributes: Record<string, string>;
  entries: Record<string, string>[];
  colors?: Float64Array;
  materialId?: string;
  materialIndices?: Uint32Array;
  weights?: Float64Array[];
  propertyIds?: string[];
  rows?: Uint32Array[];
  blendMethods?: ('mix' | 'multiply')[];
}
/** A source object, distinct from each occurrence in the build. */
export interface ThreeMFNativeObject {
  part: string;
  id: string;
  type: string;
  pid?: string;
  property?: number;
  /** Source-double xyz, before unit conversion and affine instances. */
  vertices: Float64Array;
  triangles: Uint32Array;
  lattice?: ThreeMFBeamLattice;
  slices?: { part: string; id: string; resolution: 'fullres' | 'lowres' };
}
/** Built native geometry with an exact affine matrix; source radii remain valid under nonuniform scale. */
export interface ThreeMFNativeInstance {
  object: ThreeMFNativeObject;
  /** Row-vector 4x3 matrix, applied before unitScale. */
  transform: Float64Array;
  unitScale: number;
}
/** Materials/fallback mesh plus native lattice, slices, properties and build occurrences. */
export interface ThreeMFLatticeResult extends ThreeMFMaterials {
  objects: ThreeMFNativeObject[];
  instances: ThreeMFNativeInstance[];
  sliceStacks: ThreeMFSliceStack[];
  /** Top-level slice representations; component-level stacks override stacks on their descendants. */
  sliceInstances: (ThreeMFNativeInstance & { stack: ThreeMFSliceStack })[];
  propertyResources: ThreeMFNativeProperty[];
}
/** 3MF bounds extended to native primitives and slice data. */
export interface ThreeMFLatticeOptions extends ThreeMFOptions {
  /** Maximum source beams and explicit balls each. Default 1,000,000. */
  maxBeams?: number;
  /** Maximum layers and slice references combined. Default 100,000. */
  maxSlices?: number;
}
interface State {
  requiredSlice?: boolean;
  part: string;
  objects: Map<string, ThreeMFNativeObject>;
  stacks: Map<string, ThreeMFSliceStack>;
  properties: Map<string, ThreeMFNativeProperty>;
  object?: ThreeMFNativeObject;
  lattice?: ThreeMFBeamLattice;
  stack?: ThreeMFSliceStack;
  slice?: ThreeMFSlice;
  polygon?: ThreeMFSlicePolygon;
  property?: ThreeMFNativeProperty;
  xyz: number[];
  xy: number[];
  beamSet?: { name?: string; identifier?: string; beams: number[]; balls: number[] };
}
const attribute = (a: Record<string, string>, name: string): string | undefined =>
  a[name] ?? Object.entries(a).find(([key]) => key.endsWith(':' + name))?.[1];
function number(value: string | undefined, name: string, fallback?: number): number {
  const n = value === undefined ? fallback : Number(value);
  if (n === undefined || !Number.isFinite(n)) throw new LoaderError(F, 'syntax', `${name} must be a finite number`);
  return n;
}
function index(value: string | undefined, name: string): number {
  const n = number(value, name);
  if (!Number.isSafeInteger(n) || n < 0 || n >= 2147483648)
    throw new LoaderError(F, 'range', `${name} must be a nonnegative 31-bit index`);
  return n;
}
function positive(value: string | undefined, name: string, fallback?: number): number {
  const n = number(value, name, fallback);
  if (n <= 0) throw new LoaderError(F, 'range', `${name} must be positive`);
  return n;
}
function choice<T extends string>(value: string | undefined, values: readonly T[], fallback: T): T {
  if (value === undefined) return fallback;
  if (!values.includes(value as T)) throw new LoaderError(F, 'range', `expected ${values.join(', ')}; got ${value}`);
  return value as T;
}
const cap = (value: string | undefined): ThreeMFBeam['cap1'] =>
  choice(value, ['sphere', 'hemisphere', 'butt'], 'sphere');
const own = (a: Record<string, string>): Record<string, string> => Object.assign(Object.create(null), a);
const normalize = (path: string): string => path.replaceAll('\\', '/').replace(/^\/+/, '').toLowerCase();
const list = (value: string | undefined, name: string): number[] => {
  if (!value?.trim()) throw new LoaderError(F, 'syntax', `${name} needs values`);
  return value
    .trim()
    .split(/\s+/)
    .map((v) => number(v, name));
};

/** Reads exact native beam/ball and slice resources alongside the existing textured/composite/multi material mesh. */
export async function parse3MFLattice(
  input: BinaryInput,
  options: ThreeMFLatticeOptions = {},
): Promise<ThreeMFLatticeResult> {
  const limit = limits(options, F),
    maxBeams = options.maxBeams ?? 1000000,
    maxSlices = options.maxSlices ?? 100000;
  if (!Number.isSafeInteger(maxBeams) || maxBeams < 1 || !Number.isSafeInteger(maxSlices) || maxSlices < 1)
    throw new LoaderError(F, 'limit', 'maxBeams and maxSlices must be positive safe integers');
  throwIfAborted(options.signal, F);
  const states = new Map<ThreeMFModel, State>(),
    instances: ThreeMFNativeInstance[] = [],
    sliceInstances: ThreeMFLatticeResult['sliceInstances'] = [];
  const ancestors: boolean[] = [];
  let objectCount = 0,
    references = 0,
    expandedLayers = 0;
  let beams = 0,
    balls = 0,
    slices = 0,
    vertices = 0,
    segments = 0;
  const state = (m: ThreeMFModel): State => {
    let s = states.get(m);
    if (!s) {
      s = { part: '', objects: new Map(), stacks: new Map(), properties: new Map(), xyz: [], xy: [] };
      states.set(m, s);
    }
    return s;
  };
  const propertyRef = (a: Record<string, string>, pid?: string, p?: number): { pid?: string; property?: number } => ({
    pid: a.pid ?? pid,
    property: a.pindex === undefined ? p : index(a.pindex, 'pindex'),
  });
  const hooks: ThreeMFExtension = {
    element(m, name, a) {
      const s = state(m),
        obj = s.object;
      if (name === 'model') {
        const required = (a.requiredextensions ?? '').trim().split(/\s+/);
        s.requiredSlice = Object.entries(a).some(
          ([key, value]) =>
            key.startsWith('xmlns:') &&
            value === 'http://schemas.microsoft.com/3dmanufacturing/slice/2015/07' &&
            required.includes(key.slice(6)),
        );
      } else if (name === 'object') {
        if (++objectCount > 100000) throw new LoaderError(F, 'limit', 'native objects exceed 100000');
        const id = a.id;
        if (!id || s.objects.has(id)) throw new LoaderError(F, 'syntax', 'native object id is missing or duplicated');
        s.object = {
          part: '',
          id,
          type: a.type ?? 'model',
          pid: a.pid,
          property: a.pindex === undefined ? undefined : index(a.pindex, 'pindex'),
          vertices: new Float64Array(),
          triangles: new Uint32Array(),
        };
        s.objects.set(id, s.object);
        s.xyz = [];
        const stack = attribute(a, 'slicestackid');
        if (stack)
          s.object.slices = {
            part: attribute(a, 'slicepath') ?? '',
            id: stack,
            resolution: choice(attribute(a, 'meshresolution'), ['fullres', 'lowres'], 'fullres'),
          };
      } else if (name === 'vertex') {
        if (++vertices > limit.maxVertices)
          throw new LoaderError(F, 'limit', 'native/slice vertices exceed maxVertices');
        if (s.slice) {
          s.xy.push(number(a.x, 'slice x'), number(a.y, 'slice y'));
          return true;
        }
        if (obj) s.xyz.push(number(a.x, 'vertex x'), number(a.y, 'vertex y'), number(a.z, 'vertex z'));
      } else if (name === 'beamlattice') {
        if (!obj || obj.lattice) throw new LoaderError(F, 'syntax', 'beamlattice needs a distinct mesh object');
        const r = propertyRef(a, m.objects.get(obj.id)?.pid, m.objects.get(obj.id)?.pindex);
        const lattice: ThreeMFBeamLattice = {
          radius: positive(a.radius, 'radius'),
          minLength: positive(a.minlength, 'minlength'),
          cap: cap(a.cap),
          ballMode: choice(attribute(a, 'ballmode'), ['none', 'mixed', 'all'], 'none'),
          clippingMode: choice(a.clippingmode, ['none', 'inside', 'outside'], 'none'),
          clippingMesh: a.clippingmesh,
          representationMesh: a.representationmesh,
          ...r,
          beams: [],
          balls: [],
          sets: [],
          activeBeams: new Uint32Array(),
          effectiveBalls: [],
        };
        const br = attribute(a, 'ballradius');
        if (br !== undefined) lattice.ballRadius = positive(br, 'ballradius');
        if (lattice.ballMode !== 'none' && lattice.ballRadius === undefined)
          throw new LoaderError(F, 'syntax', 'ballmode needs ballradius');
        obj.lattice = lattice;
        s.lattice = lattice;
      } else if (name === 'beam') {
        const l = s.lattice;
        if (!l) throw new LoaderError(F, 'syntax', 'beam outside beamlattice');
        if (++beams > maxBeams) throw new LoaderError(F, 'limit', 'beam count exceeds maxBeams');
        if (a.r2 !== undefined && a.r1 === undefined) throw new LoaderError(F, 'syntax', 'r2 requires r1');
        const r1 = positive(a.r1, 'r1', l.radius),
          beam: ThreeMFBeam = {
            v1: index(a.v1, 'v1'),
            v2: index(a.v2, 'v2'),
            r1,
            r2: positive(a.r2, 'r2', r1),
            cap1: a.cap1 === undefined ? l.cap : cap(a.cap1),
            cap2: a.cap2 === undefined ? l.cap : cap(a.cap2),
            pid: a.pid ?? l.pid,
            p1: a.p1 === undefined ? l.property : index(a.p1, 'p1'),
            p2: a.p2 === undefined ? l.property : index(a.p2, 'p2'),
          };
        l.beams.push(beam);
      } else if (name === 'ball') {
        const l = s.lattice;
        if (!l) throw new LoaderError(F, 'syntax', 'ball outside beamlattice');
        if (++balls > maxBeams) throw new LoaderError(F, 'limit', 'ball count exceeds maxBeams');
        l.balls.push({
          vertex: index(a.vindex, 'vindex'),
          radius: positive(a.r, 'ball radius', l.ballRadius),
          pid: a.pid ?? l.pid,
          property: a.p === undefined ? l.property : index(a.p, 'ball property'),
        });
      } else if (name === 'beamset') {
        if (!s.lattice || s.beamSet) throw new LoaderError(F, 'syntax', 'invalid beamset nesting');
        s.beamSet = { name: a.name, identifier: a.identifier, beams: [], balls: [] };
      } else if (name === 'ref' && s.beamSet) {
        if (++references > maxBeams * 2)
          throw new LoaderError(F, 'limit', 'beamset references exceed the native primitive budget');
        s.beamSet.beams.push(index(a.index, 'beam ref'));
      } else if (name === 'ballref' && s.beamSet) {
        if (++references > maxBeams * 2)
          throw new LoaderError(F, 'limit', 'beamset references exceed the native primitive budget');
        s.beamSet.balls.push(index(a.index, 'ball ref'));
      } else if (name === 'slicestack') {
        if (s.stack || !a.id || s.stacks.has(a.id))
          throw new LoaderError(F, 'syntax', 'invalid slicestack id or nesting');
        s.stack = {
          part: '',
          id: a.id,
          bottom: number(a.zbottom, 'zbottom', 0),
          slices: [],
          references: [],
          layers: [],
        };
        s.stacks.set(a.id, s.stack);
      } else if (name === 'sliceref') {
        if (!s.stack || !a.slicepath || !a.slicestackid)
          throw new LoaderError(F, 'syntax', 'sliceref requires a stack, path and id');
        if (++slices > maxSlices) throw new LoaderError(F, 'limit', 'slice references exceed maxSlices');
        s.stack.references.push({ part: a.slicepath, id: a.slicestackid });
      } else if (name === 'slice') {
        if (!s.stack || s.slice) throw new LoaderError(F, 'syntax', 'slice outside stack or nested');
        if (++slices > maxSlices) throw new LoaderError(F, 'limit', 'layers exceed maxSlices');
        s.slice = { top: number(a.ztop, 'ztop'), vertices: new Float64Array(), polygons: [] };
        s.stack.slices.push(s.slice);
        s.xy = [];
      } else if (name === 'polygon' && s.slice) {
        if (s.polygon) throw new LoaderError(F, 'syntax', 'nested slice polygon');
        s.polygon = { start: index(a.startv, 'startv'), segments: [] };
        s.slice.polygons.push(s.polygon);
      } else if (name === 'segment' && s.polygon) {
        if (++segments > limit.maxTriangles * 3)
          throw new LoaderError(F, 'limit', 'slice segments exceed triangle-derived limit');
        const p1 = a.p1 === undefined ? undefined : index(a.p1, 'p1');
        s.polygon.segments.push({
          vertex: index(a.v2, 'v2'),
          pid: a.pid,
          p1,
          p2: a.p2 === undefined ? p1 : index(a.p2, 'p2'),
        });
      }
      if (['basematerials', 'colorgroup', 'texture2dgroup', 'compositematerials', 'multiproperties'].includes(name)) {
        if (!a.id || s.properties.has(a.id))
          throw new LoaderError(F, 'syntax', 'missing or duplicate property resource id');
        s.property = { part: '', id: a.id, kind: name, attributes: own(a), entries: [] };
        s.properties.set(a.id, s.property);
      } else if (['base', 'color', 'tex2coord', 'composite', 'multi'].includes(name) && s.property)
        s.property.entries.push(own(a));
    },
    close(m, name) {
      const s = state(m);
      if (name === 'object') {
        if (s.object) s.object.vertices = Float64Array.from(s.xyz);
        s.object = undefined;
        s.xyz = [];
      } else if (name === 'beamlattice') s.lattice = undefined;
      else if (name === 'beamset' && s.beamSet && s.lattice) {
        s.lattice.sets.push({
          ...s.beamSet,
          beams: Uint32Array.from(s.beamSet.beams),
          balls: Uint32Array.from(s.beamSet.balls),
        });
        s.beamSet = undefined;
      } else if (name === 'slice' && s.slice) {
        s.slice.vertices = Float64Array.from(s.xy);
        s.slice = undefined;
        s.xy = [];
      } else if (name === 'polygon') s.polygon = undefined;
      else if (name === 'slicestack') s.stack = undefined;
      if (name === s.property?.kind) s.property = undefined;
    },
    async ready(read, context) {
      const relationships = new Map<string, Set<string>>();
      const related = async (part: string, path: string): Promise<void> => {
        const target = normalize(resolvePath(part, path));
        if (target === part) return;
        let targets = relationships.get(part);
        if (!targets) {
          const at = part.lastIndexOf('/'),
            name = part.slice(at + 1),
            folder = part.slice(0, at + 1);
          const tree = readXMLTree(decodeXML(await read(folder + '_rels/' + name + '.rels')), F);
          targets = new Set<string>();
          for (const root of tree.children)
            for (const rel of root.children)
              if (
                rel.name === 'Relationship' &&
                rel.attributes.Type?.endsWith('/3dmodel') &&
                rel.attributes.TargetMode !== 'External' &&
                rel.attributes.Target
              )
                targets.add(normalize(resolvePath(part, rel.attributes.Target)));
          relationships.set(part, targets);
        }
        if (!targets.has(target))
          throw new LoaderError(F, 'syntax', 'external slice model has no OPC model relationship');
      };
      // Model parts loaded here use the same reader and material hooks as the root, including 2D vertices.
      for (const [part, m] of context.models) {
        const s = state(m);
        s.part = part;
        const paths = [
          ...[...s.objects.values()].flatMap((o) => (o.slices?.part ? [o.slices.part] : [])),
          ...[...s.stacks.values()].flatMap((stack) => stack.references.map((r) => r.part)),
        ];
        for (const path of paths) {
          await related(part, path);
          await context.loadModelPart(resolvePath(part, path));
        }
      }
      const checkProperty = (s: State, id: string | undefined, p: number | undefined): void => {
        if (p === undefined) return;
        const resource = id && s.properties.get(id);
        if (!resource || p >= resource.entries.length)
          throw new LoaderError(F, 'range', 'native property index is outside its resource');
      };
      for (const [m, s] of states) {
        throwIfAborted(options.signal, F);
        for (const resource of s.properties.values()) {
          resource.part = s.part;
          const colors = m.properties.get(resource.id);
          if (colors) resource.colors = Float64Array.from(colors.flat());
          if (resource.kind === 'compositematerials') {
            const indices = list(resource.attributes.matindices, 'matindices').map((n) => index(String(n), 'matindex')),
              base = s.properties.get(resource.attributes.matid);
            if (!base || base.kind !== 'basematerials' || indices.some((n) => n >= base.entries.length))
              throw new LoaderError(F, 'range', 'composite materials reference invalid base materials');
            resource.materialId = base.id;
            resource.materialIndices = Uint32Array.from(indices);
            resource.weights = resource.entries.map((e) => {
              const source = list(e.values, 'composite weights'),
                weights = indices.map((_, i) => source[i] ?? 0);
              if (weights.some((w) => w < 0)) throw new LoaderError(F, 'range', 'invalid composite weight row');
              const sum = weights.reduce((a, b) => a + b, 0);
              return Float64Array.from(weights, (w) => (sum ? w / sum : 1 / indices.length));
            });
          } else if (resource.kind === 'multiproperties') {
            const pids = resource.attributes.pids?.trim().split(/\s+/);
            if (
              !pids?.length ||
              pids.some((id) => !s.properties.has(id) || s.properties.get(id)!.kind === 'multiproperties')
            )
              throw new LoaderError(F, 'range', 'invalid multi-property resource references');
            resource.propertyIds = pids;
            const blends = resource.attributes.blendmethods?.trim().split(/\s+/) ?? [];
            if (blends.length >= pids.length || blends.some((b) => b !== 'mix' && b !== 'multiply'))
              throw new LoaderError(F, 'range', 'invalid multi-property blend methods');
            resource.blendMethods = Array.from(
              { length: pids.length - 1 },
              (_, i) => (blends[i] ?? 'mix') as 'mix' | 'multiply',
            );
            resource.rows = resource.entries.map((e) => {
              const source = list(e.pindices, 'pindices');
              const row = pids.map((_, i) => index(String(source[i] ?? 0), 'property index'));
              row.forEach((n, i) => checkProperty(s, pids[i], n));
              return Uint32Array.from(row);
            });
          }
        }
        for (const o of s.objects.values()) {
          o.part = s.part;
          o.triangles = m.objects.get(o.id)?.mesh?.triangles.result() ?? new Uint32Array();
          if (o.slices) o.slices.part = o.slices.part ? normalize(resolvePath(s.part, o.slices.part)) : s.part;
          if (o.slices?.resolution === 'lowres' && !s.requiredSlice)
            throw new LoaderError(
              F,
              'syntax',
              'lowres slice objects require the slice namespace in requiredextensions',
            );
          const l = o.lattice;
          if (!l) continue;
          if (!l.beams.length) throw new LoaderError(F, 'syntax', 'beamlattice requires at least one beam');
          if (!m.objects.get(o.id)?.mesh || m.objects.get(o.id)!.components.length)
            throw new LoaderError(F, 'syntax', 'lattice object requires a mesh');
          const pointCount = o.vertices.length / 3,
            active: number[] = [],
            ends = new Set<number>();
          l.beams.forEach((beam, i) => {
            if (beam.v1 === beam.v2 || beam.v1 >= pointCount || beam.v2 >= pointCount)
              throw new LoaderError(F, 'range', 'invalid beam endpoints');
            checkProperty(s, beam.pid, beam.p1);
            checkProperty(s, beam.pid, beam.p2);
            const a = beam.v1 * 3,
              b = beam.v2 * 3;
            if (
              Math.hypot(
                o.vertices[a] - o.vertices[b],
                o.vertices[a + 1] - o.vertices[b + 1],
                o.vertices[a + 2] - o.vertices[b + 2],
              ) >= l.minLength
            ) {
              active.push(i);
              ends.add(beam.v1);
              ends.add(beam.v2);
            }
          });
          l.activeBeams = Uint32Array.from(active);
          const explicit = new Map<number, ThreeMFBall>();
          for (const ball of l.balls) {
            if (ball.vertex >= pointCount || explicit.has(ball.vertex))
              throw new LoaderError(F, 'range', 'invalid or repeated ball vertex');
            checkProperty(s, ball.pid, ball.property);
            explicit.set(ball.vertex, ball);
          }
          if (l.ballMode !== 'none')
            for (const vertex of ends) {
              const ball = explicit.get(vertex);
              if (ball) l.effectiveBalls.push({ ...ball });
              else if (l.ballMode === 'all')
                l.effectiveBalls.push({ vertex, radius: l.ballRadius!, pid: l.pid, property: l.property });
            }
          for (const set of l.sets)
            if (set.beams.some((i) => i >= l.beams.length) || set.balls.some((i) => i >= l.balls.length))
              throw new LoaderError(F, 'range', 'beamset index outside source arrays');
          for (const id of [l.clippingMesh, l.representationMesh])
            if (id !== undefined) {
              const target = s.objects.get(id);
              const ids = [...s.objects.keys()];
              if (
                !target ||
                target === o ||
                target.type !== 'model' ||
                target.lattice ||
                !target.triangles.length ||
                ids.indexOf(id) >= ids.indexOf(o.id)
              )
                throw new LoaderError(
                  F,
                  'range',
                  'clipping/representation mesh must be an earlier non-lattice model mesh',
                );
            }
          if (l.clippingMode !== 'none' && !l.clippingMesh)
            throw new LoaderError(F, 'syntax', 'clippingmode requires clippingmesh');
        }
        for (const stack of s.stacks.values()) {
          stack.part = s.part;
          if (stack.slices.length && stack.references.length)
            throw new LoaderError(F, 'syntax', 'slice stack cannot mix inline slices and references');
          let previous = stack.bottom;
          for (const slice of stack.slices) {
            if (slice.top <= previous)
              throw new LoaderError(F, 'range', 'slice tops must strictly increase above zbottom');
            previous = slice.top;
            if ((slice.vertices.length && !slice.polygons.length) || (!slice.vertices.length && slice.polygons.length))
              throw new LoaderError(F, 'syntax', 'nonvoid slice needs vertices and polygons');
            for (const polygon of slice.polygons) {
              if (polygon.start >= slice.vertices.length / 2 || !polygon.segments.length)
                throw new LoaderError(F, 'range', 'invalid slice polygon start or empty segments');
              let v = polygon.start;
              for (const segment of polygon.segments) {
                if (segment.vertex >= slice.vertices.length / 2 || segment.vertex === v)
                  throw new LoaderError(F, 'range', 'invalid slice segment vertex');
                if (segment.pid !== undefined) {
                  checkProperty(s, segment.pid, segment.p1);
                  checkProperty(s, segment.pid, segment.p2);
                  if (s.properties.get(segment.pid)?.kind === 'texture2dgroup')
                    throw new LoaderError(F, 'range', 'slice segments cannot reference image properties');
                }
                v = segment.vertex;
              }
            }
          }
        }
      }
      const byPart = new Map([...states.values()].map((s) => [s.part, s]));
      for (const s of states.values())
        for (const stack of s.stacks.values()) {
          stack.layers = [...stack.slices];
          let previous = stack.bottom;
          for (const ref of stack.references) {
            ref.part = normalize(resolvePath(s.part, ref.part));
            const target = byPart.get(ref.part)?.stacks.get(ref.id);
            if (!target || target.part === stack.part || target.references.length)
              throw new LoaderError(F, 'range', 'slice reference must target an external stack without references');
            for (const layer of target.slices) {
              if (++expandedLayers > maxSlices)
                throw new LoaderError(F, 'limit', 'expanded slice references exceed maxSlices');
              if (layer.top <= previous) throw new LoaderError(F, 'range', 'referenced slice heights do not increase');
              stack.layers.push(layer);
              previous = layer.top;
            }
          }
        }
      for (const s of states.values())
        for (const o of s.objects.values())
          if (o.slices) {
            const stack = byPart.get(o.slices.part)?.stacks.get(o.slices.id);
            if (!stack) throw new LoaderError(F, 'range', 'object references a missing slice stack');
            for (const layer of stack.layers)
              for (const polygon of layer.polygons) {
                if (
                  (o.type === 'model' || o.type === 'solidsupport') &&
                  polygon.segments.at(-1)?.vertex !== polygon.start
                )
                  throw new LoaderError(F, 'range', 'solid slice contour is not closed');
                for (const segment of polygon.segments)
                  if (segment.pid === undefined) {
                    checkProperty(s, o.pid, segment.p1);
                    checkProperty(s, o.pid, segment.p2);
                  }
              }
          }
    },
    instance(m, obj, transform, unitScale, depth) {
      const s = state(m),
        o = s.objects.get(obj.id)!;
      const instance = { object: o, transform: new Float64Array(transform), unitScale };
      instances.push(instance);
      ancestors.length = depth;
      const inherited = ancestors.some(Boolean);
      ancestors[depth] = inherited || !!o.slices;
      if (o.slices && !inherited) {
        if (transform[2] !== 0 || transform[5] !== 0 || transform[6] !== 0 || transform[7] !== 0 || transform[8] !== 1)
          throw new LoaderError(F, 'range', 'slice build transform must preserve the slicing plane');
        const owner = [...states.values()].find((s) => s.part === o.slices!.part)!;
        sliceInstances.push({ ...instance, stack: owner.stacks.get(o.slices.id)! });
      }
    },
    hasGeometry() {
      return instances.some((i) => i.object.lattice?.activeBeams.length);
    },
    bucket() {
      return '';
    },
    corner() {},
    group() {},
  };
  const mesh = await read3MFMaterials(input, options, hooks);
  return {
    ...mesh,
    objects: [...states.values()].flatMap((s) => [...s.objects.values()]),
    instances,
    sliceStacks: [...states.values()].flatMap((s) => [...s.stacks.values()]),
    sliceInstances,
    propertyResources: [...states.values()].flatMap((s) => [...s.properties.values()]),
  };
}
