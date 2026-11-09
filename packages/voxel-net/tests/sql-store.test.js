// SqlChunkStore (a ChunkStore in a SQLite or Postgres table) and the VoxelServer `store` option taking it: edits
// survive a restart and a client sees them. Postgres is driven through a pg-shaped client over node:sqlite, so the
// Postgres SQL ($n placeholders, BYTEA, the upsert) runs for real without a Postgres server.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { VoxelChunk, VoxelWorld } from '@margoengine/voxel';
import { VoxelNetClient } from '../dist/index.js';
import { connectWebSocket, VoxelServer } from '../dist/server.js';
import { SqlChunkStore } from '../dist/sql-store.js';
import { testBlocks } from './blocks.js';

const blocks = testBlocks(),
  LOG = blocks.id('log'),
  FLAT = { amplitude: 0, caves: 0, trees: 0, height: 8, seaLevel: -10 },
  pause = () => new Promise((done) => setTimeout(done, 16));

async function folder(t) {
  const dir = await mkdtemp(pathJoin(tmpdir(), 'margo-sql-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const chunkWith = (x, y, z, state) => {
  const chunk = new VoxelChunk();
  chunk.set(x, y, z, state);
  return chunk;
};
// A pg-shaped client: async query(sql, params) with $1 placeholders, rows as objects. SQLite reads $n as a named
// parameter, so they become its numbered ?n; everything else in the SQL is what Postgres would get.
function fakePostgres(db) {
  const log = [];
  return {
    log,
    async query(sql, params = []) {
      log.push(sql);
      await Promise.resolve();
      const statement = db.prepare(sql.replace(/\$(\d+)/g, '?$1'));
      return statement.columns().length ? { rows: statement.all(...params) } : (statement.run(...params), { rows: [] });
    },
  };
}

for (const [dialect, open] of [
  ['sqlite', (db) => db],
  ['postgres', (db) => fakePostgres(db)],
]) {
  test(`SqlChunkStore on ${dialect} keeps a row per chunk, and get sees every put and delete before it`, async () => {
    const db = new DatabaseSync(':memory:'),
      store = new SqlChunkStore(open(db));
    assert.equal(store.dialect, dialect);
    assert.equal(await store.get(0, 0, 0), undefined, 'nothing stored yet (and the table is made)');
    const first = chunkWith(1, 2, 3, 5),
      put = store.put(-1, 4, 7, first);
    first.set(1, 2, 3, 9); // after put returns: not saved
    assert.equal((await store.get(-1, 4, 7)).get(1, 2, 3), 5, 'the chunk as it was when put was called');
    await put;
    store.put(-1, 4, 7, chunkWith(0, 0, 0, 6)); // not awaited: the next get still sees it
    assert.equal((await store.get(-1, 4, 7)).get(0, 0, 0), 6);
    assert.equal((await store.get(-1, 4, 7)).get(1, 2, 3), 0, 'the upsert replaced the row');
    store.delete(-1, 4, 7);
    assert.equal(await store.get(-1, 4, 7), undefined, 'deleted');
    await store.put(2 ** 26 - 1, -(2 ** 26), 0, chunkWith(31, 31, 31, 3));
    await store.flush();
    assert.deepEqual(
      db
        .prepare('SELECT cx, cy, cz FROM margo_chunks')
        .all()
        .map((r) => [r.cx, r.cy, r.cz]),
      [[2 ** 26 - 1, -(2 ** 26), 0]],
      'one row per chunk, keyed by its coordinates',
    );
    const again = new SqlChunkStore(open(db));
    assert.equal((await again.get(2 ** 26 - 1, -(2 ** 26), 0)).get(31, 31, 31), 3, 'a second store reads the table');
    await again.delete(2 ** 26 - 1, -(2 ** 26), 0);
    await again.delete(2 ** 26 - 1, -(2 ** 26), 0); // deleting what is not there is fine
    assert.equal(db.prepare('SELECT count(*) AS n FROM margo_chunks').get().n, 0);
  });
}

test('the Postgres path sends $n placeholders and a BYTEA column; two tables share one database', async () => {
  const db = new DatabaseSync(':memory:'),
    pg = fakePostgres(db),
    a = new SqlChunkStore(pg),
    b = new SqlChunkStore(pg, { table: 'other_world' });
  await a.put(0, 0, 0, chunkWith(0, 0, 0, 1));
  await b.put(0, 0, 0, chunkWith(0, 0, 0, 2));
  assert.equal((await a.get(0, 0, 0)).get(0, 0, 0), 1);
  assert.equal((await b.get(0, 0, 0)).get(0, 0, 0), 2, 'each store keeps to its table');
  assert.ok(pg.log.some((sql) => /CREATE TABLE IF NOT EXISTS margo_chunks .*data BYTEA NOT NULL/.test(sql)));
  assert.ok(
    pg.log.every((sql) => !sql.includes('?')),
    'no ? placeholders reach Postgres',
  );
  assert.ok(pg.log.some((sql) => sql.includes('VALUES ($1, $2, $3, $4) ON CONFLICT (cx, cy, cz)')));
  assert.equal(pg.log.filter((sql) => sql.startsWith('CREATE')).length, 2, 'each table is made once');
});

test('SqlChunkStore names its misuse and reports database failures from put and the next flush only', async () => {
  assert.throws(() => new SqlChunkStore({}), TypeError);
  assert.throws(() => new SqlChunkStore(undefined), TypeError);
  for (const table of ['', '1st', 'chunks; DROP TABLE x', 'a.b.c', 'x'.repeat(64), 7])
    assert.throws(() => new SqlChunkStore(new DatabaseSync(':memory:'), { table }), TypeError, String(table));
  assert.equal(new SqlChunkStore(new DatabaseSync(':memory:'), { table: 'game.world_2' }).table, 'game.world_2');
  const db = new DatabaseSync(':memory:'),
    store = new SqlChunkStore(db);
  assert.throws(() => store.put(0.5, 0, 0, new VoxelChunk()), RangeError);
  assert.throws(() => store.put(2 ** 26, 0, 0, new VoxelChunk()), RangeError);
  assert.throws(() => store.put(0, 0, 0, {}), TypeError);
  await assert.rejects(() => store.get(0, '1', 0), RangeError);
  assert.throws(() => store.delete(NaN, 0, 0), RangeError);
  // Damaged bytes are an error, not a missing chunk; so is a row whose data is not bytes.
  await store.flush();
  await store.get(0, 0, 0);
  db.prepare('INSERT INTO margo_chunks VALUES (0, 0, 0, ?)').run(Uint8Array.of(1, 2, 3));
  await assert.rejects(() => store.get(0, 0, 0), RangeError);
  db.prepare("INSERT INTO margo_chunks VALUES (1, 0, 0, 'text')").run();
  await assert.rejects(() => store.get(1, 0, 0), /holds no bytes/);
  // A closed database: put rejects, the next flush rejects once, then flush is clean again.
  db.close();
  await assert.rejects(() => store.put(0, 0, 0, new VoxelChunk()));
  await assert.rejects(() => store.flush());
  await store.flush();
});

test('a table that cannot be made is retried by the next call', async () => {
  const db = new DatabaseSync(':memory:'),
    pg = fakePostgres(db);
  let refuse = true;
  const flaky = {
      async query(sql, params) {
        if (refuse && sql.startsWith('CREATE')) throw new Error('database starting up');
        return pg.query(sql, params);
      },
    },
    store = new SqlChunkStore(flaky);
  await assert.rejects(() => store.get(0, 0, 0), /starting up/);
  refuse = false;
  await store.put(0, 0, 0, chunkWith(1, 1, 1, 4));
  assert.equal((await store.get(0, 0, 0)).get(1, 1, 1), 4);
  await store.flush(); // the get's failure is not a put's: flush stays clean
});

function database(file, resources) {
  const db = new DatabaseSync(file);
  resources.defer(() => {
    if (db.isOpen) db.close();
  });
  return db;
}
async function start(options, resources) {
  const server = new VoxelServer({ blocks, workers: 2, generator: FLAT, spawn: () => [8, 8], ...options });
  resources.defer(() => server.close());
  const { port } = await server.listen(0);
  return { server, url: `ws://127.0.0.1:${port}` };
}
async function join(url) {
  const conn = await connectWebSocket(url),
    world = new VoxelWorld({ blocks }),
    client = new VoxelNetClient(world, { send: (d) => conn.send(d), close: () => conn.close() }, { view: 2 });
  conn.onmessage = (d) => client.receive(d);
  return { client, conn, world };
}
async function drive(client, done, ms = 10_000) {
  const end = performance.now() + ms;
  let last = performance.now();
  while (performance.now() < end && !done()) {
    await pause();
    const now = performance.now();
    client.update((now - last) / 1000, { keys: 0, yaw: 0, pitch: 0 });
    last = now;
  }
  return done();
}

test('a server on a SqlChunkStore keeps edits across a restart and a client sees them', {
  timeout: 60_000,
}, async (t) => {
  await using resources = new AsyncDisposableStack();
  const file = pathJoin(await folder(t), 'world.db'),
    cells = [
      [8, 12, 8],
      [40, 12, 8],
    ],
    firstDb = database(file, resources),
    first = await start({ store: new SqlChunkStore(firstDb) }, resources),
    a = await join(first.url);
  resources.defer(() => a.client.close());
  assert.ok(await drive(a.client, () => a.client.spawned), 'first client spawned');
  for (const [x, y, z] of cells) first.server.world.setBlock(x, y, z, LOG);
  a.client.close();
  const errors = [];
  first.server.onError = (e) => errors.push(e);
  await first.server.close(); // saves the edited chunks
  assert.deepEqual(errors, []);
  assert.deepEqual(
    firstDb
      .prepare('SELECT cx, cy, cz FROM margo_chunks ORDER BY cx')
      .all()
      .map((r) => `${r.cx},${r.cy},${r.cz}`),
    ['0,0,0', '1,0,0'],
  );
  firstDb.close();

  // A new server on the same database file: nothing was edited in this process.
  const secondDb = database(file, resources),
    second = await start({ store: new SqlChunkStore(secondDb) }, resources);
  const b = await join(second.url);
  resources.defer(() => b.client.close());
  assert.ok(await drive(b.client, () => b.client.spawned), 'second client spawned');
  for (const cell of cells) assert.equal(second.server.world.getBlock(...cell), LOG, `server holds ${cell}`);
  assert.ok(
    await drive(b.client, () => cells.every((c) => b.world.getBlock(...c) === LOG)),
    'the client sees the edits',
  );
  assert.equal(b.world.getBlock(9, 12, 8), 0, "next to them the world is the generator's");
  b.client.close();
});

test('failed SQL integration setup closes its database, listener and generator workers before folder cleanup', async (t) => {
  const file = pathJoin(await folder(t), 'failed.db');
  let db;
  await assert.rejects(async () => {
    await using resources = new AsyncDisposableStack();
    db = database(file, resources);
    await start({ store: new SqlChunkStore(db) }, resources);
    throw new Error('deliberate failure after listening');
  }, /deliberate failure after listening/);
  assert.equal(db.isOpen, false);
  // Windows refuses this while SQLite is open. The suite's process deadline also detects leaked workers/listeners.
  await rm(file);
});
