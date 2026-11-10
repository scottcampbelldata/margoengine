// Escaping for XML attribute values and text, kept apart from the reader so writers do not bundle the parser.
/** Escape text for an XML attribute value or text content. */
export const escapeXML = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c],
  );
