export const referenceTemperature = 20;
export const length = .126;
export const thickness = .00082;
export const gap = .00368;
export const leverArm = .019;

const steel = { modulus: 202e9, alpha: 11.7e-6, a: -thickness / 2, b: 0 };
const brass = { modulus: 103e9, alpha: 19.1e-6, a: 0, b: thickness / 2 };

function laminate() {
  let a = 0, b = 0, d = 0, force = 0, moment = 0;
  for (const layer of [steel, brass]) {
    const cross = layer.modulus * (layer.b - layer.a);
    const first = layer.modulus * (layer.b ** 2 - layer.a ** 2) / 2;
    const second = layer.modulus * (layer.b ** 3 - layer.a ** 3) / 3;
    a += cross;
    b += first;
    d += second;
    force += layer.alpha * cross;
    moment += layer.alpha * first;
  }
  return (a * moment - b * force) / (a * d - b * b);
}
export const curvaturePerDegree = laminate();

export function curve(temperature, distance = length) {
  const curvature = curvaturePerDegree * (temperature - referenceTemperature);
  const angle = curvature * distance;
  return curvature === 0 ? {x:distance,y:0,angle:0} : {
    x: Math.sin(angle) / curvature,
    y: 2 * Math.sin(angle / 2) ** 2 / curvature,
    angle,
  };
}
export function mechanism(temperature) {
  const tip = curve(temperature);
  const travel = Math.max(0, tip.y - gap);
  return { tip, rotation: Math.asin(Math.min(1, travel / leverArm)), open: travel > 0 };
}
function tripTemperature() {
  let lo = referenceTemperature, hi = 100;
  for (let i = 0; i < 36; i++) {
    const middle = (lo + hi) / 2;
    if (curve(middle).y < gap) lo = middle;
    else hi = middle;
  }
  return (lo + hi) * .5;
}
export const trip = tripTemperature();