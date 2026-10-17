import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { openBrowser } from './browser.js';
import { acquire } from './gpu-lock.mjs';
import { decodePNG } from '../tests/support/png.js';

const output = 'test-results/selection-loaded-child',
  readmePath =
    process.argv.find((argument) => argument.startsWith('--readme='))?.slice(9) ?? 'packages/selection/README.md',
  readme = await readFile(readmePath, 'utf8'),
  example = [...readme.matchAll(/```ts\r?\n([\s\S]*?)```/g)].find((match) =>
    match[1].includes('function selectModel('),
  )?.[1];
assert.ok(example, 'README must contain the selectModel TypeScript example');
const release = await acquire({ owner: 'selection-loaded-child' }),
  report = { readmePath, cases: [], checks: [] };
let browser;
const outline = (image, x, y) => {
  const i = (y * image.width + x) * 4;
  return image.data[i] > 240 && image.data[i + 1] < 15 && image.data[i + 2] > 240;
};
const inside = (x, y, bounds, pad = 5) =>
  x >= Math.floor(bounds[0]) - pad &&
  x <= Math.ceil(bounds[2]) + pad &&
  y >= Math.floor(bounds[1]) - pad &&
  y <= Math.ceil(bounds[3]) + pad;
function changes(reference, image, bounds, exclude) {
  let pixels = 0,
    outlines = 0,
    outside = 0;
  for (let y = 0; y < image.height; y++)
    for (let x = 0; x < image.width; x++) {
      if (exclude && inside(x, y, exclude)) continue;
      const i = (y * image.width + x) * 4,
        changed = [0, 1, 2, 3].some((channel) => image.data[i + channel] !== reference.data[i + channel]);
      if (!changed) continue;
      if (!bounds || inside(x, y, bounds)) pixels++;
      else outside++;
      if ((!bounds || inside(x, y, bounds)) && outline(image, x, y)) outlines++;
    }
  return { pixels, outlines, outside };
}
function check(name, assertions) {
  try {
    assertions();
    report.checks.push({ name, passed: true });
    console.log(`PASS ${name}`);
  } catch (error) {
    report.checks.push({ name, passed: false, error: error.message });
    console.error(`FAIL ${name}: ${error.message}`);
  }
}

try {
  await mkdir(output, { recursive: true });
  // Execute the exact working README example, rather than a second copy of its controller logic.
  await writeFile(`${output}/readme-example.ts`, example + '\nexport { selectModel };\n');
  console.log(`README controller source: ${readmePath}`);
  browser = await openBrowser({ startPath: '/tests/selection-loaded-child.html?samples=1', port: 5211 });
  const { page, hardware } = browser,
    errors = [];
  report.hardware = hardware;
  assert.equal(hardware.webgpu?.fallback, false, 'Physical WebGPU adapter required');
  assert.ok(hardware.webgpu?.vendor, 'Physical WebGPU vendor missing');
  page.on('pageerror', (error) => errors.push(error.message));
  for (const samples of [1, 4]) {
    if (samples === 4) {
      await page.evaluate(() => window.selectionLoadedChild.dispose());
      await page.goto(`http://127.0.0.1:5211/tests/selection-loaded-child.html?samples=${samples}`);
    }
    await page.waitForFunction(() => window.selectionLoadedChild);
    const capture = async (mode, label = mode) => {
      const state = await page.evaluate((mode) => window.selectionLoadedChild.frame(mode), mode),
        image = await decodePNG(
          await page.locator('canvas').screenshot({ path: `${output}/${samples}x-${label}.png` }),
        );
      assert.equal(state.sampleCount, samples, 'Requested sample count did not reach the scene');
      return { state, image };
    };
    const baseline = await capture('baseline'),
      child = await capture('child'),
      selectedRegions = child.state.regions.filter((region) => region.inChild),
      childBounds = [
        Math.min(...selectedRegions.map((region) => region.bounds[0])),
        Math.min(...selectedRegions.map((region) => region.bounds[1])),
        Math.max(...selectedRegions.map((region) => region.bounds[2])),
        Math.max(...selectedRegions.map((region) => region.bounds[3])),
      ],
      childChanges = changes(baseline.image, child.image, childBounds),
      siblings = child.state.regions
        .filter((region) => !region.inChild)
        .map((region) => ({
          name: region.name,
          ...changes(baseline.image, child.image, region.bounds, childBounds),
        }));
    check(
      `${samples}x README selectModel.pick(115,226) -> FridgeDoor child-only outline (${childChanges.outlines} outline pixels; ${child.state.nodes} nodes/${child.state.primitives} primitives)`,
      () => {
        assert.equal(child.state.controllerName, 'FridgeDoor', 'README controller must return the named loaded child');
        assert.equal(child.state.controllerMatchesHit, true, 'README controller result must equal Picking.pick().mesh');
        assert.equal(child.state.hitIsChild, true, 'Picking.pick().mesh must be the exact loaded child node');
        assert.equal(child.state.hitOwnsModel, true, 'Loaded child pixel lost owning model metadata');
        assert.equal(child.state.coreGeometries, 0, 'Fixture must use native loader PBR buffers');
        assert.ok(childChanges.outlines > 100, 'README child pick must draw the picked child outline');
        assert.equal(
          childChanges.outside,
          0,
          'README child pick must leave every pixel outside the selected child unchanged',
        );
        for (const sibling of siblings)
          assert.equal(sibling.pixels, 0, `README child pick must leave exposed ${sibling.name} pixels unchanged`);
      },
    );
    const root = await capture('root'),
      all = await capture('all-nodes'),
      rootOutsideChild = changes(baseline.image, root.image, undefined, childBounds);
    check(
      `${samples}x README selectModel.pick(207,144) -> FridgeCase root whole assembly (${rootOutsideChild.outlines} outline pixels outside child)`,
      () => {
        assert.equal(
          root.state.controllerName,
          'FridgeCase',
          'README root pick must return the actual loaded scene root',
        );
        assert.equal(root.state.controllerMatchesHit, true, 'README root result must equal Picking.pick().mesh');
        assert.equal(root.state.hitIsAssemblyRoot, true, 'Root hit must be the actual geometric scene root');
        assert.equal(
          root.state.hitIsLoaderWrapper,
          false,
          'Do not fabricate a hit on the non-geometric loader wrapper',
        );
        assert.equal(root.state.assemblyParentsChild, true);
        assert.equal(root.state.assemblyIsSceneRoot, true);
        assert.equal(root.state.rootHasPrimitive, true);
        assert.equal(
          Buffer.compare(root.image.data, all.image.data),
          0,
          'README root pick must equal outlining the whole assembly',
        );
        assert.ok(rootOutsideChild.outlines > 100, 'README root pick must outline the exposed case beyond the child');
      },
    );
    const childAfterRoot = await capture('child', 'child-after-root');
    check(`${samples}x README root -> FridgeDoor pixel -> exact child-only frame`, () => {
      assert.equal(
        childAfterRoot.state.controllerName,
        'FridgeDoor',
        'Repeated README child pick must return FridgeDoor',
      );
      assert.equal(childAfterRoot.state.controllerMatchesHit, true);
      assert.equal(
        Buffer.compare(child.image.data, childAfterRoot.image.data),
        0,
        'README root -> child pick must remove the stale assembly outline',
      );
    });
    const miss = await capture('miss'),
      missEqualsBaseline = Buffer.compare(baseline.image.data, miss.image.data) === 0;
    check(`${samples}x README child -> selectModel.pick(2,2) miss -> no outline`, () => {
      assert.equal(miss.state.controllerName, null, 'README background pick must return null');
      assert.equal(miss.state.controllerMatchesHit, true);
      assert.equal(
        missEqualsBaseline,
        true,
        'README miss must clear the previous selection and restore the baseline exactly',
      );
    });
    report.cases.push({
      samples,
      asset: child.state.asset,
      child: { ...child.state, bounds: childBounds, changes: childChanges, siblings },
      root: {
        ...root.state,
        fullFrameEqualsAllNodes: Buffer.compare(root.image.data, all.image.data) === 0,
        changesOutsideChild: rootOutsideChild,
      },
      childAfterRoot: {
        at: childAfterRoot.state.at,
        controllerName: childAfterRoot.state.controllerName,
        fullFrameEqualsChild: Buffer.compare(child.image.data, childAfterRoot.image.data) === 0,
      },
      miss: {
        at: miss.state.at,
        controllerName: miss.state.controllerName,
        fullFrameEqualsBaseline: missEqualsBaseline,
      },
    });
  }
  assert.deepEqual(errors, [], 'Browser errors');
  await writeFile(`${output}/gpu.json`, JSON.stringify(report, null, 2) + '\n');
  console.log(
    JSON.stringify(
      {
        hardware: report.hardware,
        checks: report.checks.length,
        failures: report.checks.filter((check) => !check.passed).length,
        report: `${output}/gpu.json`,
      },
      null,
      2,
    ),
  );
  assert.equal(report.checks.filter((check) => !check.passed).length, 0, 'README pixel-picking selection regressions');
} finally {
  try {
    if (browser) {
      await browser.page.evaluate(() => window.selectionLoadedChild?.dispose()).catch(() => {});
      await browser.close();
    }
  } finally {
    release();
  }
}
