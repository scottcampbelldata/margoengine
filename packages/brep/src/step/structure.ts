// Product structure of a STEP file (AP203, AP214 and AP242 share it): products and their shape representations, the
// assembly tree with each component's placement, the B-rep bodies with their faces and edges, length units and
// colours. Written from the ISO 10303-41/42/43 resource schemas and the application protocols' mapping of assemblies
// (NEXT_ASSEMBLY_USAGE_OCCURRENCE with CONTEXT_DEPENDENT_SHAPE_REPRESENTATION, and MAPPED_ITEM).
import { Enum, Ref, Typed, type STEPFile, type Value } from './file.js';

/** RGBA in 0..1: the colour as the file writes it (display values) and 1 - transparency. */
export type STEPColor = readonly [number, number, number, number];

/** A product definition: a part or an assembly. */
export interface STEPProduct {
  /** The PRODUCT_DEFINITION's entity id. */
  readonly id: number;
  /** The product's name (its id when the name is empty). */
  readonly name: string;
  /** The product's id, usually its part number. */
  readonly partNumber: string;
}

/** One B-rep body (solid or shell model) or tessellated body, wherever and however often it is placed. */
export interface STEPBody {
  /** The body's entity id. */
  readonly id: number;
  /** 'solid' (MANIFOLD_SOLID_BREP, BREP_WITH_VOIDS), 'faceted', 'shell' (SHELL_BASED_SURFACE_MODEL), 'tessellated'. */
  readonly kind: 'solid' | 'faceted' | 'shell' | 'tessellated';
  readonly name: string;
  /** Face entity ids (empty for tessellated bodies). */
  readonly faces: readonly number[];
  /** Number of distinct edges. */
  readonly edges: number;
  /** Metres per unit of the body's coordinates (0.001 for a body modelled in millimetres). */
  readonly unit: number;
  /** The body's style colour, when the file gives one. */
  readonly color?: STEPColor;
}

/** One placed body: which body, which product it belongs to, and where. */
export interface STEPInstance {
  /** Index into `bodies`. */
  readonly body: number;
  /** Index into `products` of the part the body belongs to (-1 for geometry outside any product). */
  readonly product: number;
  /**
   * Column-major 4x4 from the body's coordinates in metres (multiply them by the body's `unit` first) to the model's
   * world, in metres.
   */
  readonly matrix: Float64Array;
  /** Product indices from the root assembly down to `product`. */
  readonly path: readonly number[];
}

/** What `readStructure` finds. */
export interface STEPStructure {
  readonly products: readonly STEPProduct[];
  /** Indices of the products no assembly uses as a component. */
  readonly roots: readonly number[];
  readonly bodies: readonly STEPBody[];
  readonly instances: readonly STEPInstance[];
  /** Face colours that differ from their body's, by face entity id. */
  readonly faceColors: ReadonlyMap<number, STEPColor>;
  /** Surface and edge-curve types of the bodies' faces, with counts (complex types joined with '+'). */
  readonly census: {
    readonly surfaces: Readonly<Record<string, number>>;
    readonly curves: Readonly<Record<string, number>>;
  };
  /** What was skipped and why (for example an assembly link with no placement). */
  readonly warnings: readonly string[];
}

/** Options of {@link readStructure}. */
export interface STEPStructureOptions {
  /** Most placed bodies to list (default 1,000,000); a larger assembly throws a RangeError that names this option. */
  readonly maxInstances?: number;
}

const ref = (v: Value | undefined): number | undefined => (v instanceof Ref ? v.id : undefined);
const refs = (v: Value | undefined): number[] =>
  Array.isArray(v) ? v.flatMap((x) => (x instanceof Ref ? [x.id] : [])) : [];
const str = (v: Value | undefined): string => (typeof v === 'string' ? v : '');
const num = (v: Value | undefined): number | undefined =>
  typeof v === 'number' ? v : v instanceof Typed && typeof v.value === 'number' ? v.value : undefined;

const PREFIX: Readonly<Record<string, number>> = {
  EXA: 1e18,
  PETA: 1e15,
  TERA: 1e12,
  GIGA: 1e9,
  MEGA: 1e6,
  KILO: 1e3,
  HECTO: 1e2,
  DECA: 1e1,
  DECI: 1e-1,
  CENTI: 1e-2,
  MILLI: 1e-3,
  MICRO: 1e-6,
  NANO: 1e-9,
  PICO: 1e-12,
  FEMTO: 1e-15,
  ATTO: 1e-18,
};
const NAMED_COLOURS: Readonly<Record<string, readonly [number, number, number]>> = {
  red: [1, 0, 0],
  green: [0, 1, 0],
  blue: [0, 0, 1],
  yellow: [1, 1, 0],
  magenta: [1, 0, 1],
  cyan: [0, 1, 1],
  black: [0, 0, 0],
  white: [1, 1, 1],
};
const BODIES: Readonly<Record<string, STEPBody['kind']>> = {
  MANIFOLD_SOLID_BREP: 'solid',
  BREP_WITH_VOIDS: 'solid',
  FACETED_BREP: 'faceted',
  SHELL_BASED_SURFACE_MODEL: 'shell',
  TESSELLATED_SOLID: 'tessellated',
  TESSELLATED_SHELL: 'tessellated',
  TRIANGULATED_FACE: 'tessellated',
  COMPLEX_TRIANGULATED_FACE: 'tessellated',
  TRIANGULATED_SURFACE_SET: 'tessellated',
  COMPLEX_TRIANGULATED_SURFACE_SET: 'tessellated',
};

// --- 4x4 column-major affine matrices -------------------------------------------------------------------------------
const identity = (): Float64Array => Float64Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
function multiply(a: Float64Array, b: Float64Array): Float64Array {
  const out = new Float64Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return out;
}
/** Inverse of an affine matrix (general 3x3 part, so a scaled transformation operator inverts correctly). */
function invert(m: Float64Array): Float64Array {
  const [a, b, c, , d, e, f, , g, h, i] = m,
    A = e * i - f * h,
    B = f * g - d * i,
    C = d * h - e * g,
    det = a * A + b * B + c * C;
  if (!det || !Number.isFinite(det)) throw new TypeError('Invalid STEP file: a placement has no inverse (zero axes)');
  const s = 1 / det,
    r = Float64Array.of(
      A * s,
      (c * h - b * i) * s,
      (b * f - c * e) * s,
      0,
      B * s,
      (a * i - c * g) * s,
      (c * d - a * f) * s,
      0,
      C * s,
      (b * g - a * h) * s,
      (a * e - b * d) * s,
      0,
      0,
      0,
      0,
      1,
    );
  for (let k = 0; k < 3; k++) r[12 + k] = -(r[k] * m[12] + r[4 + k] * m[13] + r[8 + k] * m[14]);
  return r;
}
/** Numbers of a list parameter (non-numbers as 0). */
const numbers = (v: Value | undefined): number[] => (Array.isArray(v) ? v.map((x) => num(x) ?? 0) : []);
const normalize = (v: number[]): number[] | undefined => {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 0 && Number.isFinite(l) ? [v[0] / l, v[1] / l, v[2] / l] : undefined;
};

/**
 * Reads a STEP file's products, assembly tree, bodies, units and colours. Geometry is not evaluated: bodies list their
 * faces for the tessellator, and instances say where each body goes.
 */
export function readStructure(file: STEPFile, { maxInstances = 1_000_000 }: STEPStructureOptions = {}): STEPStructure {
  if (!Number.isSafeInteger(maxInstances) || maxInstances < 1)
    throw new RangeError('maxInstances must be a positive integer');
  const warnings: string[] = [];
  const warn = (message: string) => {
    if (warnings.length < 100) warnings.push(message);
  };

  // --- units -------------------------------------------------------------------------------------------------------
  /** Metres (or radians) per unit of `#id`, an SI or conversion-based unit; undefined when it is another quantity. */
  const unitScale = (id: number | undefined, kind: 'METRE' | 'RADIAN', depth = 0): number | undefined => {
    if (id === undefined || depth > 8 || !file.has(id)) return undefined;
    if (file.is(id, 'SI_UNIT')) {
      const args = file.args(id, 'SI_UNIT'),
        [prefix, name] = args.slice(-2);
      if (!(name instanceof Enum) || name.name !== kind) return undefined;
      return prefix instanceof Enum ? PREFIX[prefix.name] : 1;
    }
    if (file.is(id, 'CONVERSION_BASED_UNIT')) {
      const factor = ref(file.args(id, 'CONVERSION_BASED_UNIT')[1]);
      if (factor === undefined || !file.has(factor)) return undefined;
      const entity = file.get(factor),
        args = entity.parts ? (entity.parts.get('MEASURE_WITH_UNIT') ?? []) : entity.args,
        value = num(args[0]),
        base = unitScale(ref(args[1]), kind, depth + 1);
      return value !== undefined && base !== undefined ? value * base : undefined;
    }
    return undefined;
  };
  const contexts = new Map<number, { length: number; angle: number }>();
  /** Length and angle units of a representation context (metres and radians when it assigns none). */
  const context = (id: number | undefined) => {
    if (id === undefined) return { length: 1, angle: 1 };
    let units = contexts.get(id);
    if (!units) {
      units = { length: 1, angle: 1 };
      if (file.has(id) && file.is(id, 'GLOBAL_UNIT_ASSIGNED_CONTEXT')) {
        const assigned = refs(file.args(id, 'GLOBAL_UNIT_ASSIGNED_CONTEXT')[0]);
        for (const unit of assigned) {
          const length = unitScale(unit, 'METRE'),
            angle = unitScale(unit, 'RADIAN');
          if (length !== undefined) units.length = length;
          if (angle !== undefined) units.angle = angle;
        }
      }
      contexts.set(id, units);
    }
    return units;
  };

  // --- representations ---------------------------------------------------------------------------------------------
  /** A representation's [name, items, context]: its own parameters, or the REPRESENTATION part of a complex one. */
  const representation = (id: number): readonly Value[] | undefined => {
    if (!file.has(id)) return undefined;
    const entity = file.get(id);
    if (!entity.parts) return entity.type.endsWith('REPRESENTATION') ? entity.args : undefined;
    for (const name of ['SHAPE_REPRESENTATION', 'REPRESENTATION'])
      if (entity.parts.has(name) && entity.parts.get(name)!.length >= 3) return entity.parts.get(name);
    return undefined;
  };
  const repUnit = (id: number) => context(ref(representation(id)?.[2])).length;

  /** Placement `#id` (AXIS2_PLACEMENT_3D) as a matrix in metres, its location scaled by `unit`. */
  const placement = (id: number | undefined, unit: number): Float64Array => {
    if (id === undefined || !file.has(id)) return identity();
    if (!file.is(id, 'AXIS2_PLACEMENT_3D')) {
      warn(`#${id} (${file.typeName(id)}) used as a placement; treated as identity`);
      return identity();
    }
    const [, location, axis, refDirection] = file.args(id, 'AXIS2_PLACEMENT_3D');
    const at = ref(location),
      point = at !== undefined && file.has(at) ? numbers(file.args(at)[1]) : [];
    const direction = (v: Value | undefined) => {
      const d = ref(v);
      return d === undefined || !file.has(d) ? undefined : normalize(numbers(file.args(d)[1]));
    };
    // ISO 10303-42 build_axes: z from axis (default +Z); x is ref_direction (default +X, or +Y when +X is the axis)
    // made perpendicular to z; y = z x x.
    const z = direction(axis) ?? [0, 0, 1];
    let x = direction(refDirection) ?? (Math.abs(z[0]) > 1 - 1e-9 && !z[1] && !z[2] ? [0, 1, 0] : [1, 0, 0]);
    const along = x[0] * z[0] + x[1] * z[1] + x[2] * z[2];
    x = normalize([x[0] - along * z[0], x[1] - along * z[1], x[2] - along * z[2]]) ?? [1, 0, 0];
    const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
    return Float64Array.of(
      x[0],
      x[1],
      x[2],
      0,
      y[0],
      y[1],
      y[2],
      0,
      z[0],
      z[1],
      z[2],
      0,
      (point[0] ?? 0) * unit,
      (point[1] ?? 0) * unit,
      (point[2] ?? 0) * unit,
      1,
    );
  };

  // Representations linked without a transformation (a part's SHAPE_REPRESENTATION to its B-rep representation).
  const linked = new Map<number, number[]>();
  const link = (a: number, b: number) => {
    linked.set(a, [...(linked.get(a) ?? []), b]);
    linked.set(b, [...(linked.get(b) ?? []), a]);
  };
  for (const type of ['SHAPE_REPRESENTATION_RELATIONSHIP', 'REPRESENTATION_RELATIONSHIP'])
    for (const id of file.ids(type)) {
      const entity = file.get(id);
      if (entity.parts?.has('REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION')) continue;
      const args = entity.parts ? (entity.parts.get('REPRESENTATION_RELATIONSHIP') ?? []) : entity.args,
        a = ref(args[2]),
        b = ref(args[3]);
      if (a !== undefined && b !== undefined) link(a, b);
    }
  /** `reps` and every representation linked to them without a transformation. */
  const closure = (reps: readonly number[]): Set<number> => {
    const seen = new Set<number>(),
      stack = [...reps];
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const next of linked.get(id) ?? []) stack.push(next);
    }
    return seen;
  };

  // --- products ------------------------------------------------------------------------------------------------------
  const products: STEPProduct[] = [],
    productIndex = new Map<number, number>();
  for (const type of ['PRODUCT_DEFINITION', 'PRODUCT_DEFINITION_WITH_ASSOCIATED_DOCUMENTS'])
    for (const id of file.ids(type)) {
      if (productIndex.has(id)) continue;
      const formation = ref(file.args(id, type)[2]);
      const product = formation !== undefined && file.has(formation) ? ref(file.args(formation)[2]) : undefined;
      const [partNumber, name] = product !== undefined && file.has(product) ? file.args(product) : [];
      productIndex.set(id, products.length);
      products.push({ id, name: str(name) || str(partNumber) || `#${id}`, partNumber: str(partNumber) });
    }
  // Product definition shapes: of a product definition (its shape) or of an assembly link (its placement).
  const shapeOf = new Map<number, number>();
  for (const id of file.ids('PRODUCT_DEFINITION_SHAPE')) {
    const definition = ref(file.args(id)[2]);
    if (definition !== undefined) shapeOf.set(id, definition);
  }
  const repsOf = new Map<number, number[]>();
  for (const id of file.ids('SHAPE_DEFINITION_REPRESENTATION')) {
    const [definition, used] = file.args(id),
      owner = shapeOf.get(ref(definition) ?? -1),
      rep = ref(used);
    if (owner !== undefined && rep !== undefined) repsOf.set(owner, [...(repsOf.get(owner) ?? []), rep]);
  }

  // --- assembly links ------------------------------------------------------------------------------------------------
  interface Link {
    readonly id: number;
    readonly parent: number;
    readonly child: number;
  }
  const links: Link[] = [],
    used = new Set<number>();
  for (const id of file.ids('NEXT_ASSEMBLY_USAGE_OCCURRENCE')) {
    const args = file.args(id, 'NEXT_ASSEMBLY_USAGE_OCCURRENCE'),
      parent = ref(args[3]),
      child = ref(args[4]);
    if (parent === undefined || child === undefined || !productIndex.has(parent) || !productIndex.has(child)) {
      warn(`#${id}: assembly link to an unknown product definition; skipped`);
      continue;
    }
    links.push({ id, parent, child });
    used.add(child);
  }
  // Each link's placement: CONTEXT_DEPENDENT_SHAPE_REPRESENTATION -> a representation relationship with a transformation.
  const placements = new Map<number, { rep1: number; rep2: number; operator: number }>();
  for (const id of file.ids('CONTEXT_DEPENDENT_SHAPE_REPRESENTATION')) {
    const [relation, shape] = file.args(id),
      link = shapeOf.get(ref(shape) ?? -1),
      rel = ref(relation);
    if (link === undefined || rel === undefined || !file.has(rel)) continue;
    const entity = file.get(rel),
      base = entity.parts ? entity.parts.get('REPRESENTATION_RELATIONSHIP') : entity.args,
      transformed = entity.parts?.get('REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION'),
      rep1 = ref(base?.[2]),
      rep2 = ref(base?.[3]),
      operator = ref(transformed?.[0]);
    if (rep1 !== undefined && rep2 !== undefined && operator !== undefined)
      placements.set(link, { rep1, rep2, operator });
  }
  /** A link's transformation from the child's metres to the parent's metres. */
  const linkMatrix = (link: Link): Float64Array => {
    const p = placements.get(link.id);
    if (!p) {
      warn(`#${link.id}: assembly link without a placement; component placed at its parent's origin`);
      return identity();
    }
    const childReps = closure(repsOf.get(link.child) ?? []),
      childFirst = childReps.has(p.rep1) || !childReps.has(p.rep2);
    if (childFirst && !childReps.has(p.rep1))
      warn(`#${link.id}: its placement names neither representation of the component; assuming the first`);
    const [childRep, parentRep] = childFirst ? [p.rep1, p.rep2] : [p.rep2, p.rep1];
    if (file.is(p.operator, 'ITEM_DEFINED_TRANSFORMATION')) {
      const [, , item1, item2] = file.args(p.operator, 'ITEM_DEFINED_TRANSFORMATION');
      // item 1 lives in relationship representation 1, item 2 in representation 2; the transformation maps the child's
      // placement onto the parent's.
      const [childItem, parentItem] = childFirst ? [item1, item2] : [item2, item1];
      return multiply(
        placement(ref(parentItem), repUnit(parentRep)),
        invert(placement(ref(childItem), repUnit(childRep))),
      );
    }
    if (file.is(p.operator, 'CARTESIAN_TRANSFORMATION_OPERATOR_3D')) {
      const entity = file.get(p.operator),
        args = entity.parts ? (entity.parts.get('CARTESIAN_TRANSFORMATION_OPERATOR') ?? []) : entity.args,
        axis3 = entity.parts ? entity.parts.get('CARTESIAN_TRANSFORMATION_OPERATOR_3D')?.[0] : args[6];
      const direction = (v: Value | undefined, fallback: number[]) => {
        const d = ref(v);
        return (d !== undefined && file.has(d) && normalize(numbers(file.args(d)[1]))) || fallback;
      };
      const x = direction(args[2], [1, 0, 0]),
        y = direction(args[3], [0, 1, 0]),
        z = direction(axis3, [0, 0, 1]),
        origin = ref(args[4]),
        scale = num(args[5]) ?? 1,
        o = origin !== undefined && file.has(origin) ? numbers(file.args(origin)[1]) : [0, 0, 0],
        unit = repUnit(parentRep);
      const m = Float64Array.of(
        x[0] * scale,
        x[1] * scale,
        x[2] * scale,
        0,
        y[0] * scale,
        y[1] * scale,
        y[2] * scale,
        0,
        z[0] * scale,
        z[1] * scale,
        z[2] * scale,
        0,
        (o[0] ?? 0) * unit,
        (o[1] ?? 0) * unit,
        (o[2] ?? 0) * unit,
        1,
      );
      return childFirst ? m : invert(m);
    }
    warn(
      `#${link.id}: placement ${file.typeName(p.operator)} is not supported; component placed at its parent's origin`,
    );
    return identity();
  };

  // --- colours -------------------------------------------------------------------------------------------------------
  /** The first surface colour under a styled item's styles (curve styles skipped), with transparency as alpha. */
  const styleColor = (start: readonly number[]): STEPColor | undefined => {
    let rgb: readonly [number, number, number] | undefined,
      alpha = 1;
    const seen = new Set<number>(),
      stack = [...start];
    while (stack.length && seen.size < 64) {
      const id = stack.pop()!;
      if (seen.has(id) || !file.has(id)) continue;
      seen.add(id);
      const entity = file.get(id);
      if (entity.type === 'CURVE_STYLE') continue;
      if (!rgb && file.is(id, 'COLOUR_RGB')) {
        const [, r, g, b] = file.args(id, 'COLOUR_RGB');
        rgb = [num(r) ?? 0, num(g) ?? 0, num(b) ?? 0];
      } else if (!rgb && entity.type === 'DRAUGHTING_PRE_DEFINED_COLOUR')
        rgb = NAMED_COLOURS[str(entity.args[0]).toLowerCase()];
      else if (entity.type === 'SURFACE_STYLE_TRANSPARENT') alpha = 1 - (num(entity.args[0]) ?? 0);
      else
        for (const v of entity.parts ? [...entity.parts.values()].flat() : entity.args)
          for (const next of v instanceof Ref ? [v.id] : refs(v)) stack.push(next);
    }
    return rgb ? [rgb[0], rgb[1], rgb[2], alpha] : undefined;
  };
  const colors = new Map<number, STEPColor>();
  for (const type of ['STYLED_ITEM', 'OVER_RIDING_STYLED_ITEM'])
    for (const id of file.ids(type)) {
      const [, styles, item] = file.args(id, type),
        target = ref(item),
        color = target !== undefined ? styleColor(refs(styles)) : undefined;
      // An over-riding style wins over a plain one for the same item.
      if (color && target !== undefined && (type === 'OVER_RIDING_STYLED_ITEM' || !colors.has(target)))
        colors.set(target, color);
    }

  // --- bodies --------------------------------------------------------------------------------------------------------
  const bodies: STEPBody[] = [],
    bodyIndex = new Map<number, number>(),
    surfaces: Record<string, number> = {},
    curves: Record<string, number> = {},
    faceColors = new Map<number, STEPColor>(),
    countedEdges = new Set<number>();
  const shellFaces = (shell: number): number[] => {
    if (!file.has(shell)) return [];
    if (file.is(shell, 'ORIENTED_CLOSED_SHELL') || file.is(shell, 'ORIENTED_OPEN_SHELL'))
      return shellFaces(ref(file.get(shell).args[2]) ?? -1);
    return refs(file.get(shell).args[1]);
  };
  const body = (id: number, unit: number): number => {
    const known = bodyIndex.get(id);
    if (known !== undefined) return known;
    const entity = file.get(id),
      kind = BODIES[entity.type] ?? 'tessellated',
      args = entity.args;
    const shells =
      entity.type === 'SHELL_BASED_SURFACE_MODEL'
        ? refs(args[1])
        : entity.type === 'BREP_WITH_VOIDS'
          ? [ref(args[1]) ?? -1, ...refs(args[2])]
          : kind === 'tessellated'
            ? []
            : [ref(args[1]) ?? -1];
    const faces: number[] = [],
      edges = new Set<number>();
    for (const shell of shells)
      for (let face of shellFaces(shell)) {
        if (!file.has(face)) continue;
        if (file.is(face, 'ORIENTED_FACE')) face = ref(file.get(face).args[2]) ?? face;
        faces.push(face);
        const [, bounds, geometry] = file.get(face).args,
          surface = ref(geometry);
        if (surface !== undefined && file.has(surface)) {
          const name = file.typeName(surface);
          surfaces[name] = (surfaces[name] ?? 0) + 1;
        }
        const color = colors.get(face);
        if (color) faceColors.set(face, color);
        for (const bound of refs(bounds)) {
          const loop = file.has(bound) ? ref(file.get(bound).args[1]) : undefined;
          if (loop === undefined || !file.has(loop) || !file.is(loop, 'EDGE_LOOP')) continue;
          for (const oriented of refs(file.args(loop, 'EDGE_LOOP')[1])) {
            const edge = file.has(oriented) ? ref(file.get(oriented).args[3]) : undefined;
            if (edge === undefined || edges.has(edge)) continue;
            edges.add(edge);
            const curve = file.has(edge) ? ref(file.get(edge).args[3]) : undefined;
            if (curve !== undefined && file.has(curve) && !countedEdges.has(edge)) {
              countedEdges.add(edge);
              const name = file.typeName(curve);
              curves[name] = (curves[name] ?? 0) + 1;
            }
          }
        }
      }
    const color = colors.get(id) ?? (shells.length ? colors.get(shells[0]) : undefined);
    bodyIndex.set(id, bodies.length);
    bodies.push({ id, kind, name: str(args[0]), faces, edges: edges.size, unit, ...(color ? { color } : {}) });
    return bodies.length - 1;
  };

  // --- flattening --------------------------------------------------------------------------------------------------------
  const instances: STEPInstance[] = [];
  const children = new Map<number, Link[]>();
  for (const link of links) children.set(link.parent, [...(children.get(link.parent) ?? []), link]);
  const emit = (bodyId: number, unit: number, product: number, matrix: Float64Array, path: readonly number[]) => {
    if (instances.length >= maxInstances)
      throw new RangeError(`STEP assembly places more than ${maxInstances} bodies; raise the maxInstances option`);
    instances.push({ body: body(bodyId, unit), product, matrix, path });
  };
  /**
   * Bodies of representation `rep` (and its mapped items) placed by `matrix`. Mapped items of a representation in
   * `placed` (a component an assembly link already places) are skipped: some exporters write both forms.
   */
  const placeRep = (
    rep: number,
    matrix: Float64Array,
    product: number,
    path: readonly number[],
    depth: number,
    placed: ReadonlySet<number> = new Set(),
  ) => {
    const args = representation(rep);
    if (!args || depth > 32) return;
    const unit = repUnit(rep);
    for (const item of refs(args[1])) {
      if (!file.has(item)) continue;
      const type = file.get(item).type;
      if (BODIES[type]) emit(item, unit, product, matrix, path);
      else if (type === 'MAPPED_ITEM') {
        const [, source, target] = file.args(item),
          map = ref(source);
        if (map === undefined || !file.has(map)) continue;
        const [origin, mapped] = file.args(map),
          mappedRep = ref(mapped);
        if (mappedRep === undefined || placed.has(mappedRep)) continue;
        const local = multiply(placement(ref(target), unit), invert(placement(ref(origin), repUnit(mappedRep))));
        for (const r of closure([mappedRep])) placeRep(r, multiply(matrix, local), product, path, depth + 1, placed);
      }
    }
  };
  const visit = (pd: number, matrix: Float64Array, path: readonly number[], depth: number) => {
    const index = productIndex.get(pd)!;
    if (path.includes(index) || depth > 64) {
      warn(`#${pd}: assembly contains itself; stopped there`);
      return;
    }
    const here = [...path, index],
      placed = new Set<number>();
    for (const link of children.get(pd) ?? []) for (const r of closure(repsOf.get(link.child) ?? [])) placed.add(r);
    for (const rep of closure(repsOf.get(pd) ?? []))
      if (!placed.has(rep)) placeRep(rep, matrix, index, here, 0, placed);
    for (const link of children.get(pd) ?? []) visit(link.child, multiply(matrix, linkMatrix(link)), here, depth + 1);
  };
  const roots = products.map((_, i) => i).filter((i) => !used.has(products[i].id));
  for (const root of roots) visit(products[root].id, identity(), [], 0);
  // Geometry no product owns (a file of bare bodies): every body-holding representation nothing else reached.
  if (!products.length)
    for (const type of [
      'ADVANCED_BREP_SHAPE_REPRESENTATION',
      'MANIFOLD_SURFACE_SHAPE_REPRESENTATION',
      'SHAPE_REPRESENTATION',
    ])
      for (const rep of file.ids(type)) placeRep(rep, identity(), -1, [], 0);

  return { products, roots, bodies, instances, faceColors, census: { surfaces, curves }, warnings };
}
