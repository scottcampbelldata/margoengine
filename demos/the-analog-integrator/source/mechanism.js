// This demo's mechanism: its dimensions, and its motion from a stepped @margoengine/physics world (@margoengine/machinery/rigs),
// checked every step against Thomson's integral (@margoengine/machinery/mechanisms).
import { ballDiskIntegrator } from '@margoengine/machinery/mechanisms';
import { integratorRig, openRig } from '@margoengine/machinery/rigs';

export const wheelRadius = .046;
export const diskRadius = .24;
export const carriageLimit = .195;
export const diskTurnsPerSecond = .40;
const spec = {wheelRadius, diskRadius};

// At contact the disk and roller both move along -Z for positive X and positive rotation.
export const transmission = ballDiskIntegrator(spec).ratio;

const tau = 2 * Math.PI;

/** The integrator on the solver, run by the page clock: `now` in milliseconds; `signal` disposes it. */
export async function openIntegrator(now, radius, running, signal) {
  const rig = await openRig(integratorRig, { ...spec, radius, signal });
  const state = { radius, running, diskTurns: 0, outputTurns: 0 };
  let previousTime = now, disk = 0;

  function advance(now) {
    const nextTime = Math.max(previousTime, now);
    const elapsedSeconds = (nextTime - previousTime) / 1000;
    previousTime = nextTime;
    if (state.running) disk += diskTurnsPerSecond * elapsedSeconds * tau;
    const pose = rig.drive(disk, false);
    state.diskTurns = pose.disk / tau;
    state.outputTurns = pose.output / tau;
    return state;
  }

  return {
    state,
    check: rig.check,
    advance,
    setRadius(now, radius) { advance(now); state.radius = radius; rig.setRadius(radius); },
    setRunning(now, running) { advance(now); state.running = running; },
    resetOutput(now) { advance(now); rig.resetOutput(); state.outputTurns = 0; },
  };
}
