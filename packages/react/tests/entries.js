// Every runtime entry of the built package merged into one namespace, as `margoengine/react` exports them, so a test
// reaches any binding by name. Imported when called, so module mocks set up before it apply.
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
/** The dist file of each entry: index, controls, gltf-pro, ... */
export const entryFiles = Object.values(manifest.exports).map(({ import: target }) =>
  target.replace('./dist/', '').replace(/\.js$/, ''),
);
/** All entries' exports in one object. */
export async function allEntries() {
  return Object.assign({}, ...(await Promise.all(entryFiles.map((file) => import(`../dist/${file}.js`)))));
}
/** Rewrites `@margoengine/react[/<entry>]` in example source to the built files. */
export function resolveEntries(code) {
  return code.replace(
    /@margoengine\/react(?:\/([\w-]+))?(?=['"])/g,
    (_, entry) => new URL(`../dist/${entry ?? 'index'}.js`, import.meta.url).href,
  );
}
