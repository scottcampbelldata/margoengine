// Regression (KB5875a, 2026-11-11): the WebGL2 twin of core's direct light used the separable Smith G of the 2021 glTF
// Appendix B; it now evaluates the height-correlated G2 of Heitz 2014 eq. 99, as core's WGSL does, so both backends
// shade a mesh the same.
import test from 'node:test';
import assert from 'node:assert/strict';
import { GLRenderer } from '../dist/preview.js';
import { correlatedG2, shaderExpression, smithGrid } from '../../../tests/support/smith-reference.js';

test("the WebGL2 preview's direct light uses the height-correlated Smith G2, as core does", () => {
  const sources = [];
  const gl = new Proxy(
    {
      NO_ERROR: 0,
      getError: () => 0,
      isContextLost: () => false,
      getShaderParameter: () => true,
      getProgramParameter: () => true,
      shaderSource: (_shader, source) => sources.push(source),
    },
    { get: (target, key) => (key in target ? target[key] : () => ({})) },
  );
  new GLRenderer({ getContext: () => gl });
  const fragment = sources.find((source) => source.includes('float g='));
  assert.ok(fragment, 'the fragment shader declares g');
  const g = shaderExpression(/float g=([^;]+);/.exec(fragment)[1], ['nl', 'nv', 'a2']);
  for (const [nl, nv, a2] of smithGrid())
    assert.ok(Math.abs(g(nl, nv, a2) - correlatedG2(nl, nv, a2)) < 1e-12, `G at nl ${nl}, nv ${nv}, a2 ${a2}`);
});
