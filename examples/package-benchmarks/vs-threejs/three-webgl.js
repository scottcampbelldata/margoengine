// three.js WebGLRenderer entry (antialias: true = the default framebuffer's MSAA, 4 samples on desktop Chrome/Edge).
import { WebGLRenderer } from 'three';
import { run } from './harness.js';
import { threeScene } from './three-scenes.js';

run(async (canvas, params, marks) => {
  const s = performance.now(),
    renderer = new WebGLRenderer({
      canvas,
      antialias: !params.diag.includes('msaa1'),
      powerPreference: 'high-performance',
    });
  marks.createMs = +(performance.now() - s).toFixed(1);
  return threeScene(canvas, params, marks, renderer, 'webgl');
});
