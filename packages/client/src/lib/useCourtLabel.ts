import { useEffect, useState } from 'react';

/**
 * The court's display name, for screens that only know its id.
 *
 * Falls back to `null` on any failure so callers can show the id rather than
 * an empty heading — a court id is ugly but still identifies the court, which
 * is better than nothing while a match is being set up.
 */
export function useCourtLabel(courtId: string | undefined): string | null {
  const [label, setLabel] = useState<string | null>(null);

  useEffect(() => {
    if (!courtId) return;
    let cancelled = false;

    void (async () => {
      try {
        const response = await fetch(`/api/courts/${encodeURIComponent(courtId)}/label`);
        if (!response.ok) return;
        const body = (await response.json()) as { label?: string };
        // Guards a court renamed to whitespace, which would render as a blank
        // heading rather than falling back.
        if (!cancelled && body.label?.trim()) setLabel(body.label.trim());
      } catch {
        // Naming is cosmetic; never let it surface as an error on a screen
        // whose job is to transmit video.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [courtId]);

  return label;
}
