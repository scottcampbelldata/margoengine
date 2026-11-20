// KB1942c: two variant sets reach one class site, one authored on the site itself (/C/a) and one carried down from its
// parent (/C). Core Specification, Strength Ordering: between arcs of one kind the one authored deeper in namespace is
// stronger, so the set on /C/a beats the set on /C. Pinned black-box: each stage below is ours, composed by OpenUSD 26.11
// (usd-core from PyPI, run where it lives, its source never read); `Usd.Attribute.Get()` printed 2 for /Q.v and
// `GetPrimStack()` listed /C/a{ws=z} before /C{vs=y}a for every arc. Margo ranked both sets by the depth of the stage
// prim, a tie, and took the carried set first. Seen in seed 1942 stress stages 103 and 141 (prim stacks only).
import assert from 'node:assert/strict';
import test from 'node:test';
import { composeUSDFiles } from '../dist/compose.js';

const encoder = new TextEncoder();
const stage = (arc) => `#usda 1.0
class "C" (
    variantSets = "vs"
    variants = { string vs = "y" }
)
{
    variantSet "vs" = {
        "y" {
            def "a"
            {
                custom double v = 1
            }
        }
    }
    over "a" (
        variantSets = "ws"
        variants = { string ws = "z" }
    )
    {
        variantSet "ws" = {
            "z" {
                custom double v = 2
            }
        }
    }
}
def "Q" (
    ${arc} = </C/a>
)
{
}
`;

test('a variant set on a class site beats one carried down from its parent, as OpenUSD has it', async () => {
  for (const arc of ['inherits', 'references', 'specializes']) {
    const text = encoder.encode(stage(arc));
    const { specs } = await composeUSDFiles('root.usda', (id) => (id === 'root.usda' ? text : undefined));
    assert.equal(specs['/Q.v']?.fields.default, 2, arc);
  }
});
