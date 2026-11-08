// Real-GPU checks of @margoengine/ui: the renderer draws rounded rectangles, outlines, shadows, clipped lists and SDF
// text with the right colours in the right places (read back from the canvas), skips unchanged frames, and honours
// themes, resolution scaling, dialog scrims and the pixel ratio.
import { Engine } from '@margoengine/core';
import { Button, HealthBar, Inventory, Label, List, Panel, Ui, UiRenderer, themes, parseRgba } from '@margoengine/ui';

const checks = [];
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const withTimeout = (promise, ms, name) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${name} timed out after ${ms} ms`)), ms)),
  ]);
const check = async (name, run) => {
  try {
    await withTimeout(Promise.resolve().then(run), 30_000, name);
  } catch (error) {
    throw new Error(`${name}: ${error.message}`);
  }
  checks.push(name);
};

const to255 = (hex) =>
  parseRgba(hex)
    .slice(0, 3)
    .map((v) => Math.round(v * 255));
const near = (actual, expected, tolerance, message) => {
  const d = Math.max(...expected.map((v, i) => Math.abs(v - actual[i])));
  assert(d <= tolerance, `${message}: expected ${expected} within ${tolerance}, got ${actual}`);
};

async function run() {
  const canvas = document.getElementById('view');
  const engine = await Engine.create(canvas, { backend: 'webgpu' });
  engine.scene.background = '#202830';
  const gpuErrors = [];
  engine.gpu.addEventListener('uncapturederror', (event) => gpuErrors.push(event.error.message));
  const BACKGROUND = to255('#202830');
  const ui = new Ui({ theme: themes.dark, reducedMotion: true, safeArea: [0, 0, 0, 0] });
  const renderer = UiRenderer.attach(engine, ui);
  await ui.ready;

  // Frame readback: the bitmap is taken in the same task as the render, while the frame is still the canvas's image.
  async function frame() {
    // Also resets the buffer: WebKit answers every read of one buffer in a task from the first read.
    canvas.setAttribute('width', canvas.width);
    engine.render(0.016);
    const bitmap = await createImageBitmap(canvas),
      copy = new OffscreenCanvas(bitmap.width, bitmap.height),
      g = copy.getContext('2d', { willReadFrequently: true });
    g.drawImage(bitmap, 0, 0);
    const image = g.getImageData(0, 0, bitmap.width, bitmap.height);
    return {
      width: image.width,
      height: image.height,
      at: (x, y) => {
        const i = (Math.round(y) * image.width + Math.round(x)) * 4;
        return [image.data[i], image.data[i + 1], image.data[i + 2]];
      },
      count(rect, predicate) {
        let n = 0;
        for (let y = Math.max(0, Math.floor(rect.y)); y < Math.min(image.height, Math.ceil(rect.y + rect.height)); y++)
          for (
            let x = Math.max(0, Math.floor(rect.x));
            x < Math.min(image.width, Math.ceil(rect.x + rect.width));
            x++
          ) {
            const i = (y * image.width + x) * 4;
            if (predicate([image.data[i], image.data[i + 1], image.data[i + 2]])) n++;
          }
        return n;
      },
    };
  }
  const px = (widget) => {
    const r = widget.rect,
      s = ui.scale;
    return { x: r.x * s, y: r.y * s, width: r.width * s, height: r.height * s };
  };
  const luminance = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

  const card = new Panel({
    id: 'card',
    background: 'surface',
    border: true,
    shadow: true,
    anchor: 'top-left',
    margin: 24,
    width: 220,
    padding: 14,
    gap: 10,
  });
  const title = new Label({ id: 'title', text: 'Camp', size: 'large' });
  const play = new Button({ id: 'play', text: 'Play', variant: 'primary' });
  const health = new HealthBar({ id: 'health', value: 72 });
  card.add(title, play, health);
  const bag = new List({
    id: 'list',
    items: Array.from({ length: 40 }, (_, i) => `Row ${i}`),
    width: 160,
    height: 120,
    anchor: 'top-right',
    margin: 24,
  });
  ui.add(card, bag);

  await check('rectangles draw their theme colours, rounded corners and an outline', async () => {
    const f = await frame();
    assert(gpuErrors.length === 0, `GPU errors: ${gpuErrors}`);
    const c = px(card);
    near(f.at(c.x + 40, c.y + c.height - 6), to255(themes.dark.colors.surface), 4, 'card surface');
    near(f.at(c.x + c.width / 2, c.y), to255(themes.dark.colors.border), 40, 'card top outline');
    const corner = f.at(c.x, c.y);
    const distance = (p, q) => Math.max(...p.map((v, i) => Math.abs(v - q[i])));
    assert(
      distance(corner, BACKGROUND) < distance(corner, to255(themes.dark.colors.surface)),
      `the corner is rounded away, so the scene shows there: ${corner}`,
    );
    const b = px(play);
    near(f.at(b.x + 6, b.y + b.height / 2), to255(themes.dark.colors.primary), 4, 'primary button fill');
    const h = px(health);
    near(f.at(h.x + 5, h.y + 4), to255(themes.dark.colors.success), 4, 'health fill (72 percent is success)');
    near(
      f.at(h.x + h.width - 5, h.y + h.height / 2),
      to255(themes.dark.colors.surfaceSunken),
      4,
      'health track right of the fill',
    );
    const outsideCard = f.at(c.x - 8, c.y + c.height / 2);
    near(outsideCard, BACKGROUND, 8, 'far from the card the scene shows');
  });

  await check('signed distance field text draws sharp glyphs in the text colour', async () => {
    const f = await frame();
    const t = px(title),
      lit = f.count(t, (p) => luminance(p) > 170),
      soft = f.count(t, (p) => luminance(p) > 60 && luminance(p) <= 170);
    assert(lit >= 25, `title has bright pixels: ${lit}`);
    assert(soft >= 6, `title edges are antialiased: ${soft}`);
    assert(soft < lit * 3, `edges stay thin: ${soft} soft vs ${lit} lit`);
    const label = px(play);
    const dark = f.count(label, (p) => luminance(p) < 60);
    assert(dark >= 20, `button caption is dark on the primary fill: ${dark}`);
    const health = px(ui.find('health'));
    assert(f.count(health, (p) => luminance(p) > 200) >= 10, 'health numbers draw over the bar');
  });

  await check('a list clips its rows to its box and an unchanged frame uploads nothing', async () => {
    const f = await frame();
    const l = px(bag);
    const above = f.at(l.x + l.width / 2, l.y - 6);
    near(above, BACKGROUND, 3, 'above the list');
    const below = f.at(l.x + l.width / 2, l.y + l.height + 4),
      belowLeft = f.at(l.x + 10, l.y + l.height + 20);
    near(below, BACKGROUND, 3, 'just below the list is the scene, not row 12');
    near(belowLeft, BACKGROUND, 3, 'further below too');
    assert(f.count(l, (p) => luminance(p) > 170) > 20, 'rows draw inside');
    await frame();
    assert(renderer.stats.uploads === 0, `an unchanged frame uploaded ${renderer.stats.uploads} times`);
    assert(renderer.stats.drawCalls > 0, 'but it still draws');
    title.text = 'Camp 2';
    await frame();
    assert(renderer.stats.uploads === 1, `a changed frame uploads once, not ${renderer.stats.uploads}`);
  });

  await check('the health bar and its text follow value changes', async () => {
    health.value = 20;
    ui.update(1);
    let f = await frame();
    const h = px(health);
    near(f.at(h.x + 5, h.y + 4), to255(themes.dark.colors.danger), 4, 'low health is danger');
    near(f.at(h.x + h.width - 5, h.y + h.height / 2), to255(themes.dark.colors.surfaceSunken), 4, 'track');
    health.value = 72;
    ui.update(1);
    f = await frame();
  });

  await check('a dialog dims the screen and draws above everything', async () => {
    const before = await frame();
    const answer = ui.dialog({
      title: 'Quit?',
      message: 'Progress is saved.',
      buttons: [
        { label: 'Quit', value: 1 },
        { label: 'Stay', value: 0 },
      ],
    });
    const after = await frame();
    const far = [440, 340];
    assert(
      luminance(after.at(...far)) < luminance(before.at(...far)) - 8,
      `scrim darkens the scene: ${before.at(...far)} -> ${after.at(...far)}`,
    );
    const dialog = ui.modalLayer.children[0],
      d = px(dialog);
    near(
      after.at(d.x + d.width / 2, d.y + 6),
      to255(themes.dark.colors.surface),
      6,
      'the dialog is opaque above the scrim',
    );
    ui.modalLayer.children[0].close(1);
    await answer;
    const gone = await frame();
    near(gone.at(...far), BACKGROUND, 6, 'closing the dialog removes the scrim');
  });

  await check('resolution scaling and the pixel ratio resize everything', async () => {
    const before = px(play);
    ui.setScale({ reference: [240, 180], match: 0.5 });
    await frame();
    const after = px(play);
    assert(
      Math.abs(after.width - before.width * 2) < 2,
      `button is twice as wide in pixels: ${before.width} -> ${after.width}`,
    );
    ui.setScale(1);
    await frame();
    assert(Math.abs(px(play).width - before.width) < 1, 'back to normal');
  });

  await check('switching to the high contrast theme redraws black, white and yellow', async () => {
    ui.theme = themes.highContrast;
    const f = await frame();
    const c = px(card),
      b = px(play);
    near(f.at(c.x + 40, c.y + c.height - 6), [0, 0, 0], 4, 'black card');
    near(f.at(b.x + 6, b.y + b.height / 2), to255('#ffff00'), 4, 'yellow primary');
    ui.theme = themes.light;
    const light = await frame();
    near(light.at(c.x + 40, c.y + c.height - 6), to255(themes.light.colors.surface), 4, 'light card');
    ui.theme = themes.dark;
  });

  await check('text scaling grows the text and the layout', async () => {
    const before = px(play).height;
    ui.textScale = 2;
    await frame();
    assert(px(play).height > before + 5, `taller button ${before} -> ${px(play).height}`);
    ui.textScale = 1;
    await frame();
  });


  await check('Arabic and Devanagari words draw as shaped runs and right-to-left labels start at the right edge', async () => {
    // U+200C (zero width non-joiner) between the letters forces each one into its isolated form.
    const word = 'مرحبا',
      split = [...word].join('‌');
    const joined = new Label({ text: word, size: 'large', wrap: false }),
      apart = new Label({ text: split, size: 'large', wrap: false }),
      boxed = new Label({ text: word, size: 'large', width: 220 }),
      hindi = new Label({ text: 'नमस्ते', size: 'large', wrap: false });
    const panel = new Panel({ anchor: 'bottom-left', margin: 24, gap: 8, padding: 8, align: 'start' });
    panel.add(joined, apart, boxed, hindi);
    ui.add(panel);
    const f = await frame();
    const ink = (widget) => {
      const r = px(widget);
      let lo = Infinity,
        hi = -Infinity;
      for (let x = Math.floor(r.x); x < Math.ceil(r.x + r.width); x++)
        if (f.count({ x, y: r.y, width: 1, height: r.height }, (p) => luminance(p) > 120)) {
          lo = Math.min(lo, x);
          hi = Math.max(hi, x + 1);
        }
      return { lo, hi, width: hi - lo, box: r };
    };
    const a = ink(joined),
      b = ink(apart),
      c = ink(boxed),
      d = ink(hindi);
    // The browser's shaper joins the letters only when the word reaches it as one run; isolated forms are wider.
    assert(a.width > 10 && a.width < b.width, `the joined word (${a.width} px) is narrower than its isolated letters (${b.width} px)`);
    const letters = [...word].reduce((sum, letter) => {
      const l = ui.textLayout(letter, 'large');
      return sum + l.bounds.right - l.bounds.left;
    }, 0);
    const run = ui.textLayout(word, 'large');
    assert(run.bounds.right - run.bounds.left < letters, 'the run is measured shaped, not letter by letter');
    // In a 220-unit box, start is the right edge for Arabic: ink ends near the box's right and starts past its middle.
    assert(Math.abs(c.hi - (c.box.x + c.box.width)) <= 4 * ui.scale, `right-aligned ink ends at ${c.hi}, box at ${c.box.x + c.box.width}`);
    assert(c.lo > c.box.x + c.box.width / 2, 'the Arabic label does not start at the left edge');
    assert(d.width > 10, `the Devanagari word draws (${d.width} px of ink)`);
    assert(gpuErrors.length === 0, `GPU errors: ${gpuErrors}`);
    ui.remove(panel);
    await frame();
  });

  await check('an inventory draws slots, icons and counts without GPU errors', async () => {
    const grid = new Inventory({
      columns: 4,
      slots: 8,
      anchor: 'bottom-right',
      margin: 24,
      items: [
        { id: 'a', name: 'Potion', icon: 'P', count: 12, color: 'accent' },
        null,
        { id: 'b', name: 'Sword', icon: '⚔' },
      ],
    });
    ui.add(grid);
    const f = await frame();
    const g = px(grid.slot(0));
    near(f.at(g.x, g.y + g.height / 2), to255(themes.dark.colors.border), 20, 'slot outline');
    assert(f.count(g, (p) => luminance(p) > 170) > 8, 'icon draws in the slot');
    ui.remove(grid);
    await frame();
  });

  assert(gpuErrors.length === 0, `GPU validation errors: ${gpuErrors.join('; ')}`);
  context = { engine, ui, renderer, frame, px, gpuErrors };
  return { checks };
}

// Real mouse and keyboard events: the test driver (ui-browser.mjs) presses on the page between these calls.
let context;
const counts = { gameDown: 0, clicks: 0 };
window.setupInputTest = () => {
  const { ui, engine } = context;
  ui.root.clear();
  const go = new Button({ id: 'go', text: 'Go', variant: 'primary', anchor: 'top-left', margin: 40, width: 120 });
  go.on('click', () => counts.clicks++);
  ui.add(go);
  engine.canvas.addEventListener('pointerdown', () => counts.gameDown++);
  ui.layout();
  const r = go.rect;
  return { x: r.x, y: r.y, width: r.width, height: r.height };
};
window.readInputState = async () => {
  const { ui, frame } = context;
  const f = await frame();
  const go = ui.find('go'),
    r = go.rect;
  // The focus ring is drawn just outside the button: sample the middle of its top edge, 2 units above.
  const ring = f.at(r.x + r.width / 2, r.y - 2);
  return {
    ...counts,
    focused: ui.focused?.id ?? null,
    focusVisible: go.focusVisible,
    mode: ui.inputMode,
    ring,
    active: document.activeElement?.id ?? '',
  };
};
window.finishInputTest = () => {
  const { ui, engine, gpuErrors } = context;
  assert(gpuErrors.length === 0, `GPU validation errors: ${gpuErrors.join('; ')}`);
  ui.dispose();
  engine.dispose();
  return { ...counts };
};

window.runUiTests = run;
