// Cornell box for the batch 168 irradiance measurement.
// Geometry and spectra: Cornell University, "Cornell Box Data"
// (https://bowers.cornell.edu/computer-graphics/data, the same tables as
// https://www.graphics.cornell.edu/online/box/data.html).
// Published quads are not all parallelograms. Each face keeps p0, then p1 and p3
// (swapped when the normal would face the wrong way), and p2 is set to p1 + p3 - p0.
// The floor and the ceiling stay one quad each: the published holes are omitted, and the
// light is an area light one published unit below the ceiling so the ceiling does not cover it.
// Coordinates are the published numbers times SCALE (the box is about 5.5 world units).
import { rectFrame } from '../../shared/rect-frame.js';

export const SCALE = 0.01;
export const TEXELS_PER_UNIT = 2;
export const PADDING = 1;
export const AREA_SAMPLES = 16;
export const BOUNCES = 1;
export const BOUNCE_RAYS = 16;
export const SEED = 1;
/** Published units the area light is lowered, so it sits under the ceiling quad. */
export const LIGHT_DROP = 1;
export const CYCLES_SAMPLES = 128;
/** The direct-only calibration quad is 0.25 on a side. Density 16 makes a 4 by 4 chart. */
export const CALIBRATION_TEXELS = 16;

const SPECTRUM = `
400 0.343 0.092 0.040
404 0.445 0.096 0.046
408 0.551 0.098 0.048
412 0.624 0.097 0.053
416 0.665 0.098 0.049
420 0.687 0.095 0.050
424 0.708 0.095 0.053
428 0.723 0.097 0.055
432 0.715 0.095 0.057
436 0.710 0.094 0.056
440 0.745 0.097 0.059
444 0.758 0.098 0.057
448 0.739 0.096 0.061
452 0.767 0.101 0.061
456 0.777 0.103 0.060
460 0.765 0.104 0.062
464 0.751 0.107 0.062
468 0.745 0.109 0.062
472 0.748 0.112 0.061
476 0.729 0.115 0.062
480 0.745 0.125 0.060
484 0.757 0.140 0.059
488 0.753 0.160 0.057
492 0.750 0.187 0.058
496 0.746 0.229 0.058
500 0.747 0.285 0.058
504 0.735 0.343 0.056
508 0.732 0.390 0.055
512 0.739 0.435 0.056
516 0.734 0.464 0.059
520 0.725 0.472 0.057
524 0.721 0.476 0.055
528 0.733 0.481 0.059
532 0.725 0.462 0.059
536 0.732 0.447 0.058
540 0.743 0.441 0.059
544 0.744 0.426 0.061
548 0.748 0.406 0.061
552 0.728 0.373 0.063
556 0.716 0.347 0.063
560 0.733 0.337 0.067
564 0.726 0.314 0.068
568 0.713 0.285 0.072
572 0.740 0.277 0.080
576 0.754 0.266 0.090
580 0.764 0.250 0.099
584 0.752 0.230 0.124
588 0.736 0.207 0.154
592 0.734 0.186 0.192
596 0.741 0.171 0.255
600 0.740 0.160 0.287
604 0.732 0.148 0.349
608 0.745 0.141 0.402
612 0.755 0.136 0.443
616 0.751 0.130 0.487
620 0.744 0.126 0.513
624 0.731 0.123 0.558
628 0.733 0.121 0.584
632 0.744 0.122 0.620
636 0.731 0.119 0.606
640 0.712 0.114 0.609
644 0.708 0.115 0.651
648 0.729 0.117 0.612
652 0.730 0.117 0.610
656 0.727 0.118 0.650
660 0.707 0.120 0.638
664 0.703 0.122 0.627
668 0.729 0.128 0.620
672 0.750 0.132 0.630
676 0.760 0.139 0.628
680 0.751 0.144 0.642
684 0.739 0.146 0.639
688 0.724 0.150 0.657
692 0.730 0.152 0.639
696 0.740 0.157 0.635
700 0.737 0.159 0.642
`;

/** Published emission knots, wavelength nm and relative value. Not watts. */
export const EMISSION_KNOTS = [
  [400, 0],
  [500, 8],
  [600, 15.6],
  [700, 18.4],
];

const add = (a, b) => a.map((v, i) => v + b[i]);
const sub = (a, b) => a.map((v, i) => v - b[i]);
const cross = (u, v) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const avg = (pts) => pts.reduce((s, p) => add(s, p), [0, 0, 0]).map((v) => v / pts.length);
const mul = (p) => p.map((v) => v * SCALE);

export function spectrumRows() {
  return SPECTRUM.trim()
    .split('\n')
    .map((line) => {
      const [w, white, green, red] = line.trim().split(/\s+/).map(Number);
      return { w, white, green, red };
    });
}

export function emissionAt(wavelength) {
  const knots = EMISSION_KNOTS;
  for (let i = 0; i < knots.length - 1; i++) {
    const [a, ea] = knots[i],
      [b, eb] = knots[i + 1];
    if (wavelength >= a && wavelength <= b) return ea + ((eb - ea) * (wavelength - a)) / (b - a);
  }
  return 0;
}

/**
 * RGB reflectance weighted by the published emission in three bands (600 to 700, 500 to 600,
 * 400 to 500), and the mean emission in those bands. This is not a CIE match.
 */
export function bandRgb() {
  const rows = spectrumRows(),
    bands = [
      [600, 701],
      [500, 600],
      [400, 500],
    ],
    weight = (column) =>
      bands.map(([lo, hi]) => {
        let num = 0,
          den = 0,
          emit = 0,
          count = 0;
        for (const row of rows) {
          if (row.w < lo || row.w >= hi) continue;
          const e = emissionAt(row.w);
          num += row[column] * e;
          den += e;
          emit += e;
          count++;
        }
        return { albedo: den > 0 ? num / den : 0, emission: count ? emit / count : 0 };
      });
  const white = weight('white'),
    green = weight('green'),
    red = weight('red');
  return {
    white: white.map((b) => b.albedo),
    green: green.map((b) => b.albedo),
    red: red.map((b) => b.albedo),
    emission: white.map((b) => b.emission),
  };
}

function orient(name, material, corners, toward) {
  let [p0, p1, p2, p3] = corners.map((c) => c.slice());
  const publishedP2 = p2.slice(),
    n = cross(sub(p1, p0), sub(p3, p0)),
    center = avg(corners);
  let flipped = false;
  if (dot(n, sub(toward, center)) < 0) {
    [p1, p3] = [p3, p1];
    flipped = true;
  }
  const snapped = add(p1, sub(p3, p0));
  return {
    name,
    material,
    flipped,
    publishedP2,
    snappedP2: snapped,
    delta: sub(snapped, publishedP2),
    corners: [p0, p1, snapped, p3],
  };
}

const roomToward = [278, 274.4, 279.6];
const shortFaces = [
  [
    [130, 165, 65],
    [82, 165, 225],
    [240, 165, 272],
    [290, 165, 114],
  ],
  [
    [290, 0, 114],
    [290, 165, 114],
    [240, 165, 272],
    [240, 0, 272],
  ],
  [
    [130, 0, 65],
    [130, 165, 65],
    [290, 165, 114],
    [290, 0, 114],
  ],
  [
    [82, 0, 225],
    [82, 165, 225],
    [130, 165, 65],
    [130, 0, 65],
  ],
  [
    [240, 0, 272],
    [240, 165, 272],
    [82, 165, 225],
    [82, 0, 225],
  ],
];
const tallFaces = [
  [
    [423, 330, 247],
    [265, 330, 296],
    [314, 330, 456],
    [472, 330, 406],
  ],
  [
    [423, 0, 247],
    [423, 330, 247],
    [472, 330, 406],
    [472, 0, 406],
  ],
  [
    [472, 0, 406],
    [472, 330, 406],
    [314, 330, 456],
    [314, 0, 456],
  ],
  [
    [314, 0, 456],
    [314, 330, 456],
    [265, 330, 296],
    [265, 0, 296],
  ],
  [
    [265, 0, 296],
    [265, 330, 296],
    [423, 330, 247],
    [423, 0, 247],
  ],
];
const outside = (corners, centroid) => {
  const c = avg(corners);
  return c.map((_, i) => 2 * c[i] - centroid[i]);
};

function blockQuads(faces, names, centroid) {
  return faces.map((corners, i) => orient(names[i], 'white', corners, outside(corners, centroid)));
}

/** Published-unit quads after the winding fix and the parallelogram snap. */
export function publishedQuads() {
  const shortCentroid = avg(shortFaces.flat()),
    tallCentroid = avg(tallFaces.flat());
  return [
    orient(
      'floor',
      'white',
      [
        [552.8, 0, 0],
        [0, 0, 0],
        [0, 0, 559.2],
        [549.6, 0, 559.2],
      ],
      roomToward,
    ),
    orient(
      'ceiling',
      'white',
      [
        [556, 548.8, 0],
        [556, 548.8, 559.2],
        [0, 548.8, 559.2],
        [0, 548.8, 0],
      ],
      roomToward,
    ),
    orient(
      'back',
      'white',
      [
        [549.6, 0, 559.2],
        [0, 0, 559.2],
        [0, 548.8, 559.2],
        [556, 548.8, 559.2],
      ],
      roomToward,
    ),
    orient(
      'right',
      'green',
      [
        [0, 0, 559.2],
        [0, 0, 0],
        [0, 548.8, 0],
        [0, 548.8, 559.2],
      ],
      roomToward,
    ),
    orient(
      'left',
      'red',
      [
        [552.8, 0, 0],
        [549.6, 0, 559.2],
        [556, 548.8, 559.2],
        [556, 548.8, 0],
      ],
      roomToward,
    ),
    ...blockQuads(shortFaces, ['short-top', 'short-a', 'short-b', 'short-c', 'short-d'], shortCentroid),
    ...blockQuads(tallFaces, ['tall-top', 'tall-a', 'tall-b', 'tall-c', 'tall-d'], tallCentroid),
  ];
}

export function chartSize(p0, p1, p3) {
  const edge = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  return {
    width: Math.max(1, Math.ceil(edge(p0, p1) * TEXELS_PER_UNIT)),
    height: Math.max(1, Math.ceil(edge(p0, p3) * TEXELS_PER_UNIT)),
  };
}

/** The rectangle `bakeGlobalLightmap` builds for this light (corner, edges, radiance). */
export function rectangleOf(light) {
  const { normal, right, up } = rectFrame(light.direction, light.up, 'cornell area light'),
    u = right.map((v) => v * light.width),
    v = up.map((v) => v * light.height),
    color = light.color ?? [1, 1, 1],
    intensity = light.intensity ?? 1;
  return {
    corner: [0, 1, 2].map((i) => light.position[i] - u[i] * 0.5 - v[i] * 0.5),
    u,
    v,
    normal,
    radiance: color.map((c) => c * intensity),
  };
}

/** Scaled scene: quads, albedo, area light, and the direct-only calibration pair. */
export function cornellScene() {
  const rgb = bandRgb(),
    quads = publishedQuads().map((quad) => {
      const corners = quad.corners.map(mul);
      return {
        ...quad,
        corners,
        albedo: rgb[quad.material],
        chart: chartSize(corners[0], corners[1], corners[3]),
      };
    }),
    light = {
      position: mul([278, 548.8 - LIGHT_DROP, 279.5]),
      direction: [0, -1, 0],
      up: [0, 0, 1],
      width: 130 * SCALE,
      height: 105 * SCALE,
      color: rgb.emission,
      intensity: 1,
    },
    half = 0.125,
    calibration = {
      positions: [-half, 0, -half, -half, 0, half, half, 0, half, half, 0, -half],
      light: {
        position: [0, 2, 0],
        direction: [0, -1, 0],
        up: [0, 0, 1],
        width: 1,
        height: 1,
        color: [1, 1, 1],
        intensity: 1,
      },
      chart: {
        width: Math.max(1, Math.ceil(half * 2 * CALIBRATION_TEXELS)),
        height: Math.max(1, Math.ceil(half * 2 * CALIBRATION_TEXELS)),
      },
    };
  return { quads, light, rgb, calibration };
}

/** Float32 positions, with p2 rewritten so the baker sees a parallelogram after rounding. */
export function positionsOf(quads) {
  const data = new Float32Array(quads.length * 12);
  quads.forEach((quad, q) => {
    quad.corners.forEach((corner, k) => data.set(corner, q * 12 + k * 3));
    const o = q * 12;
    for (let a = 0; a < 3; a++) data[o + 6 + a] = data[o + 3 + a] + data[o + 9 + a] - data[o + a];
  });
  return data;
}

export function albedoOf(quads) {
  const data = new Float32Array(quads.length * 4);
  quads.forEach((quad, q) => data.set([quad.albedo[0], quad.albedo[1], quad.albedo[2], 1], q * 4));
  return data;
}

/** Mean physical irradiance of the calibration chart from independent midpoint quadrature. */
export function calibrationIrradiance(calibration, steps = 128) {
  const rect = rectangleOf(calibration.light);
  const area = Math.hypot(...cross(rect.u, rect.v));
  const sum = [0, 0, 0];
  const { width, height } = calibration.chart;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const p = [0, 1, 2].map(
        (a) =>
          calibration.positions[a] +
          ((calibration.positions[3 + a] - calibration.positions[a]) * (x + 0.5)) / width +
          ((calibration.positions[9 + a] - calibration.positions[a]) * (y + 0.5)) / height,
      );
      for (let v = 0; v < steps; v++)
        for (let u = 0; u < steps; u++) {
          const d = [0, 1, 2].map(
            (a) => rect.corner[a] + (rect.u[a] * (u + 0.5)) / steps + (rect.v[a] * (v + 0.5)) / steps - p[a],
          );
          const distance = Math.hypot(...d);
          const direction = d.map((value) => value / distance);
          const weight =
            (Math.max(0, direction[1]) * Math.max(0, -dot(rect.normal, direction)) * area) /
            (distance * distance * steps * steps * width * height);
          for (let c = 0; c < 3; c++) sum[c] += rect.radiance[c] * weight;
        }
    }
  return sum;
}
