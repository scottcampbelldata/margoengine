import { Engine } from "@margoengine/core";
import { parseUSDZ, parseUSDA } from "@margoengine/usdz";
const status = document.querySelector<HTMLParagraphElement>("#status")!,
  input = document.querySelector<HTMLInputElement>("input")!;
let engine: Awaited<ReturnType<typeof Engine.create>> | undefined,
  model:
    Awaited<ReturnType<ReturnType<typeof parseUSDA>["create"]>> | undefined,
  request: AbortController | undefined;
try {
  engine = await Engine.create(document.querySelector("canvas")!, {
    backend: "webgpu",
  });
  engine.start();
  model = await parseUSDA(
    `#usda 1.0\n(\n metersPerUnit = 1\n)\ndef Mesh "Triangle"\n{\n point3f[] points = [(-1,0,0),(1,0,0),(0,1,0)]\n int[] faceVertexCounts = [3]\n int[] faceVertexIndices = [0,1,2]\n uniform token subdivisionScheme = "none"\n}`,
  ).create(engine);
  status.textContent = "Sample loaded. Choose a static USDA/USDC USDZ model.";
  input.onchange = () => {
    request?.abort();
    const file = input.files?.[0];
    if (!file) return;
    const controller = (request = new AbortController());
    void (async () => {
      if (file.size > 64 * 1024 * 1024)
        throw new RangeError("File exceeds 64 MiB");
      const asset = await parseUSDZ(await file.arrayBuffer(), {
        signal: controller.signal,
      });
      const next = await asset.create(engine!, { signal: controller.signal });
      if (controller.signal.aborted) {
        next.destroy();
        return;
      }
      model?.destroy();
      model = next;
      status.textContent = `Loaded ${asset.meshes.length} meshes`;
    })().catch((error) => {
      if (!controller.signal.aborted) status.textContent = String(error);
    });
  };
} catch (error) {
  status.textContent = String(error);
}
function dispose() {
  request?.abort();
  input.onchange = null;
  engine?.dispose();
}
window.addEventListener("pagehide", dispose, { once: true });
if (import.meta.hot)
  import.meta.hot.dispose(() => {
    window.removeEventListener("pagehide", dispose);
    dispose();
  });
