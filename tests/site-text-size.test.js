// Bug 56: site text is 16 px or larger and the mobile navigation wraps instead of overflowing 390 px.
// (Rendered at 1440x900 and 390x844 in Edge: no text under 16 px on index.html and sizes.html, no horizontal scroll.)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const css = readFileSync(new URL('../site/site.css', import.meta.url), 'utf8');

/** Every font-size declaration with a fixed length (clamp and max expressions are checked by their lower bound). */
function sizes(text) {
  const found = [];
  for (const [, value] of text.matchAll(/font-size:\s*([^;}]+)/g)) {
    const v = value.trim();
    const inner = /^(?:clamp|max)\(\s*([\d.]+)(px|rem|em)/.exec(v) ?? /^([\d.]+)(px|rem|em)$/.exec(v);
    if (inner) found.push({ v, px: Number(inner[1]) * (inner[2] === 'px' ? 1 : 16) });
  }
  return found;
}

test('no site.css font-size makes text smaller than 16 px', () => {
  const small = sizes(css).filter((s) => s.px < 16);
  assert.deepEqual(small, []);
  assert.ok(sizes(css).length > 5, 'the scan found the declarations');
});

test('the narrow-screen navigation wraps', () => {
  const narrow = css.slice(css.indexOf('@media (max-width: 820px)'));
  assert.match(narrow, /\.nav \{[^}]*flex-wrap: wrap/);
});
