import { TextRenderer, Text, Font } from '../../packages/text/dist/index.js';
import { controls } from './ui-scene.js';

export function createWorkload(count = 16, options = {}) {
  if (!Number.isInteger(count) || count < 4 || count > 64) throw new RangeError('Text block count must be 4..64');
  options.signal?.throwIfAborted();
  const font = new Font({ family: 'monospace', weight: 600 }),
    points = new Float32Array(count * 4),
    side = Math.ceil(Math.sqrt(count)),
    extent = side * 0.95,
    texts = [];
  let renderer,
    ui,
    context,
    mounting = false,
    disposed = false,
    time = 0,
    frames = 0,
    updates = 0,
    displayedSecond = -1,
    outlined = true,
    setupElapsedMilliseconds = 0;
  const step = (delta) => {
    if (disposed) return;
    if (!Number.isFinite(delta) || delta < 0 || delta > 0.1) throw new RangeError('Invalid text frame delta');
    time += delta;
    frames++;
    for (let i = 0; i < count; i++) {
      points[i * 4] = ((i % side) - (side - 1) / 2) * 1.9;
      points[i * 4 + 1] = 0.2;
      points[i * 4 + 2] = (Math.floor(i / side) - (side - 1) / 2) * 1.9;
      points[i * 4 + 3] = i % 3;
    }
    const second = Math.floor(time);
    if (displayedSecond !== second) {
      displayedSecond = second;
      texts.forEach((text, i) => {
        text.text = `Actor ${String(i + 1).padStart(2, '0')}\nTime ${String(second % 100).padStart(2, '0')}`;
        updates++;
      });
    }
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    options.signal?.removeEventListener('abort', dispose);
    texts.forEach((text) => text.dispose());
    if (renderer) context?.engine.removePlugin(renderer.name);
    ui?.dispose();
    context = undefined;
  };
  options.signal?.addEventListener('abort', dispose, { once: true });
  step(0);
  return {
    points,
    renderedObjects: count * 2,
    expectedEngineVisible: count,
    font,
    get texts() {
      return texts;
    },
    bounds: { min: [-extent, 0, -extent], max: [extent, 1.5, extent] },
    description:
      'Actual TextRenderer rasterizes a local monospace font into its SDF atlas, lays out two-line billboard labels, and draws fill, outline and soft shadow glyph layers. The small cubes are real depth anchors; every simulation second updates fixed-length strings and reuses glyphs. Font/setup elapsed time, layout/glyph counts and steady-frame rendering are separate.',
    step,
    async mount(value) {
      if (disposed) throw new Error('Text workload is disposed');
      if (context || mounting) throw new Error('Text workload is already mounted');
      if (value.engine.backend !== 'webgpu') throw new Error('Text benchmark requires actual WebGPU glyph draws');
      const start = performance.now();
      mounting = true;
      try {
        await font.load('Actor 0123456789 Time');
        options.signal?.throwIfAborted();
        if (disposed) throw new DOMException('Text workload disposed', 'AbortError');
        context = value;
        renderer = new TextRenderer();
        value.engine.use(renderer);
        for (let i = 0; i < count; i++)
          texts.push(
            renderer.add(
              new Text({
                text: `Actor ${String(i + 1).padStart(2, '0')}\nTime ${String(Math.floor(time) % 100).padStart(2, '0')}`,
                font,
                mesh: value.meshes[i],
                billboard: true,
                position: [0, 0.7, 0],
                fontSize: 0.22,
                maxWidth: 1.5,
                textAlign: 'center',
                anchorX: 'center',
                anchorY: 'middle',
                color: ['#82d9ba', '#e6bb79', '#a8a3e6'][i % 3],
                outlineWidth: 0.008,
                shadowOpacity: 0.35,
                shadowBlur: 0.01,
                shadowOffset: [0.012, -0.012],
              }),
            ),
          );
        ui = controls(value.parent, count, () => {});
        ui.actor.parentElement.remove();
        ui.button('Toggle outlines + shadows', () => {
          outlined = !outlined;
          texts.forEach((text) => {
            text.outlineWidth = outlined ? 0.008 : 0;
            text.shadowOpacity = outlined ? 0.35 : 0;
          });
          value.render();
        }).dataset.uiTextOutline = '';
        setupElapsedMilliseconds = performance.now() - start;
      } catch (error) {
        dispose();
        throw error;
      } finally {
        mounting = false;
      }
    },
    details: () => ({
      textBlocks: texts.length,
      frames,
      textUpdates: updates,
      glyphsDrawn: renderer?.stats.glyphs ?? 0,
      textDrawCalls: renderer?.stats.drawCalls ?? 0,
      atlasGlyphs: renderer?.atlas.glyphs ?? 0,
      atlasPages: renderer?.atlas.sdfPages ?? 0,
      outlined,
      setupElapsedMilliseconds,
    }),
    dispose,
  };
}
