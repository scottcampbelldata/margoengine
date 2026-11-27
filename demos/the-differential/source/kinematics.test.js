import assert from 'node:assert/strict';
import { test } from 'node:test';
import { carrierRpm, gearPose, pinionTeeth, sideTeeth, speeds } from './kinematics.js';

const tau = 2 * Math.PI;
const modulo = (value) => ((value % 1) + 1) % 1;

function phaseAtContact(pose, side, pinion) {
  const relativeSide = (side < 0 ? pose.left : pose.right) - pose.carrier;
  const sideBearing = pinion * Math.PI / 2 + side * relativeSide;
  const pinionBearing = (side < 0 ? Math.PI : 0) + pose.pinions;
  return modulo((sideBearing * sideTeeth + pinionBearing * pinionTeeth) / tau);
}

test('every opposed bevel mesh starts and stays half a tooth out of phase', () => {
  for (let steering = -100; steering <= 100; steering += 5) {
    const rates = speeds(steering);
    assert.ok(Math.abs((rates.left + rates.right) - 2 * carrierRpm) < 1e-12);
    for (let time = 0; time < 19; time += 0.137) {
      const drive = 0.22 + carrierRpm * time * tau / 60;
      const offset = (rates.left - carrierRpm) * time * tau / 60;
      const pose = gearPose(drive, offset);
      for (const side of [-1, 1]) {
        for (const pinion of [-1, 1]) {
          const phase = phaseAtContact(pose, side, pinion);
          assert.ok(Math.abs(phase - 0.5) < 1e-11, 'Incorrect assembly phase at an opposed contact');
        }
      }
    }
  }
});
