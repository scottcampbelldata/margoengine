// The TypeScript projects that check the examples against the built package types (scripts/check-example-types.mjs).
// Each project is one tsconfig; `entries` are the files or folders under it whose imports decide which packages it
// uses (scripts/support/affected-packages.mjs reads them to narrow the check). tests/check-example-types.test.js fails
// when an example .ts or .tsx file is in no project, or a root .js file is not in the JavaScript one.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Files directly inside `dir` (a path under the repository root) that end in one of `extensions`, as repo paths. */
const filesIn = (root, dir, extensions) =>
  readdirSync(join(root, dir), { withFileTypes: true })
    .filter((e) => e.isFile() && extensions.some((x) => e.name.endsWith(x) && !e.name.endsWith('.d.ts')))
    .map((e) => `${dir}/${e.name}`)
    .sort();

/** Folders of examples/ whose .ts files are checked by the project `examples`. */
export const EXAMPLE_FOLDERS = ['blender-loader', 'quickstart', 'skinning-ik', 'usdz-loader', 'webxr-orbit'];

/**
 * Every project: { id, config, entries(root) }. `js` is checkJs without strict mode: the JavaScript demos are untyped
 * by design, and the check still catches a wrong engine call, a missing property and a bad argument.
 */
export const PROJECTS = [
  {
    id: 'examples',
    config: 'examples/tsconfig.json',
    entries: (root) => [
      ...filesIn(root, 'examples', ['.ts']),
      ...EXAMPLE_FOLDERS.flatMap((folder) => filesIn(root, `examples/${folder}`, ['.ts'])),
    ],
  },
  { id: 'js', config: 'examples/tsconfig.js.json', entries: (root) => filesIn(root, 'examples', ['.js']) },
  {
    id: 'vite',
    config: 'examples/vite/tsconfig.json',
    entries: () => ['examples/vite/src', 'examples/vite/vite.config.ts'],
  },
  { id: 'react-viewer', config: 'examples/react-viewer/tsconfig.json', entries: () => ['examples/react-viewer/src'] },
  { id: 'next', config: 'examples/next/tsconfig.json', entries: () => ['examples/next/app', 'examples/next/pages'] },
  {
    id: 'gameplay-sandbox',
    config: 'examples/gameplay-sandbox/tsconfig.json',
    entries: () => ['examples/gameplay-sandbox/src', 'examples/gameplay-sandbox/vite.config.ts'],
  },
  {
    id: 'voxel-sandbox',
    config: 'examples/voxel-sandbox/tsconfig.json',
    entries: () => ['examples/voxel-sandbox/src', 'examples/voxel-sandbox/vite.config.ts'],
  },
];
