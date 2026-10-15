// The demo sky configurations, shared by the Node trace test and the real-GPU browser check.
const lighting = () => ({
  intensity: 6,
  color: [1, 0.97, 0.92],
  sunset: [1, 0.69, 0.36],
  moon: { intensity: 0.6, color: [0.25, 0.45, 0.75] },
  ambient: { day: [0.14, 0.19, 0.24], night: [0.02, 0.04, 0.09] },
});
const night = () => ({
  zenithColor: [0.004, 0.008, 0.03],
  horizonColor: [0.05, 0.07, 0.12],
  moonColor: [0.75, 0.85, 1],
  moonDirection: [-0.4, 0.42, -0.81],
  moonSize: 0.035,
  starIntensity: 1,
  moonPhase: 0.4,
  glowIntensity: 1.1,
  starTwinkleIntensity: 0.9,
  hazeDensity: 1.4,
});
/** Each scene's options (fresh per run, Sky mutates them), the feature entries it needs, and what each frame changes. */
export const configs = {
  'night-citadel': {
    features: ['night', 'fog'],
    options: (depth) => ({
      hours: 0,
      timeScale: 0,
      night: night(),
      fog: { depth, color: [0.05, 0.07, 0.12], falloff: 'exp', height: 0.065, start: 0, density: 0.006 },
    }),
    frames: [
      (s) => {
        s.options.night.moonPhase = -0.5;
      },
      (s) => {
        s.options.fog.density = 0.012;
      },
    ],
  },
  'stage-sky': {
    features: ['night'],
    options: () => ({ hours: 0, timeScale: 0, night: {} }),
    frames: [
      () => {},
      (s) => {
        s.options.night.starTwinkleIntensity = 0;
      },
    ],
  },
  afterlight: {
    features: ['bruneton', 'clouds', 'fog', 'reflection', 'lighting'],
    reflection: true,
    options: (depth) => ({
      model: 'bruneton',
      clouds: { coverage: 0.38 },
      fog: { depth, density: 0.008, start: 45 },
      hours: 17.57,
      timeScale: 1 / 120,
      turbidity: 3.2,
      exposure: -0.35,
      lighting: lighting(),
    }),
    frames: [
      () => {},
      (s) => {
        s.options.hours = 18.2;
      },
      (s) => {
        s.options.hours = 23;
      },
      (s) => {
        s.options.hours = 9;
        s.options.turbidity = 4;
      },
    ],
  },
  meadow: {
    features: ['bruneton', 'clouds', 'lighting'],
    options: () => ({
      model: 'bruneton',
      hours: 16,
      timeScale: 0,
      turbidity: 3,
      exposure: -0.35,
      clouds: { coverage: 0.38, speed: 8 },
      lighting: lighting(),
    }),
    frames: [
      () => {},
      (s) => {
        s.options.clouds.coverage = 0.7;
        s.options.clouds.speed = 12;
      },
      (s) => {
        s.options.hours = 20;
      },
    ],
  },
  preetham: {
    features: ['preetham', 'reflection'],
    reflection: true,
    options: () => ({ hours: 12, timeScale: 0.5 }),
    frames: [
      () => {},
      (s) => {
        s.options.hours = 19;
      },
      (s) => {
        s.options.turbidity = 5;
      },
    ],
  },
  'preetham-clouds-fog': {
    features: ['preetham', 'clouds', 'fog'],
    options: (depth) => ({ hours: 7, timeScale: 1, clouds: {}, fog: { depth, density: 0.02, start: 10, height: 0.2 } }),
    frames: [() => {}, () => {}],
  },
};
