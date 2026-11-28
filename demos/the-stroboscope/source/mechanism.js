// This demo's mechanism: the apparent speed from @margoengine/machinery/mechanisms, and the rotor and its strobe samples from a
// stepped @margoengine/physics world (@margoengine/machinery/rigs), checked every step against the rotor's exact turn.
import { stroboscopicRate } from '@margoengine/machinery/mechanisms';
import { openRig, stroboscopeRig } from '@margoengine/machinery/rigs';

export const repeatedSectors = 6;
export const defaultSpeed = 120;
export const defaultSampling = 14;

export const apparentSpeed = (rpm, sampleRate) => stroboscopicRate(rpm, sampleRate, repeatedSectors);

/** Builds the rotor on the solver at `rpm` under a strobe at `flashRate`; `signal` disposes it. */
export const openRotor = (rpm, flashRate, signal) => openRig(stroboscopeRig, {rpm, flashRate, signal});
