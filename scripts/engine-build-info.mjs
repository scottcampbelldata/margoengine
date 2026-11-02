// Vite plugin for Margo apps: stamps the prepared engine commit recorded in <app>/.engine/manifest.json
// into every build, as `<meta name="margo-engine" content="<commit>">` in index.html and `build-info.json` beside it,
// and as `import.meta.env.MARGO_ENGINE_COMMIT` for an About box.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * @param {{ root?: string, app?: string }} [options] `root` is the app folder (default the Vite root), `app` its
 * display name for build-info.json.
 */
export function engineBuildInfo(options = {}) {
  let manifest;
  let command = 'serve';
  return {
    name: 'margo-engine-build-info',
    config(_config, env) {
      command = env.command;
      const file = join(options.root ?? process.cwd(), '.engine', 'manifest.json');
      if (!existsSync(file)) {
        if (env.command === 'build') throw new Error(`${file} is missing; prepare the verified private engine dependency before building`);
        return;
      }
      manifest = JSON.parse(readFileSync(file, 'utf8'));
      return { define: { 'import.meta.env.MARGO_ENGINE_COMMIT': JSON.stringify(manifest.commit) } };
    },
    transformIndexHtml(html) {
      if (!manifest) return html;
      return html.replace('</head>', `  <meta name="margo-engine" content="${manifest.commit}">\n  </head>`);
    },
    generateBundle() {
      if (command !== 'build' || !manifest) return;
      this.emitFile({
        type: 'asset',
        fileName: 'build-info.json',
        source: `${JSON.stringify({ app: options.app ?? null, engineCommit: manifest.commit, enginePackages: manifest.packages }, null, 2)}\n`,
      });
    },
  };
}
