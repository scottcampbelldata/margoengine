// What Water and its effects share about stepping on a film clock (WaterOptions.clock), in a module of its own so an
// effect entry (Ripples) imports it without the whole Water.

/** The most ticks a frame runs with a film clock (`WaterOptions.clock`); `Water.settle()` runs the rest of the flow's. */
export const WATER_FLOW_TICKS_PER_FRAME = 480;
