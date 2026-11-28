import { generateCity, buildCity } from '@margoengine/procedural/city';

function signature(values) {
  let hash = 0x811c9dc5;
  for (const value of values) {
    hash = Math.imul(hash ^ Math.round(value * 50), 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

async function build(seed, era, layout) {
  const modern = era === 'modern';
  const plan = generateCity({
    seed, era, layout,
    width: 163, depth: 148,
    blockWidth: 43, blockDepth: 43, streetWidth: modern ? 7.4 : 6.2,
    avenueWidth: modern ? 13.0 : 10.7, avenueEvery: 3,
    irregularity: layout === 'grid' ? .31 : .53, spokes: modern ? 8 : 7,
    sidewalk: modern ? 2.65 : 1.88, lotFrontage: modern ? 14 : 13, lotDepth: 14,
    treeSpacing: modern ? 13 : 16, lampSpacing: modern ? 23 : 0,
    downtownRadius: modern ? 33 : 27, parks: modern ? .17 : .12, industry: .10,
    minStoreys: 2, maxStoreys: modern ? 7 : 4,
  });
  const geometry = await buildCity(plan, {
    detail: 'auto', distances: [0, 37, 270], chunk: 256,
    markings: modern, variants: 3, maxTriangles: 700000,
  });
  const roads = signature(plan.nodes.flat().concat(plan.roads.flatMap(road => [road.from, road.to, road.width])));
  const lots = signature(plan.lots.flatMap(lot => lot.polygon.flat()));
  const buildings = signature(plan.buildings.flatMap(building => [
    building.options.width, building.options.depth, building.options.storeys.length, ...building.options.origin,
  ]));
  const styles = {};
  for (const building of plan.buildings) {
    const style = building.options.style;
    styles[style] = (styles[style] ?? 0) + 1;
  }
  const data = {
    seed, era, layout, streets: plan.roads.length, blocks: plan.blocks.length,
    lots: plan.lots.length, buildings: plan.buildings.length, styles, roads, lotsSignature: lots,
    buildingsSignature: buildings, triangles: geometry.triangles,
    parts: geometry.parts.map(({name, material, geometry: {positions, normals, indices}}) => ({
      name, material, positions, normals, indices,
    })),
  };
  return {
    data,
    transfer: data.parts.flatMap(part => [part.positions.buffer, part.normals.buffer, part.indices.buffer]),
  };
}

self.addEventListener('message', async ({data: {id, seed, era, layout}}) => {
  try {
    const {data, transfer} = await build(seed, era, layout);
    self.postMessage({id, plan: data}, transfer);
  } catch (error) {
    self.postMessage({id, error: error.message ?? String(error)});
  }
});
