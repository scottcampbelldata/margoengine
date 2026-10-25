// The three.js parity matrix (docs/whitepaper/perf-vs-threejs.md): every scene that a row of docs/threejs-parity.md
// names (bench/scenes/parity.js), in every engine given with --engines, interleaved per scene. Opt-in: run it with
// `npm run bench:parity` (this suite for margo and the three.js adapters, then bench/parity-report.mjs).
import { sceneCases } from '../lib/browser.mjs';
import { SCENES } from '../scenes/catalog.js';
import { parityCases } from '../scenes/parity.js';

const FRAME = [
    'cpuMs',
    'gpuMs',
    'fps',
    'serialFrameMs',
    'loadMs',
    'firstFrameMs',
    'buildMs',
    'jsHeapMB',
    'gpuMB',
    'jsBytes',
    'drawCalls',
  ],
  TASK = ['taskMs', 'coldMs', 'buildMs', 'loadMs', 'jsHeapMB', 'jsBytes'];

export default {
  name: 'parity',
  title: 'three.js parity rows: the same job in every engine',
  uses: 'gpu',
  cases: sceneCases('parity', {
    primary: [],
    list: parityCases(SCENES).map((c) => ({ ...c, keep: SCENES[c.scene].kind === 'task' ? TASK : FRAME })),
  }),
};
