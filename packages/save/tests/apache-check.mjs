// Real proof of remoteStorage against a server that is not ours: Apache HTTP Server with mod_dav. Pass a folder URL that
// allows PUT and DELETE; the keys below are written and removed. Run by hand, as it needs that server:
//   node packages/save/tests/apache-check.mjs http://127.0.0.1:18480/saves
// Apache sends no ETag with a PUT, and a weak tag for a file changed in the last second, so this waits out that second.
import assert from 'node:assert/strict';
import { remoteStorage } from '../dist/remote.js';

const url = process.argv[2],
  text = (bytes) => new TextDecoder().decode(bytes),
  bytes = (value) => new TextEncoder().encode(value),
  settle = () => new Promise((resolve) => setTimeout(resolve, 1200)), // fixed-wait: Apache's tag goes strong a second after a change, and nothing signals it
  one = remoteStorage({ url }),
  two = remoteStorage({ url });
assert.ok(url, 'pass the folder URL');
assert.equal(await one.read('margo check'), null);

await one.write('margo check', bytes('first'));
await settle();
assert.equal(text(await two.read('margo check')), 'first');

await one.write('margo check', bytes('from one'));
await settle();
await assert.rejects(two.write('margo check', bytes('from two')), (error) => error.code === 'state');
assert.equal(text(await two.read('margo check')), 'from one');

await two.write('margo check', bytes('from two'));
await assert.rejects(two.write('margo check', bytes('too soon')), (error) => error.code === 'unsupported');
await settle();
await two.write('margo check', bytes('settled'));
await settle();

const merging = remoteStorage({ url, conflict: ({ local, remote }) => bytes(`${text(remote)}+${text(local)}`) });
await merging.write('margo check', bytes('merged'));
await settle();
assert.equal(text(await one.read('margo check')), 'settled+merged');
assert.equal(await one.delete('margo check'), true);
assert.equal(await one.read('margo check'), null);
console.log('apache-check passed');
