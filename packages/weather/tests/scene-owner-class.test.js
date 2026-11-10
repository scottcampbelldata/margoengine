// Disposal leaves the scene the plugin joined, never the active one (docs/integration-fixtures.md, "Scene owner"; the
// one-argument engine.removePlugin(name) removed a same-name plugin from the active scene instead).
import test from 'node:test';
import { assertLeavesOwnScene, attachIn } from '../../../tests/support/scene-owner-decoy.js';
import { WeatherDrive } from '../dist/drive.js';
import { Hail } from '../dist/hail.js';
import { Puddles } from '../dist/puddles.js';
import { Snow } from '../dist/snow.js';

for (const [label, make] of [
  ['WeatherDrive', () => new WeatherDrive({ weather: { state: {}, update() {} } })],
  ['Hail', () => new Hail()],
  ['Puddles', () => new Puddles()],
  ['Snow', () => new Snow()],
])
  test(`${label} disposal leaves the scene it joined and keeps the active scene's same-name plugin`, (t) =>
    assertLeavesOwnScene(t, make));
