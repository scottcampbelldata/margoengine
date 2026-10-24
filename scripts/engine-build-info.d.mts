/** Vite plugin that stamps the engine commit from <app>/.engine/manifest.json into a Margo app's build. */
export function engineBuildInfo(options?: { root?: string; app?: string }): {
  name: string;
  config(config: unknown, env: { command: string }): { define: Record<string, string> } | undefined;
  transformIndexHtml(html: string): string;
  generateBundle(this: { emitFile(file: { type: 'asset'; fileName: string; source: string }): string }): void;
};
