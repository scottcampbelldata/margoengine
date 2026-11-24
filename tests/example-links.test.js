// Every same-page option link on an example page (`href="?view=hearth&debug=layers"`) names options its scripts read:
// each key appears in the page's scripts as a string, and each value that is not a number appears as a string or as
// an object key. Cabin Hearth's nav linked `debug=layers` while main.ts read only `debug=wireframe`, so the Layers
// link showed the plain scene with nothing to say it was ignored.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..'),
  examples = join(root, 'examples');

/** The `?a=b&c=d` query of every same-page link in `html`, as URLSearchParams. */
function optionLinks(html) {
  return [...html.matchAll(/href="\?([^"#]*)"/g)].map((m) => new URLSearchParams(m[1].replace(/&amp;/g, '&')));
}

/** The options of `links` that `source` never reads, as `key=value` strings. */
function unreadOptions(links, source) {
  const quoted = (text) => [`'${text}'`, `"${text}"`, `\`${text}\``].some((q) => source.includes(q));
  const missing = [];
  for (const query of links)
    for (const [key, value] of query) {
      const keyRead = quoted(key),
        valueRead = value === '' || /^-?[0-9.]+$/.test(value) || quoted(value) || new RegExp(`[{,\\s]${value}\\s*:`).test(source);
      if (!keyRead || !valueRead) missing.push(`${key}=${value}`);
    }
  return [...new Set(missing)];
}

test('unreadOptions finds a linked value the script never reads', () => {
  const links = optionLinks('<a href="?view=outside&amp;debug=wireframe">W</a><a href="?view=outside&amp;debug=layers">L</a>');
  const source = "const views = { outside: 1 }; params.get('view'); if (params.get('debug') === 'wireframe') {}";
  assert.deepEqual(unreadOptions(links, source), ['debug=layers']);
  assert.deepEqual(unreadOptions(links, source + " if (params.get('debug') === 'layers') {}"), []);
});

test('every same-page option link on an example page is read by its scripts', () => {
  let pages = 0;
  for (const entry of readdirSync(examples, { withFileTypes: true })) {
    const dir = join(examples, entry.name),
      page = join(dir, 'index.html');
    if (!entry.isDirectory() || !existsSync(page)) continue;
    const links = optionLinks(readFileSync(page, 'utf8'));
    if (!links.length) continue;
    pages++;
    const source = readdirSync(dir)
      .filter((file) => /\.(ts|js|mjs)$/.test(file))
      .map((file) => readFileSync(join(dir, file), 'utf8'))
      .join('\n');
    assert.deepEqual(unreadOptions(links, source), [], `examples/${entry.name}/index.html links options its scripts never read`);
  }
  assert.ok(pages >= 1, 'no example page with option links found; the check reads nothing');
});
