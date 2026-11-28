// Status helper shared by the web demos (`import { demoStatus } from 'margo-demo-status'`).
// Marks the exhibit ready or failed through data attributes that tests and the gallery read:
// `data-ready` once the first usable frame is drawn, `data-error` once anything failed.
// A failed exhibit is never marked ready again (KB-DEMO-STATUS1).

/** @param {unknown} error */
export const errorMessage = (error) => (error instanceof Error ? error.message : String(error));

/**
 * @param {HTMLElement} exhibit element that carries `data-ready` / `data-error`
 * @param {HTMLElement | null} [notice] element whose text shows progress
 * @param {HTMLElement | null} [errorNotice] element for the error text (defaults to `notice`)
 */
export function demoStatus(exhibit, notice, errorNotice) {
  let failed = false;
  const say = (element, text) => {
    if (element && text !== undefined) element.textContent = text;
  };
  return {
    get failed() {
      return failed;
    },
    /** Marks the exhibit usable. Returns false when it already failed. */
    ready(text, value = 'true') {
      if (failed) return false;
      say(notice, text);
      exhibit.dataset.ready = value;
      return true;
    },
    pending(text) {
      if (failed) return;
      say(notice, text);
      delete exhibit.dataset.ready;
    },
    error(error) {
      const message = errorMessage(error);
      if (!failed) say(errorNotice ?? notice, message);
      failed = true;
      delete exhibit.dataset.ready;
      exhibit.dataset.error = exhibit.dataset.error ?? message;
    },
  };
}
