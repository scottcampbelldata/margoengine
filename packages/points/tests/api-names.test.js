// docs/conventions.md: a name exported by two packages must mean the same thing. points' dirty-range type was
// called Channel and appeared in the API report next to @margoengine/netcode's public Channel (a network channel).
// It is PointChannel now. Reads the committed API report, which land-records regenerates before verify.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('the points API names its dirty-range type PointChannel, not the netcode Channel', () => {
  const report = readFileSync(new URL('../../../api/points.api.md', import.meta.url), 'utf8');
  assert.doesNotMatch(report, /\bChannel\b(?<!PointChannel)/);
  assert.match(report, /\bPointChannel\b/);
});
