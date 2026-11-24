// What happened to a browser driver's page when a check loses it (KB0043): "Execution context was destroyed" names
// no cause. `watchPageLoss(page)` keeps the page's own events (renderer crash with Chromium's exit status and code,
// close, a main-frame navigation) and a memory sample after each check, so a failed check can print why the page went.
/** Starts watching `page`; `now` is injectable for tests. */
export async function watchPageLoss(page, { now = () => Date.now() } = {}) {
  const events = [],
    samples = [],
    start = now(),
    at = () => now() - start,
    mainFrame = page.mainFrame?.();
  page.on('crash', () => events.push({ at: at(), event: 'crash' }));
  page.on('close', () => events.push({ at: at(), event: 'close' }));
  page.on('framenavigated', (frame) => {
    if (!mainFrame || frame === mainFrame) events.push({ at: at(), event: 'navigated', url: frame.url() });
  });
  let cdp;
  try {
    // Chromium only: the renderer's exit status and code (Inspector.targetCrashed carries neither).
    cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    cdp.on('Target.targetCrashed', ({ status, errorCode }) =>
      events.push({ at: at(), event: 'renderer exit', status, errorCode }),
    );
    cdp.on('Inspector.targetCrashed', () => events.push({ at: at(), event: 'inspector crash' }));
    await cdp.send('Target.setDiscoverTargets', { discover: true });
  } catch {
    cdp = undefined; // another browser: page events and the JS heap only
  }
  /** Records the renderer's memory after the check `name`. */
  async function sample(name) {
    const row = { at: at(), check: name };
    try {
      if (cdp) {
        const { metrics } = await cdp.send('Performance.getMetrics');
        for (const { name: key, value } of metrics)
          if (key === 'JSHeapUsedSize' || key === 'JSHeapTotalSize' || key === 'Documents' || key === 'Nodes') row[key] = value;
      } else row.JSHeapUsedSize = await page.evaluate(() => performance.memory?.usedJSHeapSize);
    } catch (error) {
      row.unavailable = String(error?.message ?? error).split('\n')[0];
    }
    samples.push(row);
    return row;
  }
  /** One line for a failed check: what the page did and the last memory samples. */
  function report(name, error) {
    const lost = /context was destroyed|Target (page, context or browser )?closed|crash/i.test(String(error?.message));
    return `page-loss ${JSON.stringify({ check: name, lost, events, memory: samples.slice(-3) })}`;
  }
  return { events, samples, sample, report };
}
