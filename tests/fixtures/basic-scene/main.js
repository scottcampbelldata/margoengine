// The five-line stage app from the README: what a basic glTF scene costs on the network (scripts/basic-scene-network.mjs).
import { createStage } from 'margoengine';
import { addGLTF } from 'margoengine/stage/gltf';

try {
  const app = await createStage('#scene');
  const model = await addGLTF(app, './model.glb');
  window.basicScene = { meshes: model.meshes.length };
} catch (error) {
  window.basicScene = { error: String(error?.stack ?? error) };
}
