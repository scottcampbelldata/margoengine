// One place where a demo page says it is ready or that it failed (KB-DEMO-STATUS1). Pages and their browser checks
// read `data-ready` on one element; before this, demos wrote it themselves and an error shown by `onError` (a lost
// device, an uncaptured GPU error) was overwritten by the ready line a moment later, with `data-ready` still set, so a
// check passed a page that had failed. Once `error` has run, `ready` changes nothing and returns false, the error text
// stays, `data-ready` is removed and `data-error` holds the message. Erasable TypeScript, no imports.

export interface DemoStatus {
  /** True once `error` has run. */
  readonly failed: boolean;
  /**
   * Marks the page ready: `data-ready` becomes `value` (default `'true'`) and `text`, when given, goes in the status
   * element. Does nothing after an error and returns whether it marked the page.
   */
  ready(text?: string, value?: string): boolean;
  /** Clears `data-ready` while the page loads something new; `text`, when given, goes in the status element. */
  pending(text?: string): void;
  /** Shows the error in the error element (else the status element), removes `data-ready` and sets `data-error`. */
  error(cause: unknown): void;
}

/** The message of an error or of any thrown value. */
export const errorText = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/**
 * The status of a demo page. `target` carries `data-ready` and `data-error` (the canvas or viewport the page's check
 * waits on); `status` shows progress and the ready line; `errors` shows an error (default: `status`).
 */
export function demoStatus(target: HTMLElement, status?: HTMLElement | null, errors?: HTMLElement | null): DemoStatus {
  let failed = false;
  const show = (element: HTMLElement | null | undefined, text: string | undefined) => {
    if (element && text !== undefined) element.textContent = text;
  };
  return {
    get failed() {
      return failed;
    },
    ready(text, value = 'true') {
      if (failed) return false;
      show(status, text);
      target.dataset.ready = value;
      return true;
    },
    pending(text) {
      if (failed) return;
      show(status, text);
      delete target.dataset.ready;
    },
    error(cause) {
      const text = errorText(cause);
      // The first error is the cause; later ones (a device lost after a validation error) keep it on screen.
      if (!failed) show(errors ?? status, text);
      failed = true;
      delete target.dataset.ready;
      target.dataset.error = target.dataset.error ?? text;
    },
  };
}
