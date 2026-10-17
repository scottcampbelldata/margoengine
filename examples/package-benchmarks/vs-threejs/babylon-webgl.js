// Babylon.js WebGL2 Engine entry (antialias: true = the default framebuffer's MSAA, as three's WebGLRenderer).
import { Engine } from '@babylonjs/core/Engines/engine.js';
import { run } from './harness.js';
import { babylonScene } from './babylon-scenes.js';

run(async (canvas, params, marks) => {
  const s = performance.now(),
    engine = new Engine(canvas, !params.diag.includes('msaa1'), { powerPreference: 'high-performance' });
  marks.createMs = +(performance.now() - s).toFixed(1);
  // The context Babylon created (getContext returns the existing one). Idle = a 1-pixel readPixels, as three's page.
  const gl = canvas.getContext('webgl2'),
    pixel = new Uint8Array(4),
    idle = async () => {
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    };
  const scene = await babylonScene(canvas, params, marks, engine, idle);
  return { ...scene, gl, samples: gl.getParameter(gl.SAMPLES), idle };
});
