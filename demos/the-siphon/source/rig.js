export const gravity = 9.80665;
export const density = 998.2;
export const kinematicViscosity = 1.004e-6;
export const bore = .013;
export const maxDrop = .18;
export const supply = { x: -.242, level: .321, rim: .390, bottom: .107 };
export const receiver = { x: .245, level: .087, rim: .123, bottom: .041 };
export const pivot = [.056, .353, 0];
export const armLength = .238;
export const spoutLength = pivot[1] - supply.level;
const leftRadius = .056;
const rightRadius = .052;
const crown = .496;
const leftStraight = .251;
const rightStraight = crown - rightRadius - pivot[1];
const center = supply.x + leftRadius;
const crownReach = pivot[0] - rightRadius - center;

export const tubeLength = leftStraight + Math.PI / 2 * (leftRadius + rightRadius) +
  crownReach + rightStraight + armLength + spoutLength;
export const crownLength = leftStraight + Math.PI / 2 * leftRadius + crownReach / 2;
export const relativeRoughness = 1.5e-6 / bore;
export const entranceAndBend = .70;
export const totalFittings = 1.65;

export function armAt(head) {
  const angle = Math.asin(head / armLength);
  const upper = [pivot[0] + Math.cos(angle) * armLength, pivot[1] - head, 0];
  return { angle, upper, outlet: [upper[0], supply.level - head, 0] };
}

export function fixedTube() {
  const path = [[supply.x, crown - leftRadius - leftStraight, 0]];
  for (let i = 0; i <= 14; i++) {
    const a = Math.PI - i * Math.PI / 28;
    path.push([center + leftRadius * Math.cos(a), crown - leftRadius + leftRadius * Math.sin(a), 0]);
  }
  for (let i = 0; i <= 13; i++) {
    const a = Math.PI / 2 - i * Math.PI / 26;
    path.push([pivot[0] - rightRadius + rightRadius * Math.cos(a), crown - rightRadius + rightRadius * Math.sin(a), 0]);
  }
  path.push(pivot);
  return path;
}

export function darcyFactor(reynolds) {
  if (reynolds < 900) return 64 / reynolds;
  const a = (2.457 * Math.log(1 / ((7 / reynolds) ** .9 + .27 * relativeRoughness))) ** 16;
  const b = (37530 / reynolds) ** 16;
  return 8 * ((8 / reynolds) ** 12 + 1 / (a + b) ** 1.5) ** (1 / 12);
}

export function headLoss(speed, length = tubeLength, fittings = totalFittings) {
  if (speed === 0) return 0;
  const reynolds = speed * bore / kinematicViscosity;
  return (1 + fittings + darcyFactor(reynolds) * length / bore) * speed ** 2 / (2 * gravity);
}

export function solveSiphon(drop) {
  const head = Math.min(maxDrop, Math.max(0, drop));
  let speed = 0;
  if (head > 0) {
    let low = 0;
    let high = Math.sqrt(2 * gravity * head);
    for (let i = 0; i < 37; i++) {
      const mid = (low + high) / 2;
      if (headLoss(mid) < head) low = mid;
      else high = mid;
    }
    speed = (low + high) / 2;
  }
  return {
    head,
    speed,
    litersPerMinute: Math.PI * bore ** 2 / 4 * speed * 60000,
    crownPressure: -density * gravity * (crown - supply.level + headLoss(speed, crownLength, entranceAndBend)) / 1000,
    arm: armAt(head),
  };
}