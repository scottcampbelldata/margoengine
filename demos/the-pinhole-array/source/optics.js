export const wavelength = 532e-9;
export const sourceDistance = .88;
export const sensorDistance = .28;
export const diameterMm = [.31, .60, 1.32];
export const profileLength = 256;
export const profileRadius = .003;
export const magnification = -sensorDistance / sourceDistance;
export const target = [
  [-.00348, -.00242], [-.00115, -.00242],
  [.00112, .00187], [.00271, .00187], [.00403, -.00062],
];

const angularSamples = 112;
const pupilSteps = 104;
const besselStep = .08;
const besselLength = 2200;
let bessel;

function besselTable() {
  if (bessel) return bessel;
  const cosines = Float64Array.from({length:angularSamples}, (_, i) =>
    Math.cos(Math.PI*(i+.5)/angularSamples));
  bessel = Float64Array.from({length:besselLength}, (_, i) => {
    let sum = 0;
    for (const cosine of cosines) sum += Math.cos(i*besselStep*cosine);
    return sum/angularSamples;
  });
  return bessel;
}

export function imagePosition([x,y]) {
  return [x*magnification,y*magnification];
}

export function fresnelNumber(radius) {
  return radius*radius*(1/sourceDistance+1/sensorDistance)/wavelength;
}

// Angular integration yields J0. Simpson quadrature then integrates the complex circular pupil.
export function pointSpread(mm, conjugateFresnel = fresnelNumber(mm*.0005)) {
  const lut = besselTable();
  const apertureRadius = mm*.0005;
  const waveScale = 2*Math.PI*apertureRadius/(wavelength*sensorDistance);
  const pupilGain = (Math.PI*apertureRadius**2/(wavelength*sensorDistance))**2;
  const real = new Float64Array(pupilSteps+1);
  const imag = new Float64Array(pupilSteps+1);
  for(let j=1;j<=pupilSteps;j++) {
    const rho = j/pupilSteps;
    const phase = Math.PI*conjugateFresnel*rho*rho;
    const weight = 2*rho*(j===pupilSteps?1:j%2===0?2:4)/(3*pupilSteps);
    real[j] = weight*Math.cos(phase);
    imag[j] = weight*Math.sin(phase);
  }
  const values = new Float64Array(profileLength);
  let peak = 0;
  for(let i=0;i<profileLength;i++) {
    const radius = profileRadius*i/(profileLength-1);
    const step = radius*waveScale/(pupilSteps*besselStep);
    let re = 0, im = 0;
    for(let j=1;j<=pupilSteps;j++) {
      const at = step*j;
      const k = Math.floor(at);
      const b = lut[k]+(lut[k+1]-lut[k])*(at-k);
      re += b*real[j];
      im += b*imag[j];
    }
    const intensity = pupilGain*(re*re+im*im);
    values[i] = intensity;
    peak = Math.max(peak,intensity);
  }
  const area = Math.PI*apertureRadius**2;
  const step = profileRadius/(profileLength-1);
  let flux = 0, e80;
  for(let i=1;i<profileLength;i++) {
    const before = flux;
    flux += Math.PI*step*step*((i-1)*values[i-1]+i*values[i]);
    if(e80===undefined && flux>=.8*area) e80 = 2*step*(i-1+(.8*area-before)/(flux-before));
  }
  return {values, peak, diameter80:e80, fluxFraction:flux/area};
}

export function sampleArray(scale) {
  const mm = diameterMm.map((size)=>size*scale);
  const profiles = mm.map((diameter)=>pointSpread(diameter));
  const column = new Uint8Array(profileLength*4);
  for(let i=0;i<profileLength;i++) {
    for(let channel=0;channel<3;channel++) {
      const {values,peak}=profiles[channel];
      column[4*i+channel]=Math.round(Math.sqrt(values[i]/peak)*255);
    }
    column[4*i+3]=255;
  }
  return {mm,profiles,column};
}
