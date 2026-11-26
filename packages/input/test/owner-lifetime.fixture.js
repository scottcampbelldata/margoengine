import { ownedByEngine, watchTimers } from '../../../tests/support/owner-shell.js';

const actions = { jump: [{ type: 'key', code: 'Space' }], aim: [{ type: 'control', id: 'pen', axis: 'x' }] };
const quiet = (promise) => {
  promise?.catch?.(() => {});
  return promise;
};

export async function fixtures(load = (entry) => import(entry)) {
  const { Input, Gestures } = await load('../dist/index.js');
  const { LocalPlayers } = await load('../dist/players.js');
  const { Gyro } = await load('../dist/motion.js');
  const { InputRecorder, InputReplay } = await load('../dist/replay.js');
  const { Pen } = await load('../dist/pen.js');
  const { PointerLock } = await load('../dist/lock.js');
  const { KeyboardLabels } = await load('../dist/layout.js');
  const { XRBindings } = await load('../dist/xr.js');
  const { VectorInput, wasd } = await load('../dist/vector.js');
  const { landmarkStream } = await load('../dist/landmarks.js');
  const { FaceDriver } = await load('../dist/face.js');
  const entries = [];
  const input = () => new Input(actions, { target: new EventTarget(), gamepads: () => [] });
  // `make` returns { release, cleanup? } and runs, like the release, with timers watched.
  const own = (name, make) =>
    entries.push({
      name,
      create({ scene }) {
        const timers = watchTimers(),
          made = timers.scope(() => make({ timers }));
        return ownedByEngine(scene, name, () => timers.scope(made.release), {
          async cleanup() {
            // Pending promises settle and clear their own timers a few microtasks after the disposal.
            await new Promise((resolve) => setTimeout(resolve, 5));
            made.cleanup?.();
            timers.expectNone(`a disposed ${name}`);
          },
        });
      },
    });
  own('Input', () => {
    const i = input();
    return { release: () => i.dispose() };
  });
  own('VectorInput', () => {
    const i = new VectorInput({ move: wasd() }, { target: new EventTarget(), gamepads: () => [] });
    return { release: () => i.dispose() };
  });
  own('LocalPlayers', () => {
    const players = new LocalPlayers(actions, { target: new EventTarget(), gamepads: () => [], maxPlayers: 2 });
    players.add();
    return { release: () => players.dispose() };
  });
  own('Gyro', () => {
    const gyro = new Gyro({ target: new EventTarget() }),
      host = input();
    gyro.attach(host);
    // A calibration still waiting on its timer when the sensor is disposed.
    quiet(gyro.calibrate({ duration: 60_000 }));
    return {
      release: () => {
        gyro.dispose();
        host.dispose();
      },
    };
  });
  own('InputRecorder', () => {
    const host = input(),
      recorder = new InputRecorder(host);
    host.update();
    recorder.capture();
    return { release: () => host.dispose() };
  });
  own('InputReplay', () => {
    const host = input(),
      recorder = new InputRecorder(host);
    host.update();
    recorder.capture();
    // The app's signal outlives the replay: its abort listener goes with the replay.
    const controller = new AbortController(),
      replay = new InputReplay(host, recorder.clip(), { loop: true, signal: controller.signal });
    return {
      release: () => {
        replay.stop();
        host.dispose();
      },
    };
  });
  own('Pen', () => {
    const pen = new Pen(new EventTarget()),
      host = input();
    pen.attach(host);
    return {
      release: () => {
        pen.dispose();
        host.dispose();
      },
    };
  });
  own('PointerLock', () => {
    const document = Object.assign(new EventTarget(), { pointerLockElement: null, exitPointerLock() {} });
    const element = { ownerDocument: document, requestPointerLock: () => new Promise(() => {}) };
    const lock = new PointerLock(element),
      host = input();
    lock.attach(host);
    quiet(lock.request());
    return {
      release: () => {
        lock.dispose();
        host.dispose();
      },
    };
  });
  own('KeyboardLabels', () => {
    const keyboard = Object.assign(new EventTarget(), { getLayoutMap: () => new Promise(() => {}) });
    const labels = new KeyboardLabels({ keyboard });
    quiet(labels.refresh?.());
    return { release: () => labels.dispose() };
  });
  own('XRBindings', () => {
    const session = Object.assign(new EventTarget(), { inputSources: [] }),
      host = input();
    const xr = new XRBindings(session);
    xr.attach(host);
    return {
      release: () => {
        xr.dispose();
        host.dispose();
      },
    };
  });
  own('Gestures', () => {
    const gestures = new Gestures(new EventTarget());
    gestures.on('tap', () => {});
    return { release: () => gestures.dispose() };
  });
  own('landmarkStream', () => {
    const stream = landmarkStream();
    const reading = stream[Symbol.asyncIterator]().next();
    return {
      release: () => stream.dispose(),
      cleanup: () =>
        reading.then((r) => {
          if (!r.done) throw new Error('a disposed landmarkStream left its reader waiting');
        }),
    };
  });
  own('FaceDriver', () => {
    const face = new FaceDriver(),
      source = landmarkStream();
    const driving = face.drive(source, { primitives: [] });
    return {
      release: () => {
        face.dispose();
        source.dispose();
      },
      cleanup: () => driving,
    };
  });
  return entries;
}
