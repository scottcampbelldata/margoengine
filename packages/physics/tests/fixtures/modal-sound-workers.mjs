import { MODAL_CONTACT_WORDS, ModalSoundSolver } from '@margoengine/physics/modal-sound';
import { PhysicsWorld, regionWords, worldMemory } from '@margoengine/physics/world';

const startCell = [1_170_000_000, -1_070_000_000, 2_000_000_000];
const shift = [4_100_000, -21_500_000, 17_300_000];
export const modalCell = startCell.map((coordinate, axis) => coordinate - shift[axis]);
const sampleRate = 44100;
const frames = 120;

function countModes(track) {
  return 1 + (track % 5);
}

function material(track) {
  return {
    modes: Array.from({ length: countModes(track) }, (_, mode) => ({
      frequency: 370 + track * 110 + mode * 597,
      decay: 7 + mode * 6 + track,
      gain: (mode % 2 ? -0.13 : 0.2) / (1 + mode / 4),
      scrape: 0.45 + mode / 5,
      roll: 0.34 + mode / 7,
      fracture: 1.2,
    })),
    scrapeRoughness: 0.4 + track / 70,
    rollRoughness: 0.32,
    scrapeSpacing: 0.0037,
    rollSpacing: 0.017,
  };
}

export function expectedModalWork(count, samples, threads) {
  const workers = Array.from({ length: threads }, (_, part) => {
    const start = Math.floor((part * count) / threads);
    const end = Math.floor(((part + 1) * count) / threads);
    let modes = 0;
    for (let track = start; track < end; track++) modes += countModes(track);
    const tracks = end - start;
    const pcmSamples = tracks * samples;
    return { tracks, pcmSamples, modeUpdates: modes * samples, textureUpdates: 8 * pcmSamples };
  });
  const pcmSamples = count * samples;
  return {
    threads,
    tracks: count,
    pcmSamples,
    modeUpdates: workers.reduce((sum, worker) => sum + worker.modeUpdates, 0),
    textureUpdates: 8 * pcmSamples,
    workers,
  };
}

class ContactAudioLoads {
  constructor(sound, count) {
    this.fields = [sound.contactField, sound.fractureField];
    this.count = count;
  }

  describe() {
    return {
      id: 'prescribed-contact-audio-loads',
      rate: 1,
      stableRate: () => 1,
      fields: this.fields.map((field) => ({ field, access: 'write' })),
    };
  }

  init(host) {
    this.host = host;
    this.contact = host.allocate('modal-contact-rows', this.count * MODAL_CONTACT_WORDS * 8, 'f64', 1);
    this.fracture = host.allocate('modal-fracture-rows', this.count * 8, 'f64', 1);
  }

  step({ tick }) {
    const loads = regionWords(this.host.memory, this.contact);
    const fractures = regionWords(this.host.memory, this.fracture);
    for (let track = 0; track < this.count; track++) {
      const offset = track * MODAL_CONTACT_WORDS;
      loads[offset] = tick === 0 || tick === 5 ? 0.1 + track * 0.014 : 0;
      loads[offset + 1] = 14 + track * 3 + tick / 9;
      loads[offset + 2] = 0.42 + track / 8;
      loads[offset + 3] = 3 + (track % 3);
      loads[offset + 4] = 0.8 + track / 21;
      fractures[track] = tick === 3 || tick === 8 ? 0.024 + track / 110 : 0;
    }
  }

  exportPorts(tick) {
    return [this.contact, this.fracture].map((region, i) => ({
      field: this.fields[i].name,
      tick,
      region,
      cell: this.host.cell,
    }));
  }

  importPorts() {}

  stateRegions() {
    return [this.contact, this.fracture];
  }

  extraState() {
    return [];
  }
}

export async function followModalSound(count, threads, shared = threads > 1) {
  using sound = await ModalSoundSolver.load({ threads, rate: 1, inputs: 'both' });
  const world = new PhysicsWorld({ rate: { num: frames, den: 1 }, memory: worldMemory(shared), cellSize: 4096 });
  const tracks = Array.from({ length: count }, (_, i) => ({ material: material(i) }));
  world
    .add(new ContactAudioLoads(sound, count), {}, startCell)
    .add(sound, { tracks, sampleRate, historySeconds: 0.035 }, startCell);
  world.advance(2);
  const checkpoint = world.takeSnapshot();

  function run() {
    world.shiftOrigin(shift);
    const work = [];
    for (let frame = 3; frame <= 9; frame++) {
      world.advance(frame);
      work.push({ blockSamples: sound.copyBlock().samples.length, receipt: sound.readNativeWork() });
    }
    const ports = Object.fromEntries(
      sound.exportPorts(9).map(({ field }) => {
        const port = world.fields.port(field);
        return [field, { words: regionWords(world.memory, port.region).slice(), cell: Array.from(port.cell) }];
      }),
    );
    return {
      state: {
        ports,
        snapshot: world.takeSnapshot(),
        blocks: tracks.map((_, i) => sound.copyBlock(i)),
        history: tracks.map((_, i) => sound.copySince(Math.floor((9 * sampleRate) / frames) - 1000, i)),
      },
      work,
    };
  }

  const accepted = run();
  world.restoreSnapshot(checkpoint.bytes);
  return { accepted, replay: run() };
}
