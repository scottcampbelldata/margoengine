import test from 'node:test';
import assert from 'node:assert/strict';
import { headlessReference } from '../scripts/support/headless-readme.mjs';

// check:readme-run threw on any headless/compare example without compareImages (a pixelDiff example on its own pixels).
test('headless README references are made only for compareImages examples', () => {
  const diff = "import { pixelDiff } from '@margoengine/headless/compare';\nconst d = pixelDiff(a, b);\n";
  assert.equal(headlessReference(diff), undefined);
  const compare = [
    "import { readFile } from 'node:fs/promises';",
    "import { compareImages } from '@margoengine/headless/compare';",
    "const result = await compareImages(await readPixels(engine), await readFile('reference.png'));",
  ].join('\n');
  assert.match(headlessReference(compare), /await writeFile\('reference\.png'/);
  assert.throws(() => headlessReference("import { compareImages } from '@margoengine/headless/compare';\ncompareImages(a, b);"));
});
