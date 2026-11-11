// WGSL compile guard for the browser checks: every shader module a page creates is compiled for diagnostics, so a WGSL
// error fails the check that drew it even when no pipeline is built from the module or the error surfaces only as a
// later validation message. Install `wgslGuard` as an init script (page.addInitScript or context.addInitScript); it
// reports through the console, which `watchWgsl` collects on the Node side across navigations:
//   [wgsl] module <hash>                      a distinct source compiled (debug level)
//   [wgsl] error <label> <line>:<col> <message> | <source line>
//   [wgsl] expected <label>                   a module labelled `expect-error:<name>` failed, as its check declared
//   [wgsl] unexpected-success <label>         a module labelled `expect-error:<name>` compiled cleanly (a failure)
// A check that compiles broken WGSL on purpose (to test how the error is reported) names that one module with the
// label `expect-error:<name>`; only its errors are excused, and the run fails if it does not fail.
// scripts/browser.js installs it in every page it opens; scripts/visual-regression.js in every view's context.
// Every module's compilation info is asked for when the module is created, and a check's own later
// `module.getCompilationInfo()` returns that answer (Chromium can leave a later request pending; see below).

/**
 * Init script: wraps GPUDevice.prototype.createShaderModule to check each distinct source's compilation info, and
 * makes each module's getCompilationInfo() return the answer asked for at its creation.
 */
export function wgslGuard(probe) {
  // Value-returning functions that do not end in a return on every path (KB-FF1b). The WGSL behavior analysis accepts
  // a function whose last statement is a `loop` left only by `return`, but Firefox's WGSL front end (naga) requires a
  // function with a return type to end in `return` (or `discard`), in an `if` with an `else` whose branches all do, in
  // a `switch` whose every clause does, or in a block that does; Chromium and the WebGL2 layer accept the rest, so it
  // only showed in Firefox (coastal.ts `root`, KB-FF1). Kept inside this function so the page gets it with the guard;
  // Node gets it as `wgslReturnGaps` below. Returns [{ name, line }]; a source it cannot follow yields no entry.
  const returnGaps = (code) => {
    const kept = [];
    for (let i = 0, depth = 0; i < code.length; i++) {
      if (!depth && code[i] === '/' && code[i + 1] === '/') {
        while (i < code.length && code[i] !== '\n') i++;
        kept.push('\n');
      } else if (code[i] === '/' && code[i + 1] === '*') {
        depth++;
        i++;
        kept.push('  ');
      } else if (depth && code[i] === '*' && code[i + 1] === '/') {
        depth--;
        i++;
        kept.push('  ');
      } else kept.push(depth && code[i] !== '\n' ? ' ' : code[i]);
    }
    const text = kept.join(''),
      tokens = [...text.matchAll(/[A-Za-z_][A-Za-z0-9_]*|->|\S/g)].map((m) => ({ t: m[0], at: m.index })),
      n = tokens.length,
      open = { '{': '}', '(': ')', '[': ']' };
    // Index of the token closing the bracket opened at i, or n when it never closes.
    const close = (i) => {
      for (let d = 0, j = i; j < n; j++) {
        if (open[tokens[j].t]) d++;
        else if (tokens[j].t === '}' || tokens[j].t === ')' || tokens[j].t === ']') if (--d === 0) return j;
      }
      return n;
    };
    // Index of the next `stop` token at bracket depth 0 from i (bracket groups skipped), or n.
    const skipTo = (i, stop, end) => {
      for (let j = i; j < end; j++) {
        if (tokens[j].t === stop) return j;
        if (open[tokens[j].t]) j = close(j);
      }
      return end;
    };
    // A statement from i: [index after it, whether it returns on every path]; null when it cannot be followed.
    const statement = (i, end) => {
      while (tokens[i]?.t === '@') i = tokens[i + 2]?.t === '(' ? close(i + 2) + 1 : i + 2;
      const t = tokens[i]?.t;
      if (t === '{') {
        const j = close(i);
        return j < end ? [j + 1, block(i + 1, j)] : null;
      }
      if (t === 'return' || t === 'discard') {
        const j = skipTo(i, ';', end);
        return j < end ? [j + 1, true] : null;
      }
      if (t === 'if') {
        const b = skipTo(i + 1, '{', end),
          j = close(b);
        if (j >= end) return null;
        const then = block(b + 1, j);
        if (tokens[j + 1]?.t !== 'else') return [j + 1, false];
        const rest = statement(j + 2, end);
        return rest && [rest[0], then && rest[1]];
      }
      if (t === 'switch') {
        const b = skipTo(i + 1, '{', end),
          j = close(b);
        if (j >= end) return null;
        let all = true;
        for (let k = b + 1; k < j; ) {
          const c = skipTo(k, '{', j),
            e = close(c);
          if (c >= j || e >= j) return null;
          all = all && block(c + 1, e);
          k = e + 1;
        }
        return [j + 1, all];
      }
      if (t === 'loop' || t === 'for' || t === 'while' || t === 'continuing') {
        const j = close(skipTo(i + 1, '{', end));
        return j < end ? [j + 1, false] : null;
      }
      const j = skipTo(i, ';', end);
      return j < end ? [j + 1, false] : null;
    };
    // Whether the statements from i to end return on every path (their last one does); null when not followed.
    const block = (i, end) => {
      let last = false;
      while (i < end) {
        const s = statement(i, end);
        if (!s || s[0] <= i) return null;
        [i, last] = s;
      }
      return last;
    };
    const gaps = [];
    for (let i = 0, depth = 0; i < n; i++) {
      const t = tokens[i].t;
      if (t === '{') depth++;
      else if (t === '}') depth--;
      if (depth || t !== 'fn' || !/^[A-Za-z_]/.test(tokens[i + 1]?.t ?? '') || tokens[i + 2]?.t !== '(') continue;
      const p = close(i + 2);
      if (tokens[p + 1]?.t !== '->') continue;
      const b = skipTo(p + 2, '{', n),
        e = close(b);
      if (e >= n) continue;
      if (block(b + 1, e) === false)
        gaps.push({ name: tokens[i + 1].t, line: text.slice(0, tokens[i].at).split('\n').length });
      i = e;
    }
    return gaps;
  };
  if (probe === 'returnGaps') return returnGaps;
  if (typeof GPUDevice === 'undefined' || GPUDevice.prototype.createShaderModule.margoWgslGuard) return;
  const create = GPUDevice.prototype.createShaderModule,
    seen = new Set(),
    hash = (s) => {
      let h = 0x811c9dc5;
      for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
      return (h >>> 0).toString(16).padStart(8, '0') + s.length.toString(16);
    };
  const guarded = function (descriptor) {
    const module = create.call(this, descriptor),
      code = typeof descriptor?.code === 'string' ? descriptor.code : '',
      key = hash(code),
      // Asked at creation, for every module: Chromium (Edge 156 here) leaves a getCompilationInfo() asked later, once
      // the device has gone idle, pending until some other GPU request runs, and a suite that awaited one sat until
      // its lock limit (material-extension-tests.js). A module's compilation info never changes, so each later call
      // gets this answer. Engine code must ask at creation itself (tests/compilation-info-at-creation.test.js).
      compiled = module.getCompilationInfo();
    compiled.catch(() => {});
    module.getCompilationInfo = () => compiled;
    // scripts/check-wgsl.mjs compiles fragments on purpose and judges them itself.
    const label = String(descriptor?.label ?? '');
    if (!seen.has(key) && !label.startsWith('check-wgsl:')) {
      seen.add(key);
      console.debug(`[wgsl] module ${key}`);
      // Kept until settled, so a harness can wait for every report (scripts/browser.js close()); the ones still
      // waiting are named in __margoWgslPending, so a report that never arrives names its module (settleWgslReports).
      const pending = (globalThis.__margoWgslPending ??= new Map()),
        id = globalThis.__margoWgslReports?.length ?? 0;
      pending.set(id, label || key);
      const report = compiled.then((info) => {
        const lines = code.split('\n'),
          errors = info.messages.filter((m) => m.type === 'error');
        if (label.startsWith('expect-error:')) {
          console.debug(errors.length ? `[wgsl] expected ${label}` : `[wgsl] unexpected-success ${label}`);
          return;
        }
        for (const m of errors)
          console.error(
            `[wgsl] error ${descriptor.label ?? key} ${m.lineNum}:${m.linePos} ${m.message} | ${(lines[m.lineNum - 1] ?? '').trim().slice(0, 160)}`,
          );
        for (const gap of returnGaps(code))
          console.error(
            `[wgsl] error ${descriptor.label ?? key} ${gap.line}:1 function '${gap.name}' returns a value but does not end in a return on every path; Firefox rejects it (KB-FF1b) | ${(lines[gap.line - 1] ?? '').trim().slice(0, 160)}`,
          );
      });
      (globalThis.__margoWgslReports ??= []).push(report.catch(() => {}).finally(() => pending.delete(id)));
    }
    return module;
  };
  guarded.margoWgslGuard = true;
  GPUDevice.prototype.createShaderModule = guarded;
}

/**
 * The value-returning WGSL functions in `code` that do not end in a return on every path, as Firefox requires
 * (KB-FF1b): [{ name, line }]. The same check the guard runs on every module a browser check creates.
 * @type {(code: string) => { name: string, line: number }[]}
 */
export const wgslReturnGaps = wgslGuard('returnGaps');

/** How long `settleWgslReports` waits for a page's compilation reports before it throws. */
export const WGSL_SETTLE_MS = 30_000;

/**
 * Waits for every compilation report `wgslGuard` started in `page`, so a suite reads them all before it judges. Bounded:
 * the wait was a bare `page.evaluate`, which has no time limit, so a report that never arrived (the GPU process never
 * answered `getCompilationInfo`) or a page whose main thread never answered held a suite whose every assertion passed
 * until the runner killed it ("no result after 600 s"). Past `budgetMs` it throws an error with code `SHUTDOWN_TIMEOUT`
 * naming the modules whose reports are still out, or saying that the page itself did not answer. A page that is gone
 * (closed or crashed) has no reports left to read; its loss was reported where it happened.
 * @param {{ evaluate(fn: () => unknown): Promise<unknown> }} page
 */
export async function settleWgslReports(page, { budgetMs = WGSL_SETTLE_MS } = {}) {
  let timer;
  const after = (ms) => new Promise((resolve) => (timer = setTimeout(() => resolve('late'), ms)));
  const outcome = await Promise.race([
    page
      .evaluate(() => Promise.all(globalThis.__margoWgslReports ?? []))
      .then(
        () => 'done',
        () => 'gone',
      ),
    after(budgetMs),
  ]);
  clearTimeout(timer);
  if (outcome !== 'late') return;
  // A second, short question tells a report that never came from a page that answers nothing.
  const pending = await Promise.race([
    page.evaluate(() => [...(globalThis.__margoWgslPending?.values() ?? [])]).catch(() => null),
    after(2000).then(() => null),
  ]);
  clearTimeout(timer);
  // They came after all, just late.
  if (pending?.length === 0) return;
  const error = new Error(
    pending
      ? `the compilation info of ${pending.length} shader module(s) never arrived within ${budgetMs} ms: ${pending.slice(0, 10).join(', ')}. The GPU process never answered getCompilationInfo for them; find what holds it (a pipeline compile or device request that never settled)`
      : `the page did not answer within ${budgetMs} ms while the suite waited for its WGSL compilation reports: its main thread is blocked or its renderer hung`,
  );
  error.code = 'SHUTDOWN_TIMEOUT';
  error.open = pending ? pending.map((name) => `compilation info of ${name}`) : ['page'];
  throw error;
}

/**
 * Collects a page's `[wgsl]` reports: `modules` (distinct sources compiled), `errors` (messages), `expected` (labels of
 * `expect-error:` modules that failed as declared) and `unexpected` (those that compiled cleanly, also a failure). Call
 * before the first navigation.
 */
export function watchWgsl(page) {
  const modules = new Set(),
    errors = [],
    expected = [],
    unexpected = [];
  page.on('console', (m) => {
    const text = m.text();
    if (!text.startsWith('[wgsl] ')) return;
    if (text.startsWith('[wgsl] module ')) modules.add(text.slice(14));
    else if (text.startsWith('[wgsl] error ')) errors.push(text.slice(13));
    else if (text.startsWith('[wgsl] expected ')) expected.push(text.slice(16));
    else if (text.startsWith('[wgsl] unexpected-success ')) unexpected.push(text.slice(26));
  });
  return { modules, errors, expected, unexpected };
}
