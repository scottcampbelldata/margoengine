// Opens a model in the phone's own AR viewer where WebXR is absent. iOS Safari has no WebXR, so a USDZ opens in AR
// Quick Look through an anchor with rel="ar" and an <img> child (Apple, "Viewing Augmented Reality Assets in Safari
// for iOS", developer.apple.com/augmented-reality/quick-look/; the `allowsContentScaling` and `canonicalWebPageURL`
// fragment parameters). Android Chrome without WebXR opens Google's Scene Viewer through an intent URL (Google,
// "Scene Viewer", developers.google.com/ar/develop/scene-viewer: `file`, `mode`, `title`, `link`, `sound`,
// `resizable`, `enable_vertical_placement`, `S.browser_fallback_url`). Anything else gets a fallback you choose.
// The USDZ comes from `exportUSDZ` (@margoengine/exporters/usdz); the GLB from `exportGLB`.
import { margoError } from '../../shared/errors.js';

/** Where an AR view can be shown. 'webxr' means use an `XR` session instead of this entry. */
export type ARRoute = 'webxr' | 'quick-look' | 'scene-viewer' | 'none';
/** What {@link chooseARRoute} reads; each defaults to the browser's own value. */
export interface ARPlatform {
  /** `navigator.userAgent`. */
  userAgent?: string;
  /** Whether `document.createElement('a').relList.supports('ar')`. */
  quickLook?: boolean;
  /** Whether the browser supports an 'immersive-ar' session. */
  webxr?: boolean;
}
/** Options for {@link sceneViewerURL}. */
export interface SceneViewerOptions {
  /** 'ar_preferred' starts in AR with a 3D switch, '3d_preferred' in 3D with an AR button, '3d_only' never offers AR. Default 'ar_preferred'. */
  mode?: 'ar_preferred' | '3d_preferred' | '3d_only';
  /** Name in the viewer, cut to 60 characters. Default none. */
  title?: string;
  /** Adds a button that opens this page. Default none. */
  link?: string;
  /** Looping audio synced to the first animation. Default none. */
  sound?: string;
  /** False stops pinch scaling in AR. Default true. */
  resizable?: boolean;
  /** True lets the model stand on a wall. Default false. */
  verticalPlacement?: boolean;
  /** Page Chrome opens when the Google app is missing. Default the current page. */
  fallbackUrl?: string;
}
/** Options for {@link quickLookURL}. */
export interface QuickLookOptions {
  /** False stops pinch scaling. Default true. */
  allowsContentScaling?: boolean;
  /** The page Quick Look's share button shares instead of the file. Default none. */
  canonicalWebPageURL?: string;
}
/** Options for {@link launchAR}. */
export interface LaunchAROptions extends SceneViewerOptions, QuickLookOptions {
  /** The model for iOS: a URL of a .usdz, or its bytes (made into a short-lived blob URL). */
  usdz?: string | Blob | Uint8Array;
  /** The model for Android: an https URL of a .glb or .gltf. Scene Viewer cannot read a blob. */
  glb?: string;
  /** The preview picture Quick Look needs inside its link. Default a 1 pixel transparent image. */
  poster?: string;
  /** Platform facts; default read from the browser. */
  platform?: ARPlatform;
  /** Where to send a device with neither viewer. Default: resolves with 'none' and does nothing. */
  fallback?: (route: ARRoute) => void;
}

const MODES = ['ar_preferred', '3d_preferred', '3d_only'];

/**
 * Resolves `value` against the page's base URI and returns it when its scheme is https or http (blob too, where `blob`
 * is set). An absolute URL comes back as written, a relative one resolved. A `javascript:` or `data:` href on the
 * clicked anchor would run in the page, so every URL this entry puts into a link or intent goes through here.
 * @throws MargoError code 'unsupported' for any other scheme or a value that is not a URL.
 */
function safeURL(value: unknown, what: string, blob = false): string {
  let url: URL;
  try {
    url = new URL(String(value), globalThis.document?.baseURI ?? globalThis.location?.href);
  } catch {
    throw margoError('unsupported', `${what} must be an https URL`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:' && !(blob && url.protocol === 'blob:'))
    throw margoError('unsupported', `${what} must be an http, https or (for the usdz) blob URL, not ${url.protocol}`);
  return /^[a-z][a-z0-9+.-]*:/i.test(String(value)) ? String(value) : url.href;
}

const TINY = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/** Picks the route: WebXR where it exists, else Quick Look on iOS, Scene Viewer on Android, else 'none'. */
export function chooseARRoute(platform: ARPlatform = {}): ARRoute {
  if (platform.webxr) return 'webxr';
  const ua = platform.userAgent ?? globalThis.navigator?.userAgent ?? '';
  // Only Safari on iOS and iPadOS answers relList.supports('ar'), whatever user agent an iPad sends.
  const quickLook =
    platform.quickLook ??
    (typeof document !== 'undefined' ? !!document.createElement('a').relList?.supports?.('ar') : false);
  if (quickLook) return 'quick-look';
  return /Android/.test(ua) ? 'scene-viewer' : 'none';
}

/** The href of a Quick Look link: the USDZ URL with its options in the fragment. */
export function quickLookURL(usdz: string, options: QuickLookOptions = {}): string {
  if (!usdz) throw new RangeError('quickLookURL needs the URL of a .usdz');
  usdz = safeURL(usdz, 'the usdz URL', true);
  const parts: string[] = [];
  if (options.allowsContentScaling === false) parts.push('allowsContentScaling=0');
  if (options.canonicalWebPageURL)
    parts.push(
      'canonicalWebPageURL=' + encodeURIComponent(safeURL(options.canonicalWebPageURL, 'canonicalWebPageURL')),
    );
  return parts.length ? `${usdz.split('#')[0]}#${parts.join('&')}` : usdz;
}

/**
 * The Android intent URL that opens `glb` in Scene Viewer (the Google app), with a browser fallback.
 * @throws MargoError code 'unsupported' when `glb`, `link`, `sound` or `fallbackUrl` is not an http or https URL
 * (relative ones resolve against the page): `javascript:`, `data:`, `vbscript:`, `file:` and `blob:` are refused.
 * @throws RangeError for a `mode` outside 'ar_preferred', '3d_preferred' and '3d_only'.
 */
export function sceneViewerURL(glb: string, options: SceneViewerOptions = {}): string {
  const { mode = 'ar_preferred', title, link, sound, resizable, verticalPlacement, fallbackUrl } = options;
  if (!MODES.includes(mode)) throw new RangeError(`mode must be one of ${MODES.join(', ')}`);
  const q = ['file=' + encodeURIComponent(safeURL(glb, 'glb')), 'mode=' + encodeURIComponent(mode)];
  if (title) q.push('title=' + encodeURIComponent(title.slice(0, 60)));
  if (link) q.push('link=' + encodeURIComponent(safeURL(link, 'link')));
  if (sound) q.push('sound=' + encodeURIComponent(safeURL(sound, 'sound')));
  if (resizable === false) q.push('resizable=false');
  if (verticalPlacement) q.push('enable_vertical_placement=true');
  const back = safeURL(fallbackUrl ?? globalThis.location?.href ?? glb, 'fallbackUrl');
  return (
    `intent://arvr.google.com/scene-viewer/1.0?${q.join('&')}#Intent;scheme=https;` +
    `package=com.google.android.googlequicksearchbox;action=android.intent.action.VIEW;` +
    `S.browser_fallback_url=${encodeURIComponent(back)};end;`
  );
}

/**
 * Opens the model in the viewer the platform has. Call it from a tap: browsers block both viewers otherwise.
 * Resolves with the route used; 'webxr' and 'none' open nothing (the caller starts its XR session, or `fallback` runs).
 * @throws MargoError code 'state' when the route needs a model the options leave out.
 */
export function launchAR(options: LaunchAROptions = {}): ARRoute {
  const route = chooseARRoute(options.platform);
  if (route === 'quick-look') {
    const { usdz } = options;
    if (!usdz) throw margoError('state', 'launchAR on iOS needs `usdz`: a URL or the bytes from exportUSDZ');
    const blob = typeof usdz === 'string' ? null : new Blob([usdz as BlobPart], { type: 'model/vnd.usdz+zip' });
    const url = blob ? URL.createObjectURL(blob) : (usdz as string);
    const href = quickLookURL(url, options);
    const a = document.createElement('a');
    a.rel = 'ar';
    a.href = href;
    const img = document.createElement('img');
    img.src = options.poster ?? TINY;
    a.append(img);
    a.style.display = 'none';
    document.body.append(a);
    a.click();
    a.remove();
    // Quick Look reads the file when it opens; a blob URL is released a minute later.
    if (blob) setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } else if (route === 'scene-viewer') {
    if (!options.glb) throw margoError('state', 'launchAR on Android needs `glb`: an https URL of a .glb');
    globalThis.location.href = sceneViewerURL(options.glb, options);
  } else options.fallback?.(route);
  return route;
}
