import { arrowSegments, sampleField, streamline } from '@margoengine/sciviz/maths';
import { bounds } from './wind-data.js';

const [left, right, bottom, top] = bounds;
const dx = right - left, dy = top - bottom;
const countX = 19, countY = 10;

/** One day's ink: a stroke per streamline from a jittered grid of seeds, and a stroke per arrow line, coloured by speed. */
export function streamGeometry({ direction, physical }) {
  const strokes = [];
  const speedAt = (x, y, fallback) => {
    const wind = sampleField(physical, x, y, 0);
    return wind ? Math.hypot(wind[0], wind[1]) : fallback;
  };
  for (let row = 0; row < countY; row++) {
    for (let column = 0; column < countX; column++) {
      const seed = row * countX + column;
      const x = left + dx * (column + .5 + .28 * Math.sin(seed * 83.47)) / countX;
      const y = bottom + dy * (row + .5 + .28 * Math.cos(seed * 92.67)) / countY;
      const line = streamline(direction, [x, y, 0], { step: .014, maxSteps: 14, minSpeed: .1 });
      if (line.speeds.length < 2) continue;
      const values = Float32Array.from(line.speeds, (speed, i) =>
        speedAt(line.positions[i * 3], line.positions[i * 3 + 1], speed));
      strokes.push({ positions: Float32Array.from(line.positions), values });
    }
  }

  const xs = [], ys = [], us = [], vs = [], speeds = [];
  for (let row = 1; row <= 5; row++) {
    for (let col = 1; col <= 10; col++) {
      const x = left + dx * (col - .24 * (row % 2)) / 11;
      const y = bottom + dy * row / 6;
      const velocity = sampleField(direction, x, y, 0);
      const speed = speedAt(x, y, 0);
      if (speed < .36) continue;
      const length = Math.min(.035, .013 + speed * .0011);
      const factor = length / Math.hypot(velocity[0], velocity[1]);
      xs.push(x); ys.push(y); us.push(velocity[0] * factor); vs.push(velocity[1] * factor); speeds.push(speed);
    }
  }
  const arrows = arrowSegments(xs, ys, undefined, us, vs, undefined, 1, .38);
  const arrowStrokes = Array.from(arrows.sample, (sample, i) => ({
    positions: arrows.segments.slice(i * 6, i * 6 + 6),
    values: [speeds[sample], speeds[sample]],
  }));
  const segments = strokes.reduce((sum, stroke) => sum + stroke.values.length - 1, 0);
  return { strokes, arrows: arrowStrokes, segments, vectors: xs.length };
}
