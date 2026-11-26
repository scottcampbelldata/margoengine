// @margoengine/react supports React 18 and 19, whose RefObject differ: 18's is { readonly current: T | null }, 19's is
// { current: T }. A hook typed to return RefObject<T | null> types only under 19, so <Box ref={useIntersect(...)} />
// failed the packed React 18 README check (react-45-readme.tsx, TS2322). A returned ref is typed { current: T | null },
// which both versions' ref props accept.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

const dir = new URL('../dist/', import.meta.url);

test('no public function returns a React RefObject, whose shape differs between React 18 and 19', () => {
  const offenders = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.d.ts'))) {
    const text = readFileSync(new URL(file, dir), 'utf8').replace(/\s+/g, ' ');
    for (const m of text.matchAll(/export (?:declare )?function (\w+)[^;{]*?\)\s*:\s*(?:React\.)?RefObject</g))
      offenders.push(`${file}: ${m[1]}`);
  }
  assert.deepEqual(offenders, [], 'return { current: T | null } instead');
});

test('useIntersect returns a plain ref object', () => {
  const types = readFileSync(new URL('intersect.d.ts', dir), 'utf8').replace(/\s+/g, ' ');
  assert.match(types, /useIntersect<[^>]*>\(onChange: \(visible: boolean\) => void\): \{ current: T \| null; \}/);
});
