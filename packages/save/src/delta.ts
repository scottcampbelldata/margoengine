// A scene change recorder: what changed between a loaded save document and the same scene edited, as a small JSON delta
// that applies back onto the base. Changed entities are JSON Merge Patches (RFC 7386, the format the prefab overrides
// already use); added entities are whole; removed ones are ids.
import { mergePatch } from './prefab.js';
import { parseSave, type Json, type SavedEntity, type SaveDocument, type ValidateOptions } from './document.js';

/** The changes from a base document to an edited one. Plain JSON: `JSON.stringify` it to keep it. */
export interface SaveDelta {
  format: 'margo-save-delta';
  /** Delta schema version, 1. */
  version: 1;
  /** The base document's `version`, so a delta is not applied to a document of another schema. */
  baseVersion: number;
  /** Entities that did not exist in the base, in the edited document's order. */
  added: SavedEntity[];
  /** Ids of base entities the edit deleted. */
  removed: string[];
  /** Merge patches by entity id: `name`, `parent`, `transform`, `components`, `prefab`, `overrides`; `null` removes a field. */
  changed: Record<string, Json>;
  /** A merge patch of the document's `meta`, when it changed. */
  meta?: Json;
}

/** Options of {@link applyDelta}. */
export interface ApplyDeltaOptions extends ValidateOptions {
  /** Validate the result with `parseSave`, which throws a TypeError naming the first problem. Default true. */
  validate?: boolean;
}

const isRecord = (value: unknown): value is Record<string, Json> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function equal(a: Json | undefined, b: Json | undefined): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((v, i) => equal(v, b[i]));
  if (isRecord(a)) {
    if (!isRecord(b)) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((k) => k in b && equal(a[k], b[k]));
  }
  return false;
}

/** A merge patch cannot say "set to null" (null means remove), so a null stored in a changed value cannot be recorded. */
function noNull(value: Json, path: string): void {
  if (value === null) throw new TypeError(`${path} is null, which a merge patch cannot store; use a missing key or another value for "none"`);
  if (Array.isArray(value)) value.forEach((v, i) => noNull(v, `${path}[${i}]`));
  else if (isRecord(value)) for (const [k, v] of Object.entries(value)) noNull(v, `${path}.${k}`);
}

/** The RFC 7386 patch that turns `from` into `to`, or undefined when they are equal. */
function diffJson(from: Json | undefined, to: Json | undefined, path: string): Json | undefined {
  if (equal(from, to)) return undefined;
  if (to === undefined) return null;
  if (isRecord(from) && isRecord(to)) {
    const patch: Record<string, Json> = {};
    for (const key of Object.keys(to)) {
      const part = diffJson(from[key], to[key], `${path}.${key}`);
      if (part !== undefined) patch[key] = part;
    }
    for (const key of Object.keys(from)) if (!(key in to)) patch[key] = null;
    return patch;
  }
  noNull(to, path);
  return to;
}

const entityJson = (entity: SavedEntity): Record<string, Json> => entity as unknown as Record<string, Json>;
/** The entity without its id: the part a patch describes. */
const body = (entity: SavedEntity): Record<string, Json> => Object.fromEntries(Object.entries(entityJson(entity)).filter(([k]) => k !== 'id'));

/**
 * What a user did to a loaded document, as a delta. Entities are matched by id. Reordering the list is not recorded.
 * @throws TypeError for a duplicate id, or a changed value that holds `null` (see `SaveDelta`).
 */
export function diffSave(base: SaveDocument, edited: SaveDocument): SaveDelta {
  const byId = (doc: SaveDocument, label: string): Map<string, SavedEntity> => {
    const map = new Map<string, SavedEntity>();
    for (const e of doc.entities) {
      if (map.has(e.id)) throw new TypeError(`${label} has two entities with id "${e.id}"; ids must be unique`);
      map.set(e.id, e);
    }
    return map;
  };
  const before = byId(base, 'the base document'),
    after = byId(edited, 'the edited document');
  const delta: SaveDelta = { format: 'margo-save-delta', version: 1, baseVersion: base.version, added: [], removed: [], changed: {} };
  for (const [id, entity] of after) {
    const old = before.get(id);
    if (!old) {
      noNull(entityJson(entity), `entity "${id}"`);
      delta.added.push(structuredClone(entity));
      continue;
    }
    const patch = diffJson(body(old), body(entity), `entity "${id}"`);
    if (patch !== undefined) delta.changed[id] = patch;
  }
  for (const id of before.keys()) if (!after.has(id)) delta.removed.push(id);
  const meta = diffJson(base.meta ?? {}, edited.meta ?? {}, 'meta');
  if (meta !== undefined) delta.meta = meta;
  return delta;
}

/** True when the delta changes nothing. */
export const isEmptyDelta = (delta: SaveDelta): boolean =>
  !delta.added.length && !delta.removed.length && !Object.keys(delta.changed).length && delta.meta === undefined;

/**
 * Applies a delta to a document and returns the result; `base` is not changed. A delta made from another base fails
 * loudly: an id it removes or changes must exist, an id it adds must not, and `baseVersion` must match.
 * @throws TypeError naming the id or the validation problem.
 */
export function applyDelta(base: SaveDocument, delta: SaveDelta, options: ApplyDeltaOptions = {}): SaveDocument {
  if (!isRecord(delta) || delta.format !== 'margo-save-delta' || delta.version !== 1)
    throw new TypeError("applyDelta needs a delta made by diffSave: {format: 'margo-save-delta', version: 1, ...}");
  if (delta.baseVersion !== base.version)
    throw new TypeError(`the delta was made for document version ${delta.baseVersion}, not ${base.version}; migrate the base first`);
  const entities = new Map(base.entities.map((e) => [e.id, structuredClone(e) as SavedEntity]));
  for (const id of delta.removed) {
    if (!entities.delete(id)) throw new TypeError(`the delta removes "${id}", which the base does not have; it was made from another document`);
  }
  for (const [id, patch] of Object.entries(delta.changed)) {
    const entity = entities.get(id);
    if (!entity) throw new TypeError(`the delta changes "${id}", which the base does not have; it was made from another document`);
    const merged = mergePatch(body(entity), patch);
    entities.set(id, { id, ...(merged as Record<string, Json>) } as unknown as SavedEntity);
  }
  for (const entity of delta.added) {
    if (entities.has(entity.id)) throw new TypeError(`the delta adds "${entity.id}", which the base already has; it was made from another document`);
    entities.set(entity.id, structuredClone(entity));
  }
  const out: SaveDocument = { ...structuredClone({ ...base, entities: [] }), entities: [...entities.values()] };
  if (delta.meta !== undefined) {
    const meta = mergePatch(base.meta ?? {}, delta.meta);
    if (isRecord(meta) && Object.keys(meta).length) out.meta = meta;
    else delete out.meta;
  }
  return options.validate === false ? out : parseSave(out, options);
}

/**
 * Remembers a base document and turns the scene's current document into a delta on demand. `changes(current)` is the
 * delta since the base (or since the last `commit`); `apply(delta)` re-applies a saved delta to the base.
 */
export class SaveRecorder {
  private snapshot: SaveDocument;

  constructor(base: SaveDocument) {
    this.snapshot = structuredClone(base);
  }

  /** The document the delta is measured from. */
  get base(): SaveDocument {
    return this.snapshot;
  }

  /** What changed from the base to `current`. */
  changes(current: SaveDocument): SaveDelta {
    return diffSave(this.snapshot, current);
  }

  /** Makes `current` the new base, after its changes were saved: the next `changes` is measured from here. */
  commit(current: SaveDocument): this {
    this.snapshot = structuredClone(current);
    return this;
  }

  /** Applies a delta (for example one loaded from storage) to the base. */
  apply(delta: SaveDelta, options?: ApplyDeltaOptions): SaveDocument {
    return applyDelta(this.snapshot, delta, options);
  }
}
