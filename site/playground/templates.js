// Starter scenes for the playground, from the stage README examples (packages/stage/README.md). Each one renders into
// the frame's `#scene` container and falls back to WebGL2 where the browser has no WebGPU, except where it says so.
// tests/playground.test.js checks that every import here is in margoengine's import map.

const fallback = `import {webglRenderer} from 'margoengine/webgl2-compat/preview';`;

export const templates = [
  {
    id: 'hello-cube',
    title: 'Hello cube',
    code: `// Hello cube: a stage, a box and a frame callback.
import {createStage} from 'margoengine';
${fallback}

const app = await createStage('#scene', {background: '#202024', fallback: webglRenderer});
const cube = app.box({size: [1, 1, 1], color: '#e5b454', roughness: 0.35});
app.onTick((delta) => {
  cube.rotation.x += delta * 0.6;
  cube.rotation.y += delta;
});
console.log('Rendering with', app.engine.backend);
`,
  },
  {
    id: 'gltf',
    title: 'Load a glTF model',
    code: `// Load a glTF model: addGLTF fits the camera to it. The URL must allow cross-origin reads (CORS).
import {createStage} from 'margoengine';
import {addGLTF} from 'margoengine/stage/gltf';
${fallback}

const app = await createStage('#scene', {background: '#1b2333', fallback: webglRenderer});
const url = 'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/Box/glTF-Binary/Box.glb';
const model = await addGLTF(app, url, {signal: app.signal});
console.log('Loaded', model.meshes.length, 'mesh(es) from', url);
`,
  },
  {
    id: 'shadows',
    title: 'Lights and shadows',
    code: `// Lights and shadows: cascaded shadows from the sun and a warm point light (WebGPU).
import {createStage} from 'margoengine';
import {addShadows} from 'margoengine/stage/shadows';
import {addLights} from 'margoengine/stage/lights';

const app = await createStage('#scene', {background: '#c9d6e8'});
const floor = app.box({size: [10, 0.1, 10], position: [0, -0.05, 0], color: '#d8d2c4'});
const crates = [-1.5, 0, 1.5].map((x, i) =>
  app.box({size: [0.8, 0.8 + i * 0.4, 0.8], position: [x, 0.4 + i * 0.2, 0], color: '#c0792b'}));
const shadows = await addShadows(app, {resolution: 2048});
shadows.add(floor);
await addLights(app, [{type: 'point', position: [0, 2.5, 2], range: 8, color: [1, 0.65, 0.35], intensity: 6}]);
app.fit([floor, ...crates]);
`,
  },
  {
    id: 'particles',
    title: 'Particles',
    code: `// Particles: a GPU particle field drifting in curl noise (WebGPU).
import {createStage} from 'margoengine';
import {addParticles} from 'margoengine/stage/particles';

const app = await createStage('#scene', {background: '#0b1020'});
app.sphere({radius: 0.6, color: '#84d6bd', roughness: 0.25});
const sparks = await addParticles(app, {count: 4000, curl: 2, gravity: [0, -0.2, 0]});
console.log('Particles attached:', sparks.name);
`,
  },
  {
    id: 'error',
    title: 'Errors and the console',
    code: `// Errors and the console: output appears below the canvas, and errors show their line.
import {createStage} from 'margoengine';
${fallback}

const app = await createStage('#scene', {fallback: webglRenderer});
console.log('Scene ready on', app.engine.backend);
const ball = app.sphere({radius: 0.5});
ball.dispose();
ball.setPosition([0, 1, 0]); // A disposed mesh throws MargoError 'disposed': its code links to the error help.
`,
  },
];
