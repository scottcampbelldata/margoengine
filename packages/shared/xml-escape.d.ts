/** Escape `& < > " '` for XML attribute values and text; characters XML 1.0 forbids become U+FFFD. */
export function escapeXML(value: string | number): string;
