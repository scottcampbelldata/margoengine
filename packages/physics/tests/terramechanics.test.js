import assert from 'node:assert/strict';
import test from 'node:test';
import { TerrainBed } from '@margoengine/physics/earth';
import { Terramechanics, wheelSoil } from '@margoengine/physics/terramechanics';
import { PhysicsWorld } from '@margoengine/physics/world';

test('two footprint widths separate the width-dependent and independent pressure coefficients', () => {
  const material = { cohesiveModulus: 1000, frictionalModulus: 400000, exponent: 1.2 };
  const narrow = wheelSoil(0.1, 0.3, material, false);
  const wide = wheelSoil(0.2, 0.3, material, true);
  assert.equal(narrow.stiffness, 410000);
  assert.equal(wide.stiffness, 405000);
  assert.equal(narrow.exponent, 1.2);
  assert.equal(wide.exponent, 1.2);
  assert.equal(narrow.area, 0.03);
  assert.equal(wide.area, 0.015 * Math.PI);
});

test('held-out Apfelbeck equal-area square plates for dry quartz sand and fire clay', async () => {
  // Apfelbeck et al. (2011), https://doi.org/10.1016/j.jterra.2011.04.001, Table 5 identifies the
  // coefficients with circular plates. Figure 8 measured the 1:1 square plates separately.
  const area = Math.PI * 0.05 * 0.05;
  const side = Math.sqrt(area);
  const terrain = { columns: 128, rows: 128, width: 0.25, depth: 0.25, centre: [0, 0] };
  const trials = [
    // Quartz, slow circular fit and the faster square test. At 41.21 kPa, the blue bar spans 18.7–21.1 mm.
    {
      label: 'quartz sand',
      cohesiveModulus: -9800,
      frictionalModulus: 1_200_000,
      exponent: 0.8,
      pressure: 41_210,
      lower: 0.0186,
      upper: 0.0212,
    },
    // Fire clay, fast circular fit. In Figure 8 the measured blue square trace crosses 2 kPa
    // between its 24.5 mm and 30.5 mm observations. The extra 0.2 mm covers one rendered plot pixel.
    {
      label: 'fire clay',
      cohesiveModulus: 7000,
      frictionalModulus: 220_000,
      exponent: 1.45,
      pressure: 2000,
      lower: 0.0243,
      upper: 0.0307,
    },
  ];
  for (const material of trials) {
    for (const tier of ['mean', 'resolved']) {
      const soil = await Terramechanics.load({ tier });
      const bed = new TerrainBed();
      // Use the same published plate coefficient in the mean solver, expressed as a single effective modulus
      // since it takes a nominal width. The resolved solver computes 2A/P for the chosen square itself.
      const fit =
        tier === 'mean'
          ? {
              ...material,
              cohesiveModulus: 0,
              frictionalModulus: material.frictionalModulus + (2 * material.cohesiveModulus) / side,
            }
          : material;
      const world = new PhysicsWorld({ rate: { num: 60, den: 1 } })
        .add(bed, { ...terrain, elevations: () => 0 })
        .add(soil, {
          terrain,
          material: fit,
          patches: [{ x: 0, z: 0, length: side, width: side, load: material.pressure * area }],
        })
        .couple(['terramechanics', 'bed'], 'staggered');
      world.advance(1);
      const actual = -bed.elevations()[64 * 129 + 64];
      assert.ok(
        actual >= material.lower && actual <= material.upper,
        `${material.label}, ${tier} ${actual}, measured ${material.lower}–${material.upper} m`,
      );
    }
  }
});
