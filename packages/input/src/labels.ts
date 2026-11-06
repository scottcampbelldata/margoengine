import type { Binding } from './index.js';

/** Button naming for {@link bindingLabel}: Xbox (A/B/X/Y), PlayStation (Cross/Circle/Square/Triangle) or generic numbers. */
export type GlyphLayout = 'xbox' | 'playstation' | 'generic';

const XBOX = [
  'A',
  'B',
  'X',
  'Y',
  'LB',
  'RB',
  'LT',
  'RT',
  'View',
  'Menu',
  'L3',
  'R3',
  'D-pad Up',
  'D-pad Down',
  'D-pad Left',
  'D-pad Right',
  'Guide',
];
const PLAYSTATION = [
  'Cross',
  'Circle',
  'Square',
  'Triangle',
  'L1',
  'R1',
  'L2',
  'R2',
  'Create',
  'Options',
  'L3',
  'R3',
  'D-pad Up',
  'D-pad Down',
  'D-pad Left',
  'D-pad Right',
  'PS',
];
const AXES = ['Left Stick X', 'Left Stick Y', 'Right Stick X', 'Right Stick Y'];
const MODIFIERS: Record<string, string> = { shift: 'Shift', ctrl: 'Ctrl', alt: 'Alt', meta: 'Meta' };
const MOUSE = ['Left Mouse', 'Middle Mouse', 'Right Mouse', 'Mouse Back', 'Mouse Forward'];

/** Player-facing name of a `KeyboardEvent.code`: `KeyW` becomes `W`, `ArrowUp` becomes `Up`, `Space` stays `Space`. */
function keyName(code: string): string {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad\d$/.test(code)) return `Num ${code.slice(6)}`;
  if (code.startsWith('Arrow')) return code.slice(5);
  return code.replace(/(Left|Right)$/, (side) => ` ${side}`).replace(/([a-z])([A-Z])/g, '$1 $2');
}

/**
 * Short on-screen prompt text for a binding, for "Press [Space] to jump" labels and rebinding menus.
 * Chords join with `+` (`Ctrl+S`). Gamepad buttons use the names of `layout` (default `'xbox'`).
 */
export function bindingLabel(binding: Binding, layout: GlyphLayout = 'xbox'): string {
  switch (binding.type) {
    case 'key':
      return [...(binding.modifiers ?? []).map((m) => MODIFIERS[m]), keyName(binding.code)].join('+');
    case 'mouse':
      return MOUSE[binding.button] ?? `Mouse ${binding.button + 1}`;
    case 'pointer':
      return binding.axis === 'wheel' ? 'Mouse Wheel' : `Mouse ${binding.axis.toUpperCase()}`;
    case 'gamepad-button': {
      const names = layout === 'xbox' ? XBOX : layout === 'playstation' ? PLAYSTATION : [];
      return names[binding.index] ?? `Button ${binding.index}`;
    }
    case 'gamepad-axis':
      return AXES[binding.index] ?? `Axis ${binding.index}`;
    case 'touch':
      return binding.axis ? `${binding.id} ${binding.axis.toUpperCase()}` : binding.id;
    case 'control':
      return binding.axis ? `${binding.id} ${binding.axis}` : binding.id;
  }
}
