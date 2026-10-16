import { MOUSE, TOUCH } from './orbit.js';

/** What a mouse drag does. `'rotate-or-pan'` rotates under a perspective camera and pans under an orthographic one (Rhino). */
export type DragAction = 'rotate' | 'pan' | 'dolly' | 'rotate-or-pan';
/** A view to snap to (direction from the target toward the camera), `'fit'` (dispatches a `fit` event) or `'projection'` (toggles a `@margoengine/cameras` projection). */
export type KeyAction = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom' | 'iso' | 'fit' | 'projection';

/**
 * A CAD tool's navigation bindings as data, applied with `orbit.setProfile(profile)`. Keys of `drag` and `keys` are
 * modifiers then the mouse button (0 left, 1 middle, 2 right) or `KeyboardEvent.code`: `'1'`, `'shift+1'`, `'ctrl+Digit1'`.
 * Modifiers are written in the order ctrl, shift, alt and must match exactly; Meta (Cmd) counts as ctrl.
 */
export interface NavigationProfile {
  readonly name: string;
  /** Drag bindings. Absent: three.js `mouseButtons` with its Ctrl/Meta/Shift swap (the default). */
  readonly drag?: Readonly<Record<string, DragAction>>;
  /** Copied to `mouseButtons` when there is no `drag` table. */
  readonly mouseButtons?: { LEFT: number | null; MIDDLE: number | null; RIGHT: number | null };
  readonly touches: { ONE: number | null; TWO: number | null };
  /** 1: wheel forward (away from you) zooms in, as in three.js. -1: forward zooms out. */
  readonly wheel: 1 | -1;
  readonly zoomToCursor: boolean;
  /** A double click of this button dispatches `fit`. */
  readonly fitClick?: 0 | 1 | 2;
  /** Keyboard bindings, active after `listenToKeyEvents(target)`. Arrow keys keep their three.js meaning. */
  readonly keys?: Readonly<Record<string, KeyAction>>;
  /** For `@margoengine/viewcube`: `flip` makes a click on the current view turn to the opposite one. */
  readonly viewCube?: { readonly flip?: boolean };
}

/** three.js OrbitControls, the default: left rotates, middle dollies, right pans; Ctrl/Meta/Shift + left pans. */
export const THREE_ORBIT: NavigationProfile = {
  name: 'three',
  mouseButtons: { LEFT: MOUSE.ROTATE, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.PAN },
  touches: { ONE: TOUCH.ROTATE, TWO: TOUCH.DOLLY_PAN },
  wheel: 1,
  zoomToCursor: false,
};

/** SolidWorks: middle rotates, Ctrl + middle pans, Shift + middle zooms, wheel zooms at the cursor (forward out), double middle click fits. */
export const SOLIDWORKS: NavigationProfile = {
  name: 'solidworks',
  drag: { '1': 'rotate', 'ctrl+1': 'pan', 'shift+1': 'dolly' },
  touches: { ONE: TOUCH.ROTATE, TWO: TOUCH.DOLLY_PAN },
  wheel: -1,
  zoomToCursor: true,
  fitClick: 1,
  viewCube: { flip: true },
  keys: {
    KeyF: 'fit',
    'ctrl+Digit1': 'front',
    'ctrl+Digit2': 'back',
    'ctrl+Digit3': 'left',
    'ctrl+Digit4': 'right',
    'ctrl+Digit5': 'top',
    'ctrl+Digit6': 'bottom',
    'ctrl+Digit7': 'iso',
  },
};

/** AutoCAD: middle pans, Shift + middle orbits, wheel zooms at the cursor (forward in), double middle click zooms extents. */
export const AUTOCAD: NavigationProfile = {
  name: 'autocad',
  drag: { '1': 'pan', 'shift+1': 'rotate' },
  touches: { ONE: TOUCH.PAN, TWO: TOUCH.DOLLY_PAN },
  wheel: 1,
  zoomToCursor: true,
  fitClick: 1,
};

/** Inventor and Fusion (identical defaults): middle pans, Shift + middle orbits, wheel zooms at the cursor, double middle click fits. */
export const INVENTOR: NavigationProfile = {
  name: 'inventor',
  drag: { '1': 'pan', 'shift+1': 'rotate' },
  touches: { ONE: TOUCH.ROTATE, TWO: TOUCH.DOLLY_PAN },
  wheel: 1,
  zoomToCursor: true,
  fitClick: 1,
};
export const FUSION = INVENTOR;

/** Blender: middle orbits, Shift + middle pans, Ctrl + middle zooms, wheel zooms to the view centre, numpad views. */
export const BLENDER: NavigationProfile = {
  name: 'blender',
  drag: { '1': 'rotate', 'shift+1': 'pan', 'ctrl+1': 'dolly' },
  touches: { ONE: TOUCH.ROTATE, TWO: TOUCH.DOLLY_PAN },
  wheel: 1,
  zoomToCursor: false,
  viewCube: { flip: true },
  keys: {
    Numpad1: 'front',
    'ctrl+Numpad1': 'back',
    Numpad3: 'right',
    'ctrl+Numpad3': 'left',
    Numpad7: 'top',
    'ctrl+Numpad7': 'bottom',
    Numpad5: 'projection',
    Home: 'fit',
    NumpadDecimal: 'fit',
  },
};

/** Maya: Alt + left tumbles, Alt + middle tracks, Alt + right dollies, wheel dollies to the centre of interest, F/A frame. */
export const MAYA: NavigationProfile = {
  name: 'maya',
  drag: { 'alt+0': 'rotate', 'alt+1': 'pan', 'alt+2': 'dolly' },
  touches: { ONE: TOUCH.ROTATE, TWO: TOUCH.DOLLY_PAN },
  wheel: 1,
  zoomToCursor: false,
  keys: { KeyF: 'fit', KeyA: 'fit' },
};

/** Onshape: right rotates, middle or Ctrl + right pans, wheel zooms at the cursor (forward out), F fits, Shift + 1..7 views. */
export const ONSHAPE: NavigationProfile = {
  name: 'onshape',
  drag: { '2': 'rotate', '1': 'pan', 'ctrl+2': 'pan' },
  touches: { ONE: TOUCH.ROTATE, TWO: TOUCH.DOLLY_PAN },
  wheel: -1,
  zoomToCursor: true,
  keys: {
    KeyF: 'fit',
    'shift+Digit1': 'front',
    'shift+Digit2': 'back',
    'shift+Digit3': 'left',
    'shift+Digit4': 'right',
    'shift+Digit5': 'top',
    'shift+Digit6': 'bottom',
    'shift+Digit7': 'iso',
  },
};

/** Rhino: right rotates (pans in parallel views), Shift + right pans, Ctrl + right zooms, Ctrl + Shift + right rotates, wheel zooms at the cursor. */
export const RHINO: NavigationProfile = {
  name: 'rhino',
  drag: { '2': 'rotate-or-pan', 'shift+2': 'pan', 'ctrl+2': 'dolly', 'ctrl+shift+2': 'rotate' },
  touches: { ONE: TOUCH.ROTATE, TWO: TOUCH.DOLLY_PAN },
  wheel: 1,
  zoomToCursor: true,
};

/** Every profile by name, for a preferences menu (`orbit.setProfile(PROFILES[choice])`). Importing it bundles them all. */
export const PROFILES = {
  three: THREE_ORBIT,
  solidworks: SOLIDWORKS,
  autocad: AUTOCAD,
  inventor: INVENTOR,
  fusion: FUSION,
  blender: BLENDER,
  maya: MAYA,
  onshape: ONSHAPE,
  rhino: RHINO,
} as const;
