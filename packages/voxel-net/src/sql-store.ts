// @margoengine/voxel-net/sql-store: a ChunkStore in a SQLite or Postgres table (design: DESIGN.md "Database store").
import { chunkKey, VoxelChunk } from '@margoengine/voxel';
import { decodeChunk, encodeChunk } from '@margoengine/voxel/codec';
import type { ChunkStore } from '@margoengine/voxel/stream';

/**
 * A SQLite database as `node:sqlite` `DatabaseSync` (Node 22.5 and later) or `better-sqlite3` give it: `prepare(sql)`
 * returning a statement with `run(...params)` and `get(...params)`. Calls block the thread for as long as SQLite takes.
 */
export interface SqliteDatabase {
  prepare(sql: string): { run(...params: unknown[]): unknown; get(...params: unknown[]): unknown };
}

/** A Postgres connection as the `pg` package's `Client` or `Pool` gives it: `query(sql, params)` with `$1` placeholders. */
export interface PostgresClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: ArrayLike<unknown> }>;
}

/** Options for {@link SqlChunkStore}. */
export interface SqlChunkStoreOptions {
  /**
   * The table the chunks live in, created on first use when missing: letters, digits and `_`, starting with a letter or
   * `_`, at most 63 characters, optionally after one `schema.`. Default `'margo_chunks'`.
   */
  table?: string;
}

// Chunk coordinates are cell >> 5 of a 32-bit cell coordinate: 27-bit signed integers (as VoxelStreamer's stores).
const at = (cx: number, cy: number, cz: number): string => {
  if ([cx, cy, cz].every((c) => typeof c === 'number' && (c << 5) >> 5 === c)) return chunkKey(cx, cy, cz);
  throw new RangeError(`Chunk (${cx}, ${cy}, ${cz}) is not three integers in -2^26..2^26-1; pass cell >> 5`);
};
const NAME = /^(?:[A-Za-z_][A-Za-z0-9_]{0,62}\.)?[A-Za-z_][A-Za-z0-9_]{0,62}$/;

interface Driver {
  run(sql: string, params: unknown[]): unknown;
  get(sql: string, params: unknown[]): unknown;
}
const sqliteDriver = (db: SqliteDatabase): Driver => {
  const statements = new Map<string, ReturnType<SqliteDatabase['prepare']>>(),
    statement = (sql: string) => {
      let s = statements.get(sql);
      if (!s) statements.set(sql, (s = db.prepare(sql)));
      return s;
    };
  return {
    run: (sql, params) => statement(sql).run(...params),
    get: (sql, params) => statement(sql).get(...params),
  };
};
const postgresDriver = (client: PostgresClient): Driver => {
  const numbered = (sql: string) => {
    let n = 0;
    return sql.replace(/\?/g, () => `$${++n}`);
  };
  return {
    run: (sql, params) => client.query(numbered(sql), params),
    get: async (sql, params) => (await client.query(numbered(sql), params)).rows[0],
  };
};

/**
 * A {@link ChunkStore} in one database table: a row per chunk keyed by its chunk coordinates, holding the deflated
 * `encodeChunk` bytes (`cx`, `cy`, `cz` integers, `data` BLOB or BYTEA). Hand it a SQLite database (`node:sqlite`
 * `DatabaseSync`, `better-sqlite3`) or a Postgres `Client` or `Pool` of the `pg` package; the store needs no
 * dependency of its own and you keep opening and closing the database. Pass it as the `store` of a `VoxelServer` and
 * edits survive a restart, for worlds too large for a file per chunk; `VoxelStreamer` takes it too. Calls on one chunk
 * run in order and `get` sees every put and delete made before it. Each put is one upsert, so a crash leaves the old
 * chunk or the new one.
 *
 * ```ts
 * import { DatabaseSync } from 'node:sqlite';
 * import { VoxelServer } from '@margoengine/voxel-net/server';
 * import { SqlChunkStore } from '@margoengine/voxel-net/sql-store';
 * const server = new VoxelServer({ blocks, store: new SqlChunkStore(new DatabaseSync('world.db')) });
 * ```
 */
export class SqlChunkStore implements ChunkStore {
  /** The table the chunks live in. */
  readonly table: string;
  /** Which database it was given: `'sqlite'` (has `prepare`) or `'postgres'` (has `query`). */
  readonly dialect: 'sqlite' | 'postgres';
  readonly #db: Driver;
  readonly #tails = new Map<string, Promise<void>>();
  #ready: Promise<void> | undefined;
  #failure: unknown;
  /** @throws TypeError for a database with neither `prepare` nor `query`, or a table name outside {@link SqlChunkStoreOptions.table}. */
  constructor(database: SqliteDatabase | PostgresClient, options: SqlChunkStoreOptions = {}) {
    const table = options.table ?? 'margo_chunks';
    if (typeof table !== 'string' || !NAME.test(table))
      throw new TypeError(
        `SqlChunkStore table ${JSON.stringify(table)} must be letters, digits and _ (such as "world_chunks"), at most 63 characters`,
      );
    this.table = table;
    if (typeof (database as SqliteDatabase)?.prepare === 'function') {
      this.dialect = 'sqlite';
      this.#db = sqliteDriver(database as SqliteDatabase);
    } else if (typeof (database as PostgresClient)?.query === 'function') {
      this.dialect = 'postgres';
      this.#db = postgresDriver(database as PostgresClient);
    } else
      throw new TypeError(
        'SqlChunkStore expects a SQLite database (node:sqlite DatabaseSync, with prepare) or a pg Client or Pool (with query)',
      );
  }
  /**
   * @throws RangeError or TypeError (rejects) for invalid chunk coordinates or damaged bytes in the row.
   * @throws what the database throws (rejects); a missing row is undefined.
   */
  async get(cx: number, cy: number, cz: number): Promise<VoxelChunk | undefined> {
    const key = at(cx, cy, cz);
    await this.#tails.get(key);
    await this.#table();
    const row = (await this.#db.get(`SELECT data FROM ${this.table} WHERE cx = ? AND cy = ? AND cz = ?`, [
      cx,
      cy,
      cz,
    ])) as { data?: unknown } | undefined;
    if (row === undefined) return undefined;
    if (!(row?.data instanceof Uint8Array))
      throw new TypeError(
        `SqlChunkStore row (${key}) in ${this.table} holds no bytes in data; only SqlChunkStore.put should write this table`,
      );
    return decodeChunk(row.data);
  }
  /**
   * @throws TypeError when `chunk` is not a VoxelChunk; RangeError for invalid chunk coordinates.
   * @throws what the database throws (rejects, and the next {@link SqlChunkStore.flush}).
   */
  put(cx: number, cy: number, cz: number, chunk: VoxelChunk): Promise<void> {
    const key = at(cx, cy, cz);
    if (!(chunk instanceof VoxelChunk)) throw new TypeError('SqlChunkStore.put expects a VoxelChunk');
    const bytes = encodeChunk(chunk); // reads the chunk now, so later edits are not saved
    bytes.catch(() => {}); // the write below reports it
    return this.#queue(key, async () => {
      const data = await bytes;
      await this.#table();
      await this.#db.run(
        `INSERT INTO ${this.table} (cx, cy, cz, data) VALUES (?, ?, ?, ?) ON CONFLICT (cx, cy, cz) DO UPDATE SET data = excluded.data`,
        [cx, cy, cz, data],
      );
    });
  }
  /**
   * @throws RangeError or TypeError for invalid chunk coordinates.
   * @throws what the database throws (rejects, and the next {@link SqlChunkStore.flush}).
   */
  delete(cx: number, cy: number, cz: number): Promise<void> {
    const key = at(cx, cy, cz);
    return this.#queue(key, async () => {
      await this.#table();
      await this.#db.run(`DELETE FROM ${this.table} WHERE cx = ? AND cy = ? AND cz = ?`, [cx, cy, cz]);
    });
  }
  /** @throws what the first failed put or delete since the last flush threw (rejects; the failure is then cleared). */
  async flush(): Promise<void> {
    while (this.#tails.size) await Promise.all(this.#tails.values());
    const failure = this.#failure;
    this.#failure = undefined;
    if (failure) throw failure;
  }
  // Creates the table once; a failure is retried by the next call.
  #table(): Promise<void> {
    if (this.#ready) return this.#ready;
    const sqlite = this.dialect === 'sqlite',
      ready = (async () => {
        await this.#db.run(
          `CREATE TABLE IF NOT EXISTS ${this.table} (cx INTEGER NOT NULL, cy INTEGER NOT NULL, cz INTEGER NOT NULL, data ${sqlite ? 'BLOB' : 'BYTEA'} NOT NULL, PRIMARY KEY (cx, cy, cz))${sqlite ? ' WITHOUT ROWID' : ''}`,
          [],
        );
      })();
    ready.catch(() => {
      if (this.#ready === ready) this.#ready = undefined;
    });
    return (this.#ready = ready);
  }
  #queue(key: string, job: () => Promise<void>): Promise<void> {
    const run = (this.#tails.get(key) ?? Promise.resolve()).then(job),
      tail: Promise<void> = run.then(
        () => this.#settled(key, tail),
        (error) => {
          this.#failure ??= error;
          this.#settled(key, tail);
        },
      );
    this.#tails.set(key, tail);
    return run;
  }
  #settled(key: string, tail: Promise<void>): void {
    if (this.#tails.get(key) === tail) this.#tails.delete(key);
  }
}
