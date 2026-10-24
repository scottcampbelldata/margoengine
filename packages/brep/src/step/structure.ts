// Product structure of a STEP file (AP203, AP214 and AP242 share it): products and their shape representations, the
// assembly tree with each component's placement, the B-rep bodies with their faces and edges, length units and
// colours. Written from the ISO 10303-41/42/43 resource schemas and the application protocols' mapping of assemblies
// (NEXT_ASSEMBLY_USAGE_OCCURRENCE with CONTEXT_DEPENDENT_SHAPE_REPRESENTATION, and MAPPED_ITEM).
import { Enum, Ref, Typed, type STEPFile, type STEPValue } from './file.js';
import { multiplyMatrices } from '@margoengine/math/mat4';

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
  /** Faces turned inside out by an oriented shell or face around them (a void's shell is reversed). */
  readonly reversed?: readonly number[];
  /** Number of distinct edges. */
  readonly edges: number;
  /** Metres per unit of the body's coordinates (0.001 for a body modelled in millimetres). */
  readonly unit: number;
  /** Radians per plane-angle unit of the body's context (a cone's half angle is written in it). */
  readonly angleUnit: number;
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
  /** Index into `occurrences` of the placed product the body belongs to (-1 for geometry outside any product). */
  readonly occurrence: number;
}

/** One placed product: a root, or a component where an assembly places it (each use is its own occurrence). */
export interface STEPOccurrence {
  /** Index into `products`. */
  readonly product: number;
  /** Index into `occurrences` of the assembly occurrence that places it (-1 for a root). */
  readonly parent: number;
  /** Column-major 4x4 from the product's coordinates in metres to the model's world, in metres. */
  readonly matrix: Float64Array;
}

/** A point or direction in metres. */
export type STEPPoint = readonly [number, number, number];

/**
 * What a file states about its own shape for readers to check against (the CAx-IF recommended practices for geometric
 * and tessellated validation properties): the exporting system's volume, area, centre, bounding box or facet count of a
 * product (its components included) or of particular bodies. Lengths are metres, in the coordinates of the product, or
 * of the bodies' own representation when `bodies` is set. Properties stated separately for one shape are merged.
 */
export interface STEPValidationProperty {
  /** The first PROPERTY_DEFINITION entity that states it. */
  readonly id: number;
  /** The described shape's name: the shape aspect's description, or the product's name. */
  readonly label: string;
  /** Index into `products` of the product the shape belongs to (-1 when the file does not say). */
  readonly product: number;
  /** Indices into `bodies` when particular bodies are described; undefined for the whole product. */
  readonly bodies?: readonly number[];
  /** A tessellated validation property: area, centre and facets of the triangles the file itself carries. */
  readonly tessellated: boolean;
  /** Of the independent surfaces (surface bodies beside the solids) rather than the solids. */
  readonly independent?: boolean;
  /** Volume in cubic metres. */
  readonly volume?: number;
  /** Surface area in square metres. */
  readonly area?: number;
  /** Centre of the volume, or of the surface when `surfaceCentroid` is true. */
  readonly centroid?: STEPPoint;
  /** Whether `centroid` is the centre of the surface (a tessellation, or a point the file names a surface centre). */
  readonly surfaceCentroid?: boolean;
  /** Bounding box `[min, max]`. */
  readonly box?: readonly [STEPPoint, STEPPoint];
  /** Number of facets as the file writes them, degenerate strip joins included. */
  readonly facets?: number;
}

/** What `readStructure` finds. */
export interface STEPStructure {
  readonly products: readonly STEPProduct[];
  /** Indices of the products no assembly uses as a component. */
  readonly roots: readonly number[];
  readonly bodies: readonly STEPBody[];
  readonly instances: readonly STEPInstance[];
  /** Every placed product, an assembly before its components. */
  readonly occurrences: readonly STEPOccurrence[];
  /** The validation properties the file states (empty when it states none). */
  readonly validation: readonly STEPValidationProperty[];
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

const ref = (v: STEPValue | undefined): number | undefined => (v instanceof Ref ? v.id : undefined);
const refs = (v: STEPValue | undefined): number[] =>
  Array.isArray(v) ? v.flatMap((x) => (x instanceof Ref ? [x.id] : [])) : [];
const str = (v: STEPValue | undefined): string => (typeof v === 'string' ? v : '');
const num = (v: STEPValue | undefined): number | undefined =>
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
/** Product of two column-major affine matrices (math's multiplyMatrices). */
export const multiply = (a: Float64Array, b: Float64Array): Float64Array => multiplyMatrices(a, b);
/** Inverse of an affine matrix (general 3x3 part, so a scaled transformation operator inverts correctly). */
export function invert(m: Float64Array): Float64Array {
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
const numbers = (v: STEPValue | undefined): number[] => (Array.isArray(v) ? v.map((x) => num(x) ?? 0) : []);
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
  const representation = (id: number): readonly STEPValue[] | undefined => {
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
    const direction = (v: STEPValue | undefined) => {
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
      let [childItem, parentItem]: STEPValue[] = childFirst ? [item1, item2] : [item2, item1];
      // Exporters disagree on the item order (SolidWorks lists the parent's placement first): the representation that
      // lists an item owns it.
      const lists = (rep: number, item: STEPValue) => refs(file.args(rep)[1]).includes(ref(item) ?? -1);
      if (lists(parentRep, childItem) && lists(childRep, parentItem)) {
        const swapped = childItem;
        childItem = parentItem;
        parentItem = swapped;
      }
      return multiply(
        placement(ref(parentItem), repUnit(parentRep)),
        invert(placement(ref(childItem), repUnit(childRep))),
      );
    }
    if (file.is(p.operator, 'CARTESIAN_TRANSFORMATION_OPERATOR_3D')) {
      const entity = file.get(p.operator),
        args = entity.parts ? (entity.parts.get('CARTESIAN_TRANSFORMATION_OPERATOR') ?? []) : entity.args,
        axis3 = entity.parts ? entity.parts.get('CARTESIAN_TRANSFORMATION_OPERATOR_3D')?.[0] : args[6];
      const direction = (v: STEPValue | undefined, fallback: number[]) => {
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
  const isFalse = (v: STEPValue | undefined) => v instanceof Enum && v.name === 'F';
  /** A shell's faces, each with whether an oriented shell or face around it reverses it (a void's shell does). */
  const shellFaces = (shell: number, flip = false): [number, boolean][] => {
    if (!file.has(shell)) return [];
    if (file.is(shell, 'ORIENTED_CLOSED_SHELL') || file.is(shell, 'ORIENTED_OPEN_SHELL')) {
      const args = file.get(shell).args;
      return shellFaces(ref(args[2]) ?? -1, flip !== isFalse(args[3]));
    }
    return refs(file.get(shell).args[1]).map((face) => {
      if (!file.has(face) || !file.is(face, 'ORIENTED_FACE')) return [face, flip];
      const args = file.get(face).args;
      return [ref(args[2]) ?? face, flip !== isFalse(args[3])];
    });
  };
  const body = (id: number, unit: number, angleUnit: number): number => {
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
      reversed: number[] = [],
      edges = new Set<number>();
    for (const shell of shells)
      for (const [face, flip] of shellFaces(shell)) {
        if (!file.has(face)) continue;
        faces.push(face);
        if (flip) reversed.push(face);
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
    // A tessellated body's styled items are its triangulated faces.
    if (kind === 'tessellated')
      for (const item of entity.type === 'TESSELLATED_SOLID' || entity.type === 'TESSELLATED_SHELL'
        ? refs(args[1])
        : [id]) {
        const color = colors.get(item);
        if (color) faceColors.set(item, color);
      }
    const color = colors.get(id) ?? (shells.length ? colors.get(shells[0]) : undefined);
    bodyIndex.set(id, bodies.length);
    bodies.push({
      id,
      kind,
      name: str(args[0]),
      faces,
      ...(reversed.length ? { reversed } : {}),
      edges: edges.size,
      unit,
      angleUnit,
      ...(color ? { color } : {}),
    });
    return bodies.length - 1;
  };

  // --- flattening --------------------------------------------------------------------------------------------------------
  const instances: STEPInstance[] = [],
    occurrences: STEPOccurrence[] = [];
  const children = new Map<number, Link[]>();
  for (const link of links) children.set(link.parent, [...(children.get(link.parent) ?? []), link]);
  const emit = (
    bodyId: number,
    units: { length: number; angle: number },
    product: number,
    occurrence: number,
    matrix: Float64Array,
    path: readonly number[],
  ) => {
    if (instances.length >= maxInstances)
      throw new RangeError(`STEP assembly places more than ${maxInstances} bodies; raise the maxInstances option`);
    instances.push({ body: body(bodyId, units.length, units.angle), product, matrix, path, occurrence });
  };
  /**
   * Bodies of representation `rep` (and its mapped items) placed by `matrix`. Mapped items of a representation in
   * `placed` (a component an assembly link already places) are skipped: some exporters write both forms.
   */
  const placeRep = (
    rep: number,
    matrix: Float64Array,
    product: number,
    occurrence: number,
    path: readonly number[],
    depth: number,
    placed: ReadonlySet<number> = new Set(),
  ) => {
    const args = representation(rep);
    if (!args || depth > 32) return;
    const units = context(ref(args[2])),
      unit = units.length;
    for (const item of refs(args[1])) {
      if (!file.has(item)) continue;
      const type = file.get(item).type;
      if (BODIES[type]) emit(item, units, product, occurrence, matrix, path);
      else if (type === 'MAPPED_ITEM') {
        const [, source, target] = file.args(item),
          map = ref(source);
        if (map === undefined || !file.has(map)) continue;
        const [origin, mapped] = file.args(map),
          mappedRep = ref(mapped);
        if (mappedRep === undefined || placed.has(mappedRep)) continue;
        const local = multiply(placement(ref(target), unit), invert(placement(ref(origin), repUnit(mappedRep))));
        for (const r of closure([mappedRep]))
          placeRep(r, multiply(matrix, local), product, occurrence, path, depth + 1, placed);
      }
    }
  };
  /** Placements (component metres to parent metres) of the mapped items in `reps` that map one of `targets`. */
  const mappedPlacements = (reps: ReadonlySet<number>, targets: ReadonlySet<number>): Float64Array[] => {
    const out: Float64Array[] = [];
    for (const rep of reps) {
      const args = representation(rep);
      if (!args) continue;
      const unit = context(ref(args[2])).length;
      for (const item of refs(args[1])) {
        if (!file.has(item) || file.get(item).type !== 'MAPPED_ITEM') continue;
        const [, source, target] = file.args(item),
          map = ref(source);
        if (map === undefined || !file.has(map)) continue;
        const [origin, mappedRep] = file.args(map),
          to = ref(mappedRep);
        if (to === undefined || !targets.has(to)) continue;
        out.push(multiply(placement(ref(target), unit), invert(placement(ref(origin), repUnit(to)))));
      }
    }
    return out;
  };
  const visit = (pd: number, matrix: Float64Array, path: readonly number[], depth: number, parent: number) => {
    const index = productIndex.get(pd)!;
    if (path.includes(index) || depth > 64) {
      warn(`#${pd}: assembly contains itself; stopped there`);
      return;
    }
    const here = [...path, index],
      placed = new Set<number>(),
      occurrence = occurrences.push({ product: index, parent, matrix }) - 1,
      own = closure(repsOf.get(pd) ?? []);
    // A link with no placement of its own (older files, ST-Developer 1995) is placed by the parent's mapped items of
    // the component's shape: one instance per mapped item, in place of the link.
    const mapped = new Map<number, Float64Array[]>();
    for (const link of children.get(pd) ?? []) {
      const childReps = closure(repsOf.get(link.child) ?? []);
      if (!placements.has(link.id) && !mapped.has(link.child)) {
        const found = mappedPlacements(own, childReps);
        if (found.length) mapped.set(link.child, found);
      }
      for (const r of childReps) placed.add(r);
    }
    for (const rep of own) if (!placed.has(rep)) placeRep(rep, matrix, index, occurrence, here, 0, placed);
    const visited = new Set<number>();
    for (const link of children.get(pd) ?? []) {
      const maps = mapped.get(link.child);
      if (!maps) visit(link.child, multiply(matrix, linkMatrix(link)), here, depth + 1, occurrence);
      else if (!visited.has(link.child)) {
        visited.add(link.child);
        for (const local of maps) visit(link.child, multiply(matrix, local), here, depth + 1, occurrence);
      }
    }
  };
  const roots = products.map((_, i) => i).filter((i) => !used.has(products[i].id));
  for (const root of roots) visit(products[root].id, identity(), [], 0, -1);
  // Geometry no product owns (a file of bare bodies): every body-holding representation nothing else reached.
  if (!products.length)
    for (const type of [
      'ADVANCED_BREP_SHAPE_REPRESENTATION',
      'MANIFOLD_SURFACE_SHAPE_REPRESENTATION',
      'SHAPE_REPRESENTATION',
    ])
      for (const rep of file.ids(type)) placeRep(rep, identity(), -1, -1, [], 0);

  // --- validation properties -----------------------------------------------------------------------------------------
  /** Metres to the measure's power per unit `#id`: a derived unit of lengths, or a length unit to `power`. */
  const measureScale = (id: number | undefined, power: number, length: number): number => {
    if (id !== undefined && file.has(id)) {
      const entity = file.get(id),
        derived = entity.parts
          ? entity.parts.get('DERIVED_UNIT')
          : entity.type === 'DERIVED_UNIT'
            ? entity.args
            : undefined;
      if (derived) {
        let scale = 1;
        for (const element of refs(derived[0])) {
          const [unit, exponent] = file.has(element) ? file.args(element) : [],
            base = unitScale(ref(unit), 'METRE');
          if (base === undefined || typeof exponent !== 'number') return length ** power;
          scale *= base ** exponent;
        }
        return scale;
      }
      const base = unitScale(id, 'METRE');
      if (base !== undefined) return base ** power;
    }
    return length ** power;
  };
  // What a shape aspect identifies: GEOMETRIC_ITEM_SPECIFIC_USAGE items, or the representation a property of the
  // aspect is shaped by (SHAPE_DEFINITION_REPRESENTATION).
  const aspectItems = new Map<number, number[]>(),
    identify = (aspect: number | undefined, items: readonly number[]) => {
      if (aspect !== undefined) aspectItems.set(aspect, [...(aspectItems.get(aspect) ?? []), ...items]);
    };
  for (const id of file.ids('GEOMETRIC_ITEM_SPECIFIC_USAGE')) {
    const args = file.args(id, 'GEOMETRIC_ITEM_SPECIFIC_USAGE'),
      item = args[4];
    identify(ref(args[2]), item instanceof Ref ? [item.id] : refs(item));
  }
  const propertyReps = new Map<number, number[]>();
  for (const id of file.ids('PROPERTY_DEFINITION_REPRESENTATION')) {
    const [definition, used] = file.args(id, 'PROPERTY_DEFINITION_REPRESENTATION'),
      d = ref(definition),
      r = ref(used);
    if (d !== undefined && r !== undefined) propertyReps.set(d, [...(propertyReps.get(d) ?? []), r]);
  }
  for (const id of file.ids('SHAPE_DEFINITION_REPRESENTATION')) {
    const [definition, used] = file.args(id),
      d = ref(definition);
    if (d === undefined || !file.has(d) || !file.is(d, 'PROPERTY_DEFINITION')) continue;
    const aspect = ref(file.args(d, 'PROPERTY_DEFINITION')[2]);
    if (aspect !== undefined && file.has(aspect) && file.is(aspect, 'SHAPE_ASPECT'))
      identify(aspect, refs(representation(ref(used) ?? -1)?.[1]));
  }
  /** A measure item's name, value and unit: MEASURE_REPRESENTATION_ITEM, or a complex instance with MEASURE_WITH_UNIT. */
  const measure = (id: number) => {
    const entity = file.get(id);
    if (entity.parts) {
      const m = entity.parts.get('MEASURE_WITH_UNIT');
      return m ? { name: str(entity.parts.get('REPRESENTATION_ITEM')?.[0]), value: m[0], unit: ref(m[1]) } : undefined;
    }
    return entity.type === 'MEASURE_REPRESENTATION_ITEM'
      ? { name: str(entity.args[0]), value: entity.args[1], unit: ref(entity.args[2]) }
      : undefined;
  };
  type Stated = { -readonly [K in keyof STEPValidationProperty]: STEPValidationProperty[K] };
  const stated = new Map<string, Stated>();
  for (const id of file.ids('PROPERTY_DEFINITION')) {
    const [name, description, definition] = file.args(id, 'PROPERTY_DEFINITION'),
      tag = `${str(name)} ${str(description)}`.toLowerCase(),
      tessellated = tag.includes('tessellated validation property'),
      target = ref(definition);
    if ((!tessellated && !tag.includes('geometric validation property')) || target === undefined || !file.has(target))
      continue;
    let product: number, bodyList: number[] | undefined, label: string;
    if (file.is(target, 'SHAPE_ASPECT')) {
      const [aspectName, aspectDescription, ofShape] = file.args(target, 'SHAPE_ASPECT');
      product = productIndex.get(shapeOf.get(ref(ofShape) ?? -1) ?? -1) ?? -1;
      bodyList = [...new Set((aspectItems.get(target) ?? []).flatMap((item) => bodyIndex.get(item) ?? []))].sort(
        (a, b) => a - b,
      );
      label = str(aspectDescription).trim() || str(aspectName).trim() || `#${target}`;
      // An aspect that names no body we place (a curve, a point set, a face) is not checked here.
      if (!bodyList.length) continue;
    } else {
      product = productIndex.get(shapeOf.get(target) ?? -1) ?? -1;
      label = product >= 0 ? products[product].name : `#${target}`;
    }
    /** The merged record for this shape: of its solids, or of its independent surfaces. */
    const record = (independent: boolean): Stated => {
      const key = `${product}|${bodyList?.join(',') ?? '*'}|${tessellated}|${independent}`;
      let into = stated.get(key);
      if (!into) {
        into = { id, label, product, tessellated, ...(bodyList ? { bodies: bodyList } : {}) };
        if (independent) into.independent = true;
        stated.set(key, into);
      }
      return into;
    };
    for (const r of propertyReps.get(id) ?? []) {
      const args = representation(r);
      if (!args) continue;
      const length = context(ref(args[2])).length,
        corners = new Map<Stated, number[][]>();
      for (const item of refs(args[1])) {
        if (!file.has(item)) continue;
        const entity = file.get(item),
          m = measure(item),
          // Independent points and curves (outside any solid or surface) are not meshed; independent surfaces are
          // checked against the shell bodies on their own.
          text = `${m ? m.name : str(entity.args[0])} ${str(args[0])}`;
        if (/independent\s+(point|curve)|curve length/i.test(text)) continue;
        const into = record(/independent/i.test(text));
        if (m && m.value instanceof Typed && typeof m.value.value === 'number') {
          if (m.value.type === 'VOLUME_MEASURE') into.volume ??= m.value.value * measureScale(m.unit, 3, length);
          else if (m.value.type === 'AREA_MEASURE') into.area ??= m.value.value * measureScale(m.unit, 2, length);
        } else if (entity.type === 'CARTESIAN_POINT') {
          const [pointName, coordinates] = entity.args,
            p = numbers(coordinates).map((c) => c * length);
          if (p.length !== 3) continue;
          if (/bounding box/i.test(text)) corners.set(into, [...(corners.get(into) ?? []), p]);
          else if (!into.centroid) {
            into.centroid = [p[0], p[1], p[2]];
            if (tessellated || /surface/i.test(str(pointName))) into.surfaceCentroid = true;
          }
        } else if (/facet/i.test(str(entity.args[0]))) {
          const count = num(entity.args[1]);
          if (count !== undefined) into.facets ??= count;
        }
      }
      for (const [into, [a, b, ...rest]] of corners)
        if (b && !rest.length && !into.box)
          into.box = [
            [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])],
            [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])],
          ];
    }
  }
  // Zero volume or area is an exporter's placeholder, not a measurement; so is the origin stated beside it.
  for (const v of stated.values())
    if (v.volume === 0 || v.area === 0) {
      if (v.volume === 0) delete v.volume;
      if (v.area === 0) delete v.area;
      if (v.centroid && v.centroid.every((c) => c === 0)) delete v.centroid;
    }
  const validation = [...stated.values()].filter(
    (v) => v.volume !== undefined || v.area !== undefined || v.centroid || v.box || v.facets !== undefined,
  );

  return {
    products,
    roots,
    bodies,
    instances,
    occurrences,
    validation,
    faceColors,
    census: { surfaces, curves },
    warnings,
  };
}
