import { World, Query, ChangeTracker, Relation } from '../dist/index.js';
import { ObjectComponent, objectField } from '../dist/objects.js';
import { ReactiveQuery } from '../dist/reactive.js';
import { RelationQuery } from '../dist/relation-query.js';
import { WorldSerializer } from '../dist/serialize.js';
import { SharedWorld, ParallelSchedule } from '../dist/parallel.js';
const world = new World(8);
const mixed = new ObjectComponent(world, { title: objectField(() => ''), x: Float32Array });
mixed.add(world.create(), { title: 'name', x: 2 });
// @ts-expect-error Object fields retain their inferred type.
mixed.add(world.create(), { title: 42 });
const title: string = mixed.fields.title[0];
new WorldSerializer(world, { mixed });
const shared = new SharedWorld(8),
  position = shared.component({ x: Float32Array });
const parallel = new ParallelSchedule(shared, { position });
parallel.add({ name: 'move', module: new URL('https://example.test/system.js'), writes: ['position'] });
void title;
world.query([mixed], new Uint32Array(8));
new Query(world, { with: [mixed], optional: [mixed], without: [world.tag()] });
new ChangeTracker(mixed).stop();
new ReactiveQuery(world, { with: [mixed] }).stop();
new RelationQuery(world, { with: [mixed], relations: [{ relation: new Relation(world), with: [mixed] }] });
