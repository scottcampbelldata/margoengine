// The GLSL front end moved from this package into @margoengine/shader (src/glsl) behind the GLSLHost interface.
// The snapshot holds the WGSL (or the error) this package produced for every source its tests translate, taken on the
// parent commit of that move. A transition's emitted WGSL must stay byte-identical to it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { translateGLSLTransition } from '../dist/glsl.js';
import { glslFixtures } from './glsl-fixtures.js';
const golden = JSON.parse(readFileSync(new URL('./snapshots/glsl-transition-wgsl.json', import.meta.url), 'utf8'));
const options = (g) => ({ ...(g.uniforms ? { uniforms: g.uniforms } : {}), ...(g.flipY === undefined ? {} : { flipY: g.flipY }) });
test('every recorded GLSL source translates to the byte-identical WGSL (or the same error)', () => {
  assert.ok(golden.length >= 79, 'the snapshot holds the recorded sources');
  for (const g of golden) {
    if (g.error !== undefined) {
      assert.throws(
        () => translateGLSLTransition(g.source, options(g)),
        (e) => `${e.code} ${e.message}` === g.error,
        String(g.source).slice(0, 80),
      );
    } else assert.equal(translateGLSLTransition(g.source, options(g)), g.wgsl, String(g.source).slice(0, 80));
  }
});
test('every GLSL fixture of this package is in the snapshot', () => {
  const sources = new Set(golden.map((g) => JSON.stringify([g.source, g.uniforms ?? null])));
  for (const f of glslFixtures) assert.ok(sources.has(JSON.stringify([f.source, f.uniforms ?? null])), f.name);
});
