// Run this page on a real headset or phone: see docs/xr-device-runs/README.md.
import { Engine, box, PbrMaterial } from '@margoengine/core';
import { XR, type XRMode } from '@margoengine/xr';
import { runDeviceCheck, type XRRun, type XRRunObserved } from '@margoengine/xr/device-check';

const status = document.querySelector<HTMLParagraphElement>('#status')!,
  questions = document.querySelector<HTMLFormElement>('#questions')!,
  save = document.querySelector<HTMLAnchorElement>('#save')!,
  report = document.querySelector<HTMLPreElement>('#report')!;

/** Shows the four questions and waits for the tester's answers. */
const ask = (): Promise<XRRunObserved> =>
  new Promise((resolve) => {
    questions.hidden = false;
    questions.onsubmit = (event) => {
      event.preventDefault();
      questions.hidden = true;
      const yes = (name: string) => (questions.elements.namedItem(name) as HTMLInputElement).checked;
      resolve({ scene: yes('scene'), tracking: yes('tracking'), input: yes('input'), exit: yes('exit') });
    };
  });

function show(run: XRRun): void {
  report.textContent = JSON.stringify(run, null, 2);
  save.href = URL.createObjectURL(new Blob([report.textContent], { type: 'application/json' }));
  save.download = `${run.mode}-${run.route}-${run.date.slice(0, 10)}.json`;
  save.hidden = false;
}

const engine = await Engine.create(document.querySelector('canvas')!, { backend: 'webgpu' }),
  material = new PbrMaterial({ color: '#84d6bd' }),
  pressed = new PbrMaterial({ color: '#e0a03c' }),
  cube = engine.createMesh().setGeometry(box(0.3, 0.3, 0.3)).setMaterial(material).setPosition([0, 0, -1]);
engine.start();
const xr = await XR.create(engine);
for (const [id, mode] of [
  ['vr', 'immersive-vr'],
  ['ar', 'immersive-ar'],
] as const) {
  const button = document.querySelector<HTMLButtonElement>('#' + id)!;
  button.disabled = !(await XR.isSupported(mode as XRMode));
  button.onclick = () => {
    status.textContent = 'Running: move your head, then press, pinch or tap';
    void runDeviceCheck(xr, {
      mode,
      observe: ask,
      onFrame({ delta, inputs }) {
        cube.rotation.y += delta;
        const held = inputs.some(({ source }) => source.gamepad?.buttons.some((b) => b.pressed));
        cube.setMaterial(held ? pressed : material);
      },
    })
      .then((run) => {
        status.textContent = 'Finished: save the record and add it to docs/xr-device-runs';
        show(run);
      })
      .catch((error) => {
        status.textContent = String(error);
      });
  };
}
status.textContent = 'Choose a session this device can start';
