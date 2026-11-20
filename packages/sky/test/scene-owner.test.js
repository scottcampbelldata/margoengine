// Disposal leaves the scene the plugin joined, never the active one (docs/integration-fixtures.md, "Scene owner"; the
// one-argument engine.removePlugin(name) removed a same-name plugin from the active scene instead).
import test from 'node:test';
import { assertLeavesOwnScene, attachIn } from '../../../tests/support/scene-owner-decoy.js';
import { Aurora } from '../dist/aurora.js';
import { Moon } from '../dist/moon.js';
import { MilkyWay } from '../dist/milky-way.js';

for (const [label, make] of [
  ['Aurora', () => new Aurora()],
  ['Moon', () => new Moon({ albedo: { width: 2, height: 1, data: new Uint8Array(8).fill(255) } })],
  ['MilkyWay', () => new MilkyWay({ latitude: 0, longitude: 0 })],
])
  test(`${label} disposal leaves the scene it joined and keeps the active scene's same-name layer`, (t) =>
    assertLeavesOwnScene(t, make));
