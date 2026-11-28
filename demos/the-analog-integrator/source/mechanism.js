// This demo's mechanism: its dimensions, and its pose from @margoengine/machinery/mechanisms.
import { ballDiskIntegrator } from '@margoengine/machinery/mechanisms';

export const wheelRadius = .046;
export const diskRadius = .24;
export const carriageLimit = .195;
export const diskTurnsPerSecond = .40;
const spec = {wheelRadius, diskRadius};

// At contact the disk and roller both move along -Z for positive X and positive rotation.
export const transmission = ballDiskIntegrator(spec).ratio;

/** The integrator run by the page clock: `now` in milliseconds. */
export function createIntegrator(now, radius, running) {
  const integrator = ballDiskIntegrator(spec);
  const state = { radius, running, diskTurns: 0, outputTurns: 0 };
  let previousTime = now;

  function advance(now) {
    const nextTime = Math.max(previousTime, now);
    const elapsedSeconds = (nextTime - previousTime) / 1000;
    previousTime = nextTime;
    if (state.running) integrator.advance(diskTurnsPerSecond * elapsedSeconds, state.radius);
    state.diskTurns = integrator.diskTurns;
    state.outputTurns = integrator.outputTurns;
    return state;
  }

  return {
    state,
    advance,
    setRadius(now, radius) { advance(now); state.radius = radius; },
    setRunning(now, running) { advance(now); state.running = running; },
    resetOutput(now) { advance(now); integrator.reset(); state.outputTurns = 0; },
  };
}
