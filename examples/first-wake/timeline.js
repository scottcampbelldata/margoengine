import { CatmullRomCurve3 } from '@margoengine/geometry';

export const duration = 97;
export const underwaterPass = { start: 51, end: 65 };
export const berth = [3, 0, 0];
// The mesh's full length includes the raked stem above the waterline.
export const vesselLength = 71.9;
export const waterlineOffset = -1.02;
export const surveyHull = { length: 68.68, beam: 15.5, draft: 7.16, entrance: 28 };

const clamp = (t) => Math.max(0, Math.min(1, t));
const mix = (a, b, t) => a + (b - a) * t;
export function ease(time, a, b) {
  const u = clamp((time - a) / (b - a));
  return u * u * (3 - 2 * u);
}

export function shipPath(time) {
  const t = Math.max(0, time - 1.65);
  const advance = 3.05 * (t - 12 * (1 - Math.exp(-t / 12))) - 1.54 * Math.max(0, t - 51);
  return [berth[0] + advance, 11.5 * ease(t, 2, 26) + 7.4 * ease(t, 39, 61)];
}

function shipHeading(t) {
  const earlier = shipPath(Math.max(0, t - 0.05));
  const later = shipPath(t + 0.05);
  const dx = later[0] - earlier[0];
  const dz = later[1] - earlier[1];
  return dx > 0 ? Math.atan2(dx, dz) : Math.PI / 2;
}

export function waterlinePath(t) {
  const [x, z] = shipPath(t);
  const heading = shipHeading(t);
  return [x + waterlineOffset * Math.sin(heading), z + waterlineOffset * Math.cos(heading)];
}

export function screwAngle(t) {
  return -2 * Math.PI * 1.1 * Math.max(0, t - 1.65);
}

export function shipPose(t) {
  const [x, z] = waterlinePath(t);
  const heading = shipHeading(t);
  const underway = ease(t, 2, 14);
  const roll = 0.027 * Math.sin((t - 38.3) * ((2 * Math.PI) / 11.0)) * underway;
  const pitch = 0.0048 * Math.sin(t * 1.04) * underway;
  return {
    position: [x, underway * (0.07 * Math.sin(t * 0.7) + 0.024 * Math.sin(t * 1.22)), z],
    rotation: [pitch, heading, roll],
  };
}

const cuts = [
  {
    start: 0,
    end: 4.25,
    sceneStart: 37.5,
    track: true,
    eye: [
      [45.2, 2.22, 12.4],
      [43.0, 2.63, 13.9],
    ],
    at: [
      [29.6, 3.05, 0.75],
      [27.4, 3.1, 1.4],
    ],
    fov: [45, 42],
  },
  {
    start: 4.25,
    end: 11.25,
    eye: [
      [-43.5, 3.36, -8.84],
      [-41.4, 3.2, -7.8],
    ],
    at: [
      [-24, 5.2, 0.6],
      [-21, 5.2, 1.6],
    ],
    fov: [49, 46],
  },
  {
    start: 11.25,
    end: 19,
    eye: [
      [47.5, 9.2, 10.1],
      [48.9, 10.1, 15.0],
    ],
    at: [
      [26, 10.2, 1.2],
      [36.2, 10.4, 2.5],
    ],
    fov: [41, 44],
  },
  {
    start: 19,
    end: 27.5,
    eye: [
      [-13, 7.5, 47],
      [4.7, 7.0, 49.3],
    ],
    at: [
      [16.9, 6.2, 1.7],
      [35.1, 5.7, 7.1],
    ],
    fov: [44, 46],
  },
  {
    start: 27.5,
    end: 35,
    track: true,
    eye: [
      [-42.7, 1.02, 2.85],
      [-45.0, 1.15, 6.9],
    ],
    at: [
      [-29, 5.15, -0.4],
      [-24.8, 5.15, 1.4],
    ],
    fov: [47, 46],
  },
  {
    start: 35,
    end: 43.5,
    track: true,
    eye: [
      [-55, 16, 33],
      [-51, 16.7, 37],
    ],
    at: [
      [-11, 2.7, 1],
      [-10, 2.4, 2],
    ],
    fov: [41, 39],
  },
  {
    start: 43.5,
    end: 51,
    eye: [
      [64.6, 3.9, -8.25],
      [69.8, 4.15, -8.3],
    ],
    at: [
      [84.5, 3.1, 4.0],
      [105.0, 4.5, 9.8],
    ],
    fov: [47, 46],
  },
  {
    ...underwaterPass,
    track: true,
    submerged: true,
    eye: new CatmullRomCurve3([
      [34, -4.9, 20.6],
      [8.5, -6.3, 16.8],
      [-24.7, -7.45, 11.5],
      [-36.15, -7.05, 6.7],
    ]),
    at: new CatmullRomCurve3([
      [16, -2.9, 1.2],
      [-14, -4.15, 0.18],
      [-28.7, -4.5, 0.05],
      [-28.55, -4.4, 0.13],
    ]),
    fov: [55, 43],
  },
  {
    start: 65,
    end: 75.5,
    eye: [
      [50.2, 16.2, 33.5],
      [58.7, 16.8, 35],
    ],
    at: [
      [123.5, 3.7, 13.6],
      [139.5, 3.7, 15.4],
    ],
    fov: [39, 36],
  },
  {
    start: 75.5,
    end: 82.5,
    track: true,
    eye: [
      [44.0, 3.2, 20.5],
      [42.8, 3.9, 25.6],
    ],
    at: [
      [20.1, 4.2, -2.4],
      [18.5, 4.3, -2.1],
    ],
    fov: [46, 44],
  },
  {
    start: 82.5,
    end: 90,
    eye: [
      [94.4, 13.4, 30.8],
      [98.3, 13.9, 32.8],
    ],
    at: [
      [145.6, 2.0, 17.5],
      [152.5, 2.3, 17.5],
    ],
    fov: [45, 44],
  },
  {
    start: 90,
    end: duration,
    eye: [
      [76.6, 7.8, 49.3],
      [78.4, 8.0, 49.8],
    ],
    at: [
      [168.9, 5.9, 13.6],
      [184.6, 5.4, 14.7],
    ],
    fov: [44, 43],
  },
];

export function filmAt(seconds) {
  const t = Math.max(0, Math.min(duration, seconds));
  const shot = cuts.find(({ end }) => t < end) ?? cuts.at(-1);
  const sceneTime = Math.max(0, shot.sceneStart === undefined ? t - 4.25 : shot.sceneStart + t);
  const vesselTime = sceneTime;
  const u = clamp((t - shot.start) / (shot.end - shot.start));
  const progress = mix(u, ease(u, 0, 1), 0.6);
  const move = ([a, b]) => a.map((v, i) => mix(v, b[i], progress));
  const position = shot.submerged ? shot.eye.getPoint(progress) : move(shot.eye);
  const target = shot.submerged ? shot.at.getPoint(progress) : move(shot.at);
  if (shot.track) {
    const [x, z] = shipPath(vesselTime);
    for (const point of [position, target]) {
      point[0] += x;
      point[2] += z;
    }
    position[1] += 0.026 * Math.sin(t * 1.38);
  }
  return {
    position,
    target,
    sceneTime,
    vesselTime,
    submerged: shot.submerged ?? false,
    fov: mix(...shot.fov, progress),
  };
}
