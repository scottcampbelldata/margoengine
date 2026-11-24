// The panel in a real page, for editor-browser.mjs to drive with a real mouse and keyboard.
import { Cutscene } from '../src/index.ts';
import { MARKERS, TimelineEditor } from '../src/editor.ts';
import { shotTrack } from '../src/shots.ts';

const document_ = {
  format: 'margo-cutscene',
  version: 1,
  duration: 10,
  markers: [{ time: 5, name: 'reveal' }],
  tracks: [
    { type: 'transform', id: 'door', target: 'door', keys: [{ time: 1, position: [0, 0, 0] }, { time: 3, position: [2, 0, 0] }, { time: 6, position: [4, 0, 0] }] },
    { type: 'event', id: 'cues', events: [{ time: 2, name: 'bang' }] },
    { type: 'audio', id: 'music', clips: [{ start: 1, duration: 3, sound: 'theme' }] },
    {
      type: 'shot',
      id: 'edit',
      cameras: { a: { position: [0, 0, 5], target: [0, 0, 0] }, b: { position: [5, 0, 0], target: [0, 0, 0] } },
      clips: [{ start: 0, duration: 2, camera: 'a' }, { start: 2, duration: 2, camera: 'b' }],
    },
  ],
};

const log = { seek: [], select: [], change: [] };
const editor = new TimelineEditor(document_, { parent: document.querySelector('#host'), tracks: [shotTrack()], zoom: 100 });
for (const name of Object.keys(log)) editor.on(name, (value) => log[name].push(value));

window.panel = {
  log,
  times: (track) => editor.model.rows.find((row) => row.track === track).items.map((item) => item.time),
  time: () => editor.time,
  zoom: () => editor.zoom,
  selected: () => editor.selection.length,
  undoCount: () => editor.model.history.undoCount,
  focused: () => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName,
  dispose: () => {
    editor.dispose();
    return document.querySelector('.mtl') === null;
  },
  /** What a file holds, read by a real Cutscene. */
  reads: (text) => new Cutscene(text, { tracks: [shotTrack()] }).evaluate(1).camera !== null,
  markers: MARKERS,
};
window.ready = true;
