// KB1942c: which specifier a prim composes to when a class and a weaker `def` both reach it through class arcs. The
// specification does not say, so the rule was pinned black-box: each stage below is ours, composed by OpenUSD 26.11
// (usd-core from PyPI, run where it lives, its source never read), and the expected specifier is the one
// `Usd.Prim.GetSpecifier()` printed. A class reached by an inherit gives way to a weaker `def`; a class reached through a
// specializes arc does not, even when the `def` comes through a weaker specializes arc. Stage 35 of the seed 1942 stress
// stages reduces to the first case.
import assert from 'node:assert/strict';
import test from 'node:test';
import { composeUSDFiles } from '../dist/compose.js';

const encoder = new TextEncoder();
/** /R/b reaches /C with `outer`, so /R/b/c reaches the `def` /C/c; /R/b/c reaches the class `target` with `inner`. */
const stage = (outer, inner, target) => `#usda 1.0
class "C"
{
    def "c"
    {
    }
}
class "D"
{
}
def "R"
{
    def "b" (
        ${outer} = </C>
    )
    {
        over "c" (
            ${inner} = <${target}>
        )
        {
        }
    }
}
`;
// [arc on /R/b, arc on /R/b/c, its target, OpenUSD's specifier of /R/b/c: true for def, false for class]
const cases = [
  ['specializes', 'specializes', '/C', false],
  ['specializes', 'specializes', '/D', false],
  ['inherits', 'inherits', '/D', true],
  ['specializes', 'inherits', '/D', true],
  ['inherits', 'specializes', '/D', true],
  ['inherits', 'inherits', '/C', true],
];

test('a class reached through specializes stays a class before a weaker def, as OpenUSD composes it', async () => {
  for (const [outer, inner, target, isDef] of cases) {
    const text = stage(outer, inner, target);
    const { specs } = await composeUSDFiles('root.usda', (id) => (id === 'root.usda' ? encoder.encode(text) : undefined));
    // A class is not a composed prim of the stage, as OpenUSD's default traversal leaves it out.
    assert.equal(specs['/R/b/c']?.fields.specifier, isDef ? 0 : undefined, `${outer} then ${inner} ${target}`);
    assert.equal(specs['/R/b']?.fields.specifier, 0);
  }
});
