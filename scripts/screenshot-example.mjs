import { chromium } from 'playwright';
import { closeAll } from './support/shutdown.mjs';
// Saves a screenshot of an example page served by `npm run dev:examples`, using SwiftShader WebGPU so it runs without a GPU.
// node scripts/screenshot-example.mjs http://127.0.0.1:5173/examples/split-screen.html out.png [width] [height] [waitMs]
const [url, out, w = 1280, h = 720, wait = 9000] = process.argv.slice(2);
const browser = await chromium.launch({
  channel: 'chromium',
  args: [
    '--enable-unsafe-webgpu',
    '--enable-unsafe-swiftshader',
    '--enable-features=Vulkan',
    '--use-vulkan=swiftshader',
    '--use-angle=swiftshader',
    '--use-webgpu-adapter=swiftshader',
    '--disable-dawn-features=disallow_unsafe_apis',
  ],
});
const page = await browser.newPage({ viewport: { width: +w, height: +h } });
page.on('pageerror', (e) => console.log('pageerror:', e.message));
await page.goto(url);
await page.waitForTimeout(+wait);
console.log(
  'status:',
  await page
    .locator('#status')
    .textContent()
    .catch(() => ''),
);
await page.screenshot({ path: out });
await closeAll({ browser });
