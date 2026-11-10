/// <reference lib="esnext.disposable" preserve="true" />
import { fault, rangeError, typeError } from '../../shared/errors.js';

/** Page playback setup, independent of renderer and texture upload. */
export interface VideoPlaybackOptions {
  /** Attempt playback immediately. Default true. Policy refusal exposes a click fallback. */
  autoplay?: boolean;
  /** Mute before the first play call. Default true. */
  muted?: boolean;
  /** Native video poster URL while a decoded frame is unavailable. Default leave unchanged. */
  poster?: string | URL;
  /** Existing click target. Default an accessible Play video button, inserted next to the video when blocked. */
  fallback?: HTMLElement;
  /** Cancels readiness and playback waits and disposes this helper. Default none. */
  signal?: AbortSignal;
  /** Ready-frame timeout in milliseconds. Default 30000. Finite and positive. */
  timeout?: number;
}
/** Lifecycle of a caller-owned video element and its optional click fallback. */
export interface VideoPlayback extends Disposable {
  /** Resolves at HAVE_CURRENT_DATA, independent of autoplay permission. Rejects on error, timeout or cancellation. */
  readonly ready: Promise<HTMLVideoElement>;
  /** Resolves on the first successful play. A policy refusal leaves this pending for the user's click. */
  readonly started: Promise<void>;
  /** True after NotAllowedError, until a play succeeds. */
  readonly blocked: boolean;
  /** Last non-policy playback error, or undefined. Automatic errors remain inspectable after ready resolves. */
  readonly error: unknown;
  /** Click target, supplied or owned. The helper never hides or removes a supplied element. */
  readonly fallback: HTMLElement;
  /** Start directly in a user gesture. Concurrent calls share a promise. Policy refusals reject with code state. */
  play(): Promise<void>;
  /** Reject pending waits, pause the video and remove helper listeners/owned button. Does not unload or remove video. */
  dispose(): void;
}

/**
 * Muted inline autoplay with a native poster, decoded-frame readiness and policy-only click fallback.
 * Pass a video with src/srcObject already set. Source, CORS, stream tracks and element stay caller-owned.
 * No global listeners, import side effects or automatic retry loop; fallback play runs directly in its click handler.
 */
export function prepareVideo(video: HTMLVideoElement, options: VideoPlaybackOptions = {}): VideoPlayback {
  const { signal, timeout = 30000, autoplay = true, muted = true } = options;
  signal?.throwIfAborted();
  const document = video?.ownerDocument,
    Video = document?.defaultView?.HTMLVideoElement;
  if (!Video || !(video instanceof Video))
    throw typeError('Playback needs a page HTMLVideoElement; pass a video with its source set', 'arguments');
  if (typeof autoplay !== 'boolean' || typeof muted !== 'boolean')
    throw typeError('Playback autoplay and muted must be booleans; pass true or false', 'arguments');
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 2147483647)
    throw rangeError(
      'Playback timeout must be finite and positive, at most 2147483647 ms; pass milliseconds',
      'arguments',
    );
  if (options.poster !== undefined && typeof options.poster !== 'string' && !(options.poster instanceof URL))
    throw typeError('Playback poster must be an image URL; pass a string or URL', 'arguments');
  if (options.fallback && !(options.fallback instanceof document.defaultView!.HTMLElement))
    throw typeError('Playback fallback must be an element in the video document; pass an HTML button', 'arguments');
  const owned = !options.fallback,
    button = options.fallback ?? document.createElement('button');
  if (owned) {
    (button as HTMLButtonElement).type = 'button';
    button.textContent = 'Play video';
  }
  video.muted = muted;
  video.playsInline = true;
  if (options.poster !== undefined) video.poster = String(options.poster);
  let disposed = false,
    blocked = false,
    error: unknown,
    pending: Promise<void> | undefined,
    cancelPlay: ((reason: unknown) => void) | undefined,
    readyDone = false;
  let resolveReady!: (video: HTMLVideoElement) => void,
    rejectReady!: (reason: unknown) => void,
    resolveStarted!: () => void,
    rejectStarted!: (reason: unknown) => void;
  const ready = new Promise<HTMLVideoElement>((yes, no) => {
      resolveReady = yes;
      rejectReady = no;
    }),
    started = new Promise<void>((yes, no) => {
      resolveStarted = yes;
      rejectStarted = no;
    });
  void ready.catch(() => {});
  void started.catch(() => {});
  const show = (): void => {
    if (owned && !button.isConnected) {
      if (video.parentNode) video.after(button);
      else (document.body ?? document.documentElement).append(button);
    }
  };
  const cleanup = (): void => {
    clearTimeout(timer);
    video.removeEventListener('loadeddata', loaded);
    video.removeEventListener('error', mediaError);
    video.removeEventListener('abort', mediaAbort);
    signal?.removeEventListener('abort', abort);
    button.removeEventListener('click', click);
    if (owned) button.remove();
  };
  const fail = (reason: unknown): void => {
    if (disposed) return;
    error = reason;
    rejectReady(reason);
    rejectStarted(reason);
    cancelPlay?.(reason);
    disposed = true;
    cleanup();
    video.pause();
  };
  const loaded = (): void => {
    if (!disposed && video.readyState >= 2 && !readyDone) {
      readyDone = true;
      clearTimeout(timer);
      video.removeEventListener('loadeddata', loaded);
      resolveReady(video);
    }
  };
  const mediaError = (): void =>
    fail(fault('failed', `Video media error ${video.error?.code ?? 0}; check the source, codec and CORS permission`));
  const mediaAbort = (): void =>
    fail(fault('failed', 'Video loading was aborted; prepare the replacement source again'));
  const abort = (): void => fail(signal!.reason);
  const play = (): Promise<void> => {
    if (disposed)
      return Promise.reject(error ?? fault('disposed', 'Playback helper is disposed; prepare the video again'));
    if (pending) return pending;
    // Call before any await or microtask, preserving the native click's transient activation.
    let native: Promise<void>;
    try {
      native = video.play();
    } catch (reason) {
      native = Promise.reject(reason);
    }
    const cancelled = new Promise<void>((_resolve, reject) => {
      cancelPlay = reject;
    });
    pending = Promise.race([native, cancelled])
      .then(
        () => {
          if (disposed) throw error ?? fault('disposed', 'Playback helper is disposed; prepare the video again');
          blocked = false;
          if (owned) button.remove();
          resolveStarted();
          loaded();
        },
        (reason) => {
          if (disposed) throw reason;
          if ((reason as { name?: string })?.name === 'NotAllowedError') {
            blocked = true;
            show();
            throw Object.assign(
              fault('state', 'Autoplay was blocked; click Play video or call play in a user gesture'),
              { cause: reason },
            );
          }
          const failure = Object.assign(
            fault('failed', 'Video playback failed; check the source, codec and browser permission'),
            { cause: reason },
          );
          fail(failure);
          throw failure;
        },
      )
      .finally(() => {
        pending = undefined;
        cancelPlay = undefined;
      });
    return pending;
  };
  const click = (): void => {
    void play().catch((reason) => {
      // Policy refusal is represented by blocked; all other failures are exposed through error/started.
      if (!blocked && !disposed) fail(reason);
    });
  };
  const timer = setTimeout(
    () => fail(fault('failed', 'Video frame readiness timed out; check the source or increase timeout')),
    timeout,
  );
  video.addEventListener('loadeddata', loaded);
  video.addEventListener('error', mediaError);
  video.addEventListener('abort', mediaAbort);
  button.addEventListener('click', click);
  signal?.addEventListener('abort', abort, { once: true });
  if (video.error) mediaError();
  else {
    loaded();
    if (autoplay) click();
  }
  const dispose = (): void => {
    if (disposed) return;
    fail(fault('disposed', 'Playback helper is disposed; prepare the video again'));
  };
  return {
    ready,
    started,
    fallback: button,
    get blocked() {
      return blocked;
    },
    get error() {
      return error;
    },
    play,
    dispose,
    [Symbol.dispose ?? Symbol()]: dispose,
  } as VideoPlayback;
}
