// Each 2D lighting pass leaves the scene it joined on dispose, never the active one (docs/integration-fixtures.md,
// "Scene owner"; the one-argument engine.removePlugin(name) removed a same-name plugin from the active scene instead).
import test from 'node:test';
import { assertLeavesOwnScene } from '../../../tests/support/scene-owner-decoy.js';
import { CookieLighting2D } from '../dist/cookie.js';
import { EmissiveLighting2D } from '../dist/emissive.js';
import { GILighting2D } from '../dist/gi.js';
import { HeightLighting2D } from '../dist/height.js';
import { SoftLighting2D } from '../dist/soft.js';

const target = () => ({ width: 64, height: 64, format: 'rgba8unorm', usage: 0x1f, createView: () => ({}), destroy() {} });
for (const [label, make] of [
  ['CookieLighting2D', () => new CookieLighting2D({ target: target(), name: 'owner-cookie' })],
  ['EmissiveLighting2D', () => new EmissiveLighting2D({ target: target(), name: 'owner-emissive' })],
  ['GILighting2D', () => new GILighting2D({ target: target(), name: 'owner-gi' })],
  ['HeightLighting2D', () => new HeightLighting2D({ target: target(), name: 'owner-height' })],
  ['SoftLighting2D', () => new SoftLighting2D({ target: target(), name: 'owner-soft' })],
])
  test(`${label} disposal leaves the scene it joined and keeps the active scene's same-name pass`, (t) =>
    assertLeavesOwnScene(t, make));
