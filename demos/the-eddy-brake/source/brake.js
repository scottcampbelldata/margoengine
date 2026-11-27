export const launchRpm = 144;
export const inertia = .187;
export const idleDrag = .018;
export const maxMagneticDrag = .34;
export const rpmToRadians = Math.PI / 30;

export function freshRun() {
  return { time: 0, angle: 0, speed: launchRpm, heat: 0 };
}

export function advance(run, seconds, current) {
  const magnetic = maxMagneticDrag * current ** 2;
  const drag = idleDrag + magnetic;
  const decay = drag / inertia;
  const fractionLost = -Math.expm1(-decay * seconds);
  const omega = run.speed * rpmToRadians;
  const nextOmega = omega * (1 - fractionLost);
  run.angle += omega * fractionLost / decay;
  run.heat += .5 * inertia * (omega - nextOmega) * (omega + nextOmega) * magnetic / drag;
  run.speed *= 1 - fractionLost;
  run.time += seconds;
  return run;
}

export function referenceSpeed(seconds) {
  return launchRpm * Math.exp(-idleDrag / inertia * seconds);
}