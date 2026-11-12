// Shared harness for the test pages in this folder (scripts/test-pages-browser.mjs drives them).
// Each page imports it first. It records what a user would see go wrong: uncaught errors, rejected promises,
// console errors and console warnings that say BUG. It also tracks the work a click starts, so the runner can wait
// for that work to finish instead of sleeping for a fixed time.

export interface Finding {
  kind: 'error' | 'bug';
  text: string;
}

const findings: Finding[] = [];
const pending = new Set<Promise<unknown>>();
let started: Promise<unknown> = Promise.resolve();

const text = (value: unknown): string =>
  value instanceof Error ? `${value.name}: ${value.message}` : typeof value === 'string' ? value : String(value);

function track(value: unknown): void {
  if (!value || typeof (value as PromiseLike<unknown>).then !== 'function') return;
  const settled: Promise<unknown> = Promise.resolve(value).then(
    () => undefined,
    (error: unknown) => {
      findings.push({ kind: 'error', text: `rejected: ${text(error)}` });
    },
  );
  pending.add(settled);
  void settled.finally(() => pending.delete(settled));
}

window.addEventListener('error', (event) => {
  findings.push({ kind: 'error', text: `uncaught: ${event.message}` });
});
window.addEventListener('unhandledrejection', (event) => {
  findings.push({ kind: 'error', text: `unhandled rejection: ${text(event.reason)}` });
});

const consoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  findings.push({ kind: 'error', text: args.map(text).join(' ') });
  consoleError(...args);
};
const consoleWarn = console.warn.bind(console);
console.warn = (...args: unknown[]) => {
  const line = args.map(text).join(' ');
  if (/\bBUG\b/.test(line)) findings.push({ kind: 'bug', text: line });
  consoleWarn(...args);
};

// Click handlers, both addEventListener('click') and onclick, report the promise they return.
const add = EventTarget.prototype.addEventListener;
EventTarget.prototype.addEventListener = function (
  this: EventTarget,
  type: string,
  listener: EventListenerOrEventListenerObject | null,
  options?: boolean | AddEventListenerOptions,
) {
  if (type === 'click' && typeof listener === 'function') {
    const inner = listener;
    const wrapped = function (this: unknown, event: Event) {
      track(inner.call(this, event));
    };
    return add.call(this, type, wrapped, options);
  }
  return add.call(this, type, listener, options);
};
const onclick = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'onclick');
if (onclick?.set && onclick.get) {
  const { get, set } = onclick;
  Object.defineProperty(HTMLElement.prototype, 'onclick', {
    configurable: true,
    enumerable: onclick.enumerable,
    get(this: HTMLElement) {
      return get.call(this);
    },
    set(this: HTMLElement, value: unknown) {
      if (typeof value !== 'function') return set.call(this, value);
      const inner = value as (this: HTMLElement, event: MouseEvent) => unknown;
      set.call(this, function (this: HTMLElement, event: MouseEvent) {
        track(inner.call(this, event));
      });
    },
  });
}

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** Resolves once the page start and every tracked click have settled, plus two drawn frames. */
async function settle(): Promise<void> {
  await started;
  while (pending.size) await Promise.all([...pending]);
  await frame();
  await frame();
}

/** Marks the promise of the page's start, so the runner waits for it. Returns the same promise. */
export function ready<T>(start: Promise<T>): Promise<T> {
  track(start);
  started = start.then(
    () => undefined,
    () => undefined,
  );
  return start;
}

declare global {
  interface Window {
    testPage: {
      settle(): Promise<void>;
      buttons(): string[];
      click(id: string): Promise<void>;
      findings(): Finding[];
    };
  }
}

window.testPage = {
  settle,
  buttons: () =>
    [...document.querySelectorAll<HTMLButtonElement>('button[id]')].filter((b) => !b.disabled).map((b) => b.id),
  async click(id) {
    const button = document.getElementById(id);
    if (!(button instanceof HTMLButtonElement) || button.disabled) return;
    button.click();
    await settle();
  },
  findings: () => findings.slice(),
};
