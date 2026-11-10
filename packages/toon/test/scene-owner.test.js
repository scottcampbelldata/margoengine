// Disposal leaves the scene the plugin joined, never the active one (docs/integration-fixtures.md, "Scene owner"; the
// one-argument engine.removePlugin(name) removed a same-name plugin from the active scene instead).
import test from 'node:test';
import { assertLeavesOwnScene, attachIn } from '../../../tests/support/scene-owner-decoy.js';
import { Toon } from '../dist/index.js';
import { Hatching } from '../dist/hatch.js';
import { ModelOutlines } from '../dist/models.js';

for (const [label, make] of [
  ['Toon', () => new Toon()],
  ['Hatching', (e, owner) => attachIn(owner, () => Hatching.attach(e))],
  ['ModelOutlines', () => new ModelOutlines()],
])
  test(`${label} disposal leaves the scene it joined and keeps the active scene's same-name plugin`, (t) =>
    assertLeavesOwnScene(t, make));
