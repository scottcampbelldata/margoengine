// This demo's mechanism: its dimensions, and its pose from @margoengine/machinery/mechanisms.
import { stroboscopicPose, stroboscopicRate } from '@margoengine/machinery/mechanisms';

export const repeatedSectors = 6;
export const defaultSpeed = 120;
export const defaultSampling = 14;

export const apparentSpeed = (rpm, sampleRate) => stroboscopicRate(rpm, sampleRate, repeatedSectors);

export function rotorPose(elapsed, rpm, sampleRate) {
  const {reference, sampled, flash} = stroboscopicPose(elapsed, rpm, sampleRate);
  return {reference, sampled, sample: flash};
}
