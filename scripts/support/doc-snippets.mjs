// The runnable pages of the reader documentation, shared by the three checks that prove they work:
//   tests/docs-guides.test.js         structure: each page has its sections, images exist, sizes, no stray code
//   scripts/modern-package-tests.js   type-checks every `ts` block against the packed packages (a consumer project)
//   scripts/docs-browser-test.mjs     runs each page in a real WebGPU browser
// A page is a Markdown file. Its code is the fenced blocks, in order:
//   ```ts            runs, and is type-checked. The blocks of a guide are one program: imports once at the top of the
//                    first block that needs them, `stage` and `engine` defined in the first block and used by the rest.
//   ```ts no-run     type-checked but not run (code that needs a file or a server the test does not have)
//   ```html NAME     a file of the quickstart project (README.md only)
//   ```ts NAME       a file of the quickstart project (README.md only), for example `main.ts`
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const root = resolve(import.meta.dirname, '../..');

/** The guides in the order the start page lists them. `wait` names what a browser run waits for. */
export const GUIDES = [
  { file: 'docs/guides/textures-and-materials.md', slug: 'textures', image: 'guide-textures' },
  { file: 'docs/guides/lights-and-shadows.md', slug: 'lights', image: 'guide-lights' },
  { file: 'docs/guides/camera-and-controls.md', slug: 'camera', image: 'guide-camera' },
  { file: 'docs/guides/interaction.md', slug: 'interaction', image: 'guide-interaction' },
  { file: 'docs/guides/loading-gltf.md', slug: 'gltf', image: 'guide-gltf' },
  { file: 'docs/guides/animation.md', slug: 'animation', image: 'guide-animation' },
  { file: 'docs/guides/react-state-vs-frame-loop.md', slug: 'react', image: 'guide-react-state', react: true },
  { file: 'docs/guides/react-scene-document.md', slug: 'react-document', image: 'guide-react-document', react: true },
];

/** Every fenced block of a Markdown text: [{ lang, info, code }]. `info` is what follows the language word. */
export function blocks(markdown) {
  const found = [];
  for (const [, lang, info, code] of markdown.matchAll(/^```([\w-]+)[ \t]*([^\r\n]*)\r?\n([\s\S]*?)^```[ \t]*$/gm))
    found.push({ lang, info: info.trim(), code });
  return found;
}

/** The program a guide describes: its plain `ts` blocks joined; `noRun` too when `all` is true (type-checking). */
export function program(markdown, { all = false } = {}) {
  return blocks(markdown)
    .filter((b) => (b.lang === 'ts' || b.lang === 'tsx') && (b.info === '' || (all && b.info === 'no-run')))
    .map((b) => b.code)
    .join('\n');
}

/** The named files of the quickstart project in README.md: { 'index.html': text, 'main.ts': text }. */
export function quickstartFiles(markdown = readFileSync(join(root, 'README.md'), 'utf8')) {
  const files = {};
  for (const b of blocks(markdown)) if ((b.lang === 'html' || b.lang === 'ts') && b.info) files[b.info] = b.code;
  return files;
}

/** Every page that has runnable code: { slug, file, image, program } with the quickstart first. */
export function pages() {
  const quick = quickstartFiles();
  return [
    {
      slug: 'quickstart',
      file: 'README.md',
      image: 'quickstart',
      program: quick['main.ts'],
      html: quick['index.html'],
    },
    ...GUIDES.map((g) => ({
      ...g,
      program: program(readFileSync(join(root, g.file), 'utf8')),
      all: program(readFileSync(join(root, g.file), 'utf8'), { all: true }),
      html: quick['index.html'],
    })),
  ];
}
