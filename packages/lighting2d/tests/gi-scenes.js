// Shared scenes; independent energy/visibility assertions also run in Node and on GPU.
export const rcCases = [
  {
    name: 'F4 child directions cannot cross opaque wall',
    point: [0, 0],
    options: { cascades: 2, baseRays: 1, baseDistance: 16, bounces: 0 },
    scene: {
      occluders: [{ shape: 'segment', from: [5, -100], to: [5, 100] }],
      emitters: [{ x: 30, y: 30, radius: 2 }],
    },
    exact: [0, 0, 0],
  },
  {
    name: 'F5 sealed emitter cannot illuminate outside reflector',
    point: [0, 0],
    options: { cascades: 1, baseRays: 1, baseDistance: 100, bounces: 1 },
    scene: {
      emitters: [{ x: 20, y: 0, radius: 0.1 }],
      occluders: [
        { shape: 'box', width: 2, height: 2, offset: [20, 0] },
        { shape: 'segment', from: [-10, -20], to: [-10, 20] },
      ],
    },
    exact: [0, 0, 0],
  },
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((cascades) => ({
    name: `F7 enclosing opaque emitter conserves energy level ${cascades}`,
    point: [0.5, 0.5],
    options: { cascades, angularRatio: 1, baseDistance: 2, intervalRatio: 2, bounces: 0 },
    scene: { emitters: [{ x: 0, y: 0, radius: 1000 }] },
    exact: [1, 1, 1],
  })),
  ...[4, 5, 6, 7, 8].map((cascades) => ({
    name: `F6 far source uses cascade ${cascades}`,
    point: [0.5, 0.5],
    options: { cascades, angularRatio: 1, baseDistance: 16, intervalRatio: 4, bounces: 0 },
    scene: { emitters: [{ x: 500 / Math.sqrt(2), y: 500 / Math.sqrt(2), radius: 20 }] },
    positive: true,
  })),
  ...[0, 1, 2, 4].map((bounces) => ({
    name: `F6 actual surface order ${bounces}`,
    point: [10.5, 10.5],
    options: { cascades: 2, baseDistance: 32, bounces, albedo: 0.7 },
    scene: {
      emitters: [{ x: 10, y: 5, radius: 2 }],
      occluders: [{ shape: 'box', width: 20, height: 20, offset: [10, 10] }],
    },
    bounceOrder: bounces,
  })),
  {
    name: 'F7 nearest emitter blocks farther emitter',
    point: [0.5, 0.5],
    options: { cascades: 3, baseRays: 1, angularRatio: 1, baseDistance: 8, bounces: 0 },
    scene: {
      emitters: [
        { x: -4, y: 0.5, radius: 1, color: [1, 0, 0] },
        { x: -20, y: 0.5, radius: 5, color: [0, 1, 0] },
      ],
    },
    exact: [1, 0, 0],
  },
  ...[14, 15, 16, 17, 18].map((distance) => ({
    name: `F4 F7 ringing boundary ${distance}`,
    point: [0.5, 0.5],
    options: { cascades: 3, baseRays: 8, baseDistance: 16, bounces: 0 },
    scene: { emitters: [{ x: distance, y: 0, radius: 6, intensity: 0.25 }] },
    bounded: 0.25,
  })),
];

export const radialCases = [8, 12, 15, 16, 17, 20, 30, 32, 33, 40, 60].map((distance) => ({
  name: `RASTI opaque circle analytic angular measure at ${distance}`,
  point: [0.5, 0.5],
  options: { cascades: 4, baseRays: 32, baseDistance: 8, bounces: 0 },
  scene: { emitters: [{ x: distance + 0.5, y: 0.5, radius: 6 }] },
  analytic: Math.asin(6 / distance) / Math.PI,
}));

for (const bounces of [0, 2, 4]) {
  const sealed = rcCases.find((c) => c.name.startsWith('F5'));
  rcCases.push({ ...sealed, name: `F5 sealed source at order ${bounces}`, options: { ...sealed.options, bounces } });
}

// A uniform enclosing source is an exact oracle for integer dispatch coverage at every direction.
// A narrow source at 45 degrees is not such an oracle: an eight-direction quadrature can miss it.
for (const angularRatio of [2, 3, 5, 7, 8]) {
  rcCases.push({
    name: `F6 integer angular branching ${angularRatio}`,
    point: [0.5, 0.5],
    options: { cascades: 4, baseRays: 4, angularRatio, baseDistance: 16, bounces: 0 },
    scene: { emitters: [{ x: 0, y: 0, radius: 1e9 }] },
    exact: [1, 1, 1],
    coverage: true,
  });
}
