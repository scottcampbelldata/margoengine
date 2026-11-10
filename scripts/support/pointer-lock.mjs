// Native pointer lock in the harness-launched browser, and what a check does when the operating system refuses it.
//
// Chromium grants `requestPointerLock` only to a page whose view has OS keyboard focus; otherwise the request rejects
// with WrongDocumentError ("The root document of this element is not valid for pointer lock."). On macOS a view has
// that focus only in the key window of the active (front) application. On an unattended Mac with the console locked
// the front application is loginwindow, so no browser window can be key, headed or headless, and every request is
// refused (measured on the M6 Mac mini, Chromium 156.0.8078.4, 2026-11-10: headless shell, new headless and headed,
// with and without page.bringToFront() and CDP Emulation.setFocusEmulationEnabled). That is the operating system, not
// Margo or the harness, so no launch flag fixes it. docs/limits.md "Native pointer lock on a locked Mac" records it.
//
// `pointerLockSupport(page)` probes native lock in a scratch page of the same browser. When it works, checks
// run unchanged. When it is refused for that documented macOS reason, the check installs `pointerLockStandIn`, a
// stand-in for the platform's lock state written to the Pointer Lock 2.0 specification, and prints the reason: Margo's
// lock code (request, change events, locked movement, release) is still proven end to end, and the note says plainly
// that native acquisition was not. Any other refusal (another platform, an unlocked Mac with the browser in front)
// is returned as unsupported with no reason, and the check fails as before.

import { execFileSync } from 'node:child_process';

/** `{ screenLocked, frontBundle }` of the macOS console session, or null off macOS or when the tools are missing. */
export function macConsoleSession({ platform = process.platform, run = execFileSync } = {}) {
  if (platform !== 'darwin') return null;
  try {
    const registry = run('ioreg', ['-n', 'Root', '-d1', '-a'], { encoding: 'utf8' }),
      locked = /<key>CGSSessionScreenIsLocked<\/key>\s*<true\/>/.test(registry);
    const front = run('lsappinfo', ['front'], { encoding: 'utf8' }).trim().replace(/:$/, ''),
      info = front ? run('lsappinfo', ['info', '-only', 'bundleid', front], { encoding: 'utf8' }) : '',
      frontBundle = /bundleID="([^"]+)"/.exec(info)?.[1] ?? null;
    return { screenLocked: locked, frontBundle };
  } catch {
    // ioreg and lsappinfo ship with macOS; without them the session cannot be read and no reason is given.
    return null;
  }
}

const CHROMIUM_BUNDLE = /^(com\.google\.chrome|org\.chromium\.chromium|com\.microsoft\.edgemac)/i;

/**
 * Why native pointer lock was refused for an operating-system reason a check may note instead of fail, or null.
 * Only macOS qualifies: the error must be the WrongDocumentError Chromium returns for an unfocused view, and the console
 * must be locked or a non-browser application must be in front.
 */
export function pointerLockRefusalReason({ platform = process.platform, error, session } = {}) {
  if (platform !== 'darwin' || !session || !/^WrongDocumentError\b/.test(String(error ?? ''))) return null;
  if (session.screenLocked)
    return `macOS console is locked (front app ${session.frontBundle ?? 'unknown'}), so no browser window can be key`;
  if (session.frontBundle && !CHROMIUM_BUNDLE.test(session.frontBundle))
    return `macOS front app is ${session.frontBundle}, so the harness browser has no key window`;
  return null;
}

/** Tries native pointer lock once, after a real click, in a scratch page of `page`'s browser. */
export async function probeNativePointerLock(page) {
  const probe = await page.context().browser().newPage();
  try {
    await probe.setContent('<button id="lock" style="width:120px;height:60px">lock</button>');
    await probe.evaluate(() => {
      document.querySelector('#lock').onclick = (event) =>
        event.target.requestPointerLock().then(
          () => (window.lockResult = document.pointerLockElement === event.target ? 'locked' : 'no element'),
          (error) => (window.lockResult = `${error.name}: ${error.message}`),
        );
    });
    await probe.locator('#lock').click({ timeout: 10000 });
    await probe.waitForFunction(() => window.lockResult, null, { timeout: 10000 });
    return await probe.evaluate(() => {
      document.exitPointerLock();
      return window.lockResult;
    });
  } finally {
    await probe.close();
    await page.bringToFront();
  }
}

/**
 * `{ native: true }` when the browser grants pointer lock; `{ native: false, error, reason }` when it does not, where
 * `reason` is the documented macOS cause or null (then the check must fail).
 */
export async function pointerLockSupport(page, { session = macConsoleSession() } = {}) {
  const result = await probeNativePointerLock(page);
  if (result === 'locked') return { native: true };
  return { native: false, error: result, reason: pointerLockRefusalReason({ error: result, session }) };
}

/**
 * Page script: the platform's pointer lock state, per Pointer Lock 2.0 (W3C Working Draft): `requestPointerLock()`
 * on a connected element sets the document's pointer lock element and fires `pointerlockchange` at the document,
 * resolving its promise; a disconnected element rejects with WrongDocumentError and fires `pointerlockerror`;
 * `unadjustedMovement: true` rejects with NotSupportedError as Chromium on macOS does; `exitPointerLock()` clears it
 * and fires `pointerlockchange`. Events, movementX/Y and everything else stay native. Install it with
 * `page.evaluate(pointerLockStandIn)` only after `pointerLockSupport` returned a reason.
 */
export function pointerLockStandIn() {
  let element = null;
  const change = (doc) => queueMicrotask(() => doc.dispatchEvent(new Event('pointerlockchange')));
  Object.defineProperty(Document.prototype, 'pointerLockElement', {
    configurable: true,
    get() {
      return element && element.ownerDocument === this && element.isConnected ? element : null;
    },
  });
  Element.prototype.requestPointerLock = function (options = {}) {
    const doc = this.ownerDocument;
    if (!this.isConnected) {
      queueMicrotask(() => doc.dispatchEvent(new Event('pointerlockerror')));
      return Promise.reject(new DOMException('The element is not connected.', 'WrongDocumentError'));
    }
    if (options?.unadjustedMovement)
      return Promise.reject(new DOMException('Unadjusted movement is unavailable.', 'NotSupportedError'));
    element = this;
    change(doc);
    return Promise.resolve();
  };
  Document.prototype.exitPointerLock = function () {
    if (!element || element.ownerDocument !== this) return;
    element = null;
    change(this);
  };
  window.__margoPointerLockStandIn = true;
}

/**
 * For a browser check: probes native lock and, on the documented macOS refusal, installs the stand-in in `page` and
 * prints why. Returns the support record; a refusal with no documented reason throws, naming the error.
 */
export async function usePointerLock(page, { label = 'pointer lock', log = console.log } = {}) {
  const support = await pointerLockSupport(page);
  if (support.native) return support;
  if (!support.reason)
    throw new Error(
      `Native ${label} refused (${support.error}) with no documented operating-system cause; fix the browser launch so the page's window has focus`,
    );
  await page.evaluate(pointerLockStandIn);
  log(
    `NOTE ${label}: native acquisition not proven on this machine (${support.error}; ${support.reason}). ` +
      'Margo lock handling runs against a Pointer Lock 2.0 stand-in; see docs/limits.md "Native pointer lock on a locked Mac".',
  );
  return support;
}
