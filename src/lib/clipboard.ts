/** Copy during a user gesture, including desktop shells that deny Clipboard API permissions. */
export async function copyText(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // Electron can deny the async API while still allowing a user-initiated copy.
  }

  const active = document.activeElement;
  const selection = document.getSelection();
  const ranges = selection
    ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange())
    : [];
  const fieldSelection = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
    ? { start: active.selectionStart, end: active.selectionEnd, direction: active.selectionDirection }
    : null;
  const field = document.createElement('textarea');
  field.value = text;
  field.readOnly = true;
  field.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0;pointer-events:none';
  document.body.appendChild(field);
  try {
    field.focus({ preventScroll: true });
    field.select();
    if (!document.execCommand('copy')) throw new Error('Clipboard copy failed');
  } finally {
    field.remove();
    if (active instanceof HTMLElement) active.focus({ preventScroll: true });
    if (selection) {
      selection.removeAllRanges();
      for (const range of ranges) selection.addRange(range);
    }
    // Restoring document ranges can reset a text field's selection in Chromium.
    // Restore the field-specific selection last.
    if (fieldSelection && (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement)
      && fieldSelection.start !== null && fieldSelection.end !== null) {
      active.setSelectionRange(fieldSelection.start, fieldSelection.end, fieldSelection.direction ?? undefined);
    }
  }
}
