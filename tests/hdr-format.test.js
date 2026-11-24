// Bug (bug sweep L3, from lane L4): about 30 places treated a pass's target as linear HDR only when its format was
// exactly rgba16float, so over PostStack's rg11b10ufloat capture (the WebGL2 layer's HDR capture) sky, terrain, water
// and the rest display-encoded light that was still to be tonemapped and drew up to 19/255 brighter. One shared check,
// linearHdr in packages/shared/hdr-format.js, decides it; this test keeps the exact comparison from coming back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { linearHdr } from '../packages/shared/hdr-format.js';

test('linearHdr holds for every float colour format and no other', () => {
  for (const f of ['rgba16float', 'rgba32float', 'rg11b10ufloat', 'r16float', 'rg16float', 'r32float', 'rg32float'])
    assert.equal(linearHdr(f), true, f);
  for (const f of ['rgba8unorm', 'bgra8unorm', 'rgba8unorm-srgb', 'bgra8unorm-srgb', 'rgb10a2unorm', 'r8unorm', '', undefined])
    assert.equal(linearHdr(f), false, String(f));
});

test("no package source decides HDR output from a pass format compared with 'rgba16float' alone", () => {
  const found = [];
  const pass = /\b(?:c|context|ctx)\.format\s*[!=]==?\s*['"]rgba16float['"]/;
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|js|mjs)$/.test(name) && !name.endsWith('.d.ts'))
        readFileSync(path, 'utf8')
          .split('\n')
          .forEach((line, i) => pass.test(line) && found.push(`${path}:${i + 1}: ${line.trim()}`));
    }
  };
  for (const pkg of readdirSync('packages')) {
    try {
      if (statSync(join('packages', pkg, 'src')).isDirectory()) walk(join('packages', pkg, 'src'));
    } catch {}
  }
  assert.deepEqual(found, [], 'use linearHdr from packages/shared/hdr-format.js');
});
