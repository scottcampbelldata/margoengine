// Text layer reading against values OpenUSD 26.11 (usd-core, run black-box) gives for the same layer:
// Sdf.Layer.FindOrOpen(...).GetAttributeAtPath('/A.esc').default == 'aAA\x07\tz', '/A.neg' == -inf, and the layer
// opens with its `relocates` metadata.
import assert from 'node:assert/strict';
import test from 'node:test';
import { composeUSDFiles } from '../dist/compose.js';

const compose = async (text) =>
  (await composeUSDFiles('root.usda', (id) => (id === 'root.usda' ? new TextEncoder().encode(text) : undefined))).specs;

test('a scalar -inf is read as minus infinity, as in an array', async () => {
  const specs = await compose('#usda 1.0\ndef "A" {\n    float neg = -inf\n    float[] list = [-inf, inf]\n}\n');
  assert.equal(specs['/A.neg'].fields.default, -Infinity);
  assert.deepEqual(specs['/A.list'].fields.default, [-Infinity, Infinity]);
});

test('string escapes are read as TfEscapeString reads them: hex, octal and C letters', async () => {
  const specs = await compose(
    '#usda 1.0\ndef "A" {\n    string esc = "a\\x41\\101\\a\\tz"\n    string utf = "\\xc3\\xa9!"\n    string q = \'it\\\'s\'\n}\n',
  );
  assert.equal(specs['/A.esc'].fields.default, 'aAA\x07\tz');
  assert.equal(specs['/A.utf'].fields.default, 'é!');
  assert.equal(specs['/A.q'].fields.default, "it's");
});

test('relocates metadata is read past, as the Crate reader drops it, instead of failing the layer', async () => {
  const specs = await compose(
    '#usda 1.0\n(\n    relocates = {\n        </A/B>: </A/C>,\n        </A/D>: </A/E>\n    }\n)\ndef "A" (\n    relocates = { <B>: <C> }\n) {\n    int v = 1\n}\n',
  );
  assert.equal(specs['/A.v'].fields.default, 1);
});

// The Core Specification's text grammar (VariantSetStatement) takes one or more variants between the braces, and
// OpenUSD 26.11 refuses such a layer ("Expected }"), with a comment inside the braces too.
test('a variant set with no variants is a syntax error, as the text grammar and OpenUSD have it', async () => {
  for (const inside of ['', ' # none'])
    await assert.rejects(
      compose(`#usda 1.0\ndef "A" (\n    variantSets = "vs"\n)\n{\n    variantSet "vs" = {${inside}\n    }\n}\n`),
      (error) => error.name === 'LoaderError' && error.code === 'syntax' && /variant set "vs" on \/A has no variants/.test(error.message),
    );
  const specs = await compose('#usda 1.0\ndef "A"\n{\n    variantSet "vs" = {\n        "x" {\n        }\n    }\n}\n');
  assert.equal(specs['/A'].fields.specifier, 0);
});
