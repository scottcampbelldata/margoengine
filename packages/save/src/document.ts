// The save document: entities with stable string ids, components as JSON, references as {"$ref": id}, and prefab
// definitions that instances expand with JSON Merge Patch overrides (RFC 7386). The validator reads anything and
// never throws; parseSave throws a TypeError naming the first problem's path and fix.
import type { Quat, Vec3 } from '@margoengine/math';

export type { Quat, Vec3 };

/** Any JSON value. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** A reference to another entity by its stable id, anywhere inside a component value. */
export interface EntityRef {
  $ref: string;
}

/** Local transform of an entity, relative to its parent. Every field is optional (identity). */
export interface SavedTransform {
  position?: Vec3;
  /** Unit quaternion `[x, y, z, w]`. */
  rotation?: Quat;
  scale?: Vec3;
}

/** One entity. `id` is stable: references, parents and prefab overrides use it. */
export interface SavedEntity {
  /** Stable id, unique in its list. Expanded prefab entities get `instance/local` ids; a clash with one is an error. */
  id: string;
  name?: string;
  /** Id of the parent entity. */
  parent?: string;
  transform?: SavedTransform;
  /** Component data by component name; values are JSON and may hold `{"$ref": id}` references. */
  components?: Record<string, Json>;
  /** Make this entity an instance of the prefab with this key. Its own fields override the prefab root's. */
  prefab?: string;
  /**
   * Changes to the prefab's entities by their prefab-local id, as JSON Merge Patches of an entity (objects merge,
   * other values replace, `null` removes; `null` for a whole entity removes it and its children).
   */
  overrides?: Record<string, Json>;
}

/** A reusable group of entities. Ids are local to the prefab; `root` (default the first entity) is the instance. */
export interface PrefabDefinition {
  root?: string;
  entities: SavedEntity[];
}

/** A saved scene or world. `version` is your schema version, raised with {@link Migrations}. */
export interface SaveDocument {
  format: 'margo-save';
  /** Your schema version, a whole number of 1 or more. */
  version: number;
  entities: SavedEntity[];
  /** Prefab definitions by key. */
  prefabs?: Record<string, PrefabDefinition>;
  /** Anything else to keep with the save (a title, a play time, a thumbnail URL); JSON. */
  meta?: Record<string, Json>;
}

/** One problem found by {@link validateSave}: where (`entities[3].parent`) and what to change. */
export interface SaveIssue {
  path: string;
  message: string;
}

/** Checks one component value: return a message naming the fix, or nothing when it is valid. */
export type ComponentCheck = (value: Json) => string | undefined | null | void;

/** Options of {@link validateSave} and {@link parseSave}. */
export interface ValidateOptions {
  /** Checks by component name. Components without a check accept any JSON. */
  components?: Readonly<Record<string, ComponentCheck>>;
  /** Reject components that have no check (default false). */
  strictComponents?: boolean;
}

/** Deepest prefab nesting accepted. */
export const MAX_PREFAB_DEPTH = 32;
/** Most entities a document may expand to. */
export const MAX_ENTITIES = 1_000_000;
/** Deepest JSON nesting accepted in a component value. */
export const MAX_JSON_DEPTH = 64;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const vec = (value: unknown, length: number): boolean =>
  Array.isArray(value) && value.length === length && value.every((x) => typeof x === 'number' && Number.isFinite(x));

/** Why `value` is not JSON (or nests too deep), or null. */
function notJson(value: unknown, depth = 0): string | null {
  if (depth > MAX_JSON_DEPTH) return `nests deeper than ${MAX_JSON_DEPTH} levels; flatten it`;
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return null;
  if (typeof value === 'number')
    return Number.isFinite(value) ? null : 'holds a non-finite number; JSON has no NaN or Infinity';
  if (Array.isArray(value)) {
    for (const item of value) {
      const problem = notJson(item, depth + 1);
      if (problem) return problem;
    }
    return null;
  }
  if (isRecord(value) && Object.getPrototypeOf(value) === Object.prototype) {
    for (const item of Object.values(value)) {
      const problem = notJson(item, depth + 1);
      if (problem) return problem;
    }
    return null;
  }
  return `holds a ${typeof value} that is not JSON; store plain objects, arrays, strings, numbers, booleans and null`;
}

/** Every `{"$ref": id}` inside a JSON value, with its path. */
export function findRefs(
  value: Json,
  path = '',
  out: { path: string; id: string }[] = [],
): { path: string; id: string }[] {
  if (Array.isArray(value)) value.forEach((item, i) => findRefs(item, `${path}[${i}]`, out));
  else if (isRecord(value)) {
    if (typeof value.$ref === 'string' && Object.keys(value).length === 1) out.push({ path, id: value.$ref });
    else for (const [key, item] of Object.entries(value)) findRefs(item as Json, `${path}.${key}`, out);
  }
  return out;
}

/**
 * Check a save document without loading it: shape, ids, parents (and parent cycles), references, prefabs (unknown,
 * cyclic or too deep), overrides naming prefab entities that do not exist, and component checks. Returns every
 * problem with its path and the fix; empty means valid. Never throws, whatever the input.
 */
export function validateSave(input: unknown, options: ValidateOptions = {}): SaveIssue[] {
  const issues: SaveIssue[] = [];
  const add = (path: string, message: string): void => {
    if (issues.length < 1000) issues.push({ path, message });
  };
  if (!isRecord(input)) {
    add('', 'must be a save document {format: "margo-save", version, entities}');
    return issues;
  }
  if (input.format !== 'margo-save') add('format', "must be 'margo-save'; this is not a save document");
  if (!(Number.isInteger(input.version) && (input.version as number) >= 1))
    add('version', 'must be your schema version, a whole number of 1 or more');
  if ('meta' in input) {
    if (!isRecord(input.meta)) add('meta', 'must be an object');
    else {
      const problem = notJson(input.meta);
      if (problem) add('meta', problem);
    }
  }
  const prefabs = isRecord(input.prefabs) ? input.prefabs : {};
  if ('prefabs' in input && !isRecord(input.prefabs)) add('prefabs', 'must be an object of key: prefab');
  const checks = options.components ?? {};
  const entityList = (value: unknown, path: string, local: boolean): Map<string, Record<string, unknown>> => {
    const ids = new Map<string, Record<string, unknown>>();
    if (!Array.isArray(value)) {
      add(path, 'must be an array of entities');
      return ids;
    }
    if (value.length > MAX_ENTITIES) {
      add(path, `holds more than ${MAX_ENTITIES} entities; split the save`);
      return ids;
    }
    value.forEach((entity, i) => {
      const at = `${path}[${i}]`;
      if (!isRecord(entity)) {
        add(at, 'must be an entity object {id, components}');
        return;
      }
      if (typeof entity.id !== 'string' || !entity.id) add(`${at}.id`, 'must be a non-empty string');
      else if (ids.has(entity.id))
        add(`${at}.id`, `'${entity.id}' is used by another entity; give each entity its own id`);
      else ids.set(entity.id, entity);
      for (const key of Object.keys(entity))
        if (!['id', 'name', 'parent', 'transform', 'components', 'prefab', 'overrides'].includes(key))
          add(`${at}.${key}`, 'is not an entity field; move it into components');
      if ('name' in entity && typeof entity.name !== 'string') add(`${at}.name`, 'must be a string');
      if ('parent' in entity && (typeof entity.parent !== 'string' || !entity.parent))
        add(`${at}.parent`, 'must be the id of another entity');
      if ('transform' in entity) {
        const t = entity.transform;
        if (!isRecord(t)) add(`${at}.transform`, 'must be {position?, rotation?, scale?}');
        else {
          for (const key of Object.keys(t))
            if (!['position', 'rotation', 'scale'].includes(key))
              add(`${at}.transform.${key}`, 'is not a transform field; use position, rotation or scale');
          if ('position' in t && !vec(t.position, 3))
            add(`${at}.transform.position`, 'must be [x, y, z] with finite numbers');
          if ('scale' in t && !vec(t.scale, 3)) add(`${at}.transform.scale`, 'must be [x, y, z] with finite numbers');
          if ('rotation' in t && (!vec(t.rotation, 4) || Math.abs(Math.hypot(...(t.rotation as number[])) - 1) > 1e-3))
            add(`${at}.transform.rotation`, 'must be a unit quaternion [x, y, z, w]');
        }
      }
      if ('components' in entity) {
        if (!isRecord(entity.components)) add(`${at}.components`, 'must be an object of name: value');
        else
          for (const [name, value] of Object.entries(entity.components)) {
            const problem = notJson(value);
            if (problem) {
              add(`${at}.components.${name}`, problem);
              continue;
            }
            const check = Object.hasOwn(checks, name) ? checks[name] : undefined;
            if (check) {
              let message: string | undefined | null | void;
              try {
                message = check(value as Json);
              } catch (error) {
                message = `its check threw (${(error as Error)?.message ?? String(error)}); make the check return a message instead`;
              }
              if (message) add(`${at}.components.${name}`, message);
            } else if (options.strictComponents)
              add(`${at}.components.${name}`, `unknown component '${name}'; add a check for it or remove it`);
          }
      }
      if ('prefab' in entity && !(typeof entity.prefab === 'string' && Object.hasOwn(prefabs, entity.prefab)))
        add(
          `${at}.prefab`,
          `must name a prefab in the document's prefabs (${Object.keys(prefabs).join(', ') || 'none defined'})`,
        );
      if ('overrides' in entity) {
        if (!('prefab' in entity)) add(`${at}.overrides`, 'needs prefab; only prefab instances take overrides');
        if (!isRecord(entity.overrides)) add(`${at}.overrides`, 'must be an object of prefab entity id: patch');
        else {
          const problem = notJson(entity.overrides);
          if (problem) add(`${at}.overrides`, problem);
          const definition =
            typeof entity.prefab === 'string' && Object.hasOwn(prefabs, entity.prefab) ? prefabs[entity.prefab] : null;
          const local =
            isRecord(definition) && Array.isArray(definition.entities)
              ? new Map(definition.entities.map((e) => (isRecord(e) ? [e.id, e] : [null, e])))
              : null;
          // A nested instance's entities are `instance/local`; expandSave checks the full path.
          const known = (key: string): boolean =>
            local!.has(key) ||
            (key.includes('/') &&
              isRecord(local!.get(key.split('/')[0])) &&
              typeof (local!.get(key.split('/')[0]) as Record<string, unknown>).prefab === 'string');
          for (const [key, patch] of Object.entries(entity.overrides)) {
            if (local && !known(key))
              add(
                `${at}.overrides.${key}`,
                `names no entity of prefab '${entity.prefab as string}'; use one of its entity ids`,
              );
            if (patch !== null && !isRecord(patch))
              add(`${at}.overrides.${key}`, 'must be a patch object, or null to remove that entity');
          }
        }
      }
    });
    // Parents and references inside this list (a prefab's are local; the document's are global).
    for (const [id, entity] of ids) {
      const index = (value as unknown[]).indexOf(entity);
      if (typeof entity.parent === 'string') {
        if (!ids.has(entity.parent))
          add(
            `${path}[${index}].parent`,
            `'${entity.parent}' is not an entity ${local ? 'of this prefab' : 'of this document'}`,
          );
        else {
          // Walk up; a cycle comes back to an entity already seen.
          const seen = new Set([id]);
          let up: unknown = entity.parent;
          while (typeof up === 'string' && ids.has(up)) {
            if (seen.has(up)) {
              add(`${path}[${index}].parent`, `makes a parent cycle through '${up}'; give the hierarchy a root`);
              break;
            }
            seen.add(up);
            up = ids.get(up)!.parent;
          }
        }
      }
      if (isRecord(entity.components) && !notJson(entity.components))
        for (const ref of findRefs(entity.components as Json))
          if (
            !ids.has(ref.id) &&
            !(!local && ref.id.includes('/') && typeof ids.get(ref.id.split('/')[0])?.prefab === 'string')
          )
            add(
              `${path}[${index}].components${ref.path}`,
              `references '${ref.id}', which is not an entity ${local ? 'of this prefab' : 'of this document'}`,
            );
    }
    return ids;
  };
  entityList(input.entities, 'entities', false);
  for (const [key, definition] of Object.entries(prefabs)) {
    const at = `prefabs.${key}`;
    if (!isRecord(definition)) {
      add(at, 'must be a prefab {entities, root?}');
      continue;
    }
    const ids = entityList(definition.entities, `${at}.entities`, true);
    if ('root' in definition && !(typeof definition.root === 'string' && ids.has(definition.root)))
      add(`${at}.root`, 'must be the id of one of its entities');
    if (Array.isArray(definition.entities) && !definition.entities.length)
      add(`${at}.entities`, 'must hold at least one entity');
    const root =
      typeof definition.root === 'string'
        ? definition.root
        : isRecord(definition.entities?.[0 as never])
          ? (definition.entities as Record<string, unknown>[])[0].id
          : undefined;
    const rootEntity = typeof root === 'string' ? ids.get(root) : undefined;
    if (rootEntity && 'parent' in rootEntity)
      add(`${at}.root`, 'the root entity must have no parent inside the prefab');
  }
  // Prefab cycles and depth.
  const uses = (key: string): string[] => {
    const definition = prefabs[key];
    if (!isRecord(definition) || !Array.isArray(definition.entities)) return [];
    return definition.entities.flatMap((e) =>
      isRecord(e) && typeof e.prefab === 'string' && Object.hasOwn(prefabs, e.prefab) ? [e.prefab] : [],
    );
  };
  const state = new Map<string, number>(),
    depthOf = new Map<string, number>();
  const visit = (key: string, trail: string[]): number => {
    if (state.get(key) === 2) return depthOf.get(key)!;
    if (state.get(key) === 1) {
      add(`prefabs.${key}`, `contains itself (${[...trail, key].join(' > ')}); remove the cycle`);
      return 0;
    }
    state.set(key, 1);
    let depth = 0;
    for (const child of uses(key)) depth = Math.max(depth, 1 + visit(child, [...trail, key]));
    state.set(key, 2);
    depthOf.set(key, depth);
    return depth;
  };
  for (const key of Object.keys(prefabs))
    if (visit(key, []) + 1 > MAX_PREFAB_DEPTH)
      add(`prefabs.${key}`, `nests deeper than ${MAX_PREFAB_DEPTH} prefabs; flatten it`);
  return issues;
}

/**
 * Read a save document (JSON text or an object), checked with {@link validateSave}. Returns a fresh copy.
 * @throws TypeError naming the first problem's path and fix, or for text that is not JSON.
 */
export function parseSave(input: string | unknown, options: ValidateOptions = {}): SaveDocument {
  let value: unknown;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input);
    } catch (error) {
      throw new TypeError(`Save is not valid JSON (${(error as Error).message}); the file is damaged or not a save`);
    }
  } else {
    const problem = notJson(input);
    if (problem) throw new TypeError(`Invalid save; fix the document: it ${problem}`);
    value = JSON.parse(JSON.stringify(input));
  }
  const issues = validateSave(value, options);
  if (issues.length)
    throw new TypeError(
      `Invalid save; fix ${issues[0].path || 'the document'}: ${issues[0].message}${issues.length > 1 ? ` (and ${issues.length - 1} more; see validateSave)` : ''}`,
    );
  return value as SaveDocument;
}
