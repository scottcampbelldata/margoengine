export const duration = 60;
export const lensCenter = [0, 0.106, 0];
export const reticleHeight = 0.0047;

const shots = [
  {
    name: 'rim',
    end: 7.5,
    fov: 25,
    from: [0.076, 0.151, 0.103],
    to: [0.059, 0.173, 0.103],
    aim: [0.003, 0.104, 0.008],
    focus: [0.014, 0.111, 0.022],
    aperture: 14,
  },
  {
    name: 'bench',
    end: 15.5,
    fov: 34,
    from: [0.221, 0.24, 0.323],
    to: [0.185, 0.21, 0.29],
    aim: [0.006, 0.083, -0.02],
    focus: [0, 0.082, 0.004],
    aperture: 13,
  },
  {
    name: 'rack',
    end: 26.25,
    fov: 24,
    from: [0.037, 0.248, 0.057],
    to: [0.014, 0.244, 0.038],
    aim: [0.002, 0.066, -0.009],
    focus: lensCenter,
    aperture: 8,
  },
  {
    name: 'adjustment',
    end: 34.5,
    fov: 30,
    from: [0.129, 0.068, 0.17],
    to: [0.118, 0.059, 0.155],
    aim: [0.036, 0.024, 0.056],
    focus: [0.049, 0.026, 0.077],
    aperture: 13,
  },
  {
    name: 'caustic',
    end: 45,
    fov: 31,
    from: [0.079, 0.094, 0.152],
    to: [0.065, 0.112, 0.128],
    aim: [0.001, 0.03, 0.008],
    focus: [0, reticleHeight, 0],
    aperture: 12,
  },
  {
    name: 'polish',
    end: 52.5,
    fov: 27,
    from: [0.164, 0.211, 0.121],
    to: [0.136, 0.193, 0.117],
    aim: [0.002, 0.094, -0.002],
    focus: [0.014, 0.103, 0.018],
    aperture: 11,
  },
  {
    name: 'hero',
    end: duration,
    fov: 30,
    from: [0.174, 0.246, 0.312],
    to: [0.192, 0.257, 0.338],
    aim: [-0.02, 0.094, 0.013],
    focus: [0, 0.1, 0.012],
    aperture: 12,
  },
];

const blend = (a, b, t) => a + (b - a) * t;
export const smooth = (t) => {
  const u = Math.max(0, Math.min(1, t));
  return u * u * (3 - 2 * u);
};
export const between = (seconds, from, to) => smooth((seconds - from) / (to - from));

export function filmAt(time) {
  const seconds = Math.max(0, Math.min(duration, time));
  const index = shots.findIndex(({ end }) => seconds < end);
  const shotIndex = index < 0 ? shots.length - 1 : index;
  const shot = shots[shotIndex];
  const start = shots[shotIndex - 1]?.end ?? 0;
  const travel = between(seconds, start, shot.end);
  const position = shot.from.map((part, axis) => blend(part, shot.to[axis], travel));

  const rack = shot.name === 'rack' ? between(seconds, 17.7, 22.9) : 0;
  const reticleTravel = -0.018 * (1 - between(seconds, 27, 31.8));
  const focus = shot.focus.map((value, axis) => blend(value, [0, reticleHeight, reticleTravel][axis], rack));

  return {
    position,
    target: shot.aim,
    focus,
    fov: shot.fov,
    aperture: shot.aperture,
    reticleTravel,
    ringAngle: -0.27 + 0.67 * between(seconds, 2.0, 6.4) + 0.52 * between(seconds, 27.5, 31.9),
    dialAngle: 3.3 * between(seconds, 27, 31.8),
    lamp: 0.18 + 0.3 * between(seconds, 0.5, 3.4) + 0.52 * between(seconds, 34.4, 37),
    name: shot.name,
  };
}
