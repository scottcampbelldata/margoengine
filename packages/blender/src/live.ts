// @margoengine/blender/live: a running page follows an open Blender session. The add-on's live link (Margo panel,
// "Start live link") serves the newest export at <url>/scene.margo and announces each version on <url>/events as
// Server-Sent Events; margoLive fetches every announced version, attaches it, disposes the one before and yields it,
// so artists see the engine's result as they work.
import type { EngineKernel } from "@margoengine/core";
import type { PBRModel } from "@margoengine/gltf-pro/model";
import { fault } from "../../shared/errors.js";
import { readResponse } from "../../shared/loading.js";
import { maxBytes } from "./container.js";
import { parseMargo, type MargoOptions } from "./index.js";

/** Options of margoLive. */
export interface MargoLiveOptions extends MargoOptions {
  /** Ends the stream: the generator returns and disposes the model it attached last. */
  signal?: AbortSignal;
  /** Fetches each version (default `globalThis.fetch`). */
  fetch?: typeof fetch;
  /** Opens the event stream (default `globalThis.EventSource`). */
  EventSource?: typeof EventSource;
  /**
   * Attaches one version's bytes (default parseMargo). Pass `parseMargoPBR` from `@margoengine/blender/pbr-ext` for
   * transmission, coat, sheen and subsurface.
   */
  parse?: (
    engine: EngineKernel,
    bytes: Uint8Array<ArrayBuffer>,
    options: { signal?: AbortSignal; maxNodes?: number },
  ) => Promise<PBRModel>;
}

/**
 * Follows the live link at `url` (the address the add-on's panel shows, such as `http://127.0.0.1:8765/`): yields a
 * model for the version Blender holds now and one for each edit after it. Each yielded model is attached to `engine`;
 * the previous one is disposed just before the next is yielded, and the last when the loop ends (break, return,
 * a thrown error or `signal`, which also ends a load in flight). Edits that arrive while a version loads are coalesced: only the newest is fetched.
 * Rejects with a `failed` MargoError when the stream cannot be opened (an HTTP error or a reply that is not an event
 * stream). While Blender is closed the browser keeps reconnecting and the last model stays.
 *
 * @example
 * for await (const model of margoLive(engine, 'http://127.0.0.1:8765/', { signal })) console.log(model.nodes.length);
 */
export async function* margoLive(
  engine: EngineKernel,
  url: string | URL,
  {
    signal,
    maxNodes,
    fetch: get = globalThis.fetch,
    EventSource: Source = globalThis.EventSource,
    parse = parseMargo,
  }: MargoLiveOptions = {},
): AsyncGenerator<PBRModel, void, undefined> {
  signal?.throwIfAborted();
  const base = new URL(url, globalThis.location?.href);
  if (!["http:", "https:"].includes(base.protocol))
    throw new TypeError("Live link URL must use HTTP(S); pass the address the Blender add-on's Margo panel shows");
  if (typeof Source !== "function")
    throw fault("unsupported", "Live link needs EventSource; pass it in the EventSource option outside a browser");
  let wanted = 0,
    failure: Error | undefined,
    wake: (() => void) | undefined;
  const notify = () => {
    wake?.();
    wake = undefined;
  };
  const source = new Source(new URL("events", base).href);
  source.addEventListener("scene", (event) => {
    const version = Number((event as MessageEvent).data);
    if (Number.isSafeInteger(version) && version > wanted) wanted = version;
    notify();
  });
  source.addEventListener("error", () => {
    // EventSource reconnects by itself unless the server ended the stream for good (CLOSED).
    if (source.readyState === Source.CLOSED) {
      failure = fault("failed", `Live link at ${base.href} closed; start the live link in Blender again`);
      notify();
    }
  });
  const aborted = () => notify();
  signal?.addEventListener("abort", aborted);
  let model: PBRModel | undefined,
    shown = 0;
  try {
    for (;;) {
      while (wanted <= shown && !failure && !signal?.aborted) await new Promise<void>((resolve) => (wake = resolve));
      if (signal?.aborted) return;
      if (failure) throw failure;
      const version = wanted,
        target = new URL("scene.margo", base);
      target.searchParams.set("v", String(version));
      let next: PBRModel;
      try {
        const bytes = await readResponse(await get(target, { signal, cache: "no-store" }), {
          maxBytes,
          signal,
          label: "Live .margo download",
        });
        next = await parse(engine, bytes, { signal, maxNodes });
      } catch (error) {
        if (signal?.aborted) return;
        throw error;
      }
      model?.dispose();
      model = next;
      shown = version;
      yield model;
    }
  } finally {
    signal?.removeEventListener("abort", aborted);
    source.close();
    model?.dispose();
  }
}
