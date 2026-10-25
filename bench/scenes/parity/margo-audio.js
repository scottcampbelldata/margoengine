// Margo implementation of the parity audio scene (../parity.js, area 'audio').

/** Source j's position and facing at step k, and the listener's pose (the three side uses the same paths). */
export function sourcePose(j, k, out, dir) {
  const a = j * 0.098 + k * 0.01;
  out[0] = Math.cos(a) * (5 + (j % 8));
  out[1] = 1 + (j % 4) * 0.5;
  out[2] = Math.sin(a) * (5 + (j % 8));
  dir[0] = -Math.sin(a);
  dir[1] = 0;
  dir[2] = Math.cos(a);
}
export function listenerPose(k, position, forward) {
  const a = k * 0.005;
  position[0] = Math.cos(a) * 2;
  position[1] = 1.6;
  position[2] = Math.sin(a) * 2;
  forward[0] = -Math.cos(a);
  forward[1] = 0;
  forward[2] = -Math.sin(a);
}
/** Resumes a suspended context, giving up after 500 ms (headless autoplay policy); panner updates are timed either way. */
export const tryResume = (context) =>
  Promise.race([context.resume().catch(() => {}), new Promise((r) => setTimeout(r, 500))]).then(() => context.state);

export const builders = {
  async 'p-audio'(canvas, data, marks) {
    const s = performance.now(),
      { AudioListener, PositionalAudio } = await import('@margoengine/audio'),
      listener = new AudioListener({ autoResume: false }),
      state = await tryResume(listener.context),
      sources = Array.from({ length: data.sources }, () => {
        const sound = new PositionalAudio(listener),
          oscillator = listener.context.createOscillator();
        sound.setNodeSource(oscillator);
        oscillator.start();
        return sound;
      });
    marks.createMs = 0;
    marks.buildMs = +(performance.now() - s).toFixed(1);
    const p = [0, 0, 0],
      d = [0, 0, 1],
      lp = [0, 0, 0],
      lf = [0, 0, -1],
      up = [0, 1, 0];
    let step = 0;
    return {
      task() {
        for (let k = 0; k < data.steps; k++, step++) {
          listenerPose(step, lp, lf);
          listener.setPose(lp, lf, up);
          for (let j = 0; j < sources.length; j++) {
            sourcePose(j, step, p, d);
            sources[j].setPosition(p[0], p[1], p[2]).setDirection(d);
          }
        }
      },
      output: () => ({ sources: sources.length, steps: step, context: state }),
      info: () => ({
        note: `AudioListener.setPose + PositionalAudio.setPosition/setDirection (oscillator sources); context ${state}`,
      }),
    };
  },
};
