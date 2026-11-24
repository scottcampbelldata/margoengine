// Mud mode of water/flood: the rheology against the O'Brien and Julien (1988) coefficients as the FLO-2D manuals
// tabulate them (Reference Manual 2021 table 13; Simulating Mudflow Guidelines 2021 table 3), in SI units.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MUD_SEDIMENTS, mudRheology } from '../dist/flood.js';

test('yield stress and viscosity follow a exp(b Cv) of the tabulated rows, dyne/cm^2 and poise to SI', () => {
  // Aspen Natural Soil: tau_y = 0.152 exp(18.7 Cv) dyne/cm^2, eta = 0.00136 exp(28.4 Cv) poise.
  const r = mudRheology({ sediment: 'aspen-natural-soil', concentration: 0.45 });
  assert.ok(Math.abs(r.yieldStress - 0.1 * 0.152 * Math.exp(18.7 * 0.45)) < 1e-9);
  assert.ok(Math.abs(r.yieldStress - 68.6) < 0.5, `${r.yieldStress} Pa`);
  assert.ok(Math.abs(r.viscosity - 0.1 * 0.00136 * Math.exp(28.4 * 0.45)) < 1e-9);
  assert.ok(Math.abs(r.density - (1000 + 0.45 * 1650)) < 1e-9, 'mixture density');
  assert.ok(Math.abs(r.turbulence - 0.0538 * Math.exp(6.0896 * 0.45)) < 1e-12, 'n_td over n');
  assert.deepEqual(MUD_SEDIMENTS['glenwood-4'], [0.00172, 29.5, 0.000602, 33.1]);
  assert.deepEqual(MUD_SEDIMENTS['aspen-pit-1'], [0.181, 25.7, 0.036, 22.1]);
  assert.equal(Object.keys(MUD_SEDIMENTS).length, 10);
  // About three orders of magnitude from Cv 0.1 to 0.4, as O'Brien and Julien report.
  const thin = mudRheology({ concentration: 0.1 }),
    thick = mudRheology({ concentration: 0.4 });
  assert.ok(thick.yieldStress / thin.yieldStress > 100 && thick.viscosity / thin.viscosity > 1000);
});

test('mud options are checked', () => {
  assert.throws(() => mudRheology({ concentration: 0.9 }), /concentration/);
  assert.throws(() => mudRheology({ sediment: 'clay' }), /sediment/);
  assert.throws(() => mudRheology({ resistance: 1 }), /resistance/);
});
