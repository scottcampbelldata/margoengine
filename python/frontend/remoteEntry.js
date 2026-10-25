// JupyterLab prebuilt-extension container for @margoengine/jupyter, written by hand (no webpack). JupyterLab loads
// this classic script from the extension's static folder, finds the container under window._JUPYTERLAB, calls
// init(shareScope) with the application's shared modules and get('./extension') for the plugin factory. The plugin
// takes @jupyter-widgets/base from the shared scope (so the widget classes extend the manager's own) and the figure
// code from margo-figure.js next to this file, an ES module loaded with import().
(() => {
  const here = document.currentScript?.src ?? location.href;
  let shared = {};
  // Highest version of a shared module: share scopes map version strings to { get() -> Promise<factory> }.
  const newest = (versions) =>
    Object.keys(versions).sort((a, b) => {
      const pa = a.split(/[.-]/).map(Number),
        pb = b.split(/[.-]/).map(Number);
      for (let k = 0; k < Math.max(pa.length, pb.length); k++) if ((pa[k] || 0) !== (pb[k] || 0)) return (pb[k] || 0) - (pa[k] || 0);
      return 0;
    })[0];
  const load = async (name) => {
    const versions = shared[name];
    if (!versions) throw new Error(`@margoengine/jupyter needs ${name}; install ipywidgets (jupyterlab_widgets) in this JupyterLab`);
    const factory = await versions[newest(versions)].get();
    return factory();
  };
  const container = {
    init(scope) {
      shared = scope;
    },
    async get(module) {
      if (module !== './extension') throw new Error(`@margoengine/jupyter has no module ${module}`);
      const [base, figure] = await Promise.all([load('@jupyter-widgets/base'), import(new URL('./margo-figure.js', here).href)]);
      return () => ({ __esModule: true, default: figure.extension(base) });
    },
  };
  window._JUPYTERLAB = window._JUPYTERLAB || {};
  window._JUPYTERLAB['@margoengine/jupyter'] = container;
})();
