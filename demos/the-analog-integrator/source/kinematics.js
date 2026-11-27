export const wheelRadius = .046;
export const diskRadius = .24;
export const carriageLimit = .195;
export const diskTurnsPerSecond = .40;

// At contact the disk and roller both move along -Z for positive X and positive rotation.
export function transmission(radius) {
  return radius / wheelRadius;
}

export function createIntegrator(now, radius, running) {
  const state = { radius, running, diskTurns: 0, outputTurns: 0 };
  let previousTime = now;

  function advance(now) {
    const nextTime = Math.max(previousTime, now);
    const elapsedSeconds = (nextTime - previousTime) / 1000;
    previousTime = nextTime;
    if (state.running) {
      const diskTravel = diskTurnsPerSecond * elapsedSeconds;
      state.diskTurns += diskTravel;
      state.outputTurns += diskTravel * transmission(state.radius);
    }
    return state;
  }

  return {
    state,
    advance,
    setRadius(now, radius) {
      advance(now);
      state.radius = radius;
    },
    setRunning(now, running) {
      advance(now);
      state.running = running;
    },
    resetOutput(now) {
      advance(now);
      state.outputTurns = 0;
    },
  };
}
