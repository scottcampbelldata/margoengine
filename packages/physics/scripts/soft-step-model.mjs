// The soft step of one contact as a scalar model: warm start, the biased pass with the soft coefficients, the position update and
// the relax pass (Catto, "Soft Constraints", GDC 2011; "Solver2D", 2024). A mass resting on a floor settles at the spring's own
// equilibrium g / omega^2 for every damping ratio, which `tests/next-parameters.test.js` holds the kernel to.
//   node packages/physics/scripts/soft-step-model.mjs
function resting({ hertz, zeta, substeps, g = 9.81, m = 1 }) {
  const h = 1 / 60 / substeps,
    omega = 2 * Math.PI * hertz,
    a1 = 2 * zeta + h * omega,
    a2 = h * omega * a1,
    biasRate = omega / a1,
    massScale = a2 / (1 + a2),
    impulseScale = 1 / (1 + a2);
  let gap = -1e-3,
    v = 0,
    impulse = 0;
  for (let i = 0; i < 300000; i++) {
    v += -g * h;
    v += impulse / m;
    let change = -m * massScale * (v + biasRate * gap) - impulseScale * impulse;
    let total = Math.max(impulse + change, 0);
    v += (total - impulse) / m;
    impulse = total;
    gap += v * h;
    change = -m * v;
    total = Math.max(impulse + change, 0);
    v += (total - impulse) / m;
    impulse = total;
  }
  return -gap / (g / omega ** 2);
}
for (const zeta of [0.3, 1, 10])
  console.log(
    `damping ratio ${zeta}: resting depth over g / omega^2 = ${resting({ hertz: 60, zeta, substeps: 8 }).toFixed(4)}`,
  );
