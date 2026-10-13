/**
 * Gate faster animation clocks without dropping near-native refresh ticks.
 * @param {Float64Array} clock Retained [next deadline, previous timestamp, mean callback interval].
 * @param {number} now rAF timestamp in milliseconds.
 * @param {number} targetRate Requested frames per second.
 */
export function frameDue(clock, now, targetRate) {
  const interval = 1000 / targetRate;
  const tolerance = Math.min(2, interval * 0.1);
  const previous = clock[1];
  clock[1] = now;
  const callbackDelta = now - previous;
  if (!previous || callbackDelta > interval * 4) {
    clock[2] = 0;
    clock[0] = now + interval;
    return true;
  }
  // Average bursty callbacks before deciding whether the browser already limits the cadence.
  clock[2] = clock[2]
    ? clock[2] + (callbackDelta - clock[2]) * 0.1
    : callbackDelta;
  // A near-native clock must not accumulate a future deadline if its refresh rate later changes.
  if (clock[2] >= interval - tolerance) clock[0] = Math.min(clock[0], now);
  else if (now + tolerance < clock[0]) return false;

  // Preserve phase across bursty callbacks; retain at most one interval of overdue work.
  clock[0] = Math.max(clock[0] + interval, now - interval);
  return true;
}
/** Report the measured browser callback cadence separately from the requested render cap. */
export function frameStatus(targetRate, callbackRate, fps) {
  if (!callbackRate) return 'Measuring browser cadence…';
  const rate = Math.round(callbackRate);
  if (targetRate > callbackRate * 1.15)
    return `${targetRate} FPS target · browser supplies ~${rate} Hz. Rendering load or browser/display limits can reduce this cadence.`;
  if (fps < targetRate * 0.85)
    return `${targetRate} FPS target · rendering ~${Math.round(fps)} FPS; browser cadence ~${rate} Hz.`;
  return `${targetRate} FPS target · browser cadence ~${rate} Hz.`;
}
