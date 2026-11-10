// Each clustered plugin leaves the scene it joined on dispose, never the active one (docs/integration-fixtures.md,
// "Scene owner"; the one-argument engine.removePlugin(name) removed a same-name plugin from the active scene instead).
import test from 'node:test';
import { assertLeavesOwnScene } from '../../../tests/support/scene-owner-decoy.js';
import { Clustered } from '../dist/index.js';
import { AreaLights } from '../dist/area.js';
import { AreaLightTextures } from '../dist/area-texture.js';
import { ContactLights } from '../dist/contact.js';
import { DirectionalLights } from '../dist/directional.js';
import { IESLights } from '../dist/ies.js';
import { LightLayers } from '../dist/layers.js';
import { ProjectorLights } from '../dist/projector.js';
import { LocalShadows } from '../dist/shadows.js';
import { ShapeLights } from '../dist/shapes.js';
import { StochasticLights } from '../dist/stochastic.js';

const lights = () => ({ setLights() {}, add: () => () => {}, remove() {}, count: 0, lights: [] });
for (const [label, make] of [
  ['Clustered', () => new Clustered()],
  ['AreaLights', () => new AreaLights({ lights: lights() })],
  ['AreaLightTextures', () => new AreaLightTextures({ area: { setLights() {} } })],
  ['ContactLights', () => new ContactLights({ lights: lights() })],
  ['DirectionalLights', () => new DirectionalLights({ lights: lights() })],
  ['IESLights', () => new IESLights({ lights: lights() })],
  ['LightLayers', () => new LightLayers({ lights: lights() })],
  ['ProjectorLights', () => new ProjectorLights({ lights: lights() })],
  ['LocalShadows', () => new LocalShadows({ lights: lights(), resolution: 64 })],
  ['ShapeLights', () => new ShapeLights({ lights: lights() })],
  ['StochasticLights', () => new StochasticLights({ lights: lights(), quad: false })],
])
  test(`${label} disposal leaves the scene it joined and keeps the active scene's same-name plugin`, (t) =>
    assertLeavesOwnScene(t, make));
