// The Venturi bench's tube profile. Its readings (continuity, the Bernoulli pressure drop and the piezometer heads)
// and the plug-flow tracer come from @margoengine/physics/hydraulics.
import { plugTracer, venturi, water } from '@margoengine/physics/hydraulics';

export const liquid = water(20);
export const gravity = 9.80665;
export const feedHead = .27;
export const wideRadius = .0265;
export const throatRadius = .013;
export const axisHeight = .141;
export const inletX = -.48;
export const exitX = .48;
export const taps = [-.327,-.019];
const smooth = t=>t*t*(3-2*t);

export function radiusAt(x) {
  if(x < -.246 || x > .388) return wideRadius;
  if(x < -.108) return wideRadius + (throatRadius-wideRadius)*smooth((x+.246)/.138);
  if(x <= .085) return throatRadius;
  return throatRadius+(wideRadius-throatRadius)*smooth((x-.085)/.303);
}

// The bench shows the ideal meter (discharge coefficient 1), as its README states.
const meter = { inletDiameter: 2*wideRadius, throatDiameter: 2*throatRadius, dischargeCoefficient: 1, liquid, gravity };

export function readFlow(value) {
  const literRate = Math.max(0,Math.min(50,value));
  const volumeRate = literRate/60000;
  const reading = venturi({ ...meter, flow: volumeRate });
  return {
    literRate,volumeRate,
    inletSpeed:reading.inletSpeed,throatSpeed:reading.throatSpeed,
    pressureDrop:reading.pressureDrop,dropHead:reading.dropHead,
    inletHead:feedHead,
    throatHead:feedHead-reading.dropHead,
  };
}

const tracer = plugTracer(x=>Math.PI*radiusAt(x)**2, inletX, exitX, 640);
export const internalVolume = tracer.volume;

/** Axial position of a dye mark `volume` m³ downstream of the inlet, wrapping round the closed bench loop. */
export function tracerAt(volume) {
  return tracer.positionAt((volume%internalVolume+internalVolume)%internalVolume);
}
