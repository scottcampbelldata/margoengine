export const loadedTension = 150;
export const drumRadius = .088;
export const ropeRadius = .0041;
export const windingPitch = .0105;
export const entryAngle = -.94;
export const entryHeight = .173;
const tau = 2 * Math.PI;

export function contact(turns, friction) {
  const angle = turns * tau;
  const holdingTension = tensionAt(angle, friction);
  return { angle, holdingTension, ratio: loadedTension / holdingTension };
}

export function tensionAt(angleFromLoad, friction) {
  return loadedTension * Math.exp(-friction * angleFromLoad);
}

export function winding(theta) {
  const bearing = entryAngle + theta;
  const radius = drumRadius + ropeRadius;
  return {
    position: [radius * Math.cos(bearing), entryHeight - theta * windingPitch / tau, radius * Math.sin(bearing)],
    towardHold: [-Math.sin(bearing), -windingPitch / (tau * radius), Math.cos(bearing)],
    outward: [Math.cos(bearing), 0, Math.sin(bearing)],
  };
}

export function tail(endAngle, distance) {
  const { position, towardHold, outward } = winding(endAngle);
  return { position: position.map((value, axis) => value + distance * towardHold[axis]), towardHold, outward };
}

