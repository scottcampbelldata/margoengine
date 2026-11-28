import { PbrMaterial, box } from '@margoengine/core';
import { toGeometry } from '@margoengine/geometry';
import { chamferBoxGeometry, gridSheetGeometry } from '@margoengine/geometry/parts';
import { Texture, UnlitMaterial, createMesh } from '@margoengine/materials';
import { chartHeight as height, chartWidth as width } from './wind-data.js';

/** The chart table: an oak board, a steel tray with a brass rim and corner pins, and the atlas sheet on top. */
export function buildChart(engine, atlas) {
  const material = (color, roughness, metalness = 0) => new PbrMaterial({ color, roughness, metalness });
  const dress = (geometry, surface, pos = [0, 0, 0]) => engine.createMesh()
    .setGeometry(geometry).setMaterial(surface).setPosition(pos);
  const oak = material('#1f3033', .68);
  const steel = material('#47534d', .43);
  const brass = material('#b17e46', .52);
  const dark = material('#16272d', .79);

  dress(box(5, .06, 3.2), dark, [0, -.083, 0]);
  dress(box(width + .075, .033, height + .073), oak, [0, -.026, 0]);
  dress(toGeometry(chamferBoxGeometry(width + .092, .045, height + .09, { chamfer: .008, radius: .022 })), steel, [0, -.0195, 0]);
  dress(toGeometry(chamferBoxGeometry(width + .079, .003, height + .077, { chamfer: .001, radius: .022 })), brass, [0, .0035, 0]);
  dress(toGeometry(chamferBoxGeometry(width + .056, .002, height + .054, { chamfer: .0007, radius: .016 })), steel, [0, .0045, 0]);
  const pin = box(.016, .004, .006);
  for (const y of [-1, 1]) for (const x of [-1, 1]) {
    dress(pin, brass, [x * (width / 2 + .022), .006, y * (height / 2 + .021)]);
  }
  const sheet = new UnlitMaterial({ map: new Texture(atlas, { colorSpace: 'srgb', mipmaps: true, anisotropy: 8 }) });
  // The sheet faces up, the image's top row (north) toward -z.
  createMesh(engine, gridSheetGeometry(2, 2, (u, v) => [(u - .5) * width, .006, (.5 - v) * height]), sheet);
}
