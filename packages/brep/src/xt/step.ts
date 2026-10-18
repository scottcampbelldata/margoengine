// Parasolid XT nodes to STEP, from the XT Format Reference's model description: bodies (solid regions' shells, or every
// face of a sheet or general body), faces with their loops of fins, edges between the vertices of their positive and
// negative fins, and the geometry: plane, cylinder, cone, sphere, torus, B-surface, offset, swept and spun surfaces;
// line, circle, ellipse, B-curve, trimmed and intersection curves (an intersection through its chart points).
// Assemblies become mapped items, so a part placed many times is meshed once. Lengths stay in metres.
import { readXT, type XTFile, type XTNode, type XTValue } from './read.js';
import { StepWriter } from '../step/write.js';
import { STEPFile, stepText } from '../step/file.js';
import { curveOf } from '../geometry/curves.js';
import { surfaceOf } from '../geometry/surfaces.js';

/** What {@link xtToSTEP} produces. */
export interface XTConversion {
  /** An AP214 STEP file in metres: one product, bodies placed as the assembly places them. */
  readonly step: string;
  readonly modeller: string;
  readonly schema: string;
  /** What was left out and why (faces on surfaces the converter lacks, edges with no curve). */
  readonly warnings: readonly string[];
}

type XYZ = readonly number[];
const sub = (a: XYZ, b: XYZ) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: XYZ, s: number) => [a[0] * s, a[1] * s, a[2] * s];

/** Options of {@link xtToSTEP}. */
export interface XTOptions {
  /**
   * Which of the file's top-level parts (its bodies and assemblies, in the file's order, from 0) to convert; all of
   * them when omitted.
   */
  readonly parts?: readonly number[];
}

/** Converts a Parasolid transmit file (text or neutral binary) to STEP for the kernel. */
export function xtToSTEP(input: string | ArrayBuffer | ArrayBufferView, options: XTOptions = {}): XTConversion {
  const xt: XTFile = readXT(input),
    w = new StepWriter(),
    warnings: string[] = [],
    warn = (message: string) => {
      if (warnings.length < 200) warnings.push(message);
    };
  const node = (index: XTValue | undefined): XTNode | undefined =>
    typeof index === 'number' && index > 0 ? xt.nodes.get(index) : undefined;
  const vec = (v: XTValue | undefined): XYZ | undefined =>
    Array.isArray(v) && v.length === 3 ? (v as XYZ) : undefined;
  const num = (v: XTValue | undefined, fallback = 0) => (typeof v === 'number' ? v : fallback);
  const list = (n: XTNode | undefined, field: string): XTValue[] =>
    n && Array.isArray(n.fields[field]) ? (n.fields[field] as XTValue[]) : [];
  /** Follows `field` from `first` along a chain, guarding against loops. */
  const chain = (first: XTNode | undefined, field: string) => {
    const out: XTNode[] = [],
      seen = new Set<number>();
    for (let n = first; n && !seen.has(n.index); n = node(n.fields[field])) {
      seen.add(n.index);
      out.push(n);
    }
    return out;
  };

  // --- colour attributes (SDL/TYSA_COLOUR: three reals) ----------------------------------------------------------
  const colour = (owner: XTNode): number[] | undefined => {
    for (const a of chain(node(owner.fields.attributes_groups), 'next')) {
      if (a.name !== 'ATTRIBUTE') continue;
      const def = node(a.fields.definition),
        id = node(def?.fields.identifier);
      if (id?.fields.string !== 'SDL/TYSA_COLOUR') continue;
      const values = list(node(list(a, 'fields')[0]), 'values').map((v) => num(v, Number.NaN));
      if (values.length >= 3 && values.slice(0, 3).every((v) => v >= 0 && v <= 1)) return values.slice(0, 3);
    }
    return undefined;
  };

  // --- curves ---------------------------------------------------------------------------------------------------
  /** A STEP curve id for a curve node, and whether its natural direction runs with the XT curve's sense. */
  const curves = new Map<number, { id: string; forward: boolean } | null>();
  const nurbsCurve = (n: XTNode | undefined) => {
    if (!n) return undefined;
    const degree = num(n.fields.degree),
      dim = num(n.fields.vertex_dim, 3),
      rational = n.fields.rational === true || dim === 4,
      raw = list(node(n.fields.bspline_vertices), 'vertices').map((v) => num(v)),
      // The knot arrays can carry spare slots past n_knots (V33 files): only the counted knots are the curve's.
      count = num(n.fields.n_knots, Number.POSITIVE_INFINITY),
      knots = list(node(n.fields.knots), 'knots')
        .slice(0, count)
        .map((v) => num(v)),
      multiplicities = list(node(n.fields.knot_mult), 'mult')
        .slice(0, count)
        .map((v) => num(v)),
      points: number[][] = [],
      weights: number[] = [];
    for (let k = 0; k + dim <= raw.length; k += dim) {
      // Rational vertices carry their weight with x, y and z multiplied through by it.
      const wgt = rational ? raw[k + dim - 1] : 1;
      points.push([raw[k] / wgt, raw[k + 1] / wgt, dim > 2 ? raw[k + 2] / wgt : 0]);
      weights.push(wgt);
    }
    return {
      degrees: [degree],
      counts: [points.length],
      knots: [knots],
      multiplicities: [multiplicities],
      points,
      ...(rational ? { weights } : {}),
    };
  };
  const curve = (n: XTNode | undefined): { id: string; forward: boolean } | null => {
    if (!n) return null;
    if (curves.has(n.index)) return curves.get(n.index)!;
    const f = n.fields,
      forward = f.sense !== '-';
    let result: { id: string; forward: boolean } | null = null;
    switch (n.name) {
      case 'LINE': {
        const along = w.add(`VECTOR('',${w.direction(vec(f.direction) ?? [1, 0, 0])},1.)`);
        result = { id: w.add(`LINE('',${w.point(vec(f.pvec) ?? [0, 0, 0])},${along})`), forward };
        break;
      }
      case 'CIRCLE':
        result = {
          id: w.add(`CIRCLE('',${w.axis(vec(f.centre)!, vec(f.normal)!, vec(f.x_axis)!)},${w.real(num(f.radius))})`),
          forward,
        };
        break;
      case 'ELLIPSE':
        result = {
          id: w.add(
            `ELLIPSE('',${w.axis(vec(f.centre)!, vec(f.normal)!, vec(f.x_axis)!)},${w.real(num(f.major_radius))},${w.real(num(f.minor_radius))})`,
          ),
          forward,
        };
        break;
      case 'B_CURVE': {
        const s = nurbsCurve(node(f.nurbs));
        if (s && s.points.length > s.degrees[0]) result = { id: w.spline(s), forward };
        break;
      }
      case 'TRIMMED_CURVE': {
        // The trimmed portion runs along the basis curve's own sense.
        const basis = curve(node(f.basis_curve));
        if (basis) result = { id: basis.id, forward: basis.forward === forward };
        break;
      }
      case 'INTERSECTION': {
        // The chart is a chordal approximation of the exact curve; a terminator limit adds its exact end point.
        const chart = list(node(f.chart), 'hvec').flatMap((h) => (vec(h) ? [vec(h)!] : [])),
          limitPoint = (l: XTNode | undefined) => (l && l.fields.type === 'T' ? vec(list(l, 'hvec')[0]) : undefined),
          first = limitPoint(node(f.start)),
          last = limitPoint(node(f.end)),
          points = [...(first ? [first] : []), ...chart, ...(last ? [last] : [])].filter(
            (p, k, a) => k === 0 || Math.hypot(...sub(p, a[k - 1])) > 1e-12,
          );
        if (points.length >= 2) {
          const t = [0];
          for (let k = 1; k < points.length; k++) t.push(t[k - 1] + Math.hypot(...sub(points[k], points[k - 1])));
          result = {
            id: w.spline({
              degrees: [1],
              counts: [points.length],
              knots: [t],
              multiplicities: [t.map((_, k) => (k === 0 || k === t.length - 1 ? 2 : 1))],
              points,
            }),
            forward,
          };
        }
        break;
      }
      default:
        warn(`#${n.index}: ${n.name} curves are not converted yet`);
    }
    curves.set(n.index, result);
    return result;
  };

  // --- surfaces -------------------------------------------------------------------------------------------------
  /**
   * Rolling-ball blends, built once every other entity is written: the reserved surface id, its two supporting
   * surfaces and spine (STEP ids), the ball radius, and the edges of the faces on it (where the spine range comes from).
   */
  const blends = new Map<
    number,
    { id: string; supports: [string, string]; spine: string; radius: number; edges: string[]; node: XTNode }
  >();
  /** A STEP surface id, and whether its natural normal is the XT surface's natural normal reversed. */
  const surfaces = new Map<number, { id: string; flip: boolean } | null>();
  const surface = (n: XTNode | undefined): { id: string; flip: boolean } | null => {
    if (!n) return null;
    if (surfaces.has(n.index)) return surfaces.get(n.index)!;
    const f = n.fields;
    let result: { id: string; flip: boolean } | null = null;
    switch (n.name) {
      case 'PLANE':
        result = { id: w.add(`PLANE('',${w.axis(vec(f.pvec)!, vec(f.normal)!, vec(f.x_axis)!)})`), flip: false };
        break;
      case 'CYLINDER':
        result = {
          id: w.add(
            `CYLINDRICAL_SURFACE('',${w.axis(vec(f.pvec)!, vec(f.axis)!, vec(f.x_axis)!)},${w.real(num(f.radius))})`,
          ),
          flip: false,
        };
        break;
      case 'CONE': {
        // In transmit files the radius grows along the axis (edge circles on cones bear this out), as STEP's does,
        // and both parameterizations turn the same way: the natural normals agree.
        const angle = Math.atan2(Math.abs(num(f.sin_half_angle)), Math.abs(num(f.cos_half_angle, 1)));
        result = {
          id: w.add(
            `CONICAL_SURFACE('',${w.axis(vec(f.pvec)!, vec(f.axis)!, vec(f.x_axis)!)},${w.real(num(f.radius))},${w.real(angle)})`,
          ),
          flip: false,
        };
        break;
      }
      case 'SPHERE':
        result = {
          id: w.add(
            `SPHERICAL_SURFACE('',${w.axis(vec(f.centre)!, vec(f.axis)!, vec(f.x_axis)!)},${w.real(num(f.radius))})`,
          ),
          flip: false,
        };
        break;
      case 'TORUS': {
        const major = num(f.major_radius),
          minor = num(f.minor_radius),
          place = w.axis(vec(f.centre)!, vec(f.axis)!, vec(f.x_axis)!);
        result = {
          id:
            major > minor
              ? w.add(`TOROIDAL_SURFACE('',${place},${w.real(major)},${w.real(minor)})`)
              : w.add(
                  `DEGENERATE_TOROIDAL_SURFACE('',${place},${w.real(Math.abs(major))},${w.real(minor)},${major >= 0 ? '.T.' : '.F.'})`,
                ),
          flip: false,
        };
        break;
      }
      case 'B_SURFACE': {
        const s = node(f.nurbs);
        if (!s) break;
        const ud = num(s.fields.u_degree),
          vd = num(s.fields.v_degree),
          nu = num(s.fields.n_u_vertices),
          nv = num(s.fields.n_v_vertices),
          dim = num(s.fields.vertex_dim, 3),
          rational = s.fields.rational === true || dim === 4,
          raw = list(node(s.fields.bspline_vertices), 'vertices').map((v) => num(v)),
          points: number[][] = [],
          weights: number[] = [];
        if (raw.length < nu * nv * dim) {
          warn(`#${n.index}: B-surface has ${raw.length / dim} of ${nu * nv} vertices`);
          break;
        }
        // Vertices run with v fastest; the writer takes u fastest.
        for (let j = 0; j < nv; j++)
          for (let i = 0; i < nu; i++) {
            const k = (i * nv + j) * dim,
              wgt = rational ? raw[k + dim - 1] : 1;
            points.push([raw[k] / wgt, raw[k + 1] / wgt, raw[k + 2] / wgt]);
            weights.push(wgt);
          }
        result = {
          id: w.spline({
            degrees: [ud, vd],
            counts: [nu, nv],
            // As for curves, only the first n_u_knots / n_v_knots entries count.
            knots: [
              list(node(s.fields.u_knots), 'knots')
                .slice(0, num(s.fields.n_u_knots, Number.POSITIVE_INFINITY))
                .map((v) => num(v)),
              list(node(s.fields.v_knots), 'knots')
                .slice(0, num(s.fields.n_v_knots, Number.POSITIVE_INFINITY))
                .map((v) => num(v)),
            ],
            multiplicities: [
              list(node(s.fields.u_knot_mult), 'mult')
                .slice(0, num(s.fields.n_u_knots, Number.POSITIVE_INFINITY))
                .map((v) => num(v)),
              list(node(s.fields.v_knot_mult), 'mult')
                .slice(0, num(s.fields.n_v_knots, Number.POSITIVE_INFINITY))
                .map((v) => num(v)),
            ],
            points,
            ...(rational ? { weights } : {}),
          }),
          flip: false,
        };
        break;
      }
      case 'OFFSET_SURF': {
        const basisNode = node(f.surface),
          basis = surface(basisNode);
        if (!basis) break;
        // The offset runs along the basis surface's normal as its sense turns it.
        const natural = num(f.offset) * (basisNode?.fields.sense === '-' ? -1 : 1);
        result = {
          id: w.add(`OFFSET_SURFACE('',${basis.id},${w.real(basis.flip ? -natural : natural)},.F.)`),
          flip: basis.flip,
        };
        break;
      }
      case 'SWEPT_SURF': {
        const section = curve(node(f.section));
        if (!section) break;
        const along = w.add(`VECTOR('',${w.direction(vec(f.sweep)!)},1.)`);
        result = { id: w.add(`SURFACE_OF_LINEAR_EXTRUSION('',${section.id},${along})`), flip: false };
        break;
      }
      case 'SPUN_SURF': {
        const profile = curve(node(f.profile));
        if (!profile) break;
        // STEP's surface of revolution takes the angle as u and the profile as v: its normal is the reverse.
        const axis = w.add(`AXIS1_PLACEMENT('',${w.point(vec(f.base)!)},${w.direction(vec(f.axis)!)})`);
        result = { id: w.add(`SURFACE_OF_REVOLUTION('',${profile.id},${axis})`), flip: true };
        break;
      }
      case 'BLENDED_EDGE': {
        // A rolling-ball blend: the ball runs along the spine touching both supporting surfaces. Its surface is built
        // after the rest is written (see resolveBlends); Parasolid's v runs from surface 0 to 1 unless the spine's
        // sense is negative, when the natural normal is the reverse of the one built.
        const [a, b] = list(n, 'surface').map((v) => surface(node(v))),
          spineNode = node(f.spine),
          spine = curve(spineNode),
          radius = Math.abs(num(list(n, 'range')[0]));
        if (f.blend_type !== 'R') warn(`#${n.index}: cliff-edge blends are not converted yet`);
        else if (!a || !b || !spine || !(radius > 0))
          warn(`#${n.index}: rolling-ball blend whose supports or spine could not be converted`);
        else {
          const id = w.reserve();
          blends.set(n.index, { id, supports: [a.id, b.id], spine: spine.id, radius, edges: [], node: n });
          result = { id, flip: spineNode?.fields.sense === '-' };
        }
        break;
      }
      default:
        warn(`#${n.index}: ${n.name} surfaces are not converted yet; their faces are left out`);
    }
    surfaces.set(n.index, result);
    return result;
  };

  // --- topology -------------------------------------------------------------------------------------------------
  const vertices = new Map<number, string>();
  const vertex = (v: XTNode | undefined, fallback: () => XYZ | undefined): string | undefined => {
    if (v) {
      let id = vertices.get(v.index);
      if (!id) {
        const p = vec(node(v.fields.point)?.fields.pvec);
        if (!p) return undefined;
        id = w.add(`VERTEX_POINT('',${w.point(p)})`);
        vertices.set(v.index, id);
      }
      return id;
    }
    const p = fallback();
    return p ? w.add(`VERTEX_POINT('',${w.point(p)})`) : undefined;
  };
  /** A point on a ring edge's curve, where its single vertex goes. */
  const ringPoint = (c: XTNode | undefined): XYZ | undefined => {
    if (!c) return undefined;
    const f = c.fields;
    if (c.name === 'CIRCLE') return vec(f.centre)!.map((v, k) => v + num(f.radius) * vec(f.x_axis)![k]);
    if (c.name === 'ELLIPSE') return vec(f.centre)!.map((v, k) => v + num(f.major_radius) * vec(f.x_axis)![k]);
    if (c.name === 'TRIMMED_CURVE') return vec(f.point_1);
    if (c.name === 'B_CURVE') return nurbsCurve(node(f.nurbs))?.points[0];
    if (c.name === 'INTERSECTION') return vec(list(node(f.chart), 'hvec')[0]);
    return undefined;
  };
  const edges = new Map<number, string | null>();
  const edge = (e: XTNode): string | null => {
    if (edges.has(e.index)) return edges.get(e.index)!;
    let result: string | null = null;
    const positive = node(e.fields.fin),
      negative = node(positive?.fields.other),
      curveNode = node(e.fields.curve),
      c = curve(curveNode);
    if (!c) warn(`#${e.index}: edge with ${curveNode ? curveNode.name : 'no'} curve (a tolerant edge) is left out`);
    else {
      // The positive fin's forward vertex ends the edge, the negative fin's starts it. A ring edge (no vertices)
      // starts and ends at one vertex made on its curve.
      const ring = () => ringPoint(curveNode),
        endNode = node(positive?.fields.vertex),
        startNode = node(negative?.fields.vertex),
        end = endNode || startNode ? vertex(endNode ?? startNode, ring) : vertex(undefined, ring),
        start = startNode ? vertex(startNode, ring) : end;
      if (start && end) result = w.add(`EDGE_CURVE('',${start},${end},${c.id},${c.forward ? '.T.' : '.F.'})`);
    }
    edges.set(e.index, result);
    return result;
  };
  const face = (f: XTNode): string | undefined => {
    const surfaceNode = node(f.fields.surface),
      s = surface(surfaceNode);
    if (!s) return undefined;
    const bounds: string[] = [];
    for (const loop of chain(node(f.fields.loop), 'next')) {
      const oriented: string[] = [];
      for (const fin of chain(node(loop.fields.fin), 'forward')) {
        const e = node(fin.fields.edge);
        if (!e) continue; // an isolated loop (a single vertex)
        const id = edge(e);
        if (id) oriented.push(w.add(`ORIENTED_EDGE('',*,*,${id},${fin.fields.sense === '-' ? '.F.' : '.T.'})`));
      }
      if (oriented.length) bounds.push(w.add(`FACE_BOUND('',${w.add(`EDGE_LOOP('',(${oriented.join(',')}))`)},.T.)`));
    }
    if (surfaceNode?.name === 'BLENDED_EDGE') {
      const blend = blends.get(surfaceNode.index);
      if (blend)
        for (const loop of chain(node(f.fields.loop), 'next'))
          for (const fin of chain(node(loop.fields.fin), 'forward')) {
            const id = edges.get(node(fin.fields.edge)?.index ?? -1);
            if (id) blend.edges.push(id);
          }
    }
    // The face normal follows the surface's natural normal when the face and surface senses agree.
    const along = (f.fields.sense !== '-') === (surfaceNode?.fields.sense !== '-');
    const id = w.add(`ADVANCED_FACE('',(${bounds.join(',')}),${s.id},${along !== s.flip ? '.T.' : '.F.'})`);
    const c = colour(f);
    if (c) w.style(id, c);
    return id;
  };

  const bodies = new Map<number, string | undefined>();
  /** A body as a mappable shape (solids and shell models), or undefined when it has no face. */
  const body = (b: XTNode): string | undefined => {
    if (bodies.has(b.index)) return bodies.get(b.index);
    const solid = num(b.fields.body_type) === 1,
      seen = new Set<number>(),
      items: string[] = [];
    for (const region of chain(node(b.fields.region), 'next')) {
      if (solid && region.fields.type !== 'S') continue;
      const faces: string[] = [];
      for (const shell of chain(node(region.fields.shell), 'next'))
        for (const f of [
          ...chain(node(shell.fields.face), 'next'),
          ...chain(node(shell.fields.front_face), 'next_front'),
        ]) {
          if (seen.has(f.index)) continue;
          seen.add(f.index);
          const id = face(f);
          if (id) faces.push(id);
          else warn(`#${f.index}: face left out`);
        }
      if (!faces.length) continue;
      items.push(
        solid
          ? w.add(`MANIFOLD_SOLID_BREP('',${w.add(`CLOSED_SHELL('',(${faces.join(',')}))`)})`)
          : w.add(`SHELL_BASED_SURFACE_MODEL('',(${w.add(`OPEN_SHELL('',(${faces.join(',')}))`)}))`),
      );
    }
    const c = colour(b);
    if (c) for (const item of items) w.style(item, c);
    const result = items.length ? w.shape(items) : undefined;
    bodies.set(b.index, result);
    return result;
  };

  // --- parts and placements ----------------------------------------------------------------------------------------
  const assemblies = new Map<number, string | undefined>();
  /** A part (body or assembly) as a mappable shape. */
  const part = (p: XTNode | undefined, depth = 0): string | undefined => {
    if (!p || depth > 64) return undefined;
    if (p.name === 'BODY') return body(p);
    if (p.name !== 'ASSEMBLY') return undefined;
    if (assemblies.has(p.index)) return assemblies.get(p.index);
    const items: string[] = [];
    for (const instance of chain(node(p.fields.sub_instance), 'next_in_part')) {
      const shape = part(node(instance.fields.part), depth + 1);
      if (shape) items.push(placed(shape, node(instance.fields.transform)));
    }
    const result = items.length ? w.shape(items) : undefined;
    assemblies.set(p.index, result);
    return result;
  };
  /** A mapped item for a shape under an instance's transform (x' = (R x + t) s; a non-unit scale is dropped). */
  const placed = (shape: string, t: XTNode | undefined): string => {
    if (!t) return w.place(shape, [0, 0, 0], [0, 0, 1], [1, 0, 0]);
    const r = list(t, 'rotation_matrix').map((v) => num(v)),
      s = num(t.fields.scale, 1) || 1,
      move = vec(t.fields.translation_vector) ?? [0, 0, 0];
    if (Math.abs(s - 1) > 1e-12) warn(`#${t.index}: instance scale ${s} is not applied`);
    // The rotation's columns are where the local x and z axes go.
    return w.place(shape, scale(move, s), [r[2], r[5], r[8]], [r[0], r[3], r[6]]);
  };

  const roots: string[] = [];
  const root = xt.root;
  if (!root) throw new TypeError('Invalid Parasolid file: no root node');
  const partsOf = (r: XTNode): XTNode[] =>
    r.name === 'POINTER_LIS_BLOCK'
      ? chain(r, 'next_block').flatMap((block) => list(block, 'entries').flatMap((e) => node(e) ?? []))
      : r.name === 'WORLD'
        ? [...chain(node(r.fields.assembly), 'next'), ...chain(node(r.fields.body), 'next')]
        : [r];
  const keep = options.parts && new Set(options.parts);
  for (const [i, p] of partsOf(root).entries()) {
    if (keep && !keep.has(i)) continue;
    const shape = part(p);
    if (shape) roots.push(placed(shape, undefined));
  }
  // --- rolling-ball blends ---------------------------------------------------------------------------------------
  // With everything else written, the draft file gives the kernel's own evaluators for the supporting surfaces and
  // the spine. Along the spine (over the part its faces use), each ball centre is projected onto both supports; the
  // exact circular arc between the two contacts is a rational quadratic, and the sections join linearly along the
  // spine, sampled finely enough to stay within a small fraction of the radius.
  if (blends.size) {
    const draft = new STEPFile(stepText(w.draft())),
      kernelCurves = new Map<number, ReturnType<typeof curveOf>>(),
      curveFor = (id: number) => {
        let c = kernelCurves.get(id);
        if (!c) kernelCurves.set(id, (c = curveOf(draft, id)));
        return c;
      },
      idOf = (s: string) => Number(s.slice(1)),
      pointOf = (id: number | undefined): XYZ | undefined => {
        if (id === undefined) return undefined;
        const coords = draft.args(id)[1];
        return Array.isArray(coords) ? coords.map((c) => (typeof c === 'number' ? c : 0)) : undefined;
      },
      refId = (v: unknown) => (v && typeof v === 'object' && 'id' in v ? (v as { id: number }).id : undefined);
    for (const blend of blends.values()) {
      try {
        const supports = blend.supports.map((s) => surfaceOf(draft, idOf(s), 1, curveFor)),
          spine = curveFor(idOf(blend.spine)),
          r = blend.radius;
        // The spine's range: from the face corners projected onto it (a ring edge on a closed spine: all of it).
        let ring = false;
        const params: number[] = [];
        for (const e of new Set(blend.edges)) {
          const [, a, b] = draft.args(idOf(e)),
            pa = pointOf(refId(draft.args(refId(a) ?? -1)[1])),
            pb = pointOf(refId(draft.args(refId(b) ?? -1)[1]));
          if (refId(a) === refId(b)) ring = true;
          for (const p of [pa, pb]) if (p) params.push(spine.parameter(p));
        }
        let t0: number, t1: number;
        if (spine.period && (ring || params.length < 2)) {
          t0 = spine.domain[0];
          t1 = spine.domain[0] + spine.period;
        } else if (spine.period) {
          // On a closed spine the face covers the circle less its largest gap between corner parameters.
          const p = [
            ...new Set(params.map((t) => (((t - spine.domain[0]) % spine.period) + spine.period) % spine.period)),
          ].sort((x, y) => x - y);
          let gap = -1,
            at = 0;
          for (let k = 0; k < p.length; k++) {
            const next = k + 1 < p.length ? p[k + 1] : p[0] + spine.period;
            if (next - p[k] > gap) {
              gap = next - p[k];
              at = k;
            }
          }
          t0 = spine.domain[0] + (at + 1 < p.length ? p[at + 1] : p[0]);
          t1 = t0 + spine.period - gap;
        } else {
          if (params.length < 2) throw new TypeError('no corners to place it along its spine');
          t0 = Math.min(...params);
          t1 = Math.max(...params);
          const margin = (t1 - t0) * 0.01;
          t0 = Math.max(spine.domain[0], t0 - margin);
          t1 = Math.min(spine.domain[1], t1 + margin);
        }
        const ts = spine.sample(t0, t1, Math.max(r * 5e-4, 1e-9), 0.08);
        if (ts.length < 2) throw new TypeError('its spine range is empty');
        const rows: number[][][] = [],
          weights: number[][] = [];
        const hints: (readonly number[] | undefined)[] = [undefined, undefined];
        for (const t of ts) {
          const c = spine.at(t).slice(0, 3),
            contacts = supports.map((s, k) => {
              const uv = s.parameters(c, hints[k]);
              hints[k] = uv;
              return s.at(uv[0], uv[1]).slice(0, 3);
            });
          const d0 = sub(contacts[0], c),
            d1 = sub(contacts[1], c),
            l0 = Math.hypot(d0[0], d0[1], d0[2]),
            l1 = Math.hypot(d1[0], d1[1], d1[2]);
          if (Math.abs(l0 - r) > 0.05 * r + 1e-9 || Math.abs(l1 - r) > 0.05 * r + 1e-9)
            throw new TypeError(
              `the ball does not touch its supports (${l0.toPrecision(4)}, ${l1.toPrecision(4)} for radius ${r.toPrecision(4)})`,
            );
          const cos = (d0[0] * d1[0] + d0[1] * d1[1] + d0[2] * d1[2]) / (l0 * l1);
          if (cos < -0.999) throw new TypeError('its arc is a half circle or more');
          // The middle control point of the arc: where the tangents at both contacts meet.
          const middle = [0, 1, 2].map((k) => c[k] + (d0[k] + d1[k]) / (1 + cos));
          rows.push([contacts[0], middle, contacts[1]]);
          weights.push([1, Math.sqrt((1 + cos) / 2), 1]);
        }
        const nu = rows.length,
          points: number[][] = [],
          ws: number[] = [];
        for (let j = 0; j < 3; j++)
          for (let i = 0; i < nu; i++) {
            points.push(rows[i][j]);
            ws.push(weights[i][j]);
          }
        const id = w.spline({
          degrees: [1, 2],
          counts: [nu, 3],
          knots: [ts, [0, 1]],
          multiplicities: [ts.map((_, k) => (k === 0 || k === nu - 1 ? 2 : 1)), [3, 3]],
          points,
          weights: ws,
        });
        w.fill(blend.id, `RECTANGULAR_TRIMMED_SURFACE('',${id},${w.real(ts[0])},${w.real(ts[nu - 1])},0.,1.,.T.,.T.)`);
      } catch (error) {
        warn(
          `#${blend.node.index}: rolling-ball blend not built: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  return {
    step: w.finish(roots, { unit: 'm', source: `Parasolid ${xt.schema}` }),
    modeller: xt.modeller,
    schema: xt.schema,
    warnings,
  };
}
