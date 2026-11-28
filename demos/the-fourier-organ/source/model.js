export const harmonicOrders = [1, 3, 5, 7, 9, 11, 13];
export const fundamentalHz = 174;

export function coefficient(order) {
  return order % 2 ? 4 / (Math.PI * order) : 0;
}

export function series(count, phase) {
  let value = 0;
  for (const order of harmonicOrders.slice(0, count)) {
    value += coefficient(order) * Math.sin(order * phase);
  }
  return value;
}

export function oscillatorCoefficients(count) {
  const real = new Float32Array(14);
  const imaginary = new Float32Array(14);
  for (const order of harmonicOrders.slice(0, count)) {
    imaginary[order] = coefficient(order);
  }
  return { real, imaginary };
}

