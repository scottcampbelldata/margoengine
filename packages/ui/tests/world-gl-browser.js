// Real-GPU checks of @margoengine/ui/world: a UI drawn on a panel in the 3D scene shows its colours where the camera
// sees the panel, is hidden by a mesh in front of it (depth tested), is invisible from behind unless double-sided,
// redraws its texture only when the UI changed, and takes a real mouse click through the canvas by camera ray.
import { Engine, box, PbrMaterial } from '@margoengine/core';
import { Button, Panel, Ui, parseRgba, themes } from '@margoengine/ui';
import { WorldPanel, WorldPanels } from '@margoengine/ui/world-gl';
import { webglRenderer } from '@margoengine/webgl2-compat/preview';

const checks = [];
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const to255 = (hex) =>
  parseRgba(hex)
    .slice(0, 3)
    .map((v) => Math.round(v * 255));
const near = (actual, expected, tolerance, message) => {
  const d = Math.max(...expected.map((v, i) => Math.abs(v - actual[i])));
  assert(d <= tolerance, `${message}: expected ${expected} within ${tolerance}, got ${actual}`);
};
let state;

async function run() {
  const canvas = document.getElementById('view');
  const engine = await Engine.create(canvas, {
    backend: new URLSearchParams(location.search).get('backend') ?? 'webgl2',
    fallback: webglRenderer,
    camera: { fov: 60, position: [0, 0, 3], target: [0, 0, 0] },
  });
  engine.scene.background = '#202830';
  const BACKGROUND = to255('#202830');
  const gpuErrors = [];
  engine.gpu?.addEventListener('uncapturederror', (event) => gpuErrors.push(event.error.message));
  const ui = new Ui({ width: 400, height: 200, theme: themes.dark, reducedMotion: true, safeArea: [0, 0, 0, 0] });
  let clicks = 0;
  const go = new Button({
    id: 'go',
    text: 'Earth',
    variant: 'primary',
    width: 200,
    height: 100,
    anchor: 'center',
    onClick: () => clicks++,
  });
  ui.add(new Panel({ background: 'surface', anchor: 'stretch', bleed: true }), go);
  await ui.ready;
  // NASA planetary names: https://nssdc.gsfc.nasa.gov/planetary/factsheet/ (public domain).
  const panel = new WorldPanel(ui, { width: 2, pixelRatio: 2 });
  const panels = WorldPanels.attach(engine).add(panel);

  let stateRestores = 0;
  if (engine.backend === 'webgl2') {
    const gl = canvas.getContext('webgl2'),
      sampler = gl.createSampler(),
      unpack = gl.createBuffer();
    let expected;
    const snapshot = () => {
      const active = gl.getParameter(gl.ACTIVE_TEXTURE);
      gl.activeTexture(gl.TEXTURE0);
      const sampler0 = gl.getParameter(gl.SAMPLER_BINDING);
      gl.activeTexture(active);
      return {
        sampler0,
        unpack: gl.getParameter(gl.PIXEL_UNPACK_BUFFER_BINDING),
        viewport: [...gl.getParameter(gl.VIEWPORT)],
        scissor: [...gl.getParameter(gl.SCISSOR_BOX)],
        mask: [...gl.getParameter(gl.COLOR_WRITEMASK)],
        row: gl.getParameter(gl.UNPACK_ROW_LENGTH),
        alignment: gl.getParameter(gl.UNPACK_ALIGNMENT),
        active,
      };
    };
    engine.use({
      name: 'world-gl-state-probe',
      setup() {},
      registerPasses(graph) {
        graph.add({
          name: 'world-gl:foreign-state',
          order: 24,
          execute() {
            gl.viewport(3, 5, 191, 123);
            gl.scissor(7, 11, 29, 37);
            gl.colorMask(true, false, true, false);
            gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 17);
            gl.pixelStorei(gl.UNPACK_ALIGNMENT, 8);
            gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, unpack);
            gl.bindSampler(0, sampler);
            gl.activeTexture(gl.TEXTURE3);
            expected = snapshot();
          },
        });
        graph.add({
          name: 'world-gl:restore-proof',
          order: 26,
          execute() {
            const actual = snapshot();
            assert(actual.sampler0 === expected.sampler0, 'sampler binding restored');
            assert(actual.unpack === expected.unpack, 'pixel unpack buffer restored');
            for (const key of ['viewport', 'scissor', 'mask', 'row', 'alignment', 'active'])
              assert(JSON.stringify(actual[key]) === JSON.stringify(expected[key]), key + ' restored');
            stateRestores++;
            gl.bindSampler(0, null);
            gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
            gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
            gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
            gl.activeTexture(gl.TEXTURE0);
            gl.colorMask(true, true, true, true);
            gl.viewport(0, 0, canvas.width, canvas.height);
          },
        });
      },
      dispose() {
        gl.deleteSampler(sampler);
        gl.deleteBuffer(unpack);
      },
    });
  }

  async function frame() {
    canvas.setAttribute('width', canvas.width);
    engine.render(0.016);
    const gl = engine.backend === 'webgl2' ? canvas.getContext('webgl2') : null;
    if (gl) assert(gl.getError() === gl.NO_ERROR, 'world drawing leaves no GL error');
    const bitmap = await createImageBitmap(canvas),
      copy = new OffscreenCanvas(bitmap.width, bitmap.height),
      g = copy.getContext('2d', { willReadFrequently: true });
    g.drawImage(bitmap, 0, 0);
    const image = g.getImageData(0, 0, bitmap.width, bitmap.height);
    return (x, y) => {
      const i = (Math.round(y) * image.width + Math.round(x)) * 4;
      return [image.data[i], image.data[i + 1], image.data[i + 2]];
    };
  }
  const check = async (name, body) => {
    try {
      await body();
    } catch (error) {
      throw new Error(`${name}: ${error.message}`);
    }
    checks.push(name);
  };
  const primary = to255(themes.dark.colors.primary),
    surface = to255(themes.dark.colors.surface);

  await check(
    'the panel shows its UI in the scene: the button at the centre, the surface round it, the scene outside',
    async () => {
      await frame();
      const at = await frame();
      assert(gpuErrors.length === 0, `GPU errors: ${gpuErrors}`);
      // The 2 by 1 panel at 3 metres under a 60 degree view (4:3) spans about 113 to 287 of the 400 pixels across.
      near(at(200, 170), primary, 10, 'button colour below the label at the centre');
      near(at(110, 150), surface, 10, 'panel surface left of the button');
      near(at(20, 150), BACKGROUND, 4, 'scene left of the panel');
      near(at(200, 20), BACKGROUND, 4, 'scene above the panel');
    },
  );

  await check('an unchanged UI does not redraw its texture; a change redraws it once', async () => {
    await frame();
    assert(panels.stats.repaints === 0, `repaints on an unchanged frame: ${panels.stats.repaints}`);
    assert(
      panels.stats.panels === 1 && panels.stats.drawCalls === 1,
      `one panel, one draw: ${JSON.stringify(panels.stats)}`,
    );
    go.variant = 'danger';
    await frame();
    assert(panels.stats.repaints === 1, `repaints after a change: ${panels.stats.repaints}`);
    go.variant = 'primary';
    await frame();
  });

  await check('a mesh in front of the panel hides it: the panel is depth tested against the scene', async () => {
    const blocker = engine
      .createMesh()
      .setGeometry(box(0.5, 0.5, 0.5))
      .setMaterial(new PbrMaterial({ color: '#e6331a', roughness: 0.6 }));
    blocker.setPosition([0, 0, 1]);
    const p = (await frame())(200, 170);
    assert(
      Math.abs(p[0] - primary[0]) + Math.abs(p[1] - primary[1]) + Math.abs(p[2] - primary[2]) > 90,
      `the box covers the button: ${p} against ${primary}`,
    );
    assert(p[0] > p[2], `the box is red: ${p}`);
    blocker.dispose();
    near((await frame())(200, 170), primary, 10, 'the button is back');
  });

  await check('from behind a one-sided panel is invisible; a double-sided one shows its UI', async () => {
    engine.camera.position = [0, 0, -3];
    let at = await frame();
    near(at(200, 170), BACKGROUND, 4, 'one-sided from behind');
    panel.doubleSided = true;
    at = await frame();
    near(at(200, 170), primary, 10, 'double-sided from behind');
    panel.doubleSided = false;
    engine.camera.position = [0, 0, 3];
    await frame();
  });

  await check('removing the panel releases its drawing resources and adding it redraws', async () => {
    panels.remove(panel);
    near((await frame())(200, 170), BACKGROUND, 4, 'removed panel');
    panels.add(panel);
    near((await frame())(200, 170), primary, 10, 're-added panel');
    assert(panels.stats.repaints === 1, 're-added panel repaints once');
  });
  if (engine.backend === 'webgl2') {
    assert(stateRestores > 0, 'GL state probe ran');
    checks.push('foreign GL sampler, unpack buffer, viewport, scissor and mask restored');
  }
  assert(gpuErrors.length === 0, `GPU validation errors: ${gpuErrors.join('; ')}`);
  state = { engine, ui, panels, gpuErrors, clicks: () => clicks, frame };
  return { checks };
}

window.runWorldTests = run;
window.readWorld = async () => {
  await state.frame();
  return { clicks: state.clicks(), errors: state.gpuErrors.length };
};
window.finishWorld = () => {
  state.panels.dispose();
  state.ui.dispose();
  state.engine.dispose();
};
