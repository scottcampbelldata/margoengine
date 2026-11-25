// GAP-FILM-RESET: every engine clock (a class with `advanceTime(delta)`, the clocks `@margoengine/cutscene/seek`
// replays) gets `resetTime()`, so `resetClocks` can put a world back to 0 in one process. The clocks that have none
// yet are pinned in tests/film-reset-pending.json, so the list only shrinks: a new clock without `resetTime` fails
// here, and so does a pinned one that gained it (take it off the list).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = new URL('..', import.meta.url),
  packages = new URL('packages/', root);

function* sources(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* sources(path);
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) yield path;
  }
}

/** `package/src/file.ts:Class` for each class with an `advanceTime` method and no `resetTime` of its own. */
export function pendingClocks() {
  const out = [];
  for (const pkg of readdirSync(packages)) {
    const src = join(fileURLToPath(packages), pkg, 'src');
    try {
      if (!statSync(src).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const file of sources(src)) {
      const code = readFileSync(file, 'utf8').replace(/\r\n/g, '\n'),
        classes = [...code.matchAll(/^(?:export )?(?:abstract )?class (\w+)/gm)];
      for (let i = 0; i < classes.length; i++) {
        const body = code.slice(classes[i].index, classes[i + 1]?.index ?? code.length);
        if (/^ {2}advanceTime\(delta[^)]*\)[^;{]*\{/m.test(body) && !/^ {2}resetTime\(\)[^;{]*\{/m.test(body))
          out.push(
            `${pkg}/src/${file
              .slice(src.length + 1)
              .split(sep)
              .join('/')}:${classes[i][1]}`,
          );
      }
    }
  }
  return out.sort();
}

test('the clocks without resetTime are the pinned list, which only shrinks (GAP-FILM-RESET)', () => {
  const pinned = JSON.parse(readFileSync(new URL('tests/film-reset-pending.json', root), 'utf8')).pending,
    now = pendingClocks();
  assert.deepEqual(
    now.filter((c) => !pinned.includes(c)),
    [],
    'a clock with advanceTime and no resetTime: give it resetTime (GAP-FILM-RESET)',
  );
  assert.deepEqual(
    pinned.filter((c) => !now.includes(c)),
    [],
    'these clocks reset now: take them off tests/film-reset-pending.json',
  );
});
