import { Geometry, PbrMaterial } from '@margoengine/core';
import { catalogue } from './samples.js';
import { buildShelf, deckY, xCentres } from './shelf.js';

const tones = { step: ['#718386', '#b99776', '#a5b0aa'], iges: ['#82a8aa', '#8eafaf', '#8eafaf'] };
const selectionTone = { step: '#ffbb70', iges: '#f3cf82' };
const compact = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
const count = new Intl.NumberFormat('en-US');

export async function open({ archive, initial, engine, fit, status, notice, signal, fail }) {
  const { canvas } = engine;
  engine.onError = fail;
  engine.scene.background = '#203640';
  engine.lighting.direction.set([-1.4, 2.1, 1.18, 3.35]);
  engine.lighting.radiance.set([1, .91, .80, .35]);
  engine.lighting.ambient.set([.71, .89, 1]);
  const cabinet = buildShelf(engine);

  const materials = {};
  const sides = {};
  for (const format of ['step','iges']) {
    sides[format] = {
      id: '', chosen: undefined, meshes: [], serial: 0,
      select: document.querySelector('#' + format + '-sample'),
      tree: document.querySelector('#' + format + '-tree'),
      extent: document.querySelector('#' + format + '-extent'),
      format: document.querySelector('#' + format + '-format'),
      counts: document.querySelector('#' + format + '-counts'),
    };
    materials[format] = {
      chosen: new PbrMaterial({ color: selectionTone[format], roughness: .36 }),
      swatches: tones[format].map(color => new PbrMaterial({ color, roughness: .35 })),
    };
  }
  let raf, lightingTimer, shadows, pendingTouch = false, renderFence = false;
  function camera() {
    const room = Math.max(1.66 * canvas.height / canvas.width, 1.03);
    const distance = room / Math.tan(17 * Math.PI / 180);
    engine.camera.target = [0,.36,0];
    engine.camera.position = [distance * .14,.36 + distance * .51,distance * .85];
  }
  function draw() {
    raf = undefined;
    if (signal.aborted) return;
    try {
      engine.render({ delta: 0 });
      if (pendingTouch && !renderFence) {
        pendingTouch = false;
        renderFence = true;
        engine.gpu.queue.onSubmittedWorkDone().then(() => {
          if (signal.aborted) return;
          renderFence = false;
          performance.mark('cad-shelf-control-applied');
          if (pendingTouch) schedule();
        }).catch(fail);
      }
    } catch (reason) { fail(reason); }
  }
  function schedule() {
    if (raf === undefined && !signal.aborted) raf = requestAnimationFrame(draw);
  }

  function isChildOf(rows, candidate, id) {
    for (let row = rows[candidate]; row; row = rows[row.parent]) if (row.index === id) return true;
    return false;
  }

  function lightChoice(format, sample, chosen) {
    const view = sides[format], color = materials[format];
    view.chosen = chosen;
    for (const mesh of view.meshes) {
      const selected = chosen !== undefined && isChildOf(sample.tree, mesh.occurrence, chosen);
      mesh.handle.setMaterial(selected ? color.chosen : color.swatches[mesh.body % color.swatches.length]);
    }
    for (const item of view.tree.querySelectorAll('button')) {
      item.setAttribute('aria-pressed', String(Number(item.dataset.node) === chosen));
    }
    canvas.dataset[format + 'Selection'] = chosen ?? 'all';
  }

  function treeRows(format, sample, choice) {
    const groups = new Map([[-1, sides[format].tree]]);
    sides[format].tree.replaceChildren();
    for (const item of sample.tree) {
      const leaf = document.createElement('li');
      const row = document.createElement('button');
      const children = document.createElement('ul');
      row.type = 'button';
      row.dataset.node = String(item.index);
      row.textContent = format === 'iges' ? choice.label : item.name;
      const repeats = sample.tree.filter(candidate => candidate.id === item.id && candidate.parent === item.parent);
      if (repeats.length > 1) row.textContent += ' ' + (repeats.indexOf(item) + 1);
      row.title = format === 'iges' ? 'Normalized imported product' : item.partNumber;
      row.setAttribute('aria-pressed', 'false');
      row.addEventListener('click', () => {
        const selected = sides[format].chosen === item.index ? undefined : item.index;
        lightChoice(format, sample, selected);
        pendingTouch = true;
        schedule();
      }, { signal });
      leaf.append(row);
      if (sample.tree.some(r => r.parent === item.index)) leaf.append(children);
      groups.get(item.parent)?.append(leaf);
      groups.set(item.index, children);
    }
    if (format === 'iges') {
      const rows = sample.directory.map(({ de, type, label }) => {
        const row = document.createElement('li');
        row.textContent = 'DE ' + de + ' · ' + type + ' ' + label;
        return row;
      });
      document.querySelector('#directory').replaceChildren(...rows);
    }
  }

  function show(format, id, sample) {
    if (sample.warnings.length) throw new Error(sample.warnings.join(' '));
    const view = sides[format];
    const entry = catalogue[format].find(item => item.id === id);
    for (const mesh of view.meshes) {
      mesh.removeShadow?.();
      mesh.handle.dispose();
    }
    const extents = sample.high.map((maximum, i) => maximum - sample.low[i]);
    const centreX = (sample.high[0] + sample.low[0]) * .5;
    const centreZ = (sample.high[2] + sample.low[2]) * .5;
    const zoom = Math.min(.86 / Math.max(extents[0], .00001), .76 / Math.max(extents[1], .00001),
      .64 / Math.max(extents[2], .00001));
    view.meshes = sample.meshes.map(({ xyz, normals, indices, body, occurrence }) => {
      const vertices = new Float32Array(xyz.length);
      for (let i = 0; i < xyz.length; i += 3) {
        vertices[i] = xCentres[format] + (xyz[i] - centreX) * zoom;
        vertices[i+1] = deckY + .005 + (xyz[i+1] - sample.low[1]) * zoom;
        vertices[i+2] = (xyz[i+2] - centreZ) * zoom - .026;
      }
      const handle = engine.createMesh().setGeometry(new Geometry(vertices, normals, indices));
      return { handle, body, occurrence, removeShadow: shadows?.add(handle) };
    });
    view.id = id;
    treeRows(format, sample, entry);
    lightChoice(format, sample, undefined);
    view.format.textContent = sample.schema;
    view.extent.textContent = [extents[0], extents[2], extents[1]].map(value => compact.format(value * 1000)).join(' × ') + ' mm';
    view.counts.textContent = count.format(sample.sourceCount) + ' entities · ' + count.format(sample.triangles) + (sample.triangles === 1 ? ' triangle' : ' triangles');
    canvas.dataset[format] = id;
    canvas.dataset[format + 'Triangles'] = String(sample.triangles);
    canvas.dataset[format + 'Products'] = String(sample.tree.length);
  }

  camera();
  show('step', catalogue.step[0].id, initial[0]);
  show('iges', catalogue.iges[0].id, initial[1]);
  engine.render({ delta: 0 });
  await engine.gpu.queue.onSubmittedWorkDone();
  if (signal.aborted) return;
  for (const [format, view] of Object.entries(sides)) {
    view.select.disabled = false;
    view.select.addEventListener('change', async () => {
      const id = view.select.value, serial = ++view.serial;
      try {
        const sample = await archive.get(id);
        if (serial !== view.serial || signal.aborted) return;
        show(format, id, sample);
        pendingTouch = true;
        schedule();
      } catch (reason) { fail(reason); }
    }, { signal });
  }
  const observer = new ResizeObserver(() => { if (fit()) { camera(); schedule(); } });
  observer.observe(canvas);
  signal.addEventListener('abort', () => {
    observer.disconnect();
    clearTimeout(lightingTimer);
    if (raf !== undefined) cancelAnimationFrame(raf);
  }, { once: true });
  canvas.dataset.renderer = engine.gpu.adapterInfo?.vendor === 'margo-webgl2' ? 'compatibility' : 'webgpu';
  if (status.ready()) notice.hidden = true;
  performance.mark('margo-first-usable-frame');
  lightingTimer = setTimeout(async () => {
    try {
      const { Shadows } = await import('@margoengine/shadows');
      if (signal.aborted) return;
      shadows = Shadows.attach(engine, {
        resolution: 1024, filter: 'soft', samples: 12, blockerSamples: 8, lightSize: .068,
        bounds: { min: [-1.60, -.12, -.70], max: [1.60, .97, .74] },
      });
      for (const mesh of cabinet) shadows.add(mesh);
      for (const side of Object.values(sides)) {
        for (const mesh of side.meshes) mesh.removeShadow = shadows.add(mesh.handle);
      }
      engine.render({ delta: 0 });
      await engine.gpu.queue.onSubmittedWorkDone();
      if (!signal.aborted) canvas.dataset.finish = 'shadows';
    } catch (reason) { fail(reason); }
  }, 850);
}
