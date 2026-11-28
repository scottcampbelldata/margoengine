import { arrowSegments, sampleField, streamline } from '@margoengine/sciviz/maths';
import { bounds } from './wind-data.js';

const [left, right, bottom, top] = bounds;
const dx = right - left, dy = top - bottom;
const countX = 19, countY = 10;

export function streamGeometry({ direction, physical }) {
  const data = [];
  function segment(ax, ay, as, start, bx, by, bs, end, phase, width, isArrow) {
    data.push(ax, -ay, as, start, bx, -by, bs, end, phase, width, isArrow);
  }

  for (let row = 0; row < countY; row++) {
    for (let column = 0; column < countX; column++) {
      const seed = row * countX + column;
      const x = left + dx * (column + .5 + .28 * Math.sin(seed * 83.47)) / countX;
      const y = bottom + dy * (row + .5 + .28 * Math.cos(seed * 92.67)) / countY;
      const line = streamline(direction, [x, y, 0], { step: .014, maxSteps: 14, minSpeed: .1 });
      if (line.speeds.length < 2) continue;
      const phase = (seed * .61803398875) % 1;
      let arc = 0;
      let previous;
      for (let i = 0; i < line.speeds.length; i++) {
        const offset = i * 3;
        const x = line.positions[offset], y = line.positions[offset + 1];
        const physicalFlow = sampleField(physical, x, y, 0);
        const speed = physicalFlow ? Math.hypot(physicalFlow[0], physicalFlow[1]) : line.speeds[i];
        if (i > 0) {
          const [px, py, ps] = previous;
          const end = arc + Math.hypot(x - px, y - py);
          if (end - arc > .000015) {
            segment(px, py, ps, arc, x, y, speed, end, phase, 1.15, 0);
            arc = end;
          }
        }
        previous = [x, y, speed];
      }
    }
  }

  const xs = [], ys = [], us = [], vs = [], speeds = [];
  for (let row = 1; row <= 5; row++) {
    for (let col = 1; col <= 10; col++) {
      const x = left + dx * (col - .24 * (row % 2)) / 11;
      const y = bottom + dy * row / 6;
      const velocity = sampleField(direction, x, y, 0);
      const wind = sampleField(physical, x, y, 0);
      const speed = Math.hypot(wind[0], wind[1]);
      if (speed < .36) continue;
      const length = Math.min(.035, .013 + speed * .0011);
      const factor = length / Math.hypot(velocity[0], velocity[1]);
      xs.push(x); ys.push(y); us.push(velocity[0] * factor); vs.push(velocity[1] * factor); speeds.push(speed);
    }
  }
  const arrows = arrowSegments(xs, ys, undefined, us, vs, undefined, 1, .38);
  for (let i = 0; i < arrows.sample.length; i++) {
    const k = i * 6;
    const speed = speeds[arrows.sample[i]];
    const { segments } = arrows;
    segment(segments[k], segments[k + 1], speed, 0, segments[k + 3], segments[k + 4], speed, 0, 0, 1.20, 1);
  }
  return { vertices: new Float32Array(data), segments: data.length / 11, arrows: xs.length };
}

