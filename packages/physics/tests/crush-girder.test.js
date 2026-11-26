import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveGirder } from '../dist/crush.js';

const sample = (strain, stress) => ({ strain, stress });
const elastic = [sample(-0.00125, -250e6), sample(0, 0), sample(0.00125, 250e6)];
const close = (got, want, bound = 64 * Number.EPSILON * Math.max(1, Math.abs(want))) =>
  assert.ok(Math.abs(got - want) <= bound, `${got} differs from ${want} by more than ${bound}`);

test('girder fiber equilibrium gives the centroid, axial stiffness and elastic beam moment', () => {
  const fibers = [
    { offset: -0.5, area: 0.01, curve: elastic },
    { offset: 0.5, area: 0.02, curve: elastic },
  ];
  const young = 200e9;
  const centroid = 1 / 6;
  const inertia = fibers.reduce((sum, { area, offset }) => sum + area * (offset - centroid) ** 2, 0);
  for (const curvature of [-0.001, 0.001]) {
    const result = resolveGirder(fibers, curvature);
    close(result.axialForce, 0, 64 * Number.EPSILON * 250e6 * 0.03);
    close(result.neutralAxis, centroid);
    close(result.bendingMoment, young * inertia * curvature);
    close(result.axialStiffness, young * 0.03);
  }

  const axialForce = 75e3;
  const axial = resolveGirder(fibers, 0, { axialForce });
  assert.equal(axial.neutralAxis, undefined);
  close(axial.axialForce, axialForce);
  close(axial.referenceStrain, axialForce / (young * 0.03));
  close(axial.bendingMoment, axialForce * centroid);
});

test('fold-softened compression follows either stable axial branch according to the preceding strain', () => {
  const curve = [sample(-0.04, -10), sample(-0.015, -90), sample(0, 0), sample(0.1, 100)];
  const fibers = [
    { offset: -1, area: 1, curve },
    { offset: 1, area: 1, curve },
  ];
  const before = resolveGirder(fibers, 0.025, { axialForce: -2, previousStrain: -0.02 });
  const after = resolveGirder(fibers, 0.025, { axialForce: -2, previousStrain: 0.02 });
  // One branch has one yielded fiber. Both fibers have nonzero tangent on the other branch.
  close(before.referenceStrain, -0.017);
  close(before.axialStiffness, 1000);
  close(before.bendingMoment, 18);
  close(before.axialForce, -2);
  close(after.referenceStrain, 123 / 7000);
  close(after.axialStiffness, 7000);
  close(after.axialForce, -2, 64 * Number.EPSILON * 100);
  assert.ok(after.bendingMoment > before.bendingMoment);
  assert.equal(resolveGirder(fibers, 0.025, { axialForce: 201 }), undefined);
});

test('fully plastic bending retains the previous neutral strain on its balanced plateau', () => {
  const fibers = [
    { offset: -1, area: 0.04, curve: elastic },
    { offset: 1, area: 0.04, curve: elastic },
  ];
  const reference = 0.0001;
  const result = resolveGirder(fibers, 0.02, { previousStrain: reference });
  assert.equal(result.referenceStrain, reference);
  assert.equal(result.axialStiffness, 0);
  assert.equal(result.axialForce, 0);
  close(result.bendingMoment, 2 * 0.04 * 250e6);
});

test('elastic response of the published mild-steel box section lies in its held-out reloading slope band', () => {
  // Gordo and Guedes Soares 2014, section 3.3, gives area and geometric second moment. The
  // generators use the separate steel modulus. The reloading sensor band is held out (Fig. 12, N200).
  const area = 0.0121;
  const inertia = 0.000768;
  const centroidDistance = Math.sqrt(inertia / area);
  const yieldStrain = 270e6 / 200e9;
  const curve = [sample(-yieldStrain, -270e6), sample(0, 0), sample(yieldStrain, 270e6)];
  // Equal-area fibers at the RMS distance preserve the exact zeroth and second section moments in elasticity.
  const fibers = [-centroidDistance, centroidDistance].map((offset) => ({ offset, area: area / 2, curve }));
  const a = resolveGirder(fibers, 0.0005);
  const b = resolveGirder(fibers, 0.0015);
  const slope = (b.bendingMoment - a.bendingMoment) / 0.001;
  close(slope, 200e9 * inertia);
  assert.ok(slope > 140e6 && slope < 160e6);
});

test('girder inputs require finite geometry and ordered material curves with the unloaded state', () => {
  const fiber = { offset: -0.5, area: 0.01, curve: elastic };
  assert.throws(() => resolveGirder([fiber], 0), { code: 'state', message: /Pass two or more girder fibers/ });
  assert.throws(() => resolveGirder([fiber, { ...fiber, curve: elastic.toReversed() }], 0), {
    code: 'state',
    message: /Give girder samples in strictly increasing/,
  });
  assert.throws(() => resolveGirder([fiber, { ...fiber, offset: Infinity }], 0), {
    code: 'state',
    message: /Choose finite girder offsets/,
  });
});
