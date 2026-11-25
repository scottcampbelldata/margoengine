// Finding and classifying elements of readIFCData's result: by IFC class, predefined type, type object, storey or
// any spatial ancestor (classes match their subtypes by the schema's inheritance), name, GlobalId, material, classification and property conditions. Pure functions over plain
// data, so they run on the page or in a worker. Predefined types follow the IDS 1.0 entity facet: the type object's
// PredefinedType wins, USERDEFINED resolves to ElementType (types) or ObjectType (occurrences).
import {
  classificationsOf,
  materialsOf,
  propertiesOf,
  type IFCData,
  type IFCElement,
  type IFCProperty,
  type IFCValue,
} from './data.js';
import { isSubtypeOf } from './schema.js';
import { nearlyEqual } from './tolerance.js';

export { nearlyEqual } from './tolerance.js';

export { isSubtypeOf, subtypesOf, supertypesOf, type IFCSchemaSource } from './schema.js';

/** A condition on one property or quantity (type properties included). Values compare in SI. */
export interface IFCPropertyCondition {
  /** Property set or quantity set name; any set when omitted. */
  set?: string | RegExp;
  name: string | RegExp;
  /** Default `exists` without a value, `=` with one. */
  op?: '=' | '!=' | '<' | '<=' | '>' | '>=' | 'contains' | 'matches' | 'exists' | 'missing';
  value?: IFCValue | RegExp;
}
/** What findElements matches; every given field must hold. Names and classes compare without case. */
export interface IFCQuery {
  /**
   * IFC class names, such as `IfcWall` or `IFCWALL`. Subtypes match too, by the model's schema (`IfcWall` finds
   * `IfcWallStandardCase`, `IfcBuildingElement` finds every wall, slab and door), unless `subtypes` is false. IFC2X3
   * models follow the inheritance readIFCData recorded from the runtime (`IFCData.inheritance`).
   */
  type?: string | readonly string[];
  /** Match subtypes of `type` (default true); false matches the exact classes only, as an IDS entity facet does. */
  subtypes?: boolean;
  /** Effective predefined type (see effectivePredefinedType). */
  predefinedType?: string | readonly string[];
  /** The assigned IfcTypeObject, by expressID or name. */
  typeObject?: number | string;
  /** The element's storey, by expressID or name. */
  storey?: number | string | readonly (number | string)[];
  /** Any ancestor up the containment and aggregation chain (a building, a space, an assembly), by expressID. */
  within?: number;
  name?: string | RegExp;
  globalId?: string | readonly string[];
  /** A material, layer, profile or constituent name or category. */
  material?: string | RegExp;
  classification?: { system?: string | RegExp; code?: string | RegExp };
  where?: readonly IFCPropertyCondition[];
  /** Leave out type objects (default true): they are definitions, not placed elements. */
  occurrencesOnly?: boolean;
  filter?: (element: IFCElement, data: IFCData) => boolean;
}
/** A grouping key of groupElements, or a property whose value is the key. */
export type IFCGroupBy =
  | 'type'
  | 'predefinedType'
  | 'typeObject'
  | 'storey'
  | 'material'
  | 'classification'
  | { set: string; name: string };

const list = <T>(v: T | readonly T[] | undefined): readonly T[] | undefined =>
  v === undefined ? undefined : Array.isArray(v) ? (v as readonly T[]) : [v as T];
const same = (a: string | undefined, b: string) => a !== undefined && a.toUpperCase() === b.toUpperCase();
const text = (pattern: string | RegExp, value: string | undefined): boolean => {
  if (value === undefined) return false;
  if (typeof pattern === 'string') return value === pattern;
  pattern.lastIndex = 0;
  return pattern.test(value);
};
const isType = (e: IFCElement) => e.type.toUpperCase().endsWith('TYPE') || e.type.toUpperCase().endsWith('STYLE');

/** The predefined type as IDS 1.0 resolves it: the type object's first, then the element's own; USERDEFINED takes the custom name (a type's ElementType, ProcessType or ResourceType, an occurrence's ObjectType). */
export function effectivePredefinedType(data: IFCData, id: number): string | undefined {
  const element = data.elements.get(id);
  if (!element) return;
  const own = (e: IFCElement, custom: string | undefined) =>
    e.predefinedType === 'USERDEFINED'
      ? (custom ?? 'USERDEFINED')
      : e.predefinedType === 'NOTDEFINED'
        ? undefined
        : e.predefinedType;
  const type = element.typeId !== undefined ? data.elements.get(element.typeId) : undefined;
  return (
    (type && own(type, type.elementType)) ?? own(element, isType(element) ? element.elementType : element.objectType)
  );
}

/** The chain of wholes above an element: container, aggregate, nest, the opening it fills, the element it voids. */
export function ancestorsOf(data: IFCData, id: number): number[] {
  const out: number[] = [],
    seen = new Set([id]);
  for (let at = data.elements.get(id); at; ) {
    const up = at.container ?? at.aggregate ?? at.nest ?? at.fills ?? at.voids;
    if (up === undefined || seen.has(up)) break;
    seen.add(up);
    out.push(up);
    at = data.elements.get(up);
  }
  return out;
}

/** Every element below a spatial element or assembly (contained, aggregated, nested), in expressID order. */
export function descendantsOf(data: IFCData, id: number): number[] {
  const children = new Map<number, number[]>();
  for (const e of data.elements.values()) {
    const up = e.container ?? e.aggregate ?? e.nest;
    if (up !== undefined) (children.get(up) ?? children.set(up, []).get(up)!).push(e.id);
  }
  const out: number[] = [],
    stack = [id],
    seen = new Set([id]);
  while (stack.length)
    for (const child of children.get(stack.pop()!) ?? [])
      if (!seen.has(child)) {
        seen.add(child);
        out.push(child);
        stack.push(child);
      }
  return out.sort((a, b) => a - b);
}

function compare(property: IFCProperty | undefined, condition: IFCPropertyCondition): boolean {
  const op = condition.op ?? (condition.value === undefined ? 'exists' : '=');
  const empty = (v: IFCValue) => v === null || v === '' || (Array.isArray(v) && !v.length);
  if (op === 'missing') return !property || empty(property.value);
  if (!property || empty(property.value)) return false;
  if (op === 'exists') return true;
  const values: IFCValue[] = [];
  const collect = (v: IFCValue) => (Array.isArray(v) ? v.forEach(collect) : values.push(v));
  collect(property.value);
  const want = condition.value;
  const test = (v: IFCValue): boolean => {
    if (want instanceof RegExp) return typeof v === 'string' && text(want, v);
    if (op === 'contains')
      return typeof v === 'string' && typeof want === 'string' && v.toLowerCase().includes(want.toLowerCase());
    if (op === 'matches') return typeof v === 'string' && typeof want === 'string' && new RegExp(want).test(v);
    if (typeof v === 'number' && typeof want === 'number') {
      if (op === '=') return nearlyEqual(v, want);
      if (op === '!=') return !nearlyEqual(v, want);
      if (op === '<') return v < want && !nearlyEqual(v, want);
      if (op === '<=') return v <= want || nearlyEqual(v, want);
      if (op === '>') return v > want && !nearlyEqual(v, want);
      return v >= want || nearlyEqual(v, want);
    }
    if (op === '=') return v === want;
    if (op === '!=') return v !== want;
    return false;
  };
  return op === '!=' ? values.every(test) : values.some(test);
}

/** The IDs of the elements that match every field of `query`, in expressID order. */
export function findElements(data: IFCData, query: IFCQuery = {}): number[] {
  const types = list(query.type),
    predefined = list(query.predefinedType),
    storeys = list(query.storey),
    globalIds = list(query.globalId);
  const typeObject =
    typeof query.typeObject === 'string'
      ? [...data.elements.values()].filter((e) => e.name === query.typeObject && isType(e)).map((e) => e.id)
      : query.typeObject === undefined
        ? undefined
        : [query.typeObject];
  const storeyIds =
    storeys &&
    new Set(
      storeys.flatMap((s) =>
        typeof s === 'number'
          ? [s]
          : [...data.elements.values()]
              .filter((e) => same(e.type, 'IfcBuildingStorey') && e.name === s)
              .map((e) => e.id),
      ),
    );
  const out: number[] = [];
  for (const e of data.elements.values()) {
    if ((query.occurrencesOnly ?? true) && isType(e)) continue;
    if (types && !types.some((t) => ((query.subtypes ?? true) ? isSubtypeOf(data, e.type, t) : same(e.type, t))))
      continue;
    if (predefined && !predefined.some((p) => same(effectivePredefinedType(data, e.id), p))) continue;
    if (typeObject && (e.typeId === undefined || !typeObject.includes(e.typeId))) continue;
    if (storeyIds && (e.storey === undefined || !storeyIds.has(e.storey))) continue;
    if (query.within !== undefined && !ancestorsOf(data, e.id).includes(query.within)) continue;
    if (query.name !== undefined && !text(query.name, e.name)) continue;
    if (globalIds && (e.globalId === undefined || !globalIds.includes(e.globalId))) continue;
    if (query.material !== undefined) {
      const m = query.material;
      if (!materialsOf(data, e.id).some((x) => text(m, x.name) || text(m, x.category) || text(m, x.part))) continue;
    }
    if (query.classification) {
      const { system, code } = query.classification;
      if (
        !classificationsOf(data, e.id).some(
          (c) => (system === undefined || text(system, c.system)) && (code === undefined || text(code, c.code)),
        )
      )
        continue;
    }
    if (query.where?.length) {
      const props = propertiesOf(data, e.id);
      const ok = query.where.every((condition) => {
        const sets = Object.entries(props).filter(([name]) => condition.set === undefined || text(condition.set, name));
        const candidates = sets.flatMap(([, set]) => Object.values(set).filter((p) => text(condition.name, p.name)));
        if ((condition.op ?? '') === 'missing') return candidates.every((p) => compare(p, condition));
        return candidates.some((p) => compare(p, condition));
      });
      if (!ok) continue;
    }
    if (query.filter && !query.filter(e, data)) continue;
    out.push(e.id);
  }
  return out;
}

/**
 * Groups elements by a key, as a classifier tree does: class, predefined type, type object, storey, material,
 * classification code or a property's value. An element with several materials or classifications is in each of
 * their groups; one without the key is under `''`. `ids` limits the grouping (default: every occurrence).
 */
export function groupElements(
  data: IFCData,
  by: IFCGroupBy,
  ids: Iterable<number> = findElements(data),
): Map<string, number[]> {
  const groups = new Map<string, number[]>();
  const add = (key: string, id: number) => {
    const group = groups.get(key) ?? groups.set(key, []).get(key)!;
    if (group[group.length - 1] !== id) group.push(id);
  };
  const name = (id: number | undefined) => (id === undefined ? '' : (data.elements.get(id)?.name ?? `#${id}`));
  for (const id of ids) {
    const e = data.elements.get(id);
    if (!e) continue;
    if (by === 'type') add(e.type, id);
    else if (by === 'predefinedType') add(effectivePredefinedType(data, id) ?? '', id);
    else if (by === 'typeObject') add(name(e.typeId), id);
    else if (by === 'storey') add(name(e.storey), id);
    else if (by === 'material') {
      const materials = materialsOf(data, id);
      if (!materials.length) add('', id);
      for (const m of materials) add(m.name, id);
    } else if (by === 'classification') {
      const classes = classificationsOf(data, id);
      if (!classes.length) add('', id);
      for (const c of classes) add(c.code ?? c.name ?? '', id);
    } else {
      const value = propertiesOf(data, id)[by.set]?.[by.name]?.value;
      add(value === undefined || value === null ? '' : String(value), id);
    }
  }
  return groups;
}
