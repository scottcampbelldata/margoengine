// Run in a child: an owned worker or socket leak must fail the parent's process-exit assertion.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { SqlChunkStore } from '../dist/sql-store.js';
import { sqlFixture } from './sql-fixture.js';

const stage = process.argv[2], fixture = await sqlFixture();
const injected = new Error(`injected after ${stage}`);
try {
  await assert.rejects(async () => {
    if (stage === 'directory') throw injected;
    const { db } = fixture.database();
    if (stage === 'database') throw injected;
    const { url } = await fixture.start({ store: new SqlChunkStore(db) });
    if (stage === 'server') throw injected;
    const { client } = await fixture.join(url);
    if (stage === 'client') throw injected;
    const deadline = performance.now() + 10_000;
    while (!client.spawned && performance.now() < deadline) await new Promise((done) => setTimeout(done, 16));
    assert.ok(client.spawned);
    throw injected;
  }, (error) => error === injected);
} finally {
  await fixture.close();
}
assert.equal(existsSync(fixture.directory), false, 'database closed before its directory is removed');
