// Loading a save into a live world, all or nothing: the document is validated, migrated and expanded first (pure), then
// the adapter builds every entity, links references and commits. If anything fails before the commit, everything the
// adapter built is destroyed again, latest first, and the error is rethrown, so a bad file never leaves a half-loaded
// world. Also the save and load helpers that put it together with a storage and the ECS adapter.
import { MargoError } from '@margoengine/math/errors';
import { decodeSave, encodeSave } from './codec.js';
import { type Json, type SaveDocument, type SavedEntity, type ValidateOptions, parseSave } from './document.js';
import type { Migrations } from './migrations.js';
import { type ResolvedEntity, expandSave } from './prefab.js';
import type { SaveStorage } from './storage.js';

/**
 * How a world takes a load. `create` builds one entity (off-screen, or marked as loading) and returns your handle;
 * `link` (optional) is called for every entity once all exist, to connect references; `commit` (optional) makes the
 * load visible (swap the scene, clear the old world). `destroy` undoes one `create` and is called, latest first, when
 * a later step fails.
 */
export interface WorldAdapter<H> {
  create(entity: ResolvedEntity): H;
  link?(handle: H, entity: ResolvedEntity, resolve: (id: string) => H): void;
  commit?(handles: ReadonlyMap<string, H>): void;
  destroy(handle: H): void;
}

/** Options of {@link loadWorld} and {@link loadGame}. */
export interface LoadOptions extends ValidateOptions {
  /** Migrations that bring older saves to the current schema version (default none: a save loads at the version it has). */
  migrations?: Migrations;
  /** Stops the load before the commit; nothing stays built. */
  signal?: AbortSignal;
}

/**
 * Load a save into a world through `adapter`, all or nothing. Returns the handles by entity id.
 * @throws TypeError for an invalid document (naming its first problem's path and fix); MargoError `'failed'` when a
 * migration fails or the adapter throws (the error is its `cause`), after destroying everything built; the signal's
 * reason when it aborts.
 */
export function loadWorld<H>(
  document: SaveDocument | string | unknown,
  adapter: WorldAdapter<H>,
  options: LoadOptions = {},
): Map<string, H> {
  if (adapter == null || typeof adapter.create !== 'function' || typeof adapter.destroy !== 'function')
    throw new TypeError('loadWorld needs an adapter with create(entity) and destroy(handle)');
  options.signal?.throwIfAborted();
  const entities = prepare(document, options);
  const handles = new Map<string, H>(),
    built: H[] = [];
  const resolve = (id: string): H => {
    const handle = handles.get(id);
    if (handle === undefined)
      throw new MargoError('state', `No entity '${id}' in this load; resolve only ids the save holds`);
    return handle;
  };
  let stage = 'create';
  let failing: ResolvedEntity | null = null;
  try {
    for (const entity of entities) {
      failing = entity;
      const handle = adapter.create(entity);
      built.push(handle);
      handles.set(entity.id, handle);
    }
    stage = 'link';
    if (adapter.link)
      for (const entity of entities) {
        failing = entity;
        adapter.link(handles.get(entity.id)!, entity, resolve);
      }
    failing = null;
    options.signal?.throwIfAborted();
    stage = 'commit';
    adapter.commit?.(handles);
    return handles;
  } catch (error) {
    // Undo every create, latest first. A destroy that throws is a second failure: it is reported with the first.
    const undo: unknown[] = [];
    for (let i = built.length - 1; i >= 0; i--) {
      try {
        adapter.destroy(built[i]);
      } catch (problem) {
        undo.push(problem);
      }
    }
    if (options.signal?.aborted && error === options.signal.reason) throw error;
    const where = failing ? ` at entity '${failing.id}'` : '';
    throw Object.assign(
      new MargoError(
        'failed',
        `Load failed in ${stage}${where}; nothing was kept. Fix the cause (see error.cause) and load again`,
      ),
      { cause: error, ...(undo.length ? { undoErrors: undo } : {}) },
    );
  }
}

/** Validate (after migrating) and expand; pure, throws before anything is built. */
function prepare(document: unknown, options: LoadOptions): ResolvedEntity[] {
  let value = typeof document === 'string' ? parseSave(document, { components: {} }) : document;
  // Migrate first (an old save may not pass today's component checks), then validate fully.
  if (options.migrations) {
    const shaped = parseSave(value, {});
    value = options.migrations.migrate(shaped);
  }
  return expandSave(parseSave(value, options));
}

/** Options of {@link saveGame}. */
export interface SaveGameOptions {
  /** Gzip the save (default true when CompressionStream exists). */
  compress?: boolean;
  /** Checks the document before writing (component checks); an invalid save is never written. */
  validate?: ValidateOptions;
  signal?: AbortSignal;
}

/**
 * Validate `document` and write it to `storage` under `key` in one step (encoded, compressed by default).
 * @throws TypeError for an invalid document; nothing is written.
 */
export async function saveGame(
  storage: SaveStorage,
  key: string,
  document: SaveDocument,
  options: SaveGameOptions = {},
): Promise<void> {
  const checked = parseSave(document, options.validate);
  const compress = options.compress ?? typeof CompressionStream === 'function';
  await storage.write(key, await encodeSave(checked, { compress, signal: options.signal }), { signal: options.signal });
}

/**
 * Read the save under `key`: decoded, migrated to the current version and validated. Null when there is none.
 * Load it into your world with {@link loadWorld}.
 * @throws TypeError for a damaged or invalid save; MargoError `'failed'` when a migration fails.
 */
export async function loadGame(
  storage: SaveStorage,
  key: string,
  options: LoadOptions = {},
): Promise<SaveDocument | null> {
  const bytes = await storage.read(key, { signal: options.signal });
  if (bytes === null) return null;
  let value = await decodeSave(bytes, { signal: options.signal });
  if (options.migrations) value = options.migrations.migrate(parseSave(value, {}));
  return parseSave(value, options);
}

/** A numeric ECS component as `@margoengine/ecs` makes it (structural, so this package does not depend on ecs). */
export interface EcsComponentLike {
  readonly fields: Readonly<Record<string, ArrayLike<number>>>;
  readonly entities: ArrayLike<number>;
  readonly size: number;
  index(entity: number): number;
  add(entity: number, values?: Record<string, number>): number;
}
/** The ECS world calls the adapter uses. */
export interface EcsWorldLike {
  create(): number;
  destroy(entity: number): void;
  alive(entity: number): boolean;
}

/**
 * The entities of an ECS world that hold any of `components`, as a save document (component fields as numbers,
 * entity ids as `e<entity>`). Entities are listed in a stable order: by first component, then row.
 */
export function saveEcs(
  world: EcsWorldLike,
  components: Readonly<Record<string, EcsComponentLike>>,
  version = 1,
): SaveDocument {
  const order: number[] = [],
    seen = new Set<number>();
  for (const component of Object.values(components))
    for (let row = 0; row < component.size; row++) {
      const entity = component.entities[row];
      if (world.alive(entity) && !seen.has(entity)) {
        seen.add(entity);
        order.push(entity);
      }
    }
  order.sort((a, b) => a - b);
  const entities: SavedEntity[] = order.map((entity) => {
    const out: Record<string, Json> = {};
    for (const [name, component] of Object.entries(components)) {
      const row = component.index(entity);
      if (row < 0) continue;
      out[name] = Object.fromEntries(Object.entries(component.fields).map(([field, array]) => [field, array[row]]));
    }
    return { id: `e${entity}`, components: out };
  });
  return { format: 'margo-save', version, entities };
}

/**
 * A {@link WorldAdapter} for an `@margoengine/ecs` World: each entity becomes a new ECS entity with the named
 * components' fields. Values are checked by the components themselves (a value that does not fit a field throws,
 * and the whole load is undone). Components the adapter does not know are refused with a TypeError naming them.
 */
export function ecsAdapter(
  world: EcsWorldLike,
  components: Readonly<Record<string, EcsComponentLike>>,
): WorldAdapter<number> {
  return {
    create(entity) {
      for (const name of Object.keys(entity.components))
        if (!Object.hasOwn(components, name))
          throw new TypeError(`Unknown ECS component '${name}'; pass it in the components of ecsAdapter`);
      const handle = world.create();
      try {
        for (const [name, value] of Object.entries(entity.components)) {
          if (value === null || typeof value !== 'object' || Array.isArray(value))
            throw new TypeError(`Component '${name}' of '${entity.id}' must be an object of numeric fields`);
          components[name].add(handle, value as Record<string, number>);
        }
      } catch (error) {
        world.destroy(handle);
        throw error;
      }
      return handle;
    },
    destroy(handle) {
      if (world.alive(handle)) world.destroy(handle);
    },
  };
}
