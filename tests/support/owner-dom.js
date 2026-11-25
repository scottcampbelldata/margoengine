// A document for fixtures of packages that mount DOM panels. In a browser it is the page's own, so listeners are real
// and the observer sees them; in Node it is a jsdom window with animation frames (jsdom's own event targets are not
// the ones the observer patches, so there the check is that disposal runs clean).
export async function fixtureDocument() {
  if (globalThis.document?.body) {
    const root = document.createElement('main');
    document.body.append(root);
    return { root, view: window, done: () => root.remove() };
  }
  const name = 'jsdom',
    { JSDOM } = await import(name);
  const dom = new JSDOM('<main></main>', { pretendToBeVisual: true }),
    view = dom.window;
  return { root: view.document.querySelector('main'), view, done: () => view.close() };
}
