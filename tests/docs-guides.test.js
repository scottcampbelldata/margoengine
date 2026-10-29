// The reader documentation keeps its promises: short pages with the same shape, screenshots that exist and are small,
// a quickstart whose saved copy (examples/quickstart) is the README's text, and no broken relative link anywhere.
// The code in these pages is type-checked by scripts/modern-package-tests.js and run by scripts/docs-browser-test.mjs.
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { check, linksOf, slug } from '../scripts/docs-links.mjs';
import { GUIDES, blocks, program, quickstartFiles, root } from '../scripts/support/doc-snippets.mjs';

const read = (file) => readFileSync(join(root, file), 'utf8');

test('the README quickstart is saved as examples/quickstart, byte for byte', () => {
  const files = quickstartFiles();
  assert.deepEqual(Object.keys(files).sort(), ['index.html', 'main.ts']);
  for (const [name, text] of Object.entries(files))
    assert.equal(
      read(`examples/quickstart/${name}`).replace(/\r\n/g, '\n'),
      text.replace(/\r\n/g, '\n'),
      `examples/quickstart/${name} must equal the README block; copy the block over the file`,
    );
});

for (const guide of GUIDES)
  test(`${guide.file} has the guide shape`, async () => {
    const text = read(guide.file),
      lines = text.split(/\r?\n/);
    assert.ok(lines.length <= 150, `${guide.file} has ${lines.length} lines; a guide stays under 150`);
    assert.match(lines[0], /^# \S/, 'starts with a title');
    assert.match(text, /^You will /m, 'says what the reader will build in its first paragraph');
    assert.match(text, /^## Next$/m, 'ends with next steps');
    assert.match(text, /^## Common mistakes$/m, 'lists common mistakes');
    assert.match(text, /^## 1\. /m, 'has numbered steps');
    assert.ok(guide.react || program(text).includes("createStage('#scene'"), 'its code makes a stage in #scene');
    const image = linksOf(text).find((l) => l.target.endsWith('.webp'));
    assert.ok(image, 'has a screenshot at the top');
    const file = join(root, 'docs/images', `${guide.image}.webp`);
    assert.ok(statSync(file).size <= 150_000, `${guide.image}.webp is over 150 KB`);
    const { width } = await sharp(file).metadata();
    assert.ok(width <= 1280, `${guide.image}.webp is ${width} px wide; 1280 is the most`);
  });

test('the quickstart screenshot exists and is small', async () => {
  const file = join(root, 'docs/images/quickstart.webp');
  assert.ok(statSync(file).size <= 150_000);
  assert.ok((await sharp(file).metadata()).width <= 1280);
});

test('the start page routes to every guide and the README routes to the start page', () => {
  const start = read('docs/start-here.md');
  for (const guide of GUIDES)
    assert.ok(start.includes(guide.file.replace('docs/', '')), `start-here lists ${guide.file}`);
  assert.ok(read('README.md').includes('docs/start-here.md'));
});

test('every guide code block is TypeScript, shell or HTML, so it is checked or clearly not code', () => {
  for (const guide of GUIDES)
    for (const b of blocks(read(guide.file)))
      assert.ok(['ts', 'tsx', 'sh', 'html', 'js'].includes(b.lang), `${guide.file}: unexpected ${b.lang} block`);
});

test('every relative link and image in the reader documentation resolves', () => {
  assert.deepEqual(check(), []);
});

test('the link checker finds a missing file and a missing heading', () => {
  assert.equal(slug('Common mistakes'), 'common-mistakes');
  assert.equal(slug('1. Load a texture'), '1-load-a-texture');
  const links = linksOf('see [a](docs/x.md#top) and `[b](skip.md)`\n```\n[c](skip.md)\n```\n![i](img.png)');
  assert.deepEqual(
    links.map((l) => l.target),
    ['docs/x.md#top', 'img.png'],
  );
});
