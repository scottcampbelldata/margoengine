export const gravity = 9.80665;
export const chamber = Object.freeze({ length: 18.4, width: 4.5, lower: .92, upper: 2.72, valveArea: 1.75, dischargeCoefficient: .62 });
export const area = chamber.length * chamber.width;
export const lift = chamber.upper - chamber.lower;
export const duration = 2 * area * Math.sqrt(lift) /
  (chamber.valveArea * chamber.dischargeCoefficient * Math.sqrt(2 * gravity));

const riverStation = 16.4;
const hydraulicScale = 12.2;
export const phases = Object.freeze([
  { name: 'Enter', duration: 1.46 },
  { name: 'Seal', duration: .99 },
  { name: 'Equalize', duration: duration / hydraulicScale },
  { name: 'Open', duration: 1.02 },
  { name: 'Exit', duration: 1.55 },
]);
export const finish = phases.reduce((sum, phase) => sum + phase.duration, 0);
const ease = (value) => value * value * (3 - 2 * value);

export function equalize(initial, target, time) {
  const difference = Math.abs(target - initial);
  const remainingRoot = Math.max(0, Math.sqrt(difference) -
    Math.max(0, time) * chamber.valveArea * chamber.dischargeCoefficient * Math.sqrt(2 * gravity) / (2 * area));
  const remaining = remainingRoot ** 2;
  const sign = Math.sign(target - initial);
  const change = difference - remaining;
  return {
    level: target - sign * remaining,
    volume: change * area,
    flow: sign * chamber.valveArea * chamber.dischargeCoefficient * Math.sqrt(2 * gravity) * remainingRoot,
  };
}

export function lockage(direction, seconds) {
  const ascending = direction === 'up';
  const initial = ascending ? chamber.lower : chamber.upper;
  const target = ascending ? chamber.upper : chamber.lower;
  const start = ascending ? -riverStation : riverStation;
  const motion = Math.max(0, Math.min(finish, seconds));
  let elapsed = motion;
  let phase = 0;
  while (phase < phases.length - 1 && elapsed >= phases[phase].duration) {
    elapsed -= phases[phase].duration;
    phase += 1;
  }
  const progress = ease(Math.min(1, elapsed / phases[phase].duration));
  const hydraulic = equalize(initial, target, phase < 2 ? 0 : phase > 2 ? duration : elapsed * hydraulicScale);
  const nearGate = phase === 0 ? 1 : phase === 1 ? 1 - progress : 0;
  const farGate = phase === 3 ? progress : phase === 4 ? 1 : 0;
  const boat = phase === 0 ? start * (1 - progress) : phase === 4 ? -start * progress : 0;
  return {
    phase, motion, boat,
    lowerGate: ascending ? nearGate : farGate,
    upperGate: ascending ? farGate : nearGate,
    level: hydraulic.level,
    volume: hydraulic.volume,
    flow: phase === 2 ? hydraulic.flow : 0,
  };
}