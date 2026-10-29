// The G3 limits of the flythrough check, compared without float noise. Frame times are read from performance.now(),
// whose steps (0.1 ms in a page that is not cross-origin isolated) are not exact binary fractions, so a difference of
// medians that is exactly three steps can come out as 0.30000000261 or 0.29999999981 and the raw comparison would
// pass or fail on the last bits. Rounding to a nanosecond removes that noise and nothing else: 0.4 still fails.
export const P99_LIMIT = 0.3;
export const MAX_LIMIT = 1;

/** Milliseconds rounded to the nanosecond. */
export const settle = (ms) => Math.round(ms * 1e6) / 1e6;

/** Whether streaming stayed within the G3 limits: added 99th percentile and worst frame time, milliseconds. */
export const withinLimits = (p99Added, maxAdded) => settle(p99Added) <= P99_LIMIT && settle(maxAdded) <= MAX_LIMIT;
