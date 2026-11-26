// The Playwright this repository has installed: the one `npx playwright install` (CI's browser install) runs, so a
// fixture that installs Playwright itself must take this version, or it asks for a browser build CI never fetched
// (KB-CI-PWVERSION1: the bundler matrix took npm's latest and wanted chromium-headless-shell 1255 beside 1248).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The installed `playwright` package's version under `root`. */
export function repoPlaywright(root) {
  return JSON.parse(readFileSync(join(root, 'node_modules', 'playwright', 'package.json'), 'utf8')).version;
}
