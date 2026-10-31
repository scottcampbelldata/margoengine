// The starter builds scripts/modern-browser-tests.js serves (the Vite production bundle and the Next production
// build). The suite stops at once, before it opens a browser, naming the command to run when one is missing: building
// here would build twice inside check:gpu-packages, whose PREPARE (scripts/gpu-package-tests.mjs) already builds both.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** The outputs the browser suite reads, with the build that makes each. */
export const STARTER_BUILDS = [
  { file: 'examples/vite/dist/.vite/manifest.json', command: 'npm run build --workspace @margoengine/starter-vite' },
  { file: 'examples/next/.next/BUILD_ID', command: 'npm run build --workspace @margoengine/starter-next' },
];

/** The builds missing under `root`: [{ file, command }]. */
export const missingStarterBuilds = (root) => STARTER_BUILDS.filter((b) => !existsSync(join(root, b.file)));

/** The one-line message for a missing build list (undefined when nothing is missing). */
export function starterBuildMessage(missing) {
  if (!missing.length) return undefined;
  return `starter build missing (${missing.map((b) => b.file).join(', ')}); run \`npm run modern:build:starters\` first (or ${missing.map((b) => b.command).join(' and ')}). check:gpu-packages builds them itself.`;
}
