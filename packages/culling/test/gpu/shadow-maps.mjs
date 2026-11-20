// Node side of shadow-maps.js: the two engines' shadow depth maps must match texel for texel (the casters' depths, before
// any receiver reads them: one ulp apart can leave every frame pixel equal). On the WebGL2 compatibility layer there is
// no GPUDevice to read, so only the frames are compared there.
import assert from 'node:assert/strict';
import { compatRun } from '../../../../scripts/support/compat-shim.js';

/** Asserts that canvas a's and canvas b's engines hold the same shadow map, logging what was compared as `label`. */
export async function assertShadowMaps(page, label) {
  const maps = await page.evaluate(() => window.shadowMapDiff());
  if (!maps) {
    // On WebGPU the maps must be there: a silent skip would hide a broken hook.
    if (!compatRun()) throw new Error('no shadow maps were seen: shadow-maps.js did not hook the engines');
    return;
  }
  console.log(`${label}: shadow maps: ${maps.differing} of ${maps.texels} texels differ, ${maps.covered} covered`);
  if (maps.differing) console.log('differing texels (x, y, layer, a, b):', JSON.stringify(maps.at));
  assert.ok(maps.covered[1] > 1000, `${label}: the compared maps hold casters (${maps.covered[1]} texels)`);
  assert.equal(maps.differing, 0, `${label}: the shadow depths differ between the engines`);
}
