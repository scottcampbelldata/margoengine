// GeospatialControls at planet scale: a floating origin keeps the camera in small local coordinates from street level
// to orbit, and near/far follow the height above the ground and the horizon.
import test from 'node:test';
import assert from 'node:assert/strict';
import { WGS84_A, degToRad } from '@margoengine/math/geo';
import { GeospatialControls } from '../dist/geospatial.js';
import { FakeElement, camera } from './control-fakes.js';

// A floating origin as `@margoengine/cameras/origin` keeps one: local = world - origin, rebased by moving the origin
// (and the camera with it) when the camera strays.
class Origin {
  at = [0, 0, 0];
  toLocal = (w) => [w[0] - this.at[0], w[1] - this.at[1], w[2] - this.at[2]];
  toWorld = (l) => [l[0] + this.at[0], l[1] + this.at[1], l[2] + this.at[2]];
  rebase(cam, world) {
    const shift = world.map((v, i) => v - this.at[i]);
    this.at = [...world];
    cam.position = cam.position.map((v, i) => v - shift[i]);
    cam.target = cam.target.map((v, i) => v - shift[i]);
  }
}
const street = {
  longitude: degToRad(-105.27),
  latitude: degToRad(40.02),
  height: 1655,
  heading: 1,
  pitch: 0.2,
  range: 20,
};
const rig = (options) => {
  const cam = camera({ position: [0, 0, 1], target: [0, 0, 0], fov: 60 });
  return {
    cam,
    control: new GeospatialControls(cam, new FakeElement(), { view: street, reducedMotion: true, ...options }),
  };
};

test('with a floating origin the camera stays local and every geodetic answer matches the float64 path', () => {
  const plain = rig({}),
    origin = new Origin(),
    { cam, control } = rig({ origin });
  // Rebase to the camera as the plugin does, then move: the controls follow the new origin.
  origin.rebase(cam, origin.toWorld(cam.position));
  control.rotate(0.3, 0.05);
  plain.control.rotate(0.3, 0.05);
  assert.ok(Math.hypot(...cam.position) < 100, `local eye ${cam.position}`);
  assert.ok(Math.hypot(...plain.cam.position) > 0.9 * WGS84_A, 'without it the eye is at Earth-centred size');
  const a = plain.control.eye,
    b = control.eye;
  // Float64 throughout: the two paths agree to well under a millimetre at 6,370 km.
  assert.ok(Math.abs(a.height - b.height) < 1e-6 && Math.abs(a.longitude - b.longitude) < 1e-13);
  // The local eye-to-target vector is exact in float32 terms: 20 m to the centre.
  const d = Math.hypot(...cam.target.map((v, i) => v - cam.position[i]));
  assert.ok(Math.abs(d - 20) < 1e-6, `range ${d}`);
  assert.throws(() => rig({ origin: {} }), RangeError);
});

test('near and far: centimetres on a plateau street, kilometres in orbit, peaks beyond the horizon inside far', () => {
  const plateau = () => 1650,
    { cam, control } = rig({ heightAt: plateau });
  // Eye about 5 to 10 m above a 1,650 m plateau: near is set from that, not from the 1,660 m above the ellipsoid.
  assert.ok(cam.near < 0.2, `near ${cam.near}`);
  const horizon = Math.sqrt(control.eye.height * (control.eye.height + 2 * WGS84_A));
  assert.ok(cam.far > horizon + 330_000, `far ${cam.far} reaches 9 km peaks beyond a ${horizon} m horizon`);
  control.setView({ range: 2e7, pitch: Math.PI / 2 });
  assert.ok(cam.near > 1e4 && cam.far > 2e7, `orbit near ${cam.near}, far ${cam.far}`);
});
