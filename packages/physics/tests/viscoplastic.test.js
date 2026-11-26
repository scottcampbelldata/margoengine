import assert from 'node:assert/strict';
import test from 'node:test';
import { ViscoplasticSolver } from '../dist/viscoplastic.js';
import { PhysicsWorld } from '../dist/world.js';

const rate = { num: 60, den: 1 };
const dt = 1 / 60;
const defaultShape = { cells: [8, 8, 8], spacing: 0.2, bulkModulus: 10_000, shearModulus: 100 };

async function make(options, gravity = [0, 0, 0]) {
  const material = await ViscoplasticSolver.load();
  const world = new PhysicsWorld({ rate, gravity }).add(material, { ...defaultShape, ...options });
  return { material, world };
}

function near(actual, expected, scale = 1, ulps = 128) {
  const bound = ulps * Number.EPSILON * Math.max(scale, Math.abs(expected));
  assert.ok(Math.abs(actual - expected) <= bound, `${actual} vs ${expected}, bound ${bound}`);
}

test('ViscoplasticSolver: quadratic APIC translates free-falling material while preserving its mass and stress-free shape', async () => {
  const start = [0.65, 1.4, 0.7];
  const v = [0.2, -0.01, 0.13];
  const points = [
    { position: start, velocity: v, volume: 0.000031 },
    { position: [0.7, 1.4, 0.7], velocity: v, volume: 0.000049 },
  ];
  const steps = 12;
  const { world, material } = await make({ points }, [0, -9.80665, 0]);
  world.advance(steps);
  const result = material.sample(0);
  near(result.position[0], start[0] + steps * dt * v[0]);
  near(result.position[1], start[1] + steps * dt * v[1] + (world.gravity[1] * dt * dt * steps * (steps + 1)) / 2);
  near(result.position[2], start[2] + steps * dt * v[2]);
  near(result.velocity[1], v[1] + steps * dt * world.gravity[1]);
  near(result.shearStress, 0, defaultShape.shearModulus);
  near(result.pressure, 0, defaultShape.bulkModulus);
  near(material.budget.storedReferenceVolume, 0.00008, 0.00008);
  near(material.budget.storedVolume, 0.00008, 0.00008);
  assert.ok(material.budget.occupiedNodes <= 27 * points.length);
});

function strain(grad, shear) {
  const k = grad * dt;
  const mean = 1 + (k * k) / 3;
  const trial = shear * Math.sqrt(k * k + k ** 4 / 3);
  return { k, mean, trial };
}

function correctedShear(grad, mean, trial, returned) {
  const k = grad * dt;
  const gain = returned / trial;
  const a = mean + gain * (1 + k * k - mean);
  const b = mean + gain * (1 - mean);
  const xy = gain * k;
  const normalization = ((a * b - xy * xy) * b) ** (-1 / 3);
  return returned * normalization;
}

async function shearExample(yieldStress, consistency, exponent) {
  const grad = 5;
  const shear = 100;
  const samples = Array.from({ length: 8 }, (_, i) => {
    const y = 0.65 + (i & 2) * 0.06;
    return {
      position: [0.65 + (i & 1) * 0.12, y, 0.65 + (i & 4) * 0.03],
      velocity: [grad * (y - 0.7), 0, 0],
      velocityGradient: [
        [0, grad, 0],
        [0, 0, 0],
        [0, 0, 0],
      ],
      volume: 0.0004,
    };
  });
  const { world, material } = await make({ points: samples, shearModulus: shear, yieldStress, consistency, exponent });
  world.advance(1);
  const sample = material.sample(0);
  assert.equal(material.budget.substeps, 1);
  near(sample.pressure, 0, defaultShape.bulkModulus);
  near(sample.volume, samples[0].volume, samples[0].volume);
  return { sample, grad, shear, ...strain(grad, shear) };
}

test('ViscoplasticSolver: sub-yield affine shear is elastic and the Bingham return matches its closed form', async () => {
  const below = await shearExample(20, 10, 1);
  assert.equal(below.sample.plasticShear, 0);
  near(below.sample.shearStress, below.trial, below.shear, 512);
  const flow = await shearExample(2, 10, 1);
  const returned = 2 + (flow.trial - 2) / (1 + (dt * flow.shear * flow.mean) / 10);
  near(flow.sample.shearStress, correctedShear(flow.grad, flow.mean, flow.trial, returned), flow.shear, 512);
  near(flow.sample.plasticShear, (flow.trial - returned) / (flow.shear * flow.mean));
});

test('ViscoplasticSolver: Herschel–Bulkley square-root law has the independently solved quadratic return', async () => {
  const y = 2;
  const consistency = 3;
  const flow = await shearExample(y, consistency, 0.5);
  const t = (dt * flow.shear * flow.mean) / (consistency * consistency);
  const excess = flow.trial - y;
  const returned = y + (2 * excess) / (1 + Math.sqrt(1 + 4 * t * excess));
  near(flow.sample.shearStress, correctedShear(flow.grad, flow.mean, flow.trial, returned), flow.shear, 512);
  near(flow.sample.plasticShear, (flow.trial - returned) / (flow.shear * flow.mean));
  assert.ok(flow.sample.plasticShear > 0);
});

test('ViscoplasticSolver: outflow delivers exact reference volume and a closed face retains the material', async () => {
  const point = { position: [1.58, 0.7, 0.7], velocity: [1, 0, 0], volume: 0.00025 };
  const options = { points: [point], friction: 0 };
  const open = await make({ ...options, walls: [true, false, true, true, true, true] });
  const shut = await make(options);
  open.world.advance(15);
  shut.world.advance(15);
  assert.equal(open.material.sample(0).present, false);
  assert.equal(open.material.budget.escapedReferenceVolume, point.volume);
  near(open.material.budget.escapedVolume, point.volume, point.volume);
  assert.equal(open.material.budget.activePoints, 0);
  assert.equal(shut.material.sample(0).present, true);
  assert.ok(shut.material.sample(0).position[0] <= 1.6);
  assert.equal(shut.material.budget.storedReferenceVolume, point.volume);
});

test('ViscoplasticSolver: unused slots publish finite records', async () => {
  const { world, material } = await make({ points: [{ position: [0.7, 0.7, 0.7], volume: 0.0001 }], capacity: 3 });
  world.advance(1);
  assert.deepEqual(material.sample(2), {
    position: [0, 0, 0],
    velocity: [0, 0, 0],
    volume: 0,
    pressure: 0,
    shearStress: 0,
    plasticShear: 0,
    present: false,
  });
});

test('ViscoplasticSolver: implicit solvent diffusion matches the symmetric occupied-node shear stencil', async () => {
  const grad = 20;
  const shear = 100;
  const dx = defaultShape.spacing;
  const solventViscosity = 5000;
  const density = 1600;
  const point = {
    position: [0.8, 0.8, 0.8],
    volume: 0.0004,
    velocityGradient: [
      [0, grad, 0],
      [0, 0, 0],
      [0, 0, 0],
    ],
  };
  const { world, material } = await make({
    points: [point],
    yieldStress: 200,
    shearModulus: shear,
    solventViscosity,
    density,
  });
  world.advance(1);
  const factor = 1 / (1 + (solventViscosity * dt) / (density * dx * dx));
  const expected = strain(grad * factor, shear).trial;
  const sample = material.sample(0);
  assert.equal(material.budget.substeps, 1);
  near(sample.shearStress, expected, shear, 1024);
  near(sample.velocity[0], 0);
  near(sample.plasticShear, 0);
  assert.ok(sample.shearStress < strain(grad, shear).trial);
});
