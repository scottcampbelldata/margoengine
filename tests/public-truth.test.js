// Bugs 54 and 55: the licence in the site's JSON-LD and every stated package count must match their source.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  jsonLdLicenses,
  licenceProblems,
  packageCountProblems,
  publicTruthProblems,
} from '../scripts/support/public-truth.mjs';

const apache = 'Apache License\n Version 2.0, January 2004';
const ld = (license) =>
  `<script type="application/ld+json">{"@type":"SoftwareSourceCode","license":"${license}"}</script>`;
const run = (html, licenseText = apache) =>
  licenceProblems({ html, page: 'p.html', license: 'Apache-2.0', licenseText });

test('the repository states its licence and package counts truthfully', () => {
  assert.deepEqual(publicTruthProblems(), []);
});

test('a JSON-LD licence that differs from package.json fails, and the right URL passes', () => {
  assert.deepEqual(run(ld('https://www.apache.org/licenses/LICENSE-2.0')), []);
  assert.deepEqual(run(ld('https://opensource.org/license/apache-2-0')), []);
  assert.match(run(ld('https://opensource.org/license/mit'))[0], /differs from package\.json \(Apache-2\.0\)/);
  assert.match(run('<script type="application/ld+json">{}</script>')[0], /no JSON-LD license/);
  assert.match(run(ld('https://www.apache.org/licenses/LICENSE-2.0'), 'MIT License')[0], /LICENSE is not/);
  assert.deepEqual(jsonLdLicenses('<script type="application/ld+json">{"a":[{"license":{"@id":"u"}}]}</script>'), [
    'u',
  ]);
});

test('a stated package count that differs from the catalog fails, and true counts pass', () => {
  const files = {
    'a.md': '93 packages in 12 layers, the same as the catalog.\nSearch all 93 packages by task.',
    'b.html':
      '<b>93</b><span>packages in the catalog</span> and the release includes 93 packages (none published to npm yet)',
    'c.md': 'The 47 packages whose code runs in Node, and 37 packages with WGSL shaders, are partial counts.',
  };
  assert.deepEqual(packageCountProblems(files, 93), []);
  const wrong = packageCountProblems(
    {
      'a.md': 'Search all 83 packages by task',
      'b.html': 'The release includes 78 packages under it. <b>78</b><span>optional packages</span>',
      'c.md': '75 packages in 12 layers',
      'd.md': 'all 75 packages move in lockstep',
      'e.md': '1,234 packages (none published to npm yet)',
    },
    93,
  );
  assert.equal(wrong.length, 6, wrong.join('\n'));
  assert.match(wrong[0], /a\.md: states 83 packages, the catalog has 93/);
});
