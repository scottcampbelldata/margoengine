import { Lines } from '@margoengine/lines';
import { FlowPath } from '@margoengine/lines/flow';
import { mix, ramp } from './film.js';

export function turbofanFlow(engine, centerY) {
  const lines = Lines.attach(engine);

  const path = (point, { color, width, dash, gap, speed, phase = 0, from, to, strength = 0.85 }) => {
    const positions = Array.from({ length: 49 }, (_, i) => point(i / 48)).flat();
    const flow = new FlowPath(lines, {
      positions,
      color,
      width,
      dashSize: dash,
      gapSize: gap,
      speed,
      phase,
      opacity: strength,
    });
    flow.seek(0, 0);
    return { flow, from, to };
  };
  const radial = (t, r, angle, zFrom, zTo) => [r * Math.cos(angle), centerY + r * Math.sin(angle), mix(zFrom, zTo, t)];
  const streams = [];
  for (const [i, angle] of [0.25, 0.54, 0.83, 1.12].entries()) {
    streams.push(
      path(
        (t) => radial(t, 0.56 - 0.057 * ramp(t, 0.27, 0.65) + 0.074 * ramp(t, 0.78, 1), angle + 0.14 * t, 1.7, -1.13),
        {
          color: '#16aeff',
          width: 7.2 - i * 0.36,
          dash: 0.21,
          gap: 0.27,
          speed: 0.51 + 0.039 * i,
          phase: i * 0.107,
          from: 15.15,
          to: 29.7,
          strength: 0.94,
        },
      ),
    );
  }
  for (const [i, angle] of [0.26, 0.78, 1.21].entries()) {
    streams.push(
      path((t) => radial(t, 0.242 - 0.034 * ramp(t, 0.15, 0.84), angle + 0.075 * t, 1.58, -0.12), {
        color: '#17edb3',
        width: 6.1,
        dash: 0.102,
        gap: 0.16,
        speed: 0.35 + i * 0.032,
        phase: i * 0.072,
        from: 15.6,
        to: 47.6,
        strength: 0.96,
      }),
    );
  }
  // Illustrative supply branches converge toward the cutaway's combustor inlet.
  for (const [i, angle] of [0.46, 0.75, 1.04].entries()) {
    streams.push(
      path((t) => radial(t, mix(0.407, 0.227, ramp(t, 0.26, 1)), angle - 0.23 * (1 - t), 0.29, -0.14), {
        color: '#ffca29',
        width: 7.0,
        dash: 0.063,
        gap: 0.092,
        speed: 0.215,
        phase: i * 0.041,
        from: 40.05,
        to: 47.6,
      }),
    );
  }
  for (const [i, angle] of [0.36, 0.77, 1.14].entries()) {
    streams.push(
      path(
        (t) => radial(t, 0.222 - 0.049 * ramp(t, 0.54, 0.9) + 0.039 * ramp(t, 0.85, 1), angle + 0.2 * t, -0.16, -1.65),
        {
          color: '#ff692d',
          width: 6.4,
          dash: 0.132,
          gap: 0.18,
          speed: 0.42 + i * 0.043,
          phase: i * 0.088,
          from: 43.6,
          to: 56.7,
          strength: 0.96,
        },
      ),
    );
  }
  return {
    count: streams.length,
    apply(time) {
      for (const { flow, from, to } of streams) {
        const fade = ramp(time, from, from + 0.52) * (1 - ramp(time, to - 0.38, to));
        flow.seek(time, fade);
      }
    },
    dispose() {
      for (const { flow } of streams) flow.dispose();
    },
  };
}
