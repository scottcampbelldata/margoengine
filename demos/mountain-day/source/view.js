import { blend } from './relief.mjs';

export function setDayView(engine, state) {
  const {sun,elevation,stars} = state;
  const daylight = blend(-11,12,elevation);
  const overhead = blend(.5,30,elevation);
  const sunStrength = (2.35 + .28*daylight) * blend(-1,7,elevation) * (1 - .42 * state.clouds);
  engine.lighting.direction.set(elevation > -2
    ? [...sun,sunStrength] : [-.28,.33,-.78,.17 + .10*stars]);
  const warm = blend(-2,32,elevation);
  engine.lighting.radiance.set([.57+.43*daylight,.24+.67*warm+.19*stars,
    .13+.72*warm+.65*stars,.30+.34*daylight]);
  engine.lighting.ambient.set([.11+.46*daylight,.17+.48*daylight,.36+.32*daylight]);

  const travel = state.flight;
  engine.camera.position = [1770-1110*travel,1545+300*travel,6350-1350*travel];
  engine.camera.target = [-1470+490*travel,2230+290*travel,-10900];
}

const unit = direction => { const length = Math.hypot(...direction); return direction.map(value => value/length); };
const cross = (a,b) => [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];

export function cameraBasis(camera) {
  const forward = unit(camera.target.map((value,i) => value - camera.position[i]));
  const right = unit(cross(forward,camera.up));
  return {forward,right,up:cross(right,forward)};
}
