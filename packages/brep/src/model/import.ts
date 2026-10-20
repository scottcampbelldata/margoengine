// Modeler bodies from a parsed STEP file's B-rep bodies, so every operation (Booleans, blends, mass properties,
// checks, export) works on imported parts, not only on shapes built here. SAT, Parasolid and JT B-reps reach this as
// STEP too (their readers convert to it). STEP's topology maps one to one: each face (its surface and sense), bound
// (reversed when its orientation is false), oriented edge (its direction in the loop), edge (shared by its two uses)
// and vertex. Geometry becomes the modeler's plain definitions, in metres: planes, cylinders, cones, spheres, tori and
// B-splines as they are; surfaces of revolution and extrusion of lines and circles, and offsets of analytic surfaces,
// as the analytic surfaces they are. A face on anything else makes its body fail, with the reason.
import { Enum, type STEPFile, type STEPValue } from '../step/file.js';
import { direction, frame, list, num, point, ref, vector } from '../geometry/read.js';
import { add, cross, distance, dot, length, scale, sub, unit, type XYZ } from '../geometry/vec.js';
import type { STEPModel } from '../index.js';
import { type CurveDef, type Frame, frameOf, type SurfaceDef } from './geometry.js';
import { enclosedVolume } from './mass.js';
import { Body, Edge, Face, type Shell, Vertex } from './topology.js';
import { measureTolerances, validateBody } from './validate.js';

/** The bodies of `step`, one per STEP body (undefined for a tessellated or faceted-only one, or a failed one). */
export interface ImportedBodies {
  readonly bodies: readonly (Body | undefined)[];
  /**
   * Why a body was left out, or what is wrong with one that was imported (validateBody's problems, as
   * `<name>: <problem>`): its index in `step.bodies` and the reason.
   */
  readonly problems: readonly { readonly body: number; readonly problem: string }[];
}

const isTrue = (v: STEPValue | undefined) => !(v instanceof Enum && v.name === 'F');

/** A shell's box from its vertices: [min x, min y, min z, max x, max y, max z]. */
function shellBox(shell: Shell): number[] {
  const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const f of shell.faces)
    for (const l of f.loops)
      for (const c of l.coedges)
        for (let k = 0; k < 3; k++) {
          box[k] = Math.min(box[k], c.start.point[k]);
          box[k + 3] = Math.max(box[k + 3], c.start.point[k]);
        }
  return box;
}

/** Points where a surface collapses: a sphere's two poles, a cone's apex. */
function polesOf(s: SurfaceDef): XYZ[] {
  if (s.kind === 'sphere') return [1, -1].map((k) => add(s.frame.origin, scale(s.frame.z, k * s.radius)));
  if (s.kind === 'cone' && Math.abs(Math.tan(s.angle)) > 1e-12)
    return [add(s.frame.origin, scale(s.frame.z, -s.radius / Math.tan(s.angle)))];
  return [];
}

/**
 * Modeler bodies from a parsed STEP file's solids and sheets (`parseSTEP`, or a JT part's `brep`), in metres, with
 * names from their entity ids (`<body>/face:#<id>` and so on). Each body lines up with `step.bodies`; a body using a
 * surface or curve the modeler does not have is undefined, with the reason in `problems`. Every imported body is
 * validated (validateBody), and what is wrong with it is in `problems` too; checkBody checks it fully.
 */
export function bodiesFromSTEP(step: STEPModel): ImportedBodies {
  const problems: { body: number; problem: string }[] = [];
  const bodies = step.bodies.map((b, index) => {
    if (b.kind !== 'solid' && b.kind !== 'shell') return undefined;
    try {
      const body = new Importer(step.file, b.unit, b.angleUnit).body(
        b.name || `#${b.id}`,
        b.kind,
        b.faces,
        b.reversed ?? [],
      );
      // Edges a writer left a little off their faces keep that gap as their tolerance (up to 10 micrometres, or 1e-4 of
      // the body's size when larger).
      const points = body.vertices.map((v) => v.point),
        size = points.length
          ? Math.hypot(
              ...[0, 1, 2].map((k) => Math.max(...points.map((p) => p[k])) - Math.min(...points.map((p) => p[k]))),
            )
          : 0;
      measureTolerances(body, Math.max(1e-5, 1e-4 * size));
      for (const p of validateBody(body)) problems.push({ body: index, problem: `${p.name}: ${p.problem}` });
      return body;
    } catch (e) {
      problems.push({ body: index, problem: e instanceof Error ? e.message : String(e) });
      return undefined;
    }
  });
  return { bodies, problems };
}

class Importer {
  private readonly vertices = new Map<number, Vertex>();
  private readonly edges = new Map<number, Edge>();
  private readonly polyEdges = new Map<string, Edge>();
  private name = '';

  constructor(
    private readonly file: STEPFile,
    /** Metres per file unit. */
    private readonly unit: number,
    private readonly angleUnit: number,
  ) {}

  body(name: string, kind: 'solid' | 'shell', faceIds: readonly number[], reversed: readonly number[]): Body {
    this.name = name;
    const body = new Body(name, kind === 'solid' ? 'solid' : 'sheet'),
      flipped = new Set(reversed),
      faces = faceIds.map((id) => this.face(id, flipped.has(id)));
    // One shell per connected set of faces (STEP lists a solid's outer shell and voids, and a sheet's shells, together).
    const parent = new Map<Face, Face>(faces.map((f) => [f, f])),
      root = (f: Face): Face => {
        // Each step skips a level (path halving), so long chains of joined faces stay short.
        while (parent.get(f) !== f) {
          const up = parent.get(parent.get(f)!)!;
          parent.set(f, up);
          f = up;
        }
        return f;
      };
    for (const f of faces)
      for (const l of f.loops)
        for (const c of l.coedges)
          for (const o of c.edge.coedges) if (parent.has(o.loop.face)) parent.set(root(o.loop.face), root(f));
    const groups = new Map<Face, Face[]>();
    for (const f of faces) {
      const r = root(f),
        group = groups.get(r);
      if (group) group.push(f);
      else groups.set(r, [f]);
    }
    const shells = [...groups.values()].map((group) => {
      const shell = body.shell();
      for (const f of group) shell.add(f);
      return shell;
    });
    // In a solid, a shell enclosing negative volume is a void, inside the smallest outer shell whose box holds it.
    if (body.kind === 'solid' && shells.length > 1) {
      const volumes = shells.map((sh) => enclosedVolume(sh.faces)),
        boxes = shells.map(shellBox);
      shells.forEach((sh, i) => {
        if (volumes[i] >= 0) return;
        sh.outer = shells
          .filter((o, j) => volumes[j] > 0 && boxes[j].every((x, k) => (k < 3 ? x <= boxes[i][k] : x >= boxes[i][k])))
          .sort((a, b) => volumes[shells.indexOf(a)] - volumes[shells.indexOf(b)])[0];
      });
    }
    return body;
  }

  // --- geometry, in metres -----------------------------------------------------------------------------------------
  private p(id: number | undefined): XYZ {
    return scale(point(this.file, id), this.unit);
  }
  private frame(id: number | undefined): Frame {
    const f = frame(this.file, id);
    return { ...f, origin: scale(f.origin, this.unit) };
  }
  private fail(id: number, what: string): never {
    throw new RangeError(`${this.name}: #${id} ${this.file.typeName(id)} is not a ${what} the modeler has yet`);
  }

  private curve(id: number): CurveDef {
    const entity = this.file.get(id),
      type = entity.parts ? (entity.parts.has('B_SPLINE_CURVE') ? 'B_SPLINE_CURVE_WITH_KNOTS' : '') : entity.type,
      args = entity.args;
    switch (type) {
      case 'LINE':
        return { kind: 'line', origin: this.p(ref(args[1])), direction: unit(vector(this.file, ref(args[2])))! };
      case 'CIRCLE':
        return { kind: 'circle', frame: this.frame(ref(args[1])), radius: num(args[2]) * this.unit };
      case 'ELLIPSE':
        return {
          kind: 'ellipse',
          frame: this.frame(ref(args[1])),
          a: num(args[2]) * this.unit,
          b: num(args[3]) * this.unit,
        };
      case 'B_SPLINE_CURVE_WITH_KNOTS': {
        const base = entity.parts ? entity.parts.get('B_SPLINE_CURVE') : args.slice(1, 6),
          knotted = entity.parts ? entity.parts.get('B_SPLINE_CURVE_WITH_KNOTS') : args.slice(6, 9),
          rational = entity.parts?.get('RATIONAL_B_SPLINE_CURVE');
        if (!base || !knotted) return this.fail(id, 'B-spline curve (knots implied)');
        const points = list(base[1]).map((v) => this.p(ref(v))),
          closed = base[3] instanceof Enum && base[3].name === 'T';
        return {
          kind: 'spline',
          closed: closed || distance(points[0], points[points.length - 1]) <= 1e-12,
          degrees: [num(base[0])],
          counts: [points.length],
          knots: [list(knotted[1]).map((k) => num(k))],
          multiplicities: [list(knotted[0]).map((m) => num(m))],
          points,
          ...(rational ? { weights: list(rational[0]).map((w) => num(w, 1)) } : {}),
        };
      }
      case 'POLYLINE': {
        const points = list(args[1]).map((v) => this.p(ref(v))),
          n = points.length;
        return {
          kind: 'spline',
          degrees: [1],
          counts: [n],
          knots: [points.map((_, i) => i)],
          multiplicities: [points.map((_, i) => (i === 0 || i === n - 1 ? 2 : 1))],
          points,
        };
      }
      case 'SURFACE_CURVE':
      case 'SEAM_CURVE':
      case 'INTERSECTION_CURVE':
      case 'TRIMMED_CURVE': {
        const inner = ref(args[1]);
        return inner === undefined ? this.fail(id, 'curve') : this.curve(inner);
      }
      default:
        return this.fail(id, 'curve');
    }
  }

  private surface(id: number): SurfaceDef {
    const entity = this.file.get(id),
      type = entity.parts ? (entity.parts.has('B_SPLINE_SURFACE') ? 'B_SPLINE_SURFACE_WITH_KNOTS' : '') : entity.type,
      args = entity.args,
      u = this.unit;
    switch (type) {
      case 'PLANE':
        return { kind: 'plane', frame: this.frame(ref(args[1])) };
      case 'CYLINDRICAL_SURFACE':
        return { kind: 'cylinder', frame: this.frame(ref(args[1])), radius: num(args[2]) * u };
      case 'CONICAL_SURFACE':
        return {
          kind: 'cone',
          frame: this.frame(ref(args[1])),
          radius: num(args[2]) * u,
          angle: num(args[3]) * this.angleUnit,
        };
      case 'SPHERICAL_SURFACE':
        return { kind: 'sphere', frame: this.frame(ref(args[1])), radius: num(args[2]) * u };
      case 'TOROIDAL_SURFACE':
      case 'DEGENERATE_TOROIDAL_SURFACE':
        return { kind: 'torus', frame: this.frame(ref(args[1])), major: num(args[2]) * u, minor: num(args[3]) * u };
      case 'B_SPLINE_SURFACE_WITH_KNOTS':
        return this.spline(id);
      case 'RECTANGULAR_TRIMMED_SURFACE':
        return this.surface(ref(args[1]) ?? -1);
      case 'SURFACE_OF_REVOLUTION':
        return this.revolution(id, ref(args[1]) ?? -1, ref(args[2]));
      case 'SURFACE_OF_LINEAR_EXTRUSION':
        return this.extrusion(id, ref(args[1]) ?? -1, vector(this.file, ref(args[2])));
      case 'OFFSET_SURFACE':
        return this.offset(id, this.surface(ref(args[1]) ?? -1), num(args[2]) * u);
      default:
        return this.fail(id, 'surface');
    }
  }

  private spline(id: number): SurfaceDef {
    const entity = this.file.get(id),
      base = entity.parts ? entity.parts.get('B_SPLINE_SURFACE') : entity.args.slice(1, 8),
      knotted = entity.parts ? entity.parts.get('B_SPLINE_SURFACE_WITH_KNOTS') : entity.args.slice(8, 13),
      rational = entity.parts?.get('RATIONAL_B_SPLINE_SURFACE');
    if (!base || !knotted) return this.fail(id, 'B-spline surface (knots implied)');
    // STEP lists rows of v for each u; the modeler's net runs u fastest.
    const rows = list(base[2]).map((row) => list(row).map((v) => this.p(ref(v)))),
      wrows = rational ? list(rational[0]).map((row) => list(row).map((w) => num(w, 1))) : undefined,
      nu = rows.length,
      nv = rows[0]?.length ?? 0,
      points: XYZ[] = [],
      weights: number[] = [];
    for (let j = 0; j < nv; j++)
      for (let i = 0; i < nu; i++) {
        points.push(rows[i][j]);
        if (wrows) weights.push(wrows[i][j]);
      }
    const flag = (v: STEPValue | undefined) => v instanceof Enum && v.name === 'T';
    return {
      kind: 'spline',
      uClosed: flag(base[4]) || rows[0].every((c, j) => distance(c, rows[nu - 1][j]) <= 1e-12),
      vClosed: flag(base[5]) || rows.every((row) => distance(row[0], row[nv - 1]) <= 1e-12),
      degrees: [num(base[0]), num(base[1])],
      counts: [nu, nv],
      knots: [list(knotted[2]).map((k) => num(k)), list(knotted[3]).map((k) => num(k))],
      multiplicities: [list(knotted[0]).map((m) => num(m)), list(knotted[1]).map((m) => num(m))],
      points,
      ...(wrows ? { weights } : {}),
    };
  }

  /** A line or circle swept round an axis, as the plane, cylinder, cone, sphere or torus it makes. */
  private revolution(id: number, curveId: number, axisId: number | undefined): SurfaceDef {
    if (axisId === undefined || !this.file.is(axisId, 'AXIS1_PLACEMENT')) return this.fail(id, 'surface');
    const [, location, dir] = this.file.args(axisId, 'AXIS1_PLACEMENT'),
      o = this.p(ref(location)),
      z = ref(dir) !== undefined ? direction(this.file, ref(dir)) : ([0, 0, 1] as XYZ),
      c = this.curve(curveId),
      tiny = 1e-9 * Math.max(1, length(o)),
      // Where a point sits: its height along the axis and its distance from it.
      polar = (p: XYZ): [number, number] => {
        const d = sub(p, o),
          h = dot(d, z);
        return [h, length(sub(d, scale(z, h)))];
      };
    if (c.kind === 'line') {
      const along = dot(c.direction, z),
        // A point of the line off the axis to measure from (the origin, or one a unit along when that is on it).
        far = polar(c.origin)[1] > tiny ? c.origin : add(c.origin, c.direction),
        [h, r] = polar(far),
        radial = sub(sub(far, o), scale(z, h));
      if (Math.abs(along) < 1e-12) return { kind: 'plane', frame: frameOf(add(o, scale(z, h)), z) };
      if (r <= tiny) return this.fail(id, 'surface (a line along its own axis)');
      const towards = unit(radial)!;
      // Coplanar with the axis (else it sweeps a hyperboloid).
      if (Math.abs(dot(cross(towards, c.direction), z)) > 1e-9)
        return this.fail(id, 'surface (a line swept round a skew axis)');
      const lean = dot(c.direction, towards) / along;
      if (Math.abs(lean) < 1e-12) return { kind: 'cylinder', frame: frameOf(o, z, towards), radius: r };
      // Radius r at height h, growing by `lean` per unit along the axis.
      return { kind: 'cone', frame: frameOf(add(o, scale(z, h)), z, towards), radius: r, angle: Math.atan(lean) };
    }
    if (c.kind === 'circle') {
      const f = c.frame,
        [hc, rc] = polar(f.origin),
        radial = rc > tiny ? unit(sub(sub(f.origin, o), scale(z, hc))) : undefined;
      // The circle's plane must hold the axis: its normal square to the axis and to the way out to its centre.
      if (Math.abs(dot(f.z, z)) > 1e-9 || (radial && Math.abs(dot(f.z, radial)) > 1e-9))
        return this.fail(id, 'surface (a circle swept round an axis outside its plane)');
      const centre = add(o, scale(z, hc));
      if (!radial) return { kind: 'sphere', frame: frameOf(centre, z), radius: c.radius };
      return { kind: 'torus', frame: frameOf(centre, z, radial), major: rc, minor: c.radius };
    }
    return this.fail(id, 'surface (a curve other than a line or circle swept round an axis)');
  }

  /** A line or circle swept along a vector, as the plane or cylinder it makes. */
  private extrusion(id: number, curveId: number, v: XYZ): SurfaceDef {
    const c = this.curve(curveId),
      d = unit(v)!;
    if (c.kind === 'line') {
      const n = unit(cross(c.direction, d));
      return n ? { kind: 'plane', frame: frameOf(c.origin, n, c.direction) } : this.fail(id, 'surface');
    }
    if (c.kind === 'circle' && Math.abs(Math.abs(dot(c.frame.z, d)) - 1) < 1e-9)
      return { kind: 'cylinder', frame: frameOf(c.frame.origin, c.frame.z, c.frame.x), radius: c.radius };
    return this.fail(id, 'surface (a curve other than a line or a circle along its axis, extruded)');
  }

  /** An analytic surface moved `d` along its normal, as the analytic surface it is. */
  private offset(id: number, s: SurfaceDef, d: number): SurfaceDef {
    switch (s.kind) {
      case 'plane':
        return { kind: 'plane', frame: { ...s.frame, origin: add(s.frame.origin, scale(s.frame.z, d)) } };
      case 'cylinder':
      case 'sphere':
        if (s.radius + d > 0) return { ...s, radius: s.radius + d };
        break;
      case 'torus':
        if (s.minor + d > 0) return { ...s, minor: s.minor + d };
        break;
      case 'cone': {
        // Moving along the normal widens it by d / cos(angle) at every height.
        const r = s.radius + d / Math.cos(s.angle);
        if (r > 0) return { ...s, radius: r };
        break;
      }
    }
    return this.fail(id, 'surface (an offset of this surface)');
  }

  // --- topology ---------------------------------------------------------------------------------------------------
  private vertex(id: number | undefined): Vertex {
    if (id === undefined || !this.file.is(id, 'VERTEX_POINT'))
      throw new TypeError(`Invalid STEP file: #${id} is not a vertex point`);
    let v = this.vertices.get(id);
    if (!v) {
      v = new Vertex(`${this.name}/vertex:#${id}`, this.p(ref(this.file.args(id, 'VERTEX_POINT')[1])));
      this.vertices.set(id, v);
    }
    return v;
  }

  private edge(id: number): Edge {
    let e = this.edges.get(id);
    if (!e) {
      const [, start, end, geometry, sameSense] = this.file.args(id, 'EDGE_CURVE'),
        curve = ref(geometry);
      if (curve === undefined) throw new RangeError(`${this.name}: edge #${id} has no curve`);
      e = new Edge(
        `${this.name}/edge:#${id}`,
        this.curve(curve),
        this.vertex(ref(start)),
        this.vertex(ref(end)),
        isTrue(sameSense),
      );
      this.edges.set(id, e);
    }
    return e;
  }

  /** A straight edge of a poly loop between two point entities, shared by the faces either side. */
  private polyEdge(a: number, b: number): { edge: Edge; forward: boolean } {
    // Made once, from the lower point id to the higher; a loop runs it forward when it goes that way.
    const lo = Math.min(a, b),
      hi = Math.max(a, b),
      key = `${lo},${hi}`;
    let e = this.polyEdges.get(key);
    if (!e) {
      const pl = this.p(lo),
        ph = this.p(hi);
      e = new Edge(
        `${this.name}/edge:#${lo}-#${hi}`,
        { kind: 'line', origin: pl, direction: unit(sub(ph, pl))! },
        this.pointVertex(lo, pl),
        this.pointVertex(hi, ph),
      );
      this.polyEdges.set(key, e);
    }
    return { edge: e, forward: a === lo };
  }
  private pointVertex(id: number, p: XYZ): Vertex {
    let v = this.vertices.get(-id);
    if (!v) this.vertices.set(-id, (v = new Vertex(`${this.name}/vertex:#${id}`, p)));
    return v;
  }

  private face(id: number, flipped: boolean): Face {
    const args = this.file.get(id).args,
      geometry = ref(args[2]),
      sameSense = isTrue(args[3]),
      bounds = list(args[1]).map((b) => ref(b) ?? -1),
      surface = geometry !== undefined ? this.surface(geometry) : this.planeOf(id, bounds);
    // A face its shell turns inside out faces the other way, and its loops run the other way with it.
    const face = new Face(`${this.name}/face:#${id}`, surface, sameSense !== flipped);
    for (const b of bounds) {
      const [, loopRef, orientation] = this.file.get(b).args,
        loopId = ref(loopRef) ?? -1,
        type = this.file.typeName(loopId),
        uses: { edge: Edge; forward: boolean }[] = [];
      if (type === 'VERTEX_LOOP') continue; // a pole or apex: the surface itself collapses there
      if (type === 'EDGE_LOOP')
        for (const o of list(this.file.args(loopId, 'EDGE_LOOP')[1])) {
          const [, , , element, sense] = this.file.args(ref(o) ?? -1, 'ORIENTED_EDGE');
          uses.push({ edge: this.edge(ref(element) ?? -1), forward: isTrue(sense) });
        }
      else if (type === 'POLY_LOOP') {
        const pts = list(this.file.get(loopId).args[1]).map((v) => ref(v) ?? -1);
        for (let i = 0; i < pts.length; i++) uses.push(this.polyEdge(pts[i], pts[(i + 1) % pts.length]));
      } else throw new RangeError(`${this.name}: face bound #${b} is a ${type}, not a loop of edges`);
      // Reversed by its orientation or by the face being turned: run it backwards.
      const runs = isTrue(orientation) !== flipped ? uses : uses.reverse().map((x) => ({ ...x, forward: !x.forward })),
        // A seam the loop runs both ways that ends at a pole or apex (a sphere's meridian, a cone's seam to its tip):
        // the modeler leaves it out, as its own spheres have it (a whole sphere has no loop, a hemisphere its equator).
        poles = polesOf(surface),
        atPole = (v: Vertex) => poles.some((p) => distance(p, v.point) <= 1e-9 * Math.max(1, length(p))),
        seam = (e: Edge) => runs.filter((x) => x.edge === e).length === 2 && (atPole(e.start) || atPole(e.end)),
        kept = poles.length ? runs.filter((x) => !seam(x.edge)) : runs;
      // A loop of nothing but seams run both ways (a whole torus's two circles): the face is the whole surface, which
      // the modeler writes as a face with no loop.
      if (!kept.length || kept.every((x) => kept.filter((y) => y.edge === x.edge).length === 2)) continue;
      const loop = face.loop();
      for (const use of kept) loop.use(use.edge, use.forward);
    }
    return face;
  }

  /** A face with no surface (a faceted B-rep's): the plane of its first poly loop. */
  private planeOf(id: number, bounds: readonly number[]): SurfaceDef {
    for (const b of bounds) {
      const loopId = ref(this.file.get(b).args[1]) ?? -1;
      if (this.file.typeName(loopId) !== 'POLY_LOOP') continue;
      const pts = list(this.file.get(loopId).args[1]).map((v) => this.p(ref(v)));
      // Newell's normal of the polygon.
      let n: XYZ = [0, 0, 0];
      for (let i = 0; i < pts.length; i++) n = add(n, cross(pts[i], pts[(i + 1) % pts.length]));
      const z = unit(n);
      if (z) return { kind: 'plane', frame: frameOf(pts[0], z) };
    }
    return this.fail(id, 'face (no surface and no polygon to take a plane from)');
  }
}
