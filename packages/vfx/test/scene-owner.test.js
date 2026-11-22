// Disposal leaves the scene the plugin joined, never the active one (docs/integration-fixtures.md, "Scene owner"; the
// one-argument engine.removePlugin(name) removed a same-name plugin from the active scene instead).
import test from 'node:test';
import { assertLeavesOwnScene, attachIn } from '../../../tests/support/scene-owner-decoy.js';
import { VFX } from '../dist/index.js';

test("VFX disposal leaves the scene it joined and keeps the active scene's same-name plugin", (t) =>
  assertLeavesOwnScene(t, () => new VFX()));
