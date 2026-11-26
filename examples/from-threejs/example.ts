import type { EngineKernel } from '@margoengine/core';

/** What an example hands back: its engine, plus the controls the browser check drives. */
export interface ExampleHandle {
  engine: EngineKernel;
  [control: string]: unknown;
}

/** Builds one scene on `canvas`; `say` writes the status line. */
export type Example = (canvas: HTMLCanvasElement, say: (text: string) => void) => Promise<ExampleHandle>;
