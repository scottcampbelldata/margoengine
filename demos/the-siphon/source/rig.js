// The siphon's apparatus layout. The hydraulics (energy equation, Darcy-Weisbach friction, crown pressure and the
// falling jet) come from @margoengine/physics/hydraulics.
import { jetAfterFall, siphon, water } from '@margoengine/physics/hydraulics';

export const gravity = 9.80665;
export const liquid = water(20);
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
const run = {
  diameter: bore, length: tubeLength, roughness: 1.5e-6, minorLoss: 1.65,
  crownLength, crownMinorLoss: .70, crownRise: crown - supply.level, friction: 'churchill', liquid, gravity,
};

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

/** Radius scale of the free jet `fall` m below the nozzle (continuity under gravity). */
export const jetNarrowing = (speed, fall) => Math.sqrt(jetAfterFall(speed, fall, gravity).areaRatio);

export function solveSiphon(drop) {
  const head = Math.min(maxDrop, Math.max(0, drop));
  const state = siphon({ ...run, drop: head });
  return {
    head,
    speed: state.speed,
    litersPerMinute: state.flow * 60000,
    crownPressure: state.crownPressure / 1000,
    arm: armAt(head),
  };
}
