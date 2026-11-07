// Waiting for a cutscene check page, so that a page that never gets ready says why. The suites open the page with
// scripts/browser.js's openBrowser themselves (a file that does is named in test:gpu) and hand it here.

/**
 * Collects the page's errors from its first line: openBrowser has loaded the page before a suite can listen, so it is
 * loaded again here. Resolves the list, which grows as errors come.
 */
export async function watchPage(page) {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(message.text());
  });
  await page.reload();
  return pageErrors;
}

/**
 * Waits for `window.ready`. A timeout throws naming the page's errors, the page the server answered, its scripts, and
 * the folder the dev server serves (the directory the check runs in), which must hold the page.
 */
export async function waitReady(page, pageErrors, { timeout = 60_000, root = process.cwd() } = {}) {
  try {
    await page.waitForFunction(() => window.ready, null, { timeout });
  } catch (error) {
    const seen = await page
      .evaluate(() => ({
        url: location.href,
        status: performance.getEntriesByType('navigation')[0]?.responseStatus,
        title: document.title,
        scripts: [...document.scripts].map((script) => script.src).filter((src) => src && !src.includes('/@vite/')),
      }))
      .catch((failure) => ({ unreadable: String(failure?.message ?? failure) }));
    const own =
      seen.scripts?.length === 0 ? ' The page has no script of its own: the served folder may not hold it.' : '';
    throw new Error(
      `the page never set window.ready in ${timeout} ms. Page errors: ${pageErrors.length ? pageErrors.join(' | ') : 'none'}. ` +
        `Page: ${JSON.stringify(seen)}, served from ${root}.${own}`,
      { cause: error },
    );
  }
}
