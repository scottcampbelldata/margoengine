// A generated two-storey house for WalkControls tests, the browser walk and the CPU benchmark (metres, Y up).
// Footprint x 0..10, z 0..8; walls 0.2 thick; front door x 2..3; interior wall x 4.9..5.1 with a doorway z 3..4;
// a 16-step stair (rise 0.1875, going 0.26) along z 6.7..7.7 from x 5.6 up to the upper floor at y 3; a deck of
// boards with 1 cm gaps outside the door, a 12 mm rug, a kitchen counter and a zero-thickness glass partition.
import {Geometry, PbrMaterial, box} from '@margoengine/core';

export const RISE = 3 / 16, GOING = 0.26;
/** Feet waypoints of the scripted walk: deck -> door -> rug -> doorway -> stairs -> upper floor. */
export const PATH = [[2.5, -2], [2.5, 1.2], [2, 4.5], [4.3, 3.5], [5.6, 3.5], [5.45, 7.2], [9.5, 7.2], [9.5, 5], [3, 3]];

export function buildHouse(engine) {
  const unit = box(), boxes = [], meshes = [], materials = new Map();
  const material = color => {if (!materials.has(color)) materials.set(color, new PbrMaterial({color, roughness: 0.8})); return materials.get(color);};
  const add = (min, max, color) => {
    const mesh = engine.createMesh().setGeometry(unit).setMaterial(material(color))
      .setPosition([(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2]).setScale([max[0] - min[0], max[1] - min[1], max[2] - min[2]]);
    boxes.push({min, max}); meshes.push(mesh); return mesh;
  };
  add([-10, -0.4, -10], [20, -0.3, 18], '#5f7a45');                       // garden
  for (let i = 0; i < 20; i++) add([0, -0.03, -3 + i * 0.15], [6, 0, -3 + i * 0.15 + 0.14], '#8a5a34'); // deck boards, 1 cm gaps
  add([0, -0.2, 0], [10, 0, 8], '#9b6b43');                                // ground floor (hardwood)
  add([1, 0, 3.5], [3, 0.012, 6], '#a33b3b');                              // rug
  add([0.2, 0, 0.6], [0.8, 0.9, 3], '#dddddd');                            // kitchen counter
  const walls = (y0, y1, door) => {
    if (door) {add([0, y0, 0], [2, y1, 0.2], '#e8e2d6'); add([3, y0, 0], [10, y1, 0.2], '#e8e2d6'); add([2, y0 + 2.1, 0], [3, y1, 0.2], '#e8e2d6');}
    else add([0, y0, 0], [10, y1, 0.2], '#e8e2d6');
    add([0, y0, 7.8], [10, y1, 8], '#e8e2d6'); add([0, y0, 0.2], [0.2, y1, 7.8], '#e8e2d6'); add([9.8, y0, 0.2], [10, y1, 7.8], '#e8e2d6');
  };
  walls(0, 3, true); walls(3, 5.8, false);
  add([4.9, 0, 0.2], [5.1, 2.8, 3], '#d9d2c3'); add([4.9, 0, 4], [5.1, 2.8, 7.8], '#d9d2c3'); add([4.9, 2.1, 3], [5.1, 2.8, 4], '#d9d2c3');
  for (let k = 0; k < 16; k++) add([5.6 + k * GOING, 0, 6.7], [5.6 + (k + 1) * GOING, (k + 1) * RISE, 7.7], '#7b5235');
  add([0, 2.8, 0], [10, 3, 6.6], '#9b6b43'); add([0, 2.8, 6.6], [5.5, 3, 8], '#9b6b43'); // upper floor, stair opening x 5.5..9.8, z 6.6..7.8
  add([0, 5.8, 0], [10, 6, 8], '#555555');                                 // roof slab
  // Glass partition: one zero-thickness quad (two triangles) at z = 3, x 7..9.8, y 0..2.4.
  const glass = new Geometry([7, 0, 3, 9.8, 0, 3, 9.8, 2.4, 3, 7, 2.4, 3], [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], [0, 1, 2, 0, 2, 3]);
  meshes.push(engine.createMesh().setGeometry(glass).setMaterial(new PbrMaterial({color: '#9cc9e0', roughness: 0.1, doubleSided: true})));
  return {boxes, meshes, quads: [{x0: 7, x1: 9.8, y0: 0, y1: 2.4, z: 3}]};
}

/** Distance from a vertical segment (x, y0..y1, z) to the house's boxes and glass (the capsule axis clearance). */
export function clearance(house, x, y0, y1, z) {
  let best = Infinity;
  const gap = (lo, hi, a, b) => Math.max(0, lo - b, a - hi);
  for (const {min, max} of house.boxes) best = Math.min(best, Math.hypot(gap(min[0], max[0], x, x), gap(min[1], max[1], y0, y1), gap(min[2], max[2], z, z)));
  for (const q of house.quads) best = Math.min(best, Math.hypot(gap(q.x0, q.x1, x, x), gap(q.y0, q.y1, y0, y1), z - q.z));
  return best;
}
