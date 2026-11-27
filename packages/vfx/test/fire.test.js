// Fire (@margoengine/vfx/fire): a fire from one call. The Cabin Hearth page built its fire by hand (two Gauss
// points of its own, a shadow radius, a near plane, one flicker that owned every light, three VFX with a softness):
// any other scene that wanted a fire had to copy those values. Fire takes them from the hearth data instead.
import test from 'node:test';
import assert from 'node:assert/strict';
import { engine } from '../../../tests/support/review56-engine.js';
import { stubDevice } from '../../../tests/support/scene-owner-decoy.js';
import { Fire } from '../dist/fire.js';
import { snowNight } from '../../sky/dist/scene-kits.js';
import { Clustered } from '../../clustered/dist/index.js';
import { LocalShadows } from '../../clustered/dist/shadows.js';
import { LightGroups } from '../../clustered/dist/groups.js';
import { lineShadowRadius } from '../../clustered/dist/line.js';
import { sphereIrradiance } from '../../clustered/test/sphere-irradiance-reference.js';

async function scene(t, { shadows = true } = {}) {
  const e = await engine(t);
  stubDevice(e.gpu);
  const clustered = Clustered.attach(e);
  if (shadows) LocalShadows.attach(e, { lights: clustered });
  return { e, clustered, groups: LightGroups.attach(e, clustered) };
}
const sum = (lights) => lights.reduce((s, l) => s + l.intensity, 0);

test("the kit hearth describes its flame line: its radius is lineLights' default for that length", () => {
  const { light, emberHeight } = snowNight().hearth;
  assert.equal(light.length, 0.62);
  // The light stands at the flames' radiance centroid over the fuel top (0.3 m put it 0.16 m over the flames, 6 cm
  // from the Cabin Hearth kettle's spout, once the births moved to the fuel top). The flames rise from the fuel at the
  // kit's velocity plus its cone's speed, accelerated by its gravity; each is weighted by alpha x size^2 x the colour's
  // luminance over its life, over the lifetime range.
  const { fire } = snowNight().hearth,
    key = (k, u) => {
      const x = u * (k.length - 1),
        i = Math.min(Math.floor(x), k.length - 2);
      return k[i] + (k[i + 1] - k[i]) * (x - i);
    },
    luma = (u) => {
      const c = fire.curves.color,
        j = Math.max(
          1,
          c.findIndex((p) => p.at >= u),
        ),
        a = c[j - 1],
        b = c[j],
        t = (u - a.at) / (b.at - a.at);
      return [0.2126, 0.7152, 0.0722].reduce((s, w, k) => s + w * (a.color[k] + (b.color[k] - a.color[k]) * t), 0);
    },
    rise = fire.velocity[1] + fire.emitter.speed * Math.cos(fire.emitter.angle / 2),
    lift = fire.gravity[1];
  let weight = 0,
    moment = 0;
  for (let L = fire.lifetime[0]; L <= fire.lifetime[1] + 1e-9; L += 0.01)
    for (let u = 0; u <= 1; u += 0.005) {
      const t = u * L,
        w = key(fire.curves.alpha, u) * key(fire.curves.size, u) ** 2 * luma(u) * L;
      weight += w;
      moment += w * (rise * t + (lift * t * t) / 2);
    }
  const centroid = moment / weight;
  assert.ok(
    Math.abs(light.height - centroid) <= 0.02,
    `height ${light.height} m vs the flames' centroid ${centroid.toFixed(3)} m`,
  );
  assert.ok(Math.abs(light.radius - lineShadowRadius(light.length, 2)) < 1e-12, `radius ${light.radius}`);
  assert.equal(emberHeight, 0.1);
  assert.ok(Object.isFrozen(snowNight().hearth.light));
});

test('Fire.attach: a flame line of two soft-shadowed points over the fuel, in a group of its own', async (t) => {
  const { e, clustered, groups } = await scene(t),
    { light } = snowNight().hearth;
  groups.group('room').setLights([{ position: [3, 2, 0], range: 5, intensity: 2 }]);
  const fire = Fire.attach(e, { position: [1, 0.3, -2], lights: groups });
  assert.equal(fire.lights.length, 2);
  const [a, b] = fire.lights;
  for (const p of [a, b]) {
    assert.ok(
      Math.abs(p.position[1] - (0.3 + light.height)) < 1e-12,
      'the light stands in the flames, over the fuel top',
    );
    assert.ok(p.radius >= light.radius, 'each point is a sphere at least its share of the flame line');
    assert.equal(p.position[2], -2);
    assert.equal(p.castShadow, true);
    assert.deepEqual(p.shadow, { near: 0.05, radius: light.radius });
    assert.deepEqual(p.flicker, { ...light.flicker }, 'one flicker, the kit seed');
    assert.deepEqual(p.color, [...light.color]);
    assert.equal(p.range, light.range);
  }
  assert.ok(Math.abs(Math.abs(a.position[0] - b.position[0]) / 2 - 0.62 / (2 * Math.sqrt(3))) < 1e-12, 'Gauss nodes');
  assert.ok(Math.abs(sum(fire.lights) - light.intensity) < 1e-12, "the points share the kit's intensity");
  assert.deepEqual(groups.names, ['room', 'fire']);
  assert.equal(clustered.list.length, 3, "the fire's points and the room's light, together");
  // A second fire gets its own group.
  const other = Fire.attach(e, { position: [-1, 0.3, -2], lights: groups, embers: false });
  assert.deepEqual(groups.names, ['room', 'fire', 'fire 2']);
  assert.equal(other.particles.embers, undefined);
  // Particles: born at the fuel top, embers 0.1 m above, the kit's data, soft against the depth when given.
  const { flames, embers, steam } = fire.particles;
  assert.deepEqual(flames.options.position, [1, 0.3, -2]);
  assert.deepEqual(embers.options.position, [1, 0.4, -2]);
  assert.equal(steam, undefined, 'no steam without a point');
  assert.equal(flames.options.intensity, snowNight().hearth.fire.intensity);
  assert.equal(flames.options.softness, undefined, 'no depth given: no soft fade, which would need it');
  // With the scene depth, every part fades 0.08 m before what it meets.
  const depth = () => undefined,
    soft = Fire.attach(e, { position: [0, 0.3, 4], lights: groups, depth, steam: [0, 1, 4] });
  for (const effect of Object.values(soft.particles)) {
    assert.equal(effect.options.softness, 0.08);
    assert.equal(effect.options.depth, depth);
  }
  soft.dispose();
  for (const effect of [flames, embers]) assert.equal(e.sceneOf(effect), e.scene);
  // Dispose takes the group, the flicker's frame callback and the particles with it; the room's light stays.
  fire.dispose();
  assert.deepEqual(groups.names, ['room', 'fire 2']);
  assert.equal(clustered.list.length, 3);
  for (const effect of [flames, embers]) assert.equal(e.sceneOf(effect), undefined);
  other.dispose();
  assert.deepEqual(
    clustered.list.map((l) => l.intensity),
    [2],
  );
  fire.dispose();
});

test('Fire.attach: power sets the light and the flames together; width, axis, steam and an unshadowed fire', async (t) => {
  const { e, clustered } = await scene(t, { shadows: false }),
    hearth = snowNight().hearth;
  const fire = Fire.attach(e, {
    position: [0, 0, 0],
    power: 2,
    width: 1.24,
    axis: [0, 0, 3],
    lights: clustered,
    castShadow: false,
    steam: [0.5, 0.9, 0],
  });
  assert.ok(Math.abs(sum(fire.lights) - 2 * hearth.light.intensity) < 1e-12);
  assert.equal(fire.particles.flames.options.intensity, 2 * hearth.fire.intensity);
  assert.equal(fire.particles.embers.options.intensity, 2 * hearth.embers.intensity);
  assert.equal(fire.particles.steam.options.intensity, hearth.steam.intensity, 'steam is not firelight');
  assert.deepEqual(fire.particles.steam.options.position, [0.5, 0.9, 0]);
  const [a, b] = fire.lights;
  assert.equal(a.position[0], 0);
  assert.ok(Math.abs(b.position[2] - a.position[2] - 1.24 / Math.sqrt(3)) < 1e-12, 'along the axis, 1.24 m long');
  assert.equal(a.shadow, undefined);
  assert.equal(clustered.list.length, 2, 'a Clustered given directly holds the fire');
  fire.dispose();
  assert.equal(clustered.list.length, 0);
});

// The owner/lifetime check found it: a fire whose scene was disposed (not the fire itself) left its flicker's frame
// callback behind, still lighting a disposed Clustered. The fire is a plugin of its scene now.
test('Fire is a plugin of its scene: removing it stops the flicker; a gone Clustered is not lit', async (t) => {
  const { e, clustered } = await scene(t, { shadows: false }),
    frames = new Set(),
    onFrame = e.onFrame.bind(e);
  e.onFrame = (callback) => {
    const remove = onFrame(callback);
    frames.add(callback);
    return () => (frames.delete(callback), remove());
  };
  const tick = (seconds) => [...frames].forEach((callback) => callback(e, seconds)),
    fire = Fire.attach(e, { position: [0, 0.3, 0], lights: clustered, castShadow: false });
  assert.equal(e.sceneOf(fire), e.scene);
  assert.equal(frames.size, 1, 'one frame callback flickers the whole line');
  const steady = sum(fire.lights),
    seen = new Set();
  for (let i = 0; i < 8; i++) {
    tick(0.05);
    seen.add(sum(clustered.list).toFixed(6));
    const [a, b] = clustered.list;
    assert.ok(Math.abs(a.intensity - b.intensity) < 1e-12, 'the points rise and fall together');
  }
  assert.ok(seen.size > 1, 'it flickers');
  assert.ok([...seen].every((v) => +v > 0 && +v < 3 * steady));
  // Removing the fire from its scene (as disposing the scene does) disposes it: no frame callback, no particles.
  e.removePlugin(fire.name);
  assert.equal(frames.size, 0);
  assert.equal(clustered.list.length, 0);
  for (const effect of Object.values(fire.particles)) if (effect) assert.equal(e.sceneOf(effect), undefined);
  fire.dispose();
  // A Clustered disposed before its fire: the frame callback lights nothing, and the fire still disposes cleanly.
  const other = Fire.attach(e, { position: [0, 0.3, 0], lights: clustered, castShadow: false });
  clustered.dispose();
  tick(0.05);
  other.dispose();
  assert.equal(frames.size, 0);
  assert.throws(() => Fire.attach(e, { position: [0, 0, 0], lights: {}, castShadow: false }), TypeError);
});

test('Fire.attach: errors name their fix', async (t) => {
  const { e, groups } = await scene(t, { shadows: false });
  assert.throws(() => Fire.attach(e, { position: [0, 0, 0], lights: groups }), {
    name: 'MargoError',
    code: 'state',
    message: /LocalShadows/,
  });
  assert.deepEqual(groups.names, [], 'nothing made before the throw');
  assert.throws(() => Fire.attach(e), TypeError);
  assert.throws(() => Fire.attach(e, { position: [0, 0] }), TypeError);
  assert.throws(() => Fire.attach(e, { position: [0, 0, 0], axis: [0, 0, 0] }), RangeError);
  assert.throws(() => Fire.attach(e, { position: [0, 0, 0], power: -1 }), RangeError);
  assert.throws(() => Fire.attach(e, { position: [0, 0, 0], width: 0 }), RangeError);
  assert.throws(() => Fire.attach(e, { position: [0, 0, 0], steam: [0, NaN, 0] }), TypeError);
});

// The kettle over the Cabin Hearth's fire clipped white (display 254.6 on its spout, 2026-11-16): the fire's points were
// spheres of 0.155 m, radiance 4.5 x 0.57 / (pi 0.155^2) = 34 in luminance, while the flames they stand for show 3.5 x
// 0.58 = 2.0. A clustered sphere light's highlight on a metal is at most F0 x its radiance, so the kettle mirrored a
// fire 17 times brighter than the one drawn above it. Each point's sphere is now as bright as the flames, no brighter.
// f7160a6d3d made the spheres 0.634 m to match flames of 2.0; the flames now match the 0.155 m spheres instead
// (KB-FIRE-RECEIVER1), so the wall behind the fire is out of them.
test('Fire: the sphere each light shows on a metal is no brighter than the flames, at any power', async (t) => {
  const { e, groups } = await scene(t),
    hearth = snowNight().hearth,
    lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2],
    flames = (fire) =>
      fire.intensity * Math.max(...fire.curves.color.map((k) => lum(k.color.map((v, i) => v * fire.color[i]))));
  for (const power of [0.5, 1, 3])
    for (const samples of [1, 2, 5]) {
      const fire = Fire.attach(e, { position: [0, 0.4, -2], lights: groups, power, samples });
      const bright = flames(hearth.fire) * power;
      assert.ok(Math.abs(flames(fire.particles.flames.options) - bright) < 1e-9, 'the flames carry the power');
      for (const p of fire.lights) {
        const radiance = (p.intensity * lum(p.color)) / (Math.PI * p.radius ** 2);
        assert.ok(
          radiance <= bright * (1 + 1e-9),
          `power ${power}, ${samples} samples: sphere ${radiance.toFixed(2)} > flames ${bright.toFixed(2)}`,
        );
        assert.ok(p.radius >= hearth.light.radius, 'never smaller than its share of the flame line');
        assert.equal(p.shadow.radius, hearth.light.radius * 1, "the shadow keeps the flame line's own size");
      }
      // The flames are as bright as the light (Scott, 2026-11-16 01:33): on the kit's own two-point line each sphere is
      // the line's 0.155 m share, as bright as the flames, so a wall beside the fire is no longer inside 0.634 m spheres.
      if (samples === 2)
        for (const p of fire.lights) {
          assert.ok(Math.abs(p.radius - 0.155) < 1e-12, `power ${power}: sphere radius ${p.radius}`);
          assert.ok(
            Math.abs((p.intensity * lum(p.color)) / (Math.PI * p.radius ** 2) / bright - 1) < 1e-9,
            'sphere and flames tie',
          );
        }
      fire.dispose();
    }
});

// KB-FIRE-RECEIVER1: a light wall 0.4 m behind Fire (albedo 0.5) read about as bright as the flames, so they washed out
// against it. Fire's spheres were 0.634 m, sized to flames of 2.0, so the wall was inside them and lit at their whole
// radiance from both points. Scott, 2026-11-16 01:33, "Brighter flames": the spheres are back to the flame line's
// 0.155 m share and the flames as bright as them. The wall is lit as the clustered shader lights it (Snyder 1996's cap
// form factor, the reference the clustered GPU check holds the shader to) and reads Lambertian, albedo / pi x E. A lit
// surface reads under the flames that light it when it stays two stops (a quarter) below them; it was about 1.
test('Fire: a light wall 0.4 m behind the fire stays outside the light spheres and two stops under the flames', async (t) => {
  const { e, groups } = await scene(t),
    hearth = snowNight().hearth,
    lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2],
    flames =
      hearth.fire.intensity *
      Math.max(...hearth.fire.curves.color.map((k) => lum(k.color.map((v, i) => v * hearth.fire.color[i])))),
    fire = Fire.attach(e, { position: [0, 0, 0], lights: groups }),
    wall = -0.4,
    albedo = 0.5;
  let brightest = 0;
  for (let x = -0.6; x <= 0.6 + 1e-9; x += 0.05)
    for (let y = 0; y <= 0.6 + 1e-9; y += 0.05) {
      let E = 0;
      for (const p of fire.lights) {
        const d = Math.hypot(x - p.position[0], y - p.position[1], wall - p.position[2]);
        assert.ok(d > p.radius, `the wall at [${x.toFixed(2)}, ${y.toFixed(2)}] is outside the ${p.radius} m sphere`);
        E += p.intensity * lum(p.color) * sphereIrradiance((p.position[2] - wall) / d, d, p.radius);
      }
      brightest = Math.max(brightest, (albedo / Math.PI) * E);
    }
  assert.ok(brightest <= flames / 4, `wall ${brightest.toFixed(2)} against flames ${flames.toFixed(2)}`);
  fire.dispose();
});

test('Fire.attach: the wind leans the flames, embers and steam, and setWind changes all three', async (t) => {
  const { e, groups } = await scene(t),
    field = { sample: () => [3, 0, 4] },
    fire = Fire.attach(e, { position: [0, 0.3, 0], lights: groups, steam: [0, 1, 0], wind: field }),
    parts = [fire.particles.flames, fire.particles.embers, fire.particles.steam];
  assert.equal(parts.filter(Boolean).length, 3);
  for (const part of parts) assert.equal(part.options.wind, field, 'the one field, not a copy');
  fire.setWind([2, -1]);
  for (const part of parts) assert.deepEqual(part.options.wind, [2, -1]);
  fire.setWind(undefined);
  for (const part of parts) assert.equal(part.options.wind, undefined);
  assert.throws(() => fire.setWind([Number.NaN, 0]), RangeError);
  const calm = Fire.attach(e, { position: [1, 0.3, 0], lights: groups });
  assert.equal(calm.particles.flames.options.wind, undefined, 'no wind option, no wind force');
});

// KB-VFX-SMOKEROOF1: the column over a fire that lights its smoke took that light twice, once from the fire's own lights
// and once from the glow, referred to a daylight sun: pale discs by the flames in a lamp-lit tunnel.
test("a lit fire's column takes no second light from its glow; an unlit one keeps it", async (t) => {
  const { e, groups } = await scene(t);
  const lit = Fire.attach(e, { position: [0, 0, 0], flameLength: 2, lights: groups }),
    unlit = Fire.attach(e, { position: [5, 0, 0], flameLength: 2 }),
    own = Fire.attach(e, { position: [9, 0, 0], flameLength: 2, lights: groups, smoke: { glow: 1, ceiling: 4 } });
  assert.equal(lit.smoke.options.glow, 0);
  assert.equal(lit.smoke.effect.options.lit.glow, undefined);
  assert.equal(unlit.smoke.options.glow, undefined);
  assert.ok(unlit.smoke.effect.options.lit.glow.power > 0);
  assert.equal(own.smoke.options.glow, 1, 'a glow asked for wins');
  assert.equal(own.smoke.options.ceiling, 4, 'the column takes its roof');
  for (const fire of [lit, unlit, own]) fire.dispose();
});
