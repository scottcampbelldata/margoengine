// KB1942c: where an implied class arc stops. The specification does not say, so the rules were pinned black-box: each
// stage below is ours, composed by OpenUSD 26.11 (usd-core from PyPI, run where it lives, its source never read), and
// the expected children are the ones `Usd.Prim.GetChildren()` printed; the public prim index dump
// (`Usd.Prim.GetPrimIndex().DumpToString()`) showed why. A class arc authored in a variant implies nothing above a node of
// its own stack that already holds the same site; and a specializes arc whose site an inherit of the same stack already
// reaches implies nothing upstream unless its node has another class arc of its own. Stage 50 of the seed 1942 stress
// stages reduces to the first family, stage 57 to the second.
import assert from 'node:assert/strict';
import test from 'node:test';
import { composeUSDFiles } from '../dist/compose.js';

const encoder = new TextEncoder();
const children = async (files, prim) => {
  const { specs } = await composeUSDFiles('root.usda', (id) => {
    const text = files[id.replace(/^\.\//, '')];
    return text === undefined ? undefined : encoder.encode(text);
  });
  return Object.keys(specs)
    .filter((p) => specs[p].specType === 6 && p.startsWith(prim + '/') && !p.slice(prim.length + 1).includes('/'))
    .map((p) => p.split('/').at(-1));
};

const classes = `#usda 1.0
class "C"
{
    def "a" (
        variantSets = "vs"
        variants = { string vs = "y" }
    )
    {
        variantSet "vs" = {
            "y" {
                def "c"
                {
                }
            }
        }
    }
}
`;
/** /P/b/b references l1.usda's /M; l1 specializes /M/c/b, l0 (its sublayer) inherits /M/c and, maybe in a variant, /M/c/b. */
const first = ({ outer = true, variant = true, specializes = true, select = false, offset = true }) => {
  const inner = 'def "b" (\n    append inherits = </C/a>\n)\n{\n}\n';
  const body = variant ? `variantSet "vs" = {\n"y" {\n${inner}}\n}\n` : inner;
  return {
    'root.usda': `${classes}def "P"
{
    def "b"
    {
        def "b" (
            append references = @./l1.usda@</M>
        )
        {
${select ? '            over "c" (\n                variants = { string vs = "y" }\n            )\n            {\n            }\n' : ''}        }
    }
}
`,
    'l0.usda': `#usda 1.0\ndef "M"\n{\nover "c" (\n${outer ? 'append inherits = </C/a>' : ''}\n${variant ? 'variantSets = "vs"' : ''}\n)\n{\n${body}}\n}\n`,
    'l1.usda': `#usda 1.0\n(\nsubLayers = [@./l0.usda@${offset ? ' (offset = 5)' : ''}]\n)\ndef "M"\n{\ndef "c"\n{\nover "b" (\n${specializes ? 'specializes = </C/a>' : ''}\n)\n{\n}\n}\n}\n`,
  };
};
/** /Q/a/a references l1.usda's default prim /M and selects its variant, which inherits /C on /M/c; /M/c specializes /C. */
const second = ({ inherit = true, inL1 = false }) => ({
  'root.usda': `#usda 1.0
class "C"
{
    def "a"
    {
        def "a"
        {
        }
    }
}
def "Q"
{
    def "a"
    {
        def "a" (
            append references = @./l1.usda@
            variants = { string vs = "y" }
        )
        {
        }
    }
}
`,
  'l0.usda': `#usda 1.0\ndef "M"\n{\nover "c" (\n${inherit ? 'inherits = </C/a>\n' : ''}${inL1 ? '' : 'specializes = </C>\n'})\n{\n}\n}\n`,
  'l1.usda': `#usda 1.0
(
    defaultPrim = "M"
    subLayers = [@./l0.usda@ (offset = 3)]
)
def "M" (
    variantSets = "vs"
)
{
${inL1 ? '    over "c" (\n        specializes = </C>\n    )\n    {\n    }\n' : ''}    variantSet "vs" = {
        "y" {
            def "c" (
                prepend inherits = </C>
            )
            {
            }
        }
    }
}
`,
});
// [stage, prim, OpenUSD's children of it]
const cases = [
  ['first, as stage 50', first({}), '/P/b/b/c/b', []],
  ['first, no specializes', first({ specializes: false }), '/P/b/b/c/b', ['c']],
  ['first, no sublayer offset', first({ offset: false }), '/P/b/b/c/b', []],
  ['first, variant selected in the root layer', first({ select: true }), '/P/b/b/c/b', []],
  [
    'first, no inherit on /M/c, variant selected in the root layer',
    first({ outer: false, select: true }),
    '/P/b/b/c/b',
    [],
  ],
  ['first, no inherit on /M/c, so no variant', first({ outer: false }), '/P/b/b/c/b', ['c']],
  ['first, no variant', first({ variant: false }), '/P/b/b/c/b', ['c']],
  ['first, no variant and no inherit on /M/c', first({ variant: false, outer: false }), '/P/b/b/c/b', ['c']],
  ['second, as stage 57', second({}), '/Q/a/a/c', ['a']],
  ['second, no inherit beside the specializes', second({ inherit: false }), '/Q/a/a/c', []],
  ['second, the specializes in l1', second({ inL1: true }), '/Q/a/a/c', ['a']],
  ['second, the specializes in l1, no inherit', second({ inherit: false, inL1: true }), '/Q/a/a/c', []],
];

test('an implied class arc stops where OpenUSD stops it', async () => {
  for (const [name, files, prim, expected] of cases) assert.deepEqual(await children(files, prim), expected, name);
});
