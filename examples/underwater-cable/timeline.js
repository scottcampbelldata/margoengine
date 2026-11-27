import { cableZ, bed } from './set.js';

export const duration = 60;
export const diveAt = 8.1;
export const breathCycleAt = (seconds) => (seconds + 1.05) % 4.84;
export const shipTrack = (seconds) => [-16 + 0.093 * seconds, -44 - 0.68 * seconds];
export const submarinePosition = (seconds) => [7 + seconds * 0.48, -17.4, -111 - seconds * 0.045];
export function diverTravel(seconds) {
  return seconds < 19 ? 7.8 + Math.max(0, seconds - diveAt) * 0.5 : 13.25 + (seconds - 19) * 0.49;
}

const cuts = [
  {
    id: 'surface',
    start: 0,
    end: 6.5,
    fov: 35,
    keys: [
      [
        [-163, 3.5, 121],
        [-19, 2.5, -44],
      ],
      [
        [-143, 3.4, 108],
        [-18, 2.8, -46],
      ],
      [
        [-123, 3.2, 96],
        [-17, 3.3, -48],
      ],
    ],
  },
  {
    id: 'crossing',
    start: 6.5,
    end: 10,
    fov: 54,
    keys: [
      [
        [-21.2, 0.9, 16.1],
        [-14.0, 3.4, -17],
      ],
      [
        [-18.5, 0.01, 12.6],
        [-12.5, 0.6, -15],
      ],
      [
        [-15.7, -1.45, 7.9],
        [-8.25, -0.4, -7.0],
      ],
    ],
  },
  {
    id: 'submarine',
    start: 10,
    end: 18.5,
    fov: 46,
    followSub: true,
    keys: [
      [
        [-11, 7.0, 30],
        [-2, 4.7, 0],
      ],
      [
        [-7, 6.6, 28],
        [-1, 4.5, 0],
      ],
      [
        [0, 6.2, 27],
        [3, 4.2, 0],
      ],
    ],
  },
  {
    id: 'inspection',
    start: 18.5,
    end: 26.25,
    fov: 48,
    keys: [
      [
        [-8.25, -7.5, 7.1],
        [-1.1, -10.4, -0.24],
      ],
      [
        [-5.45, -8.4, 5.4],
        [-0.37, -10.55, -0.24],
      ],
      [
        [-3.57, -8.79, 5.22],
        [-0.54, -10.47, -0.2],
      ],
    ],
  },
  {
    id: 'joint',
    start: 26.25,
    end: 37,
    fov: 41,
    keys: [
      [
        [-3.05, -9.42, 3.71],
        [-0.47, -10.7, -0.12],
      ],
      [
        [-2.13, -9.81, 3.28],
        [-0.35, -10.7, -0.13],
      ],
      [
        [-1.42, -9.66, 2.92],
        [-0.2, -10.64, -0.2],
      ],
    ],
  },
  {
    id: 'return',
    start: 37,
    end: 49,
    fov: 49,
    followSub: true,
    keys: [
      [
        [-8, 5.0, 27],
        [4, 4.7, 0],
      ],
      [
        [-2, 4.9, 24],
        [6, 5.1, 0],
      ],
      [
        [4, 5.0, 21],
        [10, 4.6, 0],
      ],
    ],
  },
  {
    id: 'cable',
    start: 49,
    end: duration,
    fov: 43,
    keys: [8.4, 12.7, 17.6].map((x) => {
      const focus = x + 4.9;
      return [
        [x, bed(x, cableZ(x)) + 0.99, cableZ(x) + 1.65],
        [focus, bed(focus, cableZ(focus)) + 0.14, cableZ(focus)],
      ];
    }),
  },
];

const catmull = (a, b, c, d, t) =>
  b.map((start, i) => {
    const m0 = (c[i] - a[i]) * 0.5;
    const m1 = (d[i] - start) * 0.5;
    const t2 = t * t;
    return (2 * t - 3) * t2 * (start - c[i]) + ((t - 2) * t + 1) * t * m0 + (t - 1) * t2 * m1 + start;
  });

export function sampleCamera(track, time) {
  const seconds = Math.max(0, Math.min(duration, time));
  const shot = track.find(({ end }) => seconds < end) ?? track.at(-1);
  const { keys, start, end, fov } = shot;
  const segment = ((seconds - start) / (end - start)) * (keys.length - 1);
  const i = Math.min(keys.length - 2, Math.floor(segment));
  const t = segment - i;
  const a = keys[Math.max(0, i - 1)];
  const b = keys[i];
  const c = keys[i + 1];
  const d = keys[Math.min(keys.length - 1, i + 2)];
  const position = catmull(a[0], b[0], c[0], d[0], t);
  const target = catmull(a[1], b[1], c[1], d[1], t);
  return { position, target, fov, shot, seconds };
}

export function cameraAt(time) {
  const { position, target, fov, shot, seconds } = sampleCamera(cuts, time);
  if (shot.followSub) {
    const sub = submarinePosition(seconds);
    for (let axis = 0; axis < 3; axis++) {
      position[axis] += sub[axis];
      target[axis] += sub[axis];
    }
  }
  const amplitude = shot.id === 'surface' ? 0.11 : shot.id === 'crossing' ? 0.067 : 0.018;
  const bob = Math.sin(seconds * 2.31) * amplitude;
  position[1] += bob;
  target[1] += bob * 0.45;
  return { position, target, fov, id: shot.id };
}
