import { duration, sampleCamera, shipTrack } from './timeline.js';

export const showcaseDiverTime = (seconds) => seconds + 25;

const cuts = [
  {
    id: 'diver-at-joint',
    start: 0,
    end: 7.5,
    fov: 47,
    keys: [
      [
        [-4.32, -8.65, -3.25],
        [-1.25, -10.17, -0.23],
      ],
      [
        [-3.92, -8.81, -3.06],
        [-1.06, -10.2, -0.26],
      ],
      [
        [-3.52, -8.92, -2.91],
        [-0.88, -10.23, -0.29],
      ],
    ],
  },
  {
    id: 'survey-team',
    start: 7.5,
    end: 14,
    fov: 49,
    keys: [
      [
        [2.95, -7.25, -5.45],
        [-0.55, -10.46, -0.42],
      ],
      [
        [2.72, -7.06, -5.78],
        [-0.45, -10.45, -0.39],
      ],
      [
        [2.4, -6.89, -6.0],
        [-0.35, -10.45, -0.36],
      ],
    ],
  },
  {
    id: 'rise-at-hull',
    start: 14,
    end: 22,
    fov: 53,
    vessel: true,
    keys: [
      [
        [19, -1.35, 19],
        [0, 1.9, 7],
      ],
      [
        [23, 0.55, 16],
        [0, 4.1, 1],
      ],
      [
        [26, 2.0, 13],
        [0, 5.9, -1],
      ],
    ],
  },
  {
    id: 'bow-reveal',
    start: 22,
    end: 32,
    fov: 37,
    vessel: true,
    keys: [
      [
        [57, 6.1, -52],
        [0, 6.8, -1],
      ],
      [
        [55, 5.9, -47],
        [0, 6.7, -1],
      ],
      [
        [54, 5.8, -43],
        [0, 6.6, -1],
      ],
    ],
  },
  {
    id: 'foam-along-hull',
    start: 32,
    end: 42,
    fov: 46,
    vessel: true,
    keys: [
      [
        [31, 1.55, -21],
        [0, 2.55, -15],
      ],
      [
        [31, 1.39, -11],
        [0, 2.28, -5],
      ],
      [
        [31, 1.45, 0],
        [0, 2.61, 5],
      ],
    ],
  },
  {
    id: 'stern-wake',
    start: 42,
    end: 51,
    fov: 45,
    vessel: true,
    keys: [
      [
        [20, 7.2, 65],
        [0, 4.5, 20],
      ],
      [
        [16, 6.5, 65],
        [0, 4.5, 19],
      ],
      [
        [11, 6.0, 65],
        [0, 4.7, 18],
      ],
    ],
  },
  {
    id: 'closing-quarter',
    start: 51,
    end: duration,
    fov: 37,
    vessel: true,
    keys: [
      [
        [65, 9.6, 62],
        [2, 4.7, 1],
      ],
      [
        [69, 9.9, 67],
        [2, 4.5, 2],
      ],
      [
        [74, 10.2, 72],
        [2, 4.4, 3],
      ],
    ],
  },
];

export function showcaseCameraAt(time) {
  const { position, target, fov, shot, seconds } = sampleCamera(cuts, time);
  if (shot.vessel) {
    const [x, z] = shipTrack(seconds);
    for (const point of [position, target]) {
      point[0] += x;
      point[2] += z;
    }
  }
  const amplitude = shot.vessel ? 0.09 : 0.018;
  const heave = amplitude * (Math.sin(seconds * 1.39) + 0.35 * Math.sin(seconds * 2.13 + 0.57));
  position[1] += heave;
  target[1] += heave * 0.35;
  return { position, target, fov, id: shot.id };
}
