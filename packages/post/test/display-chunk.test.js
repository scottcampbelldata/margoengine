// KB-SIZE-STRAIGHT1: PostStack and the LDR effects that load it read only the display curve from shared/display.js.
// The straight-colour rewrite for premultiplied canvases (KB-POST-ALPHARIM1) lived in the same module, so the shared
// display chunk every one of them downloads carried straightDisplay and displayFor, which none of them calls. It lives
// in shared/straight-display.js now; no static import graph of these entries may hold it. (The sizes gate measures
// each entry's own file, so this changes no gate figure; it is bytes on the wire.)
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const dist = new URL('../dist/', import.meta.url);
const graph = (file, seen = new Set()) => {
  if (seen.has(file)) return seen;
  seen.add(file);
  const code = readFileSync(new URL(file, dist), 'utf8');
  for (const [, next] of code.matchAll(/(?:import|export)\s*[^'"]*?from\s*["']\.\/([^"']+)["']/g))
    if (existsSync(new URL(next, dist))) graph(next, seen);
  return seen;
};

test('PostStack and the LDR effects carry no straight-colour display rewrite', () => {
  for (const entry of ['stack.js', 'glitch.js', 'halftone.js', 'stylize.js', 'outline.js']) {
    const files = [...graph(entry)];
    assert.ok(files.length > 1, `${entry} imports its chunks`);
    for (const file of files)
      assert.doesNotMatch(readFileSync(new URL(file, dist), 'utf8'), /toDisplayStraight/, `${entry} -> ${file}`);
  }
});

test('the display effects still bundle it', () => {
  const files = [...graph('bloom.js')];
  assert.ok(files.some((file) => /toDisplayStraight/.test(readFileSync(new URL(file, dist), 'utf8'))));
});
