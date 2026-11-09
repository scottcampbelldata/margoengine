import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('batch 79 records shadow and node evidence on both backends', () => {
  const record = read('../../../docs/whitepaper/build-record.md');
  const start = record.indexOf('## Lane N batch 79');
  assert.ok(start >= 0, 'batch 79 section');
  const next = record.indexOf('\n## ', start + 1);
  const section = record.slice(start, next);
  assert.equal(section.includes('the WebGL2 route for shadows and nodes'), false);
  assert.match(section, /\*\*Not proved:\*\* time on any GPU; other GPUs\./);
  const playbook = read('../../../docs/architecture/operational-playbook.md');
  const maths = playbook.slice(
    playbook.indexOf('## 2. Precise GPU mathematics'),
    playbook.indexOf('## 3. Rendering backends'),
  );
  assert.match(maths, /nodeNorm/);
  assert.match(maths, /clip z is outside \[0, w\]/);
  assert.match(maths, /1e-21/);
  assert.match(maths, /1e20/);
  const backends = playbook.slice(
    playbook.indexOf('## 3. Rendering backends'),
    playbook.indexOf('## 4. Quality architecture'),
  );
  assert.match(backends, /@margoengine\/vfx\/shadows/);
  assert.match(backends, /@margoengine\/vfx\/nodes/);
  assert.match(backends, /settles the cancelled map/);
  assert.match(backends, /GPU point-draw route/);
  assert.equal(backends.includes('existing CPU route'), false);
  const evidence = playbook.slice(playbook.indexOf('## 5. Current evidence gaps'));
  assert.match(evidence, /checkShadowFar/);
  assert.match(evidence, /checkNodeNorm/);
  assert.match(evidence, /checkShadowRelease/);
  assert.match(evidence, /checkNodeF32/);
  assert.match(evidence, /RTX A6000/);
  assert.match(evidence, /any GPU other than the RTX A6000/);
  for (const file of ['../../../docs/limits.md', '../../../docs/whitepaper/claims.md']) {
    const rows = read(file).split('\n').filter((line) => /LIM-581|LIM-590|LIM-594|LIM-595/.test(line));
    assert.equal(rows.length, 4, file);
    assert.ok(rows.every((row) => !row.includes('WebGL2 route was not run')), file);
    assert.match(rows.join('\n'), /0.97004885/);
    assert.match(rows.join('\n'), /restoration during readback/);
    assert.match(rows.join('\n'), /f32 overflow/);
  }
});
