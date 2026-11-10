// Python's bundled AFM adapter. The library entry keeps normal named exports for generated package aliases.
import { render as renderFigure, type NotebookRenderOptions } from '@margoengine/sciviz/notebook';
export function render(options: NotebookRenderOptions) {
  return renderFigure({
    prepareBackend: async (options) => {
      options.signal.throwIfAborted();
      const { install } = await import('@margoengine/webgl2-compat');
      options.signal.throwIfAborted();
      return install(options);
    },
    ...options,
  });
}
export default { render };
