import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { test } from 'node:test';

test('pixel GPU maths and section 5 evidence stay in the operational playbook', () => {
  const playbook = readFileSync(new URL('../../../docs/architecture/operational-playbook.md', import.meta.url), 'utf8'),
    maths = playbook.split('### PixelScale, CRT and PaletteQuantize')[1]?.split('## 3.')[0],
    gaps = playbook.split('## 5. Current evidence gaps')[1];
  assert.ok(maths, 'pixel GPU maths has an architecture section');
  for (const term of ['floor((2 o + 1) n / (2 w))', 'Scale2x', 'binomial', 'Oklab', 'sceneOf', 'pipeline identity'])
    assert.ok(maths.includes(term), `maths/ownership record includes ${term}`);
  for (const path of ['screen-pass.test.js', 'palette-cycle.test.js', 'screen-regressions.js']) {
    assert.ok(maths.includes(path), `architecture links its ${path} evidence`);
    assert.ok(existsSync(new URL(path, import.meta.url)), 'cited proof exists');
  }
  for (const term of ['PixelScale', 'CRT', 'PaletteQuantize', 'WebGL2', '0.001', 'speed'])
    assert.ok(gaps.includes(term), `section 5 scopes ${term} evidence`);
});
