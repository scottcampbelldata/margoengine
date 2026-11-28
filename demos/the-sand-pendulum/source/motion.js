export const gravity = 9.80665;
export const fullLength = .68;
export const duration = 9;
export const ratioChoices = [5 / 4, 3 / 2, 2];
export const sandY = .064;
const damping = .064;
const phase = .51;

export function period(length) {
  return 2 * Math.PI * Math.sqrt(length / gravity);
}
export function shortLength(ratio) {
  return fullLength / ratio ** 2;
}
function mode(time, length, amplitude, start) {
  const omega = Math.sqrt(gravity / length);
  const a = amplitude * Math.exp(-damping * time);
  const phi = omega * time + start;
  return [a * Math.cos(phi), -a * (omega * Math.sin(phi) + damping * Math.cos(phi))];
}
export function nozzle(time, ratio) {
  const short = shortLength(ratio);
  const [x, vx] = mode(time, short, Math.min(.133, .40 * short), 0);
  const [z, vz] = mode(time, fullLength, .174, phase);
  const y = .116 + x * x / (2 * short) + z * z / (2 * fullLength);
  const vy = x * vx / short + z * vz / fullLength;
  return { x, y, z, vx, vy, vz };
}
export function fallTime(p) {
  return (p.vy + Math.sqrt(p.vy ** 2 + 2 * gravity * (p.y - sandY))) / gravity;
}
export function grain(p, elapsed) {
  return [p.x + p.vx * elapsed, p.y + p.vy * elapsed - .5 * gravity * elapsed ** 2, p.z + p.vz * elapsed];
}
export function impact(time, ratio) {
  const p = nozzle(time, ratio);
  const fall = fallTime(p);
  return { point: grain(p, fall), time: time + fall, speed: Math.hypot(p.vx, p.vz) };
}