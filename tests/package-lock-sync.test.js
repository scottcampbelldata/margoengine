// ec2429404: a workspace's package.json moved dependencies while the lock kept the old set, so `npm install` rewrote the
// lock in every checkout and `npm ci` could refuse it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));

test('package-lock.json lists each workspace with the dependencies of its package.json', () => {
  const lock = read('package-lock.json').packages,
    wrong = [];
  for (const [path, entry] of Object.entries(lock)) {
    if (!path || path.includes('node_modules') || entry.link) continue;
    let own;
    try {
      own = read(`${path}/package.json`);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'])
      for (const name of new Set([...Object.keys(own[field] ?? {}), ...Object.keys(entry[field] ?? {})]))
        if (own[field]?.[name] !== entry[field]?.[name])
          wrong.push(`${path} ${field} ${name}: package.json ${own[field]?.[name]}, lock ${entry[field]?.[name]}`);
  }
  assert.deepEqual(wrong, [], 'run npm install --ignore-scripts');
});
