export const ambient = 24;
export const finCount = 18;
export const finDepth = .095;
export const finThickness = .00165;
export const finHeight = .045;
export const cells = 6;
export const modelRate = 20;

const cross = finCount * finDepth * finThickness;
const length = finHeight / cells;
const conductivity = 179;
const finLink = conductivity * cross / length;
const capacities = [9, 41, ...Array(cells).fill(cross * length * 2700 * 900)];
const contacts = [8.6, finLink * 2, ...Array(cells - 1).fill(finLink)];
const finCellArea = finCount * (2 * finDepth + 2 * finThickness) * length;
const size = 2 + cells;

export function losses(fan) {
  const coefficient = 6.0 + 39 * fan ** .65;
  return [.012, coefficient * .011, ...Array.from({length: cells}, (_, index) =>
    coefficient * (finCellArea + (index === cells - 1 ? cross : 0)))];
}

function solve(fan, watts, previous, seconds) {
  const convection = losses(fan);
  const main = new Float64Array(size), rhs = new Float64Array(size);
  for (let i = 0; i < size; i++) {
    const storage = previous ? capacities[i] / seconds : 0;
    const left = contacts[i - 1] ?? 0, right = contacts[i] ?? 0;
    main[i] = storage + left + right + convection[i];
    rhs[i] = (i === 0 ? watts : 0) + (previous ? previous[i] * storage : 0);
    if (i) {
      main[i] -= left * left / main[i - 1];
      rhs[i] += left * rhs[i - 1] / main[i - 1];
    }
  }
  for (let i = size - 1; i >= 0; i--) {
    rhs[i] += (contacts[i] ?? 0) * (rhs[i + 1] ?? 0);
    rhs[i] /= main[i];
  }
  return rhs;
}
export function equilibrium(fan, watts) {
  return solve(fan, watts);
}
export function advance(state, fan, watts, seconds) {
  return solve(fan, watts, state, seconds);
}
export function rejectedHeat(state, fan) {
  return losses(fan).reduce((sum, value, index) => sum + value * state[index], 0);
}
export function storedHeat(state) {
  return capacities.reduce((sum, value, index) => sum + value * state[index], 0);
}