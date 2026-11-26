// A view that showed an error fails the visual check instead of becoming its picture, even when the page then wrote
// other text over it. Core stops the frame loop when a frame throws and hands the error to the page's onError; the
// demos show it in their status line, and the depth-texture demo then wrote its ready line over it and reported ready,
// so `visual:update` took the black canvas as the Edge 158 baseline (KB-DEPTHTEX-BLACK1). A demo that pauses on
// purpose (reduced motion stops the loop of gameplay-sandbox and windy-meadow) submits no GPU work either, so the
// guard watches what the page shows, not the GPU. Install `shownErrorsGuard` as an init script; `shownErrors(page)`
// returns the error texts the page has shown so far.

/** Text a page shows for a thrown error: `String(error)` of an Error, a MargoError or any other `...Error`. */
export const SHOWN_ERROR = /\b(?:[A-Z][A-Za-z]*)?Error: \S/;

/** Init script: records every page text matching SHOWN_ERROR, as it appears, in `window.margoShownErrors`. */
export function shownErrorsGuard() {
  if (window.margoShownErrors) return;
  const shown = (window.margoShownErrors = []),
    pattern = /\b(?:[A-Z][A-Za-z]*)?Error: \S/,
    look = (node) => {
      const text = node.nodeType === Node.TEXT_NODE ? node.data : node.textContent;
      if (text && pattern.test(text) && shown.length < 8) shown.push(text.trim().slice(0, 300));
    };
  new MutationObserver((records) => {
    for (const record of records)
      if (record.type === 'characterData') look(record.target);
      else for (const node of record.addedNodes) look(node);
  }).observe(document, { subtree: true, childList: true, characterData: true });
}

/** The error texts the page has shown so far (empty for none). */
export function shownErrors(page) {
  return page.evaluate(() => window.margoShownErrors ?? []);
}

/** The capture failure for a view that showed an error, or undefined when it showed none. */
export function shownErrorMessage(texts) {
  return texts.length ? `the page showed an error: ${texts[0]}` : undefined;
}
