export const clamp = (value) => Math.max(0, Math.min(1, value));
const mix = (a, b, t) => a + (b - a) * t;
const between = (a, b, t) => a.map((value, axis) => mix(value, b[axis], t));
const smooth = (t) => t ** 3 * (10 + t * (-15 + 6 * t));
const window = (value, from, to) => smooth(clamp((value - from) / (to - from)));
const pulse = (u) => (4 * u * (1 - u)) ** 3;
const advance = (p0, p1, m0, m1, duration, t) => {
  const t2 = t * t, t3 = t2 * t;
  return mix(p0, p1, 3 * t2 - 2 * t3) + duration * ((t3 - 2 * t2 + t) * m0 + (t3 - t2) * m1);
};

// Reference offsets in the fitted boots' unrotated world basis, measured from each ankle.
const ankleHeight = .074;
const ankleBehind = .064;
const heel = [0, -ankleHeight, -.064];
const toe = [0, -ankleHeight, .202];

export function rotateFoot([x, y, z], yaw, pitch) {
  const cp = Math.cos(pitch), sp = Math.sin(pitch), cy = Math.cos(yaw), sy = Math.sin(yaw);
  const zz = y * sp + z * cp;
  return [x * cy + zz * sy, y * cp - z * sp, -x * sy + zz * cy];
}

function boot(location, yaw, pitch, pin) {
  const flat = rotateFoot([0, ankleHeight, -ankleBehind], yaw, 0);
  const ankle = flat.map((value, i) => value + location[i]);
  const settled = rotateFoot(pin, yaw, 0);
  const rock = rotateFoot(pin, yaw, pitch);
  const reference = ankle.map((value, i) => value + settled[i]);
  return { ankle: reference.map((value, i) => value - rock[i]), yaw, pitch, pin, reference };
}

function footYaw(from, to, side) {
  return side * .078 + Math.atan2(to[0] - from[0], Math.max(.25, to[2] - from[2])) * .28;
}

function footfall(location, yaw) { return { location, yaw }; }

function swingBoot(from, to, side, phase, leave, land, spacing) {
  const rise = to.location[1] - from.location[1];
  const toePitch = .30 - .08 * clamp((rise + .04) / .22);
  const heelPitch = -.16 + .065 * clamp((rise + .025) / .20);
  if (phase <= leave) {
    const pitch = toePitch * window(phase, leave * .34, leave);
    return boot(from.location, from.yaw, pitch, toe);
  }
  if (phase >= land) {
    const pitch = heelPitch * (1 - window(phase, land, Math.min(1, land + .16)));
    return boot(to.location, to.yaw, pitch, heel);
  }
  const u = (phase - leave) / (land - leave);
  const travel = smooth(u + .72 * u * (1 - u));
  const clearance = pulse(u + .34 * u * (1 - u));
  const takeoff = boot(from.location, from.yaw, toePitch, toe);
  const touchdown = boot(to.location, to.yaw, heelPitch, heel);
  const ankle = between(takeoff.ankle, touchdown.ankle, travel);
  ankle[0] += side * .033 * clearance;
  ankle[1] += clearance * (.086 + .071 * spacing + .23 * Math.max(0, rise));
  const pitch = mix(toePitch, heelPitch, window(u, .18, .89)) - .061 * clearance;
  return { ankle, pitch, yaw: mix(from.yaw, to.yaw, travel), pin: null, reference: null };
}

function slopes(values, durations) {
  const speeds = durations.map((duration, index) => (values[index + 1] - values[index]) / duration);
  return [0, ...speeds.slice(1).map((speed, i) => 2 * speed * speeds[i] / (speed + speeds[i])), 0];
}

export function createCrossing(start, landings) {
  const route = [start[1], ...landings];
  const stations = [(start[0][2] + start[1][2]) / 2];
  const durations = [];
  for (let index = 0; index < landings.length; index++) {
    const a = route[index], b = route[index + 1];
    const separation = b[2] - a[2];
    const last = index === landings.length - 1;
    stations.push(mix(a[2], b[2], last ? .5 : .64));
    durations.push(.66 + .44 * separation + .45 * Math.abs(a[1] - b[1]) + (index === 0 ? .12 : last ? .09 : 0));
  }
  const turns = stations.map((_, i) => i);
  return { durations, stations, zSlopes: slopes(stations, durations), rhythmSlopes: slopes(turns, durations) };
}

export function sampleGait(path, placed, landing, step, phase, settling = 0) {
  const count = path.durations.length;
  const swing = step % 2, support = 1 - swing;
  const origin = placed[swing], fixed = placed[support];
  const active = step < count && landing !== null;
  const resting = step === count;
  const finalStep = step === count - 1;
  const from = between(origin.location, fixed.location, step === 0 || resting ? .5 : .64);
  const to = active ? between(fixed.location, landing, finalStep ? .5 : .64) : from;
  const side = swing === 0 ? 1 : -1;
  const takeoff = step === 0 ? .25 : .158;
  const land = finalStep ? .79 : .82;
  const next = active ? footfall(landing, footYaw(origin.location, landing, side)) : origin;
  const spacing = Math.hypot(fixed.location[0] - next.location[0], fixed.location[2] - next.location[2]);
  const feet = placed.map((sole, index) => active && index === swing
    ? swingBoot(sole, next, side, phase, takeoff, land, spacing)
    : boot(sole.location, sole.yaw, 0, heel));
  const pacing = active ? advance(step, step + 1, path.rhythmSlopes[step],
    path.rhythmSlopes[step + 1], path.durations[step], phase) : step;
  const rhythm = pacing * Math.PI;
  const activity = active ? window(pacing, 0, .54) * (1 - window(pacing, count - .53, count)) : 0;
  const sway = Math.cos(rhythm) * activity;
  const brace = active ? window(phase, .02, .39) * (1 - window(phase, .49, .96)) : 0;
  const absorb = active ? pulse(clamp((phase - land) / (1 - land))) : 0;
  const transfer = smooth(phase);
  const x = mix(mix(from[0], to[0], transfer), fixed.location[0], .53 * brace);
  const z = active ? advance(path.stations[step], path.stations[step + 1], path.zSlopes[step],
    path.zSlopes[step + 1], path.durations[step], phase) : from[2];
  const overshoot = .017 * pulse(settling) * Math.cos(Math.PI * settling);
  const y = mix(from[1], to[1], transfer) - .042 + .030 * brace - .020 * absorb + overshoot;
  const coming = active ? Math.min(.65, Math.max(-.65, next.location[0] - fixed.location[0])) : 0;
  const anticipation = active ? .4 * Math.sin(2 * Math.PI * phase) ** 2 + .6 * brace : 0;
  return { x, y, z, feet, next, sway, rhythm, activity, brace, absorb, anticipation, coming, settling,
    lean: (fixed.location[0] - x) * brace };
}

export function initialFootfalls(start) {
  return start.map((location, side) => footfall(location, side === 0 ? .078 : -.078));
}

// Plan around the reach limits ahead of each footfall, rather than dropping the hips
// at the instant a leg reaches its limit. Every reachable stone setting shares this height track.
export function planPelvis(path, start, routes, settleTime, ceiling) {
  const interval = .018;
  const ends = path.durations.reduce((times, duration) => [...times, times.at(-1) + duration], [0]);
  const finalTime = ends.at(-1);
  const samples = Math.ceil((finalTime + settleTime) / interval) + 2;
  const limit = new Float64Array(samples).fill(Infinity);
  for (const route of routes) {
    const planted = initialFootfalls(start);
    let step = 0;
    for (let i = 0; i < samples; i++) {
      const time = i * interval;
      while (step < route.length && time >= ends[step + 1]) {
        planted[step % 2] = sampleGait(path, planted, route[step], step, 1).next;
        step++;
      }
      const rest = step === route.length;
      const phase = rest ? clamp((time - finalTime) / settleTime) : (time - ends[step]) / path.durations[step];
      const target = sampleGait(path, planted, rest ? null : route[step], step, phase, rest ? phase : 0);
      limit[i] = Math.min(limit[i], ceiling(target));
    }
  }

  const liftRate = .64;
  const maxStep = liftRate * interval;
  for (let i = 1; i < samples; i++) limit[i] = Math.min(limit[i], limit[i - 1] + maxStep);
  for (let i = samples - 2; i >= 0; i--) limit[i] = Math.min(limit[i], limit[i + 1] + maxStep);

  // A centered cosine filter keeps the acceleration smooth. Subtract its worst-case
  // rise for the capped slope, so the filtered height never exceeds the reach envelope.
  const radius = 10;
  const weights = Array.from({ length: 2 * radius + 1 }, (_, i) =>
    .5 + .5 * Math.cos(Math.PI * (i - radius) / (radius + 1)));
  const sum = weights.reduce((total, value) => total + value, 0);
  const allowance = weights.reduce((total, value, i) => total + value * Math.abs(i - radius), 0) / sum * maxStep;
  const keys = limit.map((_, i) => weights.reduce((total, weight, j) =>
    total + limit[Math.min(samples - 1, Math.max(0, i + j - radius))] * weight, 0) / sum - allowance - .004);
  return (seconds) => {
    const key = Math.min(samples - 2, Math.max(0, seconds / interval));
    const i = Math.floor(key), t = key - i;
    const a = keys[i], b = keys[i + 1];
    const enter = (b - keys[Math.max(0, i - 1)]) / 2;
    const leave = (keys[Math.min(samples - 1, i + 2)] - a) / 2;
    return advance(a, b, enter, leave, 1, t);
  };
}
