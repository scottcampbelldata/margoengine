// Babylon.js, in words: new DefaultRenderingPipeline("default", true, scene, [camera]) with bloomEnabled,
// fxaaEnabled, imageProcessing.toneMappingEnabled and exposure; SSAO2RenderingPipeline for ambient occlusion; a
// GlowLayer for emissive glow; custom effects through PostProcess and a fragment shader.
//
// Margo: `PostStack` runs a list of effects in array order on one linear HDR capture of the frame: HDR effects first
// (SSAO, bloom), then one tone map, then LDR effects (FXAA). The engine renders the stack; there is no composer to call.
import { createStage } from 'margoengine';
import { PbrMaterial, createMesh } from 'margoengine/materials';
import { sphereGeometry } from 'margoengine/geometry';
import { Bloom } from 'margoengine/post/bloom';
import { FXAA } from 'margoengine/post/fxaa';
import { PostStack } from 'margoengine/post/stack';
import { SSAO } from 'margoengine/post/ssao';
import { Tonemap } from 'margoengine/tonemap';
import { fail, status } from './common';

const stage = await createStage('#scene', { camera: { position: [0, 2, 6], target: [0, 0.6, 0] } }).catch(fail);
const engine = stage.engine;
stage.box({ size: [10, 0.1, 10], position: [0, -0.05, 0], color: '#d4d4cc' });
stage.box({ position: [-1.2, 0.5, 0], color: '#d9824c' });
// A glowing sphere: PbrMaterial emissive above 1 is what Bloom picks up (Babylon: emissiveColor plus a GlowLayer).
const lamp = createMesh(engine, sphereGeometry(0.4, 48, 24), new PbrMaterial({ color: '#202020', emissive: '#ffb347', emissiveIntensity: 6 }));
lamp.root.setPosition([1.2, 0.4, 0]);

const bloom = new Bloom({ strength: 0.8 });
PostStack.attach(engine, [
  new SSAO({ radius: 0.5 }), // SSAO2RenderingPipeline
  bloom, // bloomEnabled, bloomWeight
  new Tonemap({ curve: 'agx', exposure: 0 }), // imageProcessing.toneMappingEnabled, exposure (in stops here)
  new FXAA(), // fxaaEnabled
]);

const toggle = document.createElement('button');
toggle.textContent = 'Bloom on';
toggle.style.cssText = 'position:fixed;bottom:8px;left:8px';
toggle.onclick = () => {
  // Effect options are read every frame, so changing one needs no rebuild (Babylon: pipeline.bloomEnabled = ...).
  const on = bloom.options.strength === 0;
  bloom.options.strength = on ? 0.8 : 0;
  toggle.textContent = on ? 'Bloom on' : 'Bloom off';
};
document.body.append(toggle);
status.textContent = 'SSAO, bloom, tone mapping and FXAA in one stack.';
window.addEventListener('pagehide', () => stage.dispose(), { once: true });
