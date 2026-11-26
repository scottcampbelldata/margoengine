// A bloom, tone mapping and anti-aliasing chain over glowing spheres.
//
// In three.js you create an EffectComposer on the renderer, add a RenderPass, then UnrealBloomPass, OutputPass and a
// ShaderPass running FXAA, size the composer with the window, and call its render instead of the renderer's.
//
// In Margo PostStack takes the effects in order. It captures the scene itself, follows the canvas size, and the
// engine's ordinary frame renders it.
import { Engine } from '@margoengine/core';
import { ColorBackground } from '@margoengine/environment';
import { sphereGeometry } from '@margoengine/geometry';
import { createMesh, PbrMaterial } from '@margoengine/materials';
import { Bloom } from '@margoengine/post/bloom';
import { FXAA } from '@margoengine/post/fxaa';
import { PostStack } from '@margoengine/post/stack';
import { Tonemap } from '@margoengine/tonemap';
import type { Example } from './example.ts';

const postProcessing: Example = async (canvas, say) => {
  const engine = await Engine.create(canvas, { camera: { position: [0, 1.2, 5], target: [0, 0, 0], fov: 45 } });
  // With a post chain the scene is captured in linear light, so the backdrop comes from ColorBackground.
  ColorBackground.attach(engine, { color: '#18181b' });
  engine.lighting.direction.set([-2, 4, 3, 1.5]);

  const sphere = sphereGeometry(0.45, 48, 24);
  const colours = ['#ff5a36', '#ffd23f', '#35d0ff'];
  colours.forEach((colour, i) => {
    // emissiveIntensity above 1 is what the bloom picks up.
    const glow = new PbrMaterial({ color: '#111111', emissive: colour, emissiveIntensity: 4, roughness: 0.4 });
    createMesh(engine, sphere, glow).root.setPosition([(i - 1) * 1.5, 0, 0]);
  });

  const bloom = new Bloom({ strength: 0.8 });
  const stack = PostStack.attach(engine, [
    bloom, // HDR effects first
    new Tonemap({ curve: 'neutral' }), // then the display transform (OutputPass)
    new FXAA(), // low dynamic range effects last
  ]);
  const removeBloom = () => stack.removeEffect(bloom);
  say('Bloom, tone mapping and FXAA in one PostStack.');
  engine.start();
  return { engine, stack, removeBloom };
};

export default postProcessing;
