import { createIFCScene } from '@margoengine/ifc/scene';

export function addGlass(engine, model) {
  return createIFCScene(engine, { origin: model.origin, geometries: model.geometries,
    placements: model.placements.filter((placement) => placement.color[3] < 1),
  }, { instancing: 0, selectionColor: [.99,.74,.40] });
}
