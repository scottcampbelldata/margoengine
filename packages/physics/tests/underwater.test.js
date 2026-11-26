import assert from 'node:assert/strict';
import test from 'node:test';

import { acousticBeamPressure, UnderwaterAcousticsSolver } from '../dist/underwater.js';
import { PhysicsWorld } from '../dist/world.js';

function make(options = {}) {
  const solver = new UnderwaterAcousticsSolver();
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(solver, options);
  return { solver, world };
}

function close(actual, expected, scale = Math.max(1, Math.abs(expected)), operations = 200) {
  const tolerance = operations * Number.EPSILON * scale;
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected} by more than ${tolerance}`);
}

function arc(speed, initialSine, slowness, slope, seconds) {
  const u = Math.tanh(Math.atanh(initialSine) - slope * seconds);
  const c = Math.sqrt((1 - u) * (1 + u)) / slowness;
  return {
    u,
    dx: (initialSine - u) / (slowness * slope),
    dz: (c - speed) / slope,
    length: (Math.asin(initialSine) - Math.asin(u)) / (slowness * slope),
  };
}

test('uniform sound speed gives straight ray travel and the homogeneous Porter–Bucker beam', () => {
  const speed = 1500;
  const depth = 40;
  const frequency = 1200;
  const waist = 4;
  const absorption = 8;
  const { solver, world } = make({ rays: [{ depth, frequency, waist, pressure: 2 }], absorption });
  world.advance(60);
  const ray = solver.sample(0);
  const norm = Math.hypot(speed * speed, Math.PI * frequency * waist * waist);
  const spreading = norm / (Math.PI * frequency * waist * waist);
  const phase = 0.5 * Math.atan2(speed * speed, Math.PI * frequency * waist * waist);
  close(ray.range, speed, speed, 600);
  close(ray.pathLength, speed, speed, 600);
  close(ray.travelTime, 1, 1, 600);
  close(ray.depth, depth);
  close(ray.width, waist * spreading, ray.width, 600);
  close(ray.curvature, (-speed * speed * speed) / (norm * norm), 1, 600);
  close(ray.pressure, (2 / Math.sqrt(spreading)) * Math.pow(10, (-absorption * speed) / 20000), 2, 600);
  const axis = acousticBeamPressure(ray, 0);
  const wing = acousticBeamPressure(ray, ray.width);
  close(Math.hypot(axis.real, axis.imaginary), ray.pressure);
  close(Math.hypot(wing.real, wing.imaginary), ray.pressure / Math.E);
  // Frequency times travel time magnifies clock roundoff, so use the bound for phase rather than path length.
  close(axis.real, ray.pressure * Math.cos(phase), 2 * Math.PI * frequency, 600);
  close(axis.imaginary, ray.pressure * Math.sin(phase), 2 * Math.PI * frequency, 600);
});

test('a linear gradient gives the circular Snell arc and a smooth interior turning point', () => {
  const slope = 0.5;
  const profile = [
    { depth: 0, speed: 1450 },
    { depth: 1000, speed: 1950 },
  ];
  const depth = 100;
  const direction = 0.12;
  const { solver, world } = make({ profile, rays: [{ depth, declination: direction }] });
  const p = Math.cos(direction) / 1500;
  const at = arc(1500, Math.sin(direction), p, slope, 0.4);
  world.advance(24);
  const ray = solver.sample(0);
  assert.ok(ray.declination < 0, 'the initially descending ray turns upwards away from higher sound speed');
  close(ray.range, at.dx, 1500, 500);
  close(ray.depth, depth + at.dz, 1500, 500);
  close(ray.pathLength, at.length, 1500, 500);
  close(Math.cos(ray.declination) / ray.soundSpeed, p, p, 500);
  assert.equal(ray.reflections, 0);
});

test('a kink between sound-speed layers changes beam curvature while preserving Snell slowness', () => {
  const profile = [
    { depth: 0, speed: 1490 },
    { depth: 100, speed: 1500 },
    { depth: 500, speed: 1580 },
  ];
  const declination = 0.4;
  const depth = 90;
  const frequency = 1200;
  const waist = 5;
  const { solver, world } = make({ profile, rays: [{ depth, declination, frequency, waist }] });
  assert.equal(solver.soundSpeed(95), 1499.5);
  assert.equal(solver.soundSpeed(100), 1500);
  assert.equal(solver.soundSpeed(300), 1540);
  const c0 = 1499;
  const edgeSpeed = 1500;
  const p = Math.cos(declination) / c0;
  const u0 = Math.sin(declination);
  const uEdge = Math.sqrt(1 - p * p * edgeSpeed * edgeSpeed);
  const arrival = (Math.atanh(u0) - Math.atanh(uEdge)) / 0.1;
  const seconds = 0.15;
  const firstJ = (u0 - uEdge) / (p * p * 0.1);
  const second = arc(edgeSpeed, uEdge, p, 0.2, seconds - arrival);
  const secondJ = second.dx / p;
  const kick = (-0.1 * p * p) / uEdge;
  const epsilon = Math.PI * frequency * waist * waist;
  const pReal = 1 + kick * firstJ;
  const pImag = kick * epsilon;
  const qReal = firstJ + secondJ * pReal;
  const qImag = epsilon + secondJ * pImag;
  const norm = Math.hypot(qReal, qImag);
  world.advance(9);
  const ray = solver.sample(0);
  close(ray.range, firstJ * p + second.dx, 1500, 700);
  close(ray.depth, 100 + second.dz, 1500, 700);
  close(Math.cos(ray.declination) / ray.soundSpeed, p, p, 700);
  close(ray.width, (waist * norm) / epsilon, ray.width, 700);
  close(ray.curvature, (-ray.soundSpeed * (pReal * qReal + pImag * qImag)) / (norm * norm), 1, 700);
  assert.equal(ray.reflections, 0);
});

test('the free surface inverts pressure and the bottom attenuates repeated arrivals', () => {
  const { solver, world } = make({ rays: [{ depth: 25, declination: Math.PI / 2 }], bottomReflection: 0.8 });
  world.advance(12);
  const ray = solver.sample(0);
  assert.equal(ray.reflections, 3);
  assert.equal(ray.range, 0);
  close(ray.depth, 75, 100);
  close(ray.pathLength, 300, 300);
  assert.equal(ray.declination, -Math.PI / 2);
  const epsilon = Math.PI * 1000 * 25;
  const qNorm = Math.hypot(300 * 1500, epsilon);
  close(ray.pressure, -0.8 * 0.8 * Math.sqrt(epsilon / qNorm));
});

test('a ray can turn and reflect on its opposite boundary within one world tick', () => {
  const slope = 20;
  const profile = [
    { depth: 0, speed: 1490 },
    { depth: 1, speed: 1510 },
  ];
  const direction = 0.08;
  const { solver, world } = make({ profile, rays: [{ depth: 0.5, declination: direction }] });
  const sine = Math.sin(direction);
  const slowness = Math.cos(direction) / 1500;
  const surfaceSine = Math.sqrt(1 - slowness * slowness * 1490 * 1490);
  const arrival = (Math.atanh(sine) + Math.atanh(surfaceSine)) / slope;
  const incoming = arc(1500, sine, slowness, slope, arrival);
  const outgoing = arc(1490, surfaceSine, slowness, slope, 1 / 60 - arrival);
  world.advance(1);
  const ray = solver.sample(0);
  assert.equal(ray.reflections, 1);
  close(ray.range, incoming.dx + outgoing.dx, 100);
  close(ray.depth, outgoing.dz, 100);
  close(ray.pathLength, incoming.length + outgoing.length, 100);
  assert.ok(ray.pressure < 0);
});

test('horizontal sound at a channel minimum stays on its axis and validates outside depths', () => {
  const profile = [
    { depth: 0, speed: 1600 },
    { depth: 100, speed: 1500 },
    { depth: 200, speed: 1600 },
  ];
  const { solver, world } = make({ profile });
  assert.throws(() => solver.soundSpeed(-1), /use a depth/);
  assert.throws(
    () =>
      make({
        profile: [
          { depth: 0, speed: 1500 },
          { depth: 0, speed: 1510 },
        ],
      }),
    /strictly increasing/,
  );
  assert.throws(() => make({ surfaceReflection: 2 }), /signed pressure ratio/);
  world.advance(60);
  const ray = solver.sample(0);
  assert.equal(ray.depth, 100);
  assert.equal(ray.declination, 0);
  assert.equal(ray.reflections, 0);
});
