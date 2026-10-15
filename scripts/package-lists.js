// The package lists in README.md and docs/README.md, grouped by the catalog's layers. docs/catalog.json is the one
// source: scripts/build-catalog.js rewrites both lists from it and tests/package-lists.test.js fails when either drifts.
const START = '<!-- package-list: generated from docs/catalog.json by scripts/build-catalog.js; do not edit -->',
  END = '<!-- /package-list -->';

/** Markdown files holding a list, with the relative path from each to packages/. */
export const PACKAGE_LISTS = { 'README.md': 'packages/', 'docs/README.md': '../packages/' };

/** The list: one table per layer, in catalog order, each package linking to its README. */
export function packageList(catalog, packagesPath) {
  const layers = [...new Set(catalog.map((entry) => entry.category))];
  const section = (layer) => {
    const members = catalog.filter((entry) => entry.category === layer);
    return [
      `### ${layer} (${members.length})`,
      '',
      '| Package | What it is |',
      '| --- | --- |',
      ...members.map(
        (entry) =>
          `| [\`${entry.package}\`](${packagesPath}${entry.id}/README.md) | ${entry.description.replaceAll('|', '\\|')} |`,
      ),
    ].join('\n');
  };
  return [
    START,
    `${catalog.length} packages in ${layers.length} layers, the same as the [catalog](https://margoengine.com/catalog/).`,
    ...layers.map(section),
    END,
  ].join('\n\n');
}

/** `text` with its marked list replaced by a fresh one; keeps the file's line endings. */
export function withPackageList(text, catalog, packagesPath) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n',
    lf = text.replaceAll('\r\n', '\n');
  const start = lf.indexOf(START),
    end = lf.indexOf(END);
  if (start < 0 || end < start) throw new Error(`no ${START} ... ${END} markers`);
  return (lf.slice(0, start) + packageList(catalog, packagesPath) + lf.slice(end + END.length)).replaceAll('\n', eol);
}
