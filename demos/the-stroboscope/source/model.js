export const repeatedSectors = 6;
export const defaultSpeed = 120;
export const defaultSampling = 14;
const tau = Math.PI * 2;

export function apparentSpeed(rpm, sampleRate) {
  const repeatedFeaturesPerSecond = rpm * repeatedSectors / 60;
  const order = Math.round(repeatedFeaturesPerSecond / sampleRate);
  const observed = (repeatedFeaturesPerSecond - order * sampleRate) * 60 / repeatedSectors;
  return Math.abs(observed) < 1e-10 ? 0 : observed;
}

export function rotorPose(elapsed, rpm, sampleRate) {
  const revolutionsPerSecond = rpm / 60;
  const sample = Math.floor(elapsed * sampleRate + 1e-10);
  return {
    reference: (elapsed * revolutionsPerSecond % 1) * tau,
    sampled: (sample * revolutionsPerSecond / sampleRate % 1) * tau,
    sample,
  };
}


