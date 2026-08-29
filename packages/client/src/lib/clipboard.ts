/**
 * `navigator.clipboard` only exists in secure contexts (HTTPS or
 * localhost), but this app is designed to run over a plain
 * `http://<lan-ip>` address on match day — so this falls back to the
 * legacy `document.execCommand('copy')` path, which insecure contexts
 * still support. Returns whether the copy actually succeeded, so the
 * caller can tell the user to select-and-copy the visible link field
 * themselves when it doesn't.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the legacy path below.
    }
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();

  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }
  document.body.removeChild(textarea);

  return copied;
}
