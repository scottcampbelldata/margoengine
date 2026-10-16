import { Engine, box, PbrMaterial } from '@margoengine/core';
import { XRManager, useXRSession, type XRMode } from '@margoengine/xr';
const status = document.querySelector<HTMLParagraphElement>('#status')!,
  exit = document.querySelector<HTMLButtonElement>('#exit')!;
let engine: Awaited<ReturnType<typeof Engine.create>> | undefined, manager: XRManager | undefined;
try {
  engine = await Engine.create(document.querySelector('canvas')!, {
    backend: 'webgpu',
  });
  const cube = engine
    .createMesh()
    .setGeometry(box())
    .setMaterial(new PbrMaterial({ color: '#84d6bd' }));
  engine.onFrame((_, delta) => {
    cube.rotation.y += delta;
  });
  engine.start();
  manager = await XRManager.create(engine);
  for (const [id, mode] of [
    ['inline', 'inline'],
    ['vr', 'immersive-vr'],
    ['ar', 'immersive-ar'],
  ] as const) {
    const button = document.querySelector<HTMLButtonElement>('#' + id)!;
    button.disabled = !(await XRManager.isSupported(mode));
    button.onclick = () => {
      void useXRSession(manager!, mode as XRMode, {
        optionalFeatures: ['hand-tracking'],
        onFrame({ delta }) {
          if (mode !== 'inline') cube.rotation.y += delta;
        },
      })
        .then((session) => {
          status.textContent = 'XR active: ' + mode;
          exit.disabled = false;
          session.addEventListener(
            'end',
            () => {
              status.textContent = 'Desktop rendering resumed';
              exit.disabled = true;
            },
            { once: true },
          );
        })
        .catch((error) => {
          status.textContent = String(error);
        });
    };
  }
  status.textContent = 'Choose a supported session mode. Inline provides pose tracking with the desktop canvas.';
  exit.onclick = () => {
    void manager!.end().catch((error) => {
      status.textContent = String(error);
    });
  };
} catch (error) {
  status.textContent = String(error);
}
function dispose() {
  manager?.dispose();
  engine?.dispose();
}
window.addEventListener('pagehide', dispose, { once: true });
if (import.meta.hot)
  import.meta.hot.dispose(() => {
    window.removeEventListener('pagehide', dispose);
    dispose();
  });
