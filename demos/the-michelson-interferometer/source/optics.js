export const wavelengthNm=632.8;
export const mirrorPeriodNm=wavelengthNm/2;
export const travelNm=4*mirrorPeriodNm;
export const carrierMeters=.026;
export const mirrorTilt=.5*Math.asin(wavelengthNm*1e-9/carrierMeters);
export const visibility=.96;

export function opticalPathNm(mirrorNm){return 2*mirrorNm;}
export function fringeCount(mirrorNm){return opticalPathNm(mirrorNm)/wavelengthNm;}
export function phaseAt(x,mirrorNm){return 2*Math.PI*(x/carrierMeters+fringeCount(mirrorNm));}
export function fringeIntensity(x,mirrorNm){return .5+.5*visibility*Math.cos(phaseAt(x,mirrorNm));}
