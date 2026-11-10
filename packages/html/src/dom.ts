/** @internal Inline computed styles and live form state without changing the source tree. */
export function inlineCopy(source: Element): Element {
  const copy = source.cloneNode(false) as Element,
    view = source.ownerDocument.defaultView!;
  if (source instanceof view.HTMLElement || source instanceof view.SVGElement) {
    const style = view.getComputedStyle(source);
    let text = '';
    for (let i = 0; i < style.length; i++) {
      const name = style[i];
      text += `${name}:${style.getPropertyValue(name)};`;
    }
    copy.setAttribute('style', text);
  }
  if (source instanceof view.HTMLInputElement) {
    copy.setAttribute('value', source.value);
    if (source.checked) copy.setAttribute('checked', '');
    else copy.removeAttribute('checked');
  }
  // cloneNode resets an option's selectedness to its `selected` attribute; carry the user's choice over.
  if (source instanceof view.HTMLOptionElement) {
    if (source.selected) copy.setAttribute('selected', '');
    else copy.removeAttribute('selected');
  }
  if (source instanceof view.HTMLTextAreaElement) copy.textContent = source.value;
  else
    for (const child of source.childNodes)
      copy.appendChild(child.nodeType === 1 ? inlineCopy(child as Element) : child.cloneNode(false));
  return copy;
}
