// `npm ci` on npm 11 printed "1 package has install scripts not yet covered by allowScripts ... Run `npm approve-scripts`"
// at the end of a clean install (webgpu's postinstall; fsevents on macOS). A new reader took it for a failed install
// and a step to do. Every dependency with an install script is now reviewed and pinned in package.json allowScripts,
// so the README's `npm ci` ends clean, and a dependency bump that brings a new or changed install script fails here
// until someone reviews it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = join(import.meta.dirname, '..');
const read = (file) => JSON.parse(readFileSync(join(root, file), 'utf8'));

test('every locked dependency with an install script is reviewed in allowScripts, pinned to its locked version', () => {
  const allow = read('package.json').allowScripts ?? {},
    lock = read('package-lock.json');
  const scripted = Object.entries(lock.packages)
    .filter(([path, entry]) => path.includes('node_modules/') && entry.hasInstallScript)
    .map(([path, entry]) => `${path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length)}@${entry.version}`);
  assert.ok(scripted.length > 0, 'the lock file still marks install scripts');
  for (const id of scripted) assert.equal(typeof allow[id], 'boolean', `${id} is reviewed in package.json allowScripts`);
  for (const id of Object.keys(allow)) assert.ok(scripted.includes(id), `allowScripts entry ${id} matches a locked package`);
});
