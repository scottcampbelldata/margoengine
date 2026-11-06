/// <reference lib="esnext.disposable" preserve="true" />
import type { XR, XRMode, XRNativeSession, XRSessionOptions } from '@margoengine/xr';
import type { Stage } from './index.js';
import { optionalPackage, stageSignal } from './feature.js';
import { fault } from '../../shared/errors.js';

/** Options for `addXRButton`: the session options of `XR.requestSession` plus the button's own. */
export interface XRButtonOptions extends Omit<XRSessionOptions, 'signal'> {
  /** Session the button starts. Default 'immersive-vr'. */
  mode?: Exclude<XRMode, 'inline'>;
  /** Element the button goes in. Default the canvas's parent. */
  parent?: HTMLElement;
  /** Text that starts a session. Default 'Enter VR' or 'Enter AR'. */
  label?: string;
  /** Text during a session. Default 'Exit VR' or 'Exit AR'. */
  exitLabel?: string;
  /** Text of the disabled button when the session cannot start here. Default 'VR not available' or 'AR not available'. */
  unavailableLabel?: string;
  /** Style the button with your own CSS class instead of the built-in style, which places it at the foot of `parent`. */
  className?: string;
  /** Receives a session that fails to start or end. Default `engine.onError`. */
  onError?: (error: unknown) => void;
  /** Cancels the wait for the package and the device; the stage's disposal cancels it too. */
  signal?: AbortSignal;
}

/** What `addXRButton` returns. */
export interface XRButton {
  /** The `<button>`, already on the page. */
  readonly element: HTMLButtonElement;
  /** False when this browser, device or engine cannot start the session: the button is disabled and says so. */
  readonly supported: boolean;
  /** The XR plugin, for `xr.controllers`, `xr.session` and `HitTest`; null when not supported. */
  readonly xr: XR | null;
  /** Removes the button. The last button of a stage also ends its session and releases the XR device. */
  dispose(): void;
  [Symbol.dispose](): void;
}

/** One XR plugin per stage, shared by its buttons (a VR and an AR button) and released with the last of them. */
interface SharedXR {
  ready: Promise<XR>;
  users: number;
}
const shared = new WeakMap<Stage, SharedXR>();

const style =
  'position:absolute;left:50%;transform:translateX(-50%);z-index:1;min-height:44px;padding:0 24px;' +
  'border:1px solid #fff;border-radius:4px;background:#000c;color:#fff;font:16px sans-serif;cursor:pointer';

/**
 * Shows an accessible Enter VR or Enter AR button on the stage, importing `@margoengine/xr` on the first call. Clicking
 * it starts the session and turns it into Exit VR; where the session cannot start, the button stays on the page,
 * disabled and saying so. Immersive sessions stop the window's frame loop, so `stage.onTick` pauses: animate in `onFrame`.
 * Rejects with `Install @margoengine/xr` when it is missing, and with AbortError, adding nothing, when `signal` aborts
 * or the stage is disposed first. Needs WebGPU and a browser with WebXR's WebGPU binding.
 * @example const button = await addXRButton(stage, { onFrame: ({ delta }) => { cube.rotation.y += delta; } });
 */
export async function addXRButton(
  stage: Stage,
  {
    mode = 'immersive-vr',
    parent,
    label,
    exitLabel,
    unavailableLabel,
    className,
    onError,
    signal,
    ...session
  }: XRButtonOptions = {},
): Promise<XRButton> {
  const abort = stageSignal(stage, signal),
    kind = mode === 'immersive-ar' ? 'AR' : 'VR',
    host = parent ?? stage.canvas.parentElement;
  abort.throwIfAborted();
  if (!host) throw fault('state', 'XR button needs a canvas on the page or the parent option');
  const { XR } = await optionalPackage('@margoengine/xr', () => import('@margoengine/xr'), abort);
  const supported =
    stage.engine.backend === 'webgpu' &&
    (await XR.isSupported(mode).catch((error: unknown) => {
      // A page whose permissions policy blocks WebXR has no session to offer; anything else is a real failure.
      if ((error as { name?: string }).name === 'SecurityError') return false;
      throw error;
    }));
  abort.throwIfAborted();
  let share: SharedXR | undefined, xr: XR | null;
  if (supported) {
    share = shared.get(stage);
    // The stage's own signal: one caller's abort must not fail the other buttons waiting for the same device.
    if (!share) shared.set(stage, (share = { ready: XR.create(stage.engine, { signal: stage.signal }), users: 0 }));
    share.users++;
  }
  try {
    xr = share ? await share.ready : null;
    abort.throwIfAborted();
  } catch (error) {
    release(stage, share);
    if ((error as { code?: string }).code !== 'unsupported') throw error;
    xr = null;
  }
  const report = onError ?? ((error: unknown) => stage.engine.onError(error)),
    enter = label ?? `Enter ${kind}`,
    element = host.ownerDocument.createElement('button'),
    view = host.ownerDocument.defaultView!,
    others = host.querySelectorAll('[data-xr-button]').length;
  let active: XRNativeSession | null = null,
    busy = false,
    disposed = false;
  element.type = 'button';
  element.textContent = xr ? enter : (unavailableLabel ?? `${kind} not available`);
  element.disabled = !xr;
  element.dataset.xrButton = mode;
  if (className) element.className = className;
  else {
    element.style.cssText = `${style};bottom:${20 + 56 * others}px`;
    // The built-in style places the button at the foot of the host, so the host must be its containing block.
    if (view.getComputedStyle(host).position === 'static') host.style.position = 'relative';
  }
  const click = (): void => {
    if (busy || !xr) return;
    busy = true;
    element.setAttribute('aria-busy', 'true');
    const done = (): void => {
      busy = false;
      element.removeAttribute('aria-busy');
    };
    if (active) {
      xr.end().catch(report).finally(done);
      return;
    }
    xr.requestSession(mode, session)
      .then((started) => {
        active = started;
        element.textContent = exitLabel ?? `Exit ${kind}`;
        started.addEventListener(
          'end',
          () => {
            active = null;
            element.textContent = enter;
          },
          { once: true },
        );
      })
      .catch(report)
      .finally(done);
  };
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    stage.signal.removeEventListener('abort', dispose);
    element.removeEventListener('click', click);
    element.remove();
    if (xr) release(stage, share);
  };
  element.addEventListener('click', click);
  stage.signal.addEventListener('abort', dispose, { once: true });
  host.append(element);
  return { element, supported: !!xr, xr, dispose, [Symbol.dispose ?? Symbol()]: dispose } as XRButton;
}

/** One user fewer; the last one disposes the plugin, which ends its session. */
function release(stage: Stage, share: SharedXR | undefined): void {
  if (!share || --share.users) return;
  if (shared.get(stage) === share) shared.delete(stage);
  share.ready.then(
    (xr) => xr.dispose(),
    () => {},
  );
}
