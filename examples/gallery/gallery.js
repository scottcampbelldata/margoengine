// The Harrow Head page template (examples/gallery/DIRECTION.md): panel, sections with deep links, Reset, the numbers strip
// and the hidden dedication. A page's module calls mountGallery; the egg runs on every page, WebGPU or not.

/** The dedication every demo hides (Scott's rule). The exact wording stays here and enters the DOM only when found. */
const EGG = 'Margo engine ❤️ made for Margie';
const EGG_MS = 4000;
const EGG_PRESSES = 3;
const EGG_WINDOW_MS = 1500;

/** Shows the dedication for four seconds in the page's polite live region. */
export function revealEgg() {
  const region = document.querySelector('.egg');
  if (!region) return;
  region.textContent = EGG;
  clearTimeout(revealEgg.timer);
  revealEgg.timer = setTimeout(() => {
    region.textContent = '';
  }, EGG_MS);
}

/**
 * Counts presses inside a short window and calls `found` on the third; a press outside the window starts again.
 * @param {() => void} found
 * @param {() => number} [now]
 */
export function eggCounter(found, now = () => performance.now()) {
  let count = 0,
    first = 0;
  return () => {
    const t = now();
    if (t - first > EGG_WINDOW_MS) (count = 0), (first = t);
    if (++count === EGG_PRESSES) (count = 0), found();
  };
}

/**
 * Hides the dedication behind pressing M three times, or three clicks or taps on the footer mark, so a phone can find
 * it too. A later page may add a scene detail by calling `revealEgg` from its own pick handler.
 */
export function hideEgg() {
  const press = eggCounter(revealEgg);
  addEventListener('keydown', (event) => {
    const editing = event.target instanceof HTMLElement && /^(INPUT|SELECT|TEXTAREA)$/.test(event.target.tagName);
    if (event.code === 'KeyM' && !event.repeat && !editing) press();
  });
  document.querySelector('.mark')?.addEventListener('click', press);
}

/**
 * The section a page opens on: `?section=id`, then `#id`, then its first button. An unknown id falls back to the first
 * so an old link still opens the page.
 * @param {readonly string[]} ids
 * @param {string} search location.search
 * @param {string} hash location.hash
 */
export function initialSection(ids, search, hash) {
  const wanted = new URLSearchParams(search).get('section') ?? decodeURIComponent(hash.slice(1));
  return ids.includes(wanted) ? wanted : ids[0];
}

/** Sum of what the page has downloaded so far, from the browser's resource timing. */
function bytesLoaded() {
  let total = 0;
  for (const entry of performance.getEntriesByType('resource')) total += entry.encodedBodySize ?? 0;
  return total;
}

const number = (value, digits = 1) => (value == null ? 'n/a' : value.toFixed(digits));

/**
 * Fills the numbers strip from a live `Stats` plugin, twice a second. Nothing on the strip is typed in.
 * @param {{ frameTime: number, drawCalls: number, gpuTime: number | null }} stats
 * @param {AbortSignal} signal
 */
function runNumbers(stats, signal) {
  const cell = (name) => document.querySelector(`[data-number="${name}"]`);
  const timer = setInterval(() => {
    cell('frame').textContent = stats.frameTime > 0 ? `${number(stats.frameTime)} ms` : 'n/a';
    cell('gpu').textContent = stats.gpuTime == null ? 'n/a' : `${number(stats.gpuTime)} ms`;
    cell('draws').textContent = String(stats.drawCalls);
    cell('bytes').textContent = `${number(bytesLoaded() / 1e6)} MB`;
  }, 500);
  signal.addEventListener('abort', () => clearInterval(timer));
}

/**
 * Wires a scene page. `show(id, signal)` loads and draws one section and resolves once it is on screen; a newer section
 * aborts `signal`. `reset()` puts the current section back to how it opened. `stats` feeds the numbers strip.
 * Sets `window.gallery = {readiness, engine, section, setSection, dispose}`; `readiness` is true while a section is on
 * screen and false while one loads.
 * @param {{
 *   engine: object,
 *   stats: { frameTime: number, drawCalls: number, gpuTime: number | null },
 *   show: (id: string, signal: AbortSignal) => Promise<void>,
 *   reset?: () => void,
 *   dispose?: () => void,
 * }} page
 */
export function mountGallery({ engine, stats, show, reset, dispose }) {
  const buttons = [...document.querySelectorAll('[data-section]')],
    ids = buttons.map((button) => button.dataset.section),
    status = document.querySelector('[data-gallery-status]'),
    life = new AbortController();
  let current = null,
    loading = null,
    disposed = false;

  const state = {
    readiness: false,
    engine,
    get section() {
      return current;
    },
    setSection,
    dispose: stop,
  };

  async function setSection(id) {
    if (!ids.includes(id)) throw new RangeError(`Unknown section "${id}"; use one of ${ids.join(', ')}`);
    loading?.abort();
    const attempt = (loading = new AbortController());
    current = id;
    state.readiness = false;
    for (const button of buttons) button.setAttribute('aria-pressed', String(button.dataset.section === id));
    history.replaceState(null, '', `${location.pathname}?section=${encodeURIComponent(id)}`);
    if (status) status.textContent = 'Loading';
    try {
      await show(id, attempt.signal);
    } catch (error) {
      if (attempt.signal.aborted) return;
      if (status) status.textContent = `This section failed to load: ${error?.message ?? error}`;
      throw error;
    }
    if (attempt.signal.aborted) return;
    if (status) status.textContent = '';
    state.readiness = true;
  }

  function stop() {
    if (disposed) return;
    disposed = true;
    loading?.abort();
    life.abort();
    dispose?.();
  }

  for (const button of buttons)
    button.addEventListener('click', () => {
      setSection(button.dataset.section).catch((error) => console.error(error));
    });
  document.querySelector('[data-reset]')?.addEventListener('click', () => reset?.());
  addEventListener('pagehide', stop, { signal: life.signal });
  runNumbers(stats, life.signal);
  window.gallery = state;
  return setSection(initialSection(ids, location.search, location.hash));
}
