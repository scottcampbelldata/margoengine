// The exhibit's props, placed from @margoengine/geometry builders: a museum plinth with an oak deck, a red lattice
// tower crane (trussGeometry mast, jibs and A-frame), the trolley, chain links, the ball and thirty pine blocks.
import { PbrMaterial } from '@margoengine/core';
import { boxGeometry, cylinderGeometry, sphereGeometry } from '@margoengine/geometry/primitives';
import { chainLinkGeometry, roundedBoxGeometry, trussGeometry } from '@margoengine/geometry/extras';
import { toGeometry } from '@margoengine/geometry/utils';
import { axisAngleToQuaternion } from '@margoengine/math/quat';
import { ball, chain, pivot, stack } from './trial.js';

const Z = [0, 0, 1], X = [1, 0, 0], Y = [0, 1, 0];
const mastX = -0.6, mastTop = 0.6, jibY = pivot[1] + 0.03;
const woods = ['#d9c39b', '#cfb48a', '#e1cda7', '#c8a77c', '#d6bc92'];

export function buildExhibit(engine, shadows) {
  const paint = (color, roughness, metalness = 0) => new PbrMaterial({ color, roughness, metalness });
  const [enamel, worn, darkSteel, steel, iron] = [paint('#b5402a', 0.38), paint('#9c3524', 0.5), paint('#2f3336', 0.42, 0.75), paint('#b9bec2', 0.26, 1), paint('#2a2b2e', 0.48, 0.9)];
  const [glass, concrete, lacquer, brass, oak, inlay] = [paint('#2a3a44', 0.08, 0.2), paint('#8f8a82', 0.86), paint('#2b2a29', 0.62), paint('#b48f55', 0.3, 1), paint('#c9b590', 0.66), paint('#7c6748', 0.55)];
  const place = (geometry, material, at, { cast = true, moving = false, rotation, parent = null } = {}) => {
    const mesh = engine.createMesh(parent).setGeometry('uvs' in geometry ? toGeometry(geometry) : geometry).setMaterial(material).setPosition(at);
    if (rotation) mesh.setQuaternion(rotation);
    if (cast) shadows.add(mesh, { static: !moving });
    return mesh;
  };
  const slab = (size, bevel, material, at, options) => place(roundedBoxGeometry(...size, 3, bevel), material, at, options);
  const truss = (options, at, rotation) => place(trussGeometry({ chordRadius: 0.0034, lacingRadius: 0.002, ...options }), enamel, at, { rotation });

  // Gallery floor and plinth: a dark lacquered body, a brass band and an oak deck marked every 10 cm.
  place(boxGeometry(30, 0.1, 30), paint('#5f5a54', 0.9), [0, -0.66, 0], { cast: false });
  slab([1.62, 0.56, 0.82], 0.012, lacquer, [0, -0.33, 0]);
  slab([1.6, 0.012, 0.8], 0.004, brass, [0, -0.046, 0]);
  slab([1.56, 0.04, 0.76], 0.008, oak, [0, -0.02, 0]);
  for (let i = -7; i <= 7; i++) slab([0.0035, 0.0012, i % 5 ? 0.026 : 0.05], 0.0005, inlay, [i * 0.1, 0.0004, 0.33], { cast: false });
  slab([1.4, 0.0012, 0.003], 0.0005, inlay, [0, 0.0004, 0.355], { cast: false });

  // Crane: a ballasted foot, the mast, a slewing deck with its cab, the main jib, the counter-jib and its ballast.
  slab([0.2, 0.035, 0.2], 0.006, concrete, [mastX, 0.0175, 0]);
  slab([0.15, 0.03, 0.15], 0.005, concrete, [mastX, 0.05, 0]);
  for (const [dx, dz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) place(cylinderGeometry(0.006, 0.006, 0.012, 12), darkSteel, [mastX + dx * 0.05, 0.071, dz * 0.05]);
  truss({ length: mastTop - 0.07, width: 0.075, bays: 9, chordRadius: 0.0042, lacingRadius: 0.0024 }, [mastX, 0.065, 0]);
  place(cylinderGeometry(0.058, 0.058, 0.014, 40), darkSteel, [mastX, mastTop + 0.002, 0]);
  slab([0.2, 0.016, 0.1], 0.004, worn, [mastX - 0.03, mastTop + 0.017, 0]);
  slab([0.075, 0.07, 0.075], 0.008, enamel, [mastX + 0.04, mastTop + 0.06, 0.07]);
  slab([0.074, 0.032, 0.076], 0.004, glass, [mastX + 0.043, mastTop + 0.072, 0.0705]);
  truss({ length: pivot[0] + 0.04 - mastX, width: 0.05, depth: 0.055, bays: 14, taper: 0.7 }, [mastX + 0.03, jibY, 0], axisAngleToQuaternion(Z, -Math.PI / 2));
  truss({ length: 0.21, width: 0.045, depth: 0.055, bays: 4, taper: 0.85 }, [mastX - 0.03, jibY, 0], axisAngleToQuaternion(Z, Math.PI / 2));
  slab([0.07, 0.07, 0.07], 0.006, concrete, [mastX - 0.2, jibY - 0.045, 0]);
  slab([0.05, 0.06, 0.07], 0.006, concrete, [mastX - 0.135, jibY - 0.045, 0]);
  // The A-frame over the mast and the tie bars from its apex to both jibs.
  truss({ length: 0.17, width: 0.04, bays: 3, taper: 0.4, chordRadius: 0.003, lacingRadius: 0.0018 }, [mastX, jibY, 0]);
  for (const z of [-0.02, 0.02]) for (const end of [pivot[0] - 0.12, mastX - 0.22]) {
    const dx = end - mastX, dy = 0.025 - 0.17;
    place(cylinderGeometry(0.0018, 0.0018, Math.hypot(dx, dy), 8), darkSteel, [mastX + dx / 2, jibY + 0.17 + dy / 2, z], { rotation: axisAngleToQuaternion(Z, Math.atan2(-dx, dy)) });
  }
  // Trolley and sheave on the jib's lower chords; the chain hangs from the sheave.
  slab([0.05, 0.012, 0.07], 0.003, darkSteel, [pivot[0], jibY - 0.03, 0]);
  place(cylinderGeometry(0.013, 0.013, 0.012, 28), steel, [pivot[0], pivot[1] + 0.008, 0], { rotation: axisAngleToQuaternion(X, Math.PI / 2) });
  for (const z of [-0.012, 0.012]) slab([0.034, 0.03, 0.004], 0.0015, darkSteel, [pivot[0], pivot[1] + 0.006, z]);

  // Moving parts. Every other link turns a quarter turn about its length so the links interleave.
  const step = chain.length / chain.links;
  const link = toGeometry(chainLinkGeometry({ length: step * 1.5, width: step * 0.62, wire: chain.radius * 0.72 }));
  const quarter = axisAngleToQuaternion(Y, Math.PI / 2);
  const links = Array.from({ length: chain.links }, (_, i) => {
    const holder = engine.createMesh();
    const mesh = place(link, steel, [0, 0, 0], { moving: true, parent: holder });
    if (i % 2) mesh.setQuaternion(quarter);
    return holder;
  });
  const head = engine.createMesh();
  place(sphereGeometry(ball.radius, 64, 40), iron, [0, 0, 0], { moving: true, parent: head });
  place(cylinderGeometry(ball.radius * 0.32, ball.radius * 0.42, ball.radius * 0.3, 24), iron, [0, ball.radius * 0.95, 0], { moving: true, parent: head });
  place(chainLinkGeometry({ length: ball.eye * 1.9, width: ball.eye * 1.3, wire: chain.radius * 0.8 }), iron, [0, ball.radius + ball.eye * 0.55, 0], { moving: true, rotation: quarter, parent: head });
  const blocks = stack.map(({ position, size }, i) => place(roundedBoxGeometry(...size, 2, 0.0022), paint(woods[(i * 7) % 5], 0.58 + ((i * 37) % 19) / 100), position, { moving: true }));

  return {
    /** Moves every mesh to its body in the trial's world. */
    pose(trial) {
      trial.rope.segments.forEach((body, i) => links[i].setPosition(body.position).setQuaternion(body.rotation));
      head.setPosition(trial.weight.position).setQuaternion(trial.weight.rotation);
      trial.blocks.forEach((body, i) => blocks[i].setPosition(body.position).setQuaternion(body.rotation));
    },
  };
}
