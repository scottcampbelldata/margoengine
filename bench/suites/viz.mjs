// Data visualisation (@margoengine/sciviz): scatter plots of 100,000 to 4,000,000 points, surfaces of 256^2 and
// 1024^2 and ray-marched volumes of 64^3 and 128^3, each a figure with axes and the camera circling it
// (bench/scenes/catalog.js vizScenes; Margo's in bench/scenes/margo-data.js).
import { sceneCases } from '../lib/browser.mjs';

export default {
  name: 'viz',
  title: 'Data visualisation: scatter, surface and volume figures',
  uses: 'gpu',
  cases: sceneCases('viz', {
    primary: ['cpuMs', 'gpuMs'],
    keep: ['buildMs', 'createMs', 'cpuMs', 'gpuMs', 'fps', 'serialFrameMs', 'jsHeapMB', 'gpuMB'],
  }),
};
