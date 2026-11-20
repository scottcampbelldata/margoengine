// KB1942c: one class site reached twice in a prim index, once by a class arc carried down from the parent prim and once
// by an arc placed for the prim itself. The specification does not say which one holds it, so the rule was pinned
// black-box: each stage below is ours, composed by OpenUSD 26.11 (usd-core from PyPI, run where it lives, its source never
// read), and the expected value is the one `Usd.Attribute.Get()` printed; the public prim index dump marked the later arc
// inert. The carried arc keeps the site and its own place: an inherit carried down makes the class stronger than the
// variant that authors the later arc (28), a specializes carried down keeps it weaker (634), whichever arc comes later.
// Stage 25 of the seed 1942 stress stages reduces to the first case.
import assert from 'node:assert/strict';
import test from 'node:test';
import { composeUSDFiles } from '../dist/compose.js';

const encoder = new TextEncoder();
/** /M's variant y gives /M/a a payload to l0.usda's /M, whose `carried` arc to /C reaches /M/a/a; its variant `later`s /C/a. */
const stage = (carried, later) => ({
  'root.usda': '#usda 1.0\n(\n    subLayers = [@./l1.usda@ (offset = 7), @./l0.usda@]\n)\n',
  'l0.usda': `#usda 1.0
(
    defaultPrim = "M"
)
class "C"
{
    def "a"
    {
        custom double v1 = 28
    }
}
def "M" (
    ${carried} = </C>
)
{
}
`,
  'l1.usda': `#usda 1.0
def "M" (
    variantSets = "vs"
    variants = { string vs = "y" }
)
{
    variantSet "vs" = {
        "y" {
            def "a" (
                payload = @./l0.usda@ (offset = 3; scale = 2)
                variantSets = "vs"
                variants = { string vs = "y" }
            )
            {
                variantSet "vs" = {
                    "y" {
                        def "a" (
                            ${later} = </C/a>
                        )
                        {
                            custom double v1 = 634
                        }
                    }
                }
            }
        }
    }
}
`,
});
// [arc on l0's /M, arc on /M{vs=y}a{vs=y}a, OpenUSD's /M/a/a.v1]
const cases = [
  ['append inherits', 'specializes', 28],
  ['append inherits', 'inherits', 28],
  ['specializes', 'specializes', 634],
  ['specializes', 'inherits', 634],
];

test('a class site carried down from the parent prim keeps its place before a later arc to it, as OpenUSD has it', async () => {
  for (const [carried, later, v1] of cases) {
    const files = stage(carried, later);
    const { specs } = await composeUSDFiles('root.usda', (id) => {
      const text = files[id.replace(/^\.\//, '')];
      return text === undefined ? undefined : encoder.encode(text);
    });
    assert.equal(specs['/M/a/a.v1']?.fields.default, v1, `${carried} then ${later}`);
  }
});
