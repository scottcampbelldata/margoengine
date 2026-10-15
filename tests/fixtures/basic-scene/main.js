// The five-line stage app from the README: what a basic glTF scene costs on the network (scripts/basic-scene-network.mjs).
import {createStage} from 'margoengine';

try {
  const app = await createStage('#scene');
  const model = await app.load('./model.glb');
  window.basicScene = {meshes: model.meshes.length};
} catch (error) {
  window.basicScene = {error: String(error?.stack ?? error)};
}
