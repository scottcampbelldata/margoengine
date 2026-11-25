// `@margoengine/materials/texture` gives Texture and CubeTexture without the Material pipeline: an entry that only
// samples images (video frames, mips, soot) must not statically load the glTF material entries, which the
// sizes gate counts as a leak once they pass 10,000 B gzip.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as root from '@margoengine/materials';
import * as entry from '@margoengine/materials/texture';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');

/** Every bare specifier a dist file loads statically, following its relative imports. */
function staticBare(file, seen = new Set(), out = new Set()) {
  if (seen.has(file)) return out;
  seen.add(file);
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/(?:^|[;\n])\s*(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']/g)) {
    const spec = m[1];
    if (spec.startsWith('.')) staticBare(join(dirname(file), spec), seen, out);
    else out.add(spec);
  }
  for (const m of text.matchAll(/(?:^|[;\n])\s*import\s*["']([^"']+)["']/g))
    if (m[1].startsWith('.')) staticBare(join(dirname(file), m[1]), seen, out);
    else out.add(m[1]);
  return out;
}

test('the texture entry loads no glTF entry and no Material code', () => {
  const bare = [...staticBare(join(dist, 'texture.js'))];
  assert.deepEqual(
    bare.filter((s) => !/^@margoengine\/(math(\/|$)|core\/extension$)/.test(s)),
    [],
    'texture.js may load only math and core/extension',
  );
  for (const name of ['mips.js', 'soot.js'])
    assert.ok(
      ![...staticBare(join(dist, name))].some((s) => s.startsWith('@margoengine/gltf/extended-materials')),
      `${name} loads gltf/extended-materials`,
    );
});

test('the texture entry exports the same classes as the package root', () => {
  for (const name of ['Texture', 'CubeTexture', 'loadTexture', 'loadKTX2Texture', 'loadCubeTexture'])
    assert.equal(entry[name], root[name], name);
  const t = new entry.Texture({ data: new Uint8Array(4), width: 1, height: 1 });
  assert.ok(t instanceof root.Texture);
  t.dispose();
});
