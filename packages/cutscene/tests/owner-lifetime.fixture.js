// Owner/lifetime fixture for @margoengine/cutscene. The package's objects are not engine plugins: a player, a range or
// scroll binding and the editor panels hang off an app and are released with it. What each holds is listeners (on the
// app's AbortSignal, on a scroll source and its window, on panel elements and the page's window), animation frames and
// mounted DOM; after disposal every one must be gone and the app's own signal must outlive the object. The seek entry
// steps a real clock registration and holds nothing once it resolves. The editors need the page's window and document, so
// they run in the browser leaves only (Node has no page; jsdom's event targets are not the ones the observer patches).
// ViewportKeying is not here: it attaches an inspector gizmo, and the inspector fixture covers that gizmo's lifetime.
import { lifetimeFault, ownedByEngine } from '../../../tests/support/owner-shell.js';

const document_ = () => ({
  format: 'margo-cutscene',
  version: 1,
  duration: 10,
  tracks: [
    { type: 'event', id: 'events', events: [{ time: 2.5, name: 'a' }, { time: 3.5, name: 'b' }] },
    { type: 'property', id: 'opacity', target: 'screen', property: 'opacity', keys: [{ time: 0, value: 0 }, { time: 8, value: 1 }] },
  ],
});

// What a scroll binding hangs on: in a browser, a real scrolling element and the page's window; in Node, stand-ins with
// the same shape (an EventTarget that scrolls, a window that runs animation frames).
function scroller() {
  if (globalThis.document?.body) {
    const element = document.createElement('div');
    element.style.cssText = 'position:fixed;left:0;top:0;width:40px;height:40px;overflow:auto';
    element.innerHTML = '<div style="height:400px"></div>';
    document.body.append(element);
    return { source: element, done: () => element.remove() };
  }
  const frames = new Set();
  const view = Object.assign(new EventTarget(), {
    requestAnimationFrame: (fn) => { frames.add(fn); return frames.size; },
    cancelAnimationFrame: () => frames.clear(),
  });
  const source = Object.assign(new EventTarget(), { scrollTop: 0, scrollLeft: 0, scrollHeight: 400, scrollWidth: 40,
    clientHeight: 40, clientWidth: 40, ownerDocument: { defaultView: view } });
  return { source, frames, done() {} };
}

export async function fixtures(load = (entry) => import(entry)) {
  const { CutscenePlayer } = await load('../dist/index.js');
  const { RangePlayback, ScrollPlayback } = await load('../dist/scroll.js');
  const { seek } = await load('../dist/seek.js');
  const entries = [
    {
      // A play() and an events() stream both wait on the app's signal: disposal settles both and lets the signal go.
      name: 'CutscenePlayer',
      create({ scene }) {
        const controller = new AbortController(), player = new CutscenePlayer(document_());
        const finished = player.play({ signal: controller.signal });
        const stream = player.events({ signal: controller.signal })[Symbol.asyncIterator]();
        const ended = stream.next();
        let settled = null;
        finished.then((done) => (settled = done));
        return ownedByEngine(scene, 'CutscenePlayer', () => player.dispose(), { async check({ phase }) {
          if (phase !== 'disposed') return;
          await Promise.resolve();
          if (settled !== false) lifetimeFault('a disposed player leaves its play() promise pending');
          if (!(await ended).done) lifetimeFault('a disposed player leaves its events() stream open');
        } });
      },
    },
    {
      // A range borrows the player; its play() waits on the app's signal, and the player stays usable after it goes.
      name: 'RangePlayback',
      create({ scene }) {
        const controller = new AbortController(), player = new CutscenePlayer(document_());
        const range = new RangePlayback(player, { range: [2, 4], iterationCount: Infinity });
        range.play({ signal: controller.signal }).catch(() => {});
        range.update(0.1);
        // The harness cleans up more than once; the borrowed player is checked and released the first time.
        let checked = false;
        return ownedByEngine(scene, 'RangePlayback', () => range.dispose(), { cleanup() {
          if (checked) return;
          checked = true;
          player.seek(1);
          if (player.time !== 1) lifetimeFault('a disposed range leaves its borrowed player unusable');
          player.dispose();
        } });
      },
    },
    {
      // Scroll and resize listeners, a smoothing frame and a listener on the app's signal, all gone at disposal.
      name: 'ScrollPlayback',
      create({ scene }) {
        const { source, frames, done } = scroller(), controller = new AbortController();
        const player = new CutscenePlayer(document_());
        const link = new ScrollPlayback(player, { source, scrub: 0.2, signal: controller.signal });
        source.scrollTop = 120;
        source.dispatchEvent(new Event('scroll'));
        return ownedByEngine(scene, 'ScrollPlayback', () => link.dispose(), { cleanup() {
          done();
          if (frames?.size) lifetimeFault('a disposed scroll binding leaves an animation frame queued');
          if (controller.signal.aborted) lifetimeFault('a scroll binding aborts the app signal');
          player.dispose();
        } });
      },
    },
    {
      // A seek steps the scene's clocks (a timer turn per 1,000 steps, each awaited) and keeps nothing once it resolves.
      name: 'seek',
      async create({ engine, scene }) {
        const controller = new AbortController();
        const clock = { name: 'owner-lifetime:seek-clock', time: 0, setup() {}, advanceTime(delta) { this.time += delta; } };
        scene.use(clock);
        const result = await seek(engine, 40, { scenes: [scene], signal: controller.signal });
        if (result.steps !== 2400 || !result.clocks.includes(clock.name)) lifetimeFault('a seek steps the scene clock');
        if (controller.signal.aborted) lifetimeFault('a seek aborts the app signal');
        return { plugin: clock, dispose() { if (scene.plugins.get(clock.name) === clock) scene.removePlugin(clock.name); } };
      },
    },
  ];
  if (globalThis.document?.body) {
    const { TimelineEditor } = await load('../dist/editor.js');
    const { CurveEditor } = await load('../dist/curve-editor.js');
    const { NestedTimelineEditor } = await load('../dist/nested-editor.js');
    // A panel listens on its own elements; the curve and nested panels also listen on the page's window and on the
    // timeline panel they extend, which the app made (a dependency) and which outlives them. Each panel must leave the
    // page as it found it.
    const panel = (name, make) => entries.push({ name, create({ scene, dependency }) {
      const host = document.createElement('div');
      document.body.append(host);
      const made = make(host, dependency);
      return ownedByEngine(scene, name, made.release, { cleanup() {
        if (host.querySelector(made.selector)) lifetimeFault(`a disposed ${name} leaves its panel mounted`);
        made.cleanup?.();
        host.remove();
      } });
    } });
    panel('TimelineEditor', (parent) => {
      const editor = new TimelineEditor(document_(), { parent });
      return { selector: '*', release: () => editor.dispose() };
    });
    panel('CurveEditor', (parent, dependency) => {
      const editor = dependency(() => new TimelineEditor(document_(), { parent })), graph = new CurveEditor(editor, { parent });
      return { selector: '.margo-curve-editor', release: () => graph.dispose(), cleanup: () => editor.dispose() };
    });
    panel('NestedTimelineEditor', (parent, dependency) => {
      const editor = dependency(() => new TimelineEditor(document_(), { parent })), nested = new NestedTimelineEditor(editor, { parent });
      return { selector: '.margo-nested-editor', release: () => nested.dispose(), cleanup: () => editor.dispose() };
    });
  }
  return entries;
}
