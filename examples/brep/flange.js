// A pipe flange built with the @margoengine/brep modeler: a disc and a hub joined, a bore through both,
// six bolt holes on a circle and a rounded rim. Lengths are metres (the modeler's unit).
import { model } from '@margoengine/brep';

const { boolean, cylinder, fillet, frameOf } = model;
const mm = 0.001;
const at = (x, y, z) => frameOf([x * mm, y * mm, z * mm], [0, 0, 1], [1, 0, 0]);

/** Returns the flange body. */
export function flange() {
  let part = boolean('flange', 'union', cylinder('disc', 40 * mm, 10 * mm), cylinder('hub', 20 * mm, 30 * mm));
  part = boolean('flange', 'subtract', part, cylinder('bore', 12 * mm, 50 * mm, at(0, 0, -10)));
  for (let i = 0; i < 6; i++) {
    const a = (i * Math.PI) / 3;
    part = boolean(
      'flange',
      'subtract',
      part,
      cylinder(`bolt${i}`, 4 * mm, 30 * mm, at(30 * Math.cos(a), 30 * Math.sin(a), -10)),
    );
  }
  return part;
}

/** The flange with its outer rim edges rounded (2 mm), when the fillet succeeds. */
export function roundedFlange() {
  const part = flange();
  const rim = part.edges.filter((e) => e.curve.kind === 'circle' && Math.abs(e.curve.radius - 40 * mm) < 1e-9);
  return rim.length
    ? fillet(
        'flange',
        part,
        rim.map((e) => e.name),
        2 * mm,
      )
    : part;
}
