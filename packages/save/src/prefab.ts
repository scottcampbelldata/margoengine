// Prefab expansion: every instance becomes the prefab's entities with ids `instance/local`, its root merged into the
// instance entity, local parents and references re-pointed at the instance's copies, nested prefabs expanded inside
// out, then the instance's overrides applied as JSON Merge Patches (RFC 7386).
import type { Json, SaveDocument, SavedEntity, SavedTransform } from './document.js';

/** An entity after prefab expansion: no prefab fields; every reference resolves to an entity of the same list. */
export interface ResolvedEntity {
  id: string;
  name?: string;
  parent?: string;
  transform?: SavedTransform;
  components: Record<string, Json>;
  /** Prefab key this entity was made from, and its id inside that prefab (for tools; not needed to load). */
  source?: { prefab: string; local: string };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** JSON Merge Patch (RFC 7386): objects merge key by key, `null` removes a key, anything else replaces. */
export function mergePatch(target: Json | undefined, patch: Json): Json | undefined {
  if (!isRecord(patch)) return patch === null ? undefined : structuredClone(patch);
  const out: Record<string, Json> = isRecord(target) ? { ...(target as Record<string, Json>) } : {};
  for (const [key, value] of Object.entries(patch as Record<string, Json>)) {
    if (value === null) delete out[key];
    else {
      const merged = mergePatch(out[key], value);
      if (merged === undefined) delete out[key];
      else out[key] = merged;
    }
  }
  return out;
}

/** Rewrite `{"$ref": id}` through `map` (ids it does not hold stay as they are). */
function remap(value: Json, map: (id: string) => string): Json {
  if (Array.isArray(value)) return value.map((item) => remap(item, map));
  if (isRecord(value)) {
    if (typeof value.$ref === 'string' && Object.keys(value).length === 1) return { $ref: map(value.$ref) };
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, remap(item as Json, map)]));
  }
  return value;
}

const entityJson = (entity: ResolvedEntity): Record<string, Json> => {
  const out: Record<string, Json> = { components: entity.components };
  if (entity.name !== undefined) out.name = entity.name;
  if (entity.parent !== undefined) out.parent = entity.parent;
  if (entity.transform !== undefined) out.transform = entity.transform as unknown as Json;
  return out;
};

/**
 * Expand every prefab instance of a valid document (see {@link validateSave}) into plain entities, parents before
 * children. Pure: the document is not changed.
 * @throws TypeError when an expanded id collides with another entity or a reference does not resolve after
 * expansion (`door/handle` naming no entity), each naming the fix.
 */
export function expandSave(document: SaveDocument): ResolvedEntity[] {
  const prefabs = document.prefabs ?? {};
  // The prefab's entities, expanded, with prefab-local ids (`a`, `a/b` for nested instances).
  const cache = new Map<string, ResolvedEntity[]>();
  const expandPrefab = (key: string): ResolvedEntity[] => {
    let done = cache.get(key);
    if (!done) {
      done = expandList(prefabs[key].entities, key);
      cache.set(key, done);
    }
    return done;
  };
  const expandList = (entities: readonly SavedEntity[], prefab: string | null): ResolvedEntity[] => {
    const out: ResolvedEntity[] = [];
    for (const entity of entities) {
      const own: ResolvedEntity = { id: entity.id, components: structuredClone(entity.components ?? {}) };
      if (entity.name !== undefined) own.name = entity.name;
      if (entity.parent !== undefined) own.parent = entity.parent;
      if (entity.transform !== undefined) own.transform = structuredClone(entity.transform);
      if (prefab) own.source = { prefab, local: entity.id };
      if (!entity.prefab) {
        out.push(own);
        continue;
      }
      const definition = prefabs[entity.prefab],
        root = definition.root ?? definition.entities[0].id,
        inner = expandPrefab(entity.prefab);
      const locals = new Set(inner.map((e) => e.id));
      const map = (id: string): string => (id === root ? entity.id : locals.has(id) ? `${entity.id}/${id}` : id);
      let copies: ResolvedEntity[] = inner.map((e) => {
        const copy: ResolvedEntity = {
          ...structuredClone(e),
          id: map(e.id),
          components: remap(e.components, map) as Record<string, Json>,
        };
        if (e.parent !== undefined) copy.parent = map(e.parent);
        if (e.id === root) {
          // The instance is the root: its own fields win, component by component.
          copy.components = { ...copy.components, ...own.components };
          if (own.name !== undefined) copy.name = own.name;
          if (own.transform !== undefined) copy.transform = own.transform;
          if (own.parent !== undefined) copy.parent = own.parent;
          else delete copy.parent;
          if (own.source) copy.source = own.source;
          else copy.source = { prefab: entity.prefab!, local: root };
        }
        return copy;
      });
      // Overrides by prefab-local id; null removes that entity and everything under it.
      const removed = new Set<string>();
      for (const [local, patch] of Object.entries(entity.overrides ?? {})) {
        const id = map(local);
        if (!copies.some((copy) => copy.id === id))
          throw new TypeError(
            `Entity '${entity.id}' overrides '${local}', which prefab '${entity.prefab}' does not have; use one of its entity ids`,
          );
        if (patch === null) {
          removed.add(id);
          continue;
        }
        copies = copies.map((copy) => {
          if (copy.id !== id) return copy;
          const merged = mergePatch(entityJson(copy), remap(patch, map)) as Record<string, Json>;
          const next: ResolvedEntity = { id: copy.id, components: (merged.components as Record<string, Json>) ?? {} };
          if (typeof merged.name === 'string') next.name = merged.name;
          if (typeof merged.parent === 'string') next.parent = merged.parent;
          if (isRecord(merged.transform)) next.transform = merged.transform as SavedTransform;
          if (copy.source) next.source = copy.source;
          return next;
        });
      }
      if (removed.size) {
        let grew = true;
        while (grew) {
          grew = false;
          for (const copy of copies)
            if (!removed.has(copy.id) && copy.parent !== undefined && removed.has(copy.parent)) {
              removed.add(copy.id);
              grew = true;
            }
        }
        copies = copies.filter((copy) => !removed.has(copy.id));
      }
      out.push(...copies);
    }
    return out;
  };
  const all = expandList(document.entities, null);
  // Ids are unique, references resolve, and parents come first.
  const byId = new Map<string, ResolvedEntity>();
  for (const entity of all) {
    if (byId.has(entity.id))
      throw new TypeError(
        `Prefab expansion made two entities '${entity.id}'; rename the entity or the instance that collides`,
      );
    byId.set(entity.id, entity);
  }
  for (const entity of all) {
    if (entity.parent !== undefined && !byId.has(entity.parent))
      throw new TypeError(
        `Entity '${entity.id}' has parent '${entity.parent}', which does not exist after prefab expansion; fix the parent or the override that removed it`,
      );
    for (const ref of collectRefs(entity.components))
      if (!byId.has(ref))
        throw new TypeError(
          `Entity '${entity.id}' references '${ref}', which does not exist after prefab expansion; fix the reference or the override that removed it`,
        );
  }
  const ordered: ResolvedEntity[] = [],
    placed = new Set<string>();
  const place = (entity: ResolvedEntity, trail: Set<string>): void => {
    if (placed.has(entity.id)) return;
    if (trail.has(entity.id))
      throw new TypeError(
        `Entity '${entity.id}' is its own ancestor after prefab overrides; give the hierarchy a root`,
      );
    trail.add(entity.id);
    if (entity.parent !== undefined) place(byId.get(entity.parent)!, trail);
    placed.add(entity.id);
    ordered.push(entity);
  };
  for (const entity of all) place(entity, new Set());
  return ordered;
}

function collectRefs(value: Json, out: string[] = []): string[] {
  if (Array.isArray(value)) for (const item of value) collectRefs(item, out);
  else if (isRecord(value)) {
    if (typeof value.$ref === 'string' && Object.keys(value).length === 1) out.push(value.$ref);
    else for (const item of Object.values(value)) collectRefs(item as Json, out);
  }
  return out;
}
