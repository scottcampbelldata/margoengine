// @ts-check
// `margo-convert mobile`: a Capacitor-compatible project from a built app folder (its index.html): capacitor.config.json,
// a package.json that names the Capacitor packages without installing them, the web assets in webDir with
// viewport-fit=cover and the safe-area / orientation runtime injected, and a README with the native orientation keys.
// No native platform folders: `npx cap add android|ios` makes them. Clean room, from public docs (README "Mobile apps"):
// Capacitor configuration schema, W3C Screen Orientation, W3C CSS Environment Variables, Android manifest
// `screenOrientation`, Apple Info.plist `UISupportedInterfaceOrientations`.
import { copyFile, cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { margoError } from './paths.js';

const HELP = 'see https://margoengine.com/errors#mobile';
const RUNTIME_FILE = 'margo-mobile-runtime.js';

/** @typedef {'portrait' | 'landscape' | 'any'} MobileOrientation */

/**
 * @typedef {object} MobileOptions
 * @property {string} input A built app folder with an `index.html`.
 * @property {string} [out] The project folder, default `mobile`. Its `www` (webDir) is replaced.
 * @property {string} appId Reverse-DNS id, `com.example.game`: two or more dot-separated segments, each starting with a
 * letter and holding letters, digits and underscores (Android's package-name rule, which is stricter than iOS's).
 * @property {string} [appName] Name under the icon, default the input folder's name.
 * @property {string} [version] `package.json` version, default `1.0.0`.
 * @property {MobileOrientation} [orientation] Default `any`.
 * @property {string} [backgroundColor] Web view and launch colour, `#rgb`, `#rrggbb` or `#rrggbbaa`, default `#000000`.
 * @property {{style?: 'default' | 'light' | 'dark', backgroundColor?: string}} [statusBar] Style names Capacitor's
 * StatusBar plugin: `dark` is light text for a dark page. Default `{style: 'default'}`.
 * @property {{backgroundColor?: string, duration?: number, image?: string}} [splash] Splash colour (default the
 * background colour), `launchShowDuration` in ms (default 500) and an optional image copied to `resources/`.
 * @property {string} [icon] A PNG (1024 x 1024 recommended) copied to `resources/icon.png` for `@capacitor/assets`.
 * @property {string | false} [safeAreaCanvas] CSS selector of the canvas the injected script fits inside the safe area,
 * default `canvas`; false only sets the CSS variables and the lock.
 * @property {string} [capacitorVersion] Version range of every `@capacitor/*` dependency, default `^7.0.0`.
 * @property {AbortSignal} [signal]
 */

/**
 * @typedef {object} MobileReport
 * @property {string} out the project folder
 * @property {string} webDir `www`
 * @property {string[]} files every file written, relative to `out`
 * @property {string} appId
 * @property {MobileOrientation} orientation
 * @property {{androidScreenOrientation: string, iosOrientations: string[]}} native the keys to set after `cap add`
 */

const ORIENTATIONS = {
  portrait: { android: 'portrait', ios: ['UIInterfaceOrientationPortrait'] },
  landscape: {
    android: 'sensorLandscape',
    ios: ['UIInterfaceOrientationLandscapeLeft', 'UIInterfaceOrientationLandscapeRight'],
  },
  any: {
    android: 'fullSensor',
    ios: ['UIInterfaceOrientationPortrait', 'UIInterfaceOrientationLandscapeLeft', 'UIInterfaceOrientationLandscapeRight'],
  },
};

/** @param {string} id */
export const isAppId = (id) => typeof id === 'string' && /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(id);

/** @param {string} value @param {string} name @returns {string} #RRGGBB or #RRGGBBAA */
function color(value, name) {
  if (typeof value !== 'string' || !/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value))
    throw new RangeError(`Mobile ${name} must be #rgb, #rrggbb or #rrggbbaa, got ${value}; ${HELP}`);
  const hex = value.slice(1);
  return `#${(hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex).toUpperCase()}`;
}

/** @param {string} text @returns {string} text safe inside a double-quoted attribute or an XML text node */
const xml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Adds viewport-fit=cover to the page's viewport meta (or adds the meta) and the runtime start script.
 * @param {string} html @param {MobileOrientation} orientation @param {string | false} canvas
 */
export function injectMobile(html, orientation, canvas) {
  const meta = /<meta\b[^>]*\bname\s*=\s*["']?viewport["']?[^>]*>/i.exec(html);
  if (meta) {
    const tag = meta[0];
    const content = /\bcontent\s*=\s*(["'])(.*?)\1/i.exec(tag);
    let fixed;
    if (!content) fixed = tag.replace(/\/?>$/, ' content="width=device-width, initial-scale=1, viewport-fit=cover">');
    else {
      const parts = content[2].split(',').map((p) => p.trim()).filter((p) => p && !/^viewport-fit\s*=/i.test(p));
      fixed = tag.replace(content[0], `content=${content[1]}${[...parts, 'viewport-fit=cover'].join(', ')}${content[1]}`);
    }
    html = html.replace(tag, fixed);
  } else {
    const tag = '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">';
    html = /<head\b[^>]*>/i.test(html) ? html.replace(/<head\b[^>]*>/i, (m) => `${m}\n${tag}`) : `${tag}\n${html}`;
  }
  const select = canvas === false ? 'null' : `document.querySelector(${JSON.stringify(canvas).replace(/</g, '\\u003c')})`;
  const script =
    `<script type="module">\nimport { startMobile } from './${RUNTIME_FILE}';\n` +
    `startMobile({ orientation: ${JSON.stringify(orientation)}, canvas: ${select} ?? undefined });\n</script>`;
  return /<\/body\s*>/i.test(html) ? html.replace(/<\/body\s*>/i, () => `${script}\n</body>`) : `${html}\n${script}\n`;
}

/**
 * Writes the Capacitor project. Throws a MargoError (`failed`) for a bad appId or a missing index.html, a RangeError for
 * a bad option and the signal's reason when `signal` aborts.
 * @param {MobileOptions} options
 * @returns {Promise<MobileReport>}
 */
export async function buildMobile(options) {
  if (!options || typeof options.input !== 'string' || !options.input)
    throw new TypeError('buildMobile needs {input, appId}: a built app folder and a reverse-DNS app id');
  const { signal } = options;
  signal?.throwIfAborted();
  if (!isAppId(options.appId))
    throw margoError(
      'failed',
      `Mobile appId ${JSON.stringify(options.appId)} is not a reverse-DNS id; use two or more dot-separated words that start with a letter, like com.example.game; ${HELP}`,
    );
  const orientation = options.orientation ?? 'any';
  if (!(orientation in ORIENTATIONS))
    throw new RangeError(`Mobile orientation must be portrait, landscape or any, got ${orientation}; ${HELP}`);
  const background = color(options.backgroundColor ?? '#000000', 'backgroundColor');
  const barStyle = options.statusBar?.style ?? 'default';
  if (!['default', 'light', 'dark'].includes(barStyle))
    throw new RangeError(`Mobile statusBar.style must be default, light or dark, got ${barStyle}; ${HELP}`);
  const barColor = options.statusBar?.backgroundColor ? color(options.statusBar.backgroundColor, 'statusBar.backgroundColor') : undefined;
  const splashColor = color(options.splash?.backgroundColor ?? background, 'splash.backgroundColor');
  const duration = options.splash?.duration ?? 500;
  if (!Number.isInteger(duration) || duration < 0) throw new RangeError(`Mobile splash.duration must be a whole number of ms, got ${duration}; ${HELP}`);
  const capVersion = options.capacitorVersion ?? '^7.0.0';
  const safeCanvas = options.safeAreaCanvas ?? 'canvas';

  const input = resolve(options.input);
  const out = resolve(options.out ?? 'mobile');
  const page = resolve(input, 'index.html');
  if (!(await stat(page).catch(() => null))?.isFile())
    throw margoError('failed', `Mobile input has no index.html in ${input}; build the app first (vite build); ${HELP}`);
  const rel = relative(input, out);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)))
    throw margoError('failed', `Mobile out ${out} is the input folder or inside it; choose a folder outside it; ${HELP}`);
  for (const extra of [options.icon, options.splash?.image])
    if (extra && !(await stat(resolve(extra)).catch(() => null))?.isFile())
      throw margoError('failed', `Mobile icon or splash image ${extra} does not exist; ${HELP}`);

  const appName = options.appName ?? (basename(input) || 'Margo App');
  const webDir = 'www';
  const www = resolve(out, webDir);
  await rm(www, { recursive: true, force: true });
  await mkdir(www, { recursive: true });
  signal?.throwIfAborted();
  /** @type {string[]} */ const copied = [];
  await cp(input, www, {
    recursive: true,
    filter: (src) => {
      const name = basename(src);
      if (src !== input && (name.startsWith('.') || name === 'node_modules' || name.endsWith('.map'))) return false;
      if (extname(src)) copied.push(relative(input, src).split(/[\\/]/).join('/'));
      return true;
    },
  });
  signal?.throwIfAborted();
  await writeFile(resolve(www, 'index.html'), injectMobile(await readFile(resolve(www, 'index.html'), 'utf8'), orientation, safeCanvas));
  await copyFile(resolve(dirname(fileURLToPath(import.meta.url)), 'mobile-runtime.js'), resolve(www, RUNTIME_FILE));

  const native = { androidScreenOrientation: ORIENTATIONS[orientation].android, iosOrientations: ORIENTATIONS[orientation].ios };
  const files = [...new Set([...copied, RUNTIME_FILE, 'index.html'])].map((f) => `${webDir}/${f}`);
  /** @param {string} path @param {string} text */
  const put = async (path, text) => {
    await writeFile(resolve(out, path), text);
    files.push(path);
  };
  const config = {
    appId: options.appId,
    appName,
    webDir,
    backgroundColor: background,
    plugins: {
      SplashScreen: { backgroundColor: splashColor, launchShowDuration: duration },
      StatusBar: { style: barStyle.toUpperCase(), ...(barColor ? { backgroundColor: barColor } : {}) },
    },
    // Capacitor defines no orientation key; the lock is native (README) and at run time (margo-mobile-runtime.js).
    margo: { orientation, ...native },
  };
  await put('capacitor.config.json', `${JSON.stringify(config, null, 2)}\n`);
  const pkg = {
    name: appName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'margo-app',
    version: options.version ?? '1.0.0',
    private: true,
    description: `${appName}, a Capacitor wrapper made by margo-convert mobile`,
    scripts: { 'add:android': 'cap add android', 'add:ios': 'cap add ios', sync: 'cap sync', 'open:android': 'cap open android', 'open:ios': 'cap open ios' },
    dependencies: Object.fromEntries(
      ['core', 'cli', 'android', 'ios', 'splash-screen', 'status-bar'].map((n) => [`@capacitor/${n}`, capVersion]),
    ),
  };
  await put('package.json', `${JSON.stringify(pkg, null, 2)}\n`);
  if (options.icon) {
    await mkdir(resolve(out, 'resources'), { recursive: true });
    await copyFile(resolve(options.icon), resolve(out, 'resources', 'icon.png'));
    files.push('resources/icon.png');
  }
  if (options.splash?.image) {
    await mkdir(resolve(out, 'resources'), { recursive: true });
    await copyFile(resolve(options.splash.image), resolve(out, 'resources', 'splash.png'));
    files.push('resources/splash.png');
  }
  const ios = native.iosOrientations.map((o) => `    <string>${o}</string>`).join('\n');
  await put(
    'README.md',
    `# ${xml(appName)}

A Capacitor project made by \`margo-convert mobile\`. Nothing is installed and there are no native folders yet.

\`\`\`sh
npm install
npx cap add android      # and/or: npx cap add ios
npx cap sync
npx cap open android     # Android Studio, or: npx cap open ios (Xcode)
\`\`\`

Orientation: ${orientation}. The page locks itself with \`screen.orientation.lock\` where the web view allows it; set the
native keys too, so the app starts in the right orientation.

Android, \`android/app/src/main/AndroidManifest.xml\`, on the main \`<activity>\`:

\`\`\`xml
android:screenOrientation="${native.androidScreenOrientation}"
\`\`\`

iOS, \`ios/App/App/Info.plist\` (\`UISupportedInterfaceOrientations\`; the iPad key is \`UISupportedInterfaceOrientations~ipad\`):

\`\`\`xml
<key>UISupportedInterfaceOrientations</key>
<array>
${ios}
</array>
\`\`\`
${options.icon || options.splash?.image ? '\nIcon and splash images are in `resources/`; `npx @capacitor/assets generate` makes the native sizes.\n' : ''}`,
  );
  return { out, webDir, files, appId: options.appId, orientation, native };
}

export const MOBILE_USAGE = `Usage: margo-convert mobile <built-app-folder> --app-id com.example.game [--out mobile] [options]

Writes a Capacitor project (capacitor.config.json, package.json, www/ with the app, README.md) without installing
anything or making native folders; then run npx cap add android|ios.

Options:
  --app-id <id>           reverse-DNS app id (required)
  --app-name <text>       name under the icon (default the folder's name)
  --out <folder>          project folder (default mobile)
  --orientation <o>       portrait | landscape | any (default any)
  --background <#hex>     web view and launch colour (default #000000)
  --status-bar <style>    default | light | dark (default default)
  --status-bar-color <#hex>
  --splash-color <#hex>   default the background colour
  --splash-duration <ms>  default 500
  --splash-image <png>    copied to resources/splash.png
  --icon <png>            copied to resources/icon.png
  --canvas <selector|none> canvas fitted inside the safe area (default canvas)
  --version <semver>      package.json version (default 1.0.0)
  --capacitor <range>     version range of the @capacitor packages (default ^7.0.0)
  --json                  print the report as JSON
  --quiet                 print nothing on success
  --help                  this text`;

/**
 * Runs `margo-convert mobile`.
 * @param {string[]} argv arguments after the mode
 * @returns {Promise<number>} the exit code
 */
export async function runMobile(argv) {
  const { parseArgs } = await import('node:util');
  const fail = (/** @type {string} */ message) => {
    console.error(`margo-convert mobile: ${message}`);
    return 1;
  };
  /** @type {Record<string, any>} */ let values;
  /** @type {string[]} */ let positionals;
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        'app-id': { type: 'string' },
        'app-name': { type: 'string' },
        out: { type: 'string' },
        orientation: { type: 'string' },
        background: { type: 'string' },
        'status-bar': { type: 'string' },
        'status-bar-color': { type: 'string' },
        'splash-color': { type: 'string' },
        'splash-duration': { type: 'string' },
        'splash-image': { type: 'string' },
        icon: { type: 'string' },
        canvas: { type: 'string' },
        version: { type: 'string' },
        capacitor: { type: 'string' },
        json: { type: 'boolean' },
        quiet: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (error) {
    return fail(`${error instanceof Error ? error.message : error}\n\n${MOBILE_USAGE}`);
  }
  if (values.help) {
    console.log(MOBILE_USAGE);
    return 0;
  }
  if (positionals.length !== 1) return fail(`expected one built app folder\n\n${MOBILE_USAGE}`);
  try {
    const report = await buildMobile({
      input: positionals[0],
      out: values.out,
      appId: values['app-id'],
      appName: values['app-name'],
      orientation: values.orientation,
      backgroundColor: values.background,
      statusBar: { style: values['status-bar'], backgroundColor: values['status-bar-color'] },
      splash: {
        backgroundColor: values['splash-color'],
        duration: values['splash-duration'] === undefined ? undefined : Number(values['splash-duration']),
        image: values['splash-image'],
      },
      icon: values.icon,
      safeAreaCanvas: values.canvas === 'none' ? false : values.canvas,
      version: values.version,
      capacitorVersion: values.capacitor,
    });
    if (values.json) console.log(JSON.stringify(report, null, 2));
    else if (!values.quiet)
      console.log(`mobile: ${report.files.length} files in ${report.out}; next: cd ${report.out} && npm install && npx cap add android`);
    return 0;
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}
