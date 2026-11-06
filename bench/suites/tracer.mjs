// The voxel path tracer's ray functions: camera, panorama and fisheye frames, each on the precise functions and, as the
// like-for-like row (fast=1), on the WGSL builtins (bench/scenes/catalog.js tracer-rays). Opt in: `npm run bench -- tracer`.
import { sceneCases } from '../lib/browser.mjs';

export default {
  name: 'tracer',
  title: 'Path tracer: precise and builtin ray functions',
  uses: 'gpu',
  cases: sceneCases('tracer', { primary: ['gpuMs'], keep: ['cpuMs', 'gpuMs', 'fps'] }),
};
