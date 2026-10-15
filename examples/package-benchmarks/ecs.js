import { World } from '../../packages/ecs/dist/index.js';
import { grid } from './layout.js';

export function createWorkload(count = 10000) {
  const points = grid(count),
    world = new World(count),
    ids = new Uint32Array(count);
  const position = world.component({ x: Float32Array, z: Float32Array }),
    velocity = world.component({ x: Float32Array, z: Float32Array });
  const components = [position, velocity],
    limit = Math.ceil(Math.sqrt(count)) * 0.2 + 0.2;
  for (let i = 0; i < count; i++) {
    const entity = world.create();
    position.add(entity, { x: points[i * 4], z: points[i * 4 + 2] });
    velocity.add(entity, { x: ((i % 7) - 3) * 0.04, z: ((i % 5) - 2) * 0.04 });
  }
  let queried = 0,
    queries = 0;
  return {
    points,
    world,
    position,
    velocity,
    description:
      'Intersect position and velocity components, integrate every matching entity, and render the resulting positions.',
    step(delta) {
      queried = world.query(components, ids);
      queries++;
      for (let i = 0; i < queried; i++) {
        const p = position.index(ids[i]),
          v = velocity.index(ids[i]);
        position.fields.x[p] += velocity.fields.x[v] * delta;
        position.fields.z[p] += velocity.fields.z[v] * delta;
        if (Math.abs(position.fields.x[p]) > limit) velocity.fields.x[v] *= -1;
        if (Math.abs(position.fields.z[p]) > limit) velocity.fields.z[v] *= -1;
        points[i * 4] = position.fields.x[p];
        points[i * 4 + 2] = position.fields.z[p];
      }
    },
    details: () => ({ entities: count, queriedPerFrame: queried, queries }),
  };
}
