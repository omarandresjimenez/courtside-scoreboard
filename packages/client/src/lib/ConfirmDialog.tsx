import { useEffect, useRef } from 'react';

/**
 * A small confirm-before-acting dialog, used for the umpire actions that
 * cannot be taken back mid-match: finishing a match and ending an interval.
 * Both are one tap away from a thumb that is already tapping +1 repeatedly,
 * which is exactly when a mis-tap happens.
 *
 * Deliberately not <dialog>: Safari on older tablets (the kind that end up
 * courtside) only got showModal() in 15.4, and the TV/umpire devices here
 * are explicitly old — see the legacy-bundle work in the client's Vite
 * config for the same reasoning.
 */

export interface ConfirmChoice {
  label: string;
  onSelect: () => void;
  danger?: boolean | undefined;
}

export interface ConfirmDialogProps {
  title: string;
  /** Optional supporting line under the title. */
  message?: string | undefined;
  /**
   * The actions offered besides cancelling. A single-entry list is the
   * ordinary confirm; several entries let the umpire pick an outcome (which
   * side a retirement is awarded to) without ever overloading Cancel — Cancel
   * and Escape must always mean "do nothing".
   */
  choices: ConfirmChoice[];
  cancelLabel?: string | undefined;
  onCancel: () => void;
}

export function ConfirmDialog({
  title,
  message,
  choices,
  cancelLabel = 'Cancel',
  onCancel,
}: ConfirmDialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // Focus the confirm button so a keyboard/remote user can act at once,
    // and so screen readers announce what is being asked.
    confirmRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onCancel();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  return (
    <div className="confirm-backdrop" onClick={onCancel} data-testid="confirm-backdrop">
      <div
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        // The backdrop closes on click; clicks inside the panel must not
        // bubble up to it and dismiss the very thing being read.
        onClick={(event) => event.stopPropagation()}
      >
        <h2>{title}</h2>
        {message && <p>{message}</p>}
        <div className="confirm-actions">
          <button type="button" onClick={onCancel}>
            {cancelLabel}
          </button>
          {choices.map((choice, index) => (
            <button
              key={choice.label}
              type="button"
              ref={index === 0 ? confirmRef : undefined}
              className={choice.danger ? 'danger-button' : 'primary'}
              onClick={choice.onSelect}
            >
              {choice.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
