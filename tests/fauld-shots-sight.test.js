// The Fauld shot cameras see their subjects: three first looked at a hedge tree trunk a few metres off a long lens
// (fr011), at nothing but grass over rising ground (fr031) and into leaves across the lens (fr139). The generator
// (tools/shot/fauld-shots.mjs) turns or lifts each camera until `sightClearance` passes; this holds the shot files to it
// over the recorded ground and plants (tools/shot/fauld-sight-fixture.mjs), and records the rows still blocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { sightClearance } from '../packages/cameras/dist/clearance.js';

const json = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const fixture = json('./fixtures/fauld-sight.json');
// The generator's limits: open ground shows the subject's foot; the wooded crater is seen through its trees.
const OPEN = { subject: 0.85 },
  WOODED = { subject: 0.2, near: 0.2, foreground: 0.25, centre: 0.15 };

function measure(shot, keys, { grid, occluders }, limits) {
  const { origin, along, half, step, columns, rows, heights } = grid;
  const ground = (x, z) => {
    const a = (x - origin[0]) * along[0] + (z - origin[1]) * along[1],
      s = -(x - origin[0]) * along[1] + (z - origin[1]) * along[0],
      u = Math.max(0, Math.min(columns - 1.001, (a + half) / step)),
      v = Math.max(0, Math.min(rows - 1.001, (s + half) / step)),
      i = Math.floor(u),
      j = Math.floor(v),
      at = (p, q) => heights[q * columns + p],
      low = at(i, j) + (at(i + 1, j) - at(i, j)) * (u - i),
      high = at(i, j + 1) + (at(i + 1, j + 1) - at(i, j + 1)) * (u - i);
    return low + (high - low) * (v - j);
  };
  const [tx, , tz] = shot.shot.subject.target,
    height = { fr011: 25, fr031: 6, fr139: 6 }[shot.shot.id.slice(6)];
  const lift = (p) => [p[0], p[1] + ground(p[0], p[2]), p[2]];
  return keys.map((k) =>
    sightClearance(
      {
        position: lift(k.position),
        target: lift(k.target),
        fov: k.fov,
        subject: { centre: [tx, ground(tx, tz), tz], width: shot.shot.subject.size, height },
      },
      {
        ground,
        occluders: occluders.map(([x, z, bottom, top, radius, opacity]) => ({ x, z, bottom, top, radius, opacity })),
      },
      limits,
    ),
  );
}

for (const [id, limits] of [
  ['fr011', OPEN],
  ['fr031', OPEN],
  ['fr139', WOODED],
])
  test(`${id}: the blocked camera fails the sight check and the shot file's camera passes it`, () => {
    const shot = json(`../tools/shot/shots/fauld-${id}.json`),
      { blocked, now } = fixture[id];
    const old = measure(shot, blocked.keys, blocked, limits);
    assert.ok(
      old.some((c) => !c.clear),
      `the first camera passed: ${JSON.stringify(old)}`,
    );
    for (const c of measure(shot, shot.tracks[0].keys, now, limits)) assert.ok(c.clear, `${id}: ${JSON.stringify(c)}`);
  });

test('every Fauld countryside, crater and blast row is sight checked, and the blocked rows are the known ones', () => {
  const report = json('../tools/shot/fauld-sight.json'),
    files = readdirSync(new URL('../tools/shot/shots/', import.meta.url)).flatMap(
      (f) => f.match(/^fauld-(fr\d+)\.json$/)?.[1] ?? [],
    ),
    known = readFileSync(new URL('../docs/known-bugs.md', import.meta.url), 'utf8');
  for (const id of Object.keys(report)) assert.ok(files.includes(id), `${id} has no shot file`);
  const blocked = Object.keys(report).filter((id) => !report[id].clear);
  assert.deepEqual(blocked, ['fr073', 'fr108', 'fr114', 'fr136', 'fr146']);
  for (const id of blocked) assert.ok(known.includes(id), `${id} is blocked and not in docs/known-bugs.md`);
});
