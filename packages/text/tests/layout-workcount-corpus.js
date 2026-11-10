export const texts = [
  'AVATAR'.repeat(100),
  'office affine\u00a0waffle',
  '\u0633\u0644\u0627\u0645 \u0645\u0631\u062d\u0628\u0627',
  'abc \u05d0\u05d1\u05d2 (123) xyz',
  '\u4e2d\u6587\uff0c\u6e2c\u8a66\uff01',
  'a\u0301 \u{1f469}\u200d\u{1f469}\u200d\u{1f467} \r\nAV',
  '\u092d\u093e\u0937\u093e \u092a\u0930\u0940\u0915\u094d\u0937\u0923',
];
export const variants = [
  {},
  { ligatures: true, fontSize: 0.3, letterSpacing: 0.017 },
  { maxWidth: 3.7, textAlign: 'justify' },
  { direction: 'rtl', maxWidth: 5, anchorX: 'center' },
  { whiteSpace: 'nowrap', anchorY: 'baseline' },
];
export function measured() {
  const calls = { advance: 0, kern: 0 };
  const measurer = {
    advance: (s) => {
      calls.advance++;
      return s.length * 0.523;
    },
    kerning: (a, b) => {
      calls.kern++;
      return (((a.charCodeAt(0) + b.charCodeAt(0)) % 5) - 2) * 0.03;
    },
    metrics: () => ({ ascent: 0.8, descent: 0.2 }),
  };
  return { calls, measurer };
}
export const layoutBytes = (layout) =>
  Buffer.from(JSON.stringify(layout, (_, value) => (Object.is(value, -0) ? '__negative_zero__' : value)));
