// Escaping for XML attribute values and text, kept apart from the reader so writers do not bundle the parser.
// XML 1.0 section 2.2 (Char) allows no C0 control other than tab, line feed and carriage return, no lone surrogate
// and neither U+FFFE nor U+FFFF, even escaped; each becomes U+FFFD so the document still parses.
/** Escape text for an XML attribute value or text content. */
export const escapeXML = (value) =>
  String(value).replace(
    /[&<>"'\0-\x08\x0B\x0C\x0E-\x1F￾￿]|\p{Cs}/gu,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c] ?? '�',
  );
