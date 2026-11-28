export const gravity = 9.80665;
export const radius = .063;
export const bore = .0567;
export const startX = -.818;
export const timedDistance = .701;
export const catchDistance = .075;
export const objects = [
  { label: 'Solid disc', factor: .5 },
  { label: 'Hollow ring', factor: .5 * (1 + (bore / radius) ** 2) },
];

export function makeRace(angle) {
  return objects.map(({factor}) => {
    const a = gravity * Math.sin(angle) / (1 + factor);
    const finish = Math.sqrt(2 * timedDistance / a);
    const finishSpeed = a * finish;
    const brake = finishSpeed * finishSpeed / (2 * catchDistance);
    return {a, finish, finishSpeed, brake, stop:finish + finishSpeed / brake};
  });
}
export function sample(racer, time) {
  if (time < racer.finish) return { distance: .5 * racer.a * time ** 2, speed:racer.a * time };
  const catchTime = Math.min(time, racer.stop) - racer.finish;
  return {
    distance: timedDistance + racer.finishSpeed * catchTime - .5 * racer.brake * catchTime ** 2,
    speed: Math.max(0, racer.finishSpeed - racer.brake * catchTime),
  };
}