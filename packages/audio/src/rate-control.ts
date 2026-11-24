/** Internal authored-rate validation and modulation shared by sounds and optional controllers. */
export const playbackRateModifiers = new WeakMap<object, {apply(value: number): number; validate(value: number): void}>();
