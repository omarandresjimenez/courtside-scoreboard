import { useEffect, useId, useMemo, useState } from 'react';
import type { TournamentPlayer } from '@courtside/shared';

export interface PlayerSelection {
  tournamentPlayerId: string;
  displayName: string;
}

export interface PlayerAutocompleteProps {
  label: string;
  roster: TournamentPlayer[];
  value: PlayerSelection | null;
  onChange: (selection: PlayerSelection | null) => void;
  /** Already picked for another slot in this same match — hidden from this
   * slot's results so the same roster player can't fill two seats. */
  excludeIds?: string[];
}

// Generous rather than tight: the dropdown scrolls (see .player-autocomplete-dropdown
// in styles.css), so this only guards against rendering an unreasonable number
// of rows for a single field, not against showing "too many" — a roster the
// size a single tournament actually has should appear in full on an empty
// query, exactly like opening a native <select>.
const MAX_RESULTS = 50;

function fullName(p: Pick<TournamentPlayer, 'firstName' | 'lastName'>): string {
  return `${p.firstName} ${p.lastName}`;
}

/**
 * Dropdown combobox over a tournament's imported roster: focusing it opens
 * the full (category-filtered) list immediately, and typing narrows it from
 * the very first character — no minimum before it starts filtering. Replaces
 * free-typed first/last name fields once a roster has been imported (see
 * AdminDashboard) — a tournament that size is entered once by import, not
 * retyped per match.
 */
export function PlayerAutocomplete({
  label,
  roster,
  value,
  onChange,
  excludeIds = [],
}: PlayerAutocompleteProps) {
  const [query, setQuery] = useState(value?.displayName ?? '');
  const [isOpen, setIsOpen] = useState(false);
  const listboxId = useId();

  // Keeps the visible text in sync when a parent clears the selection (e.g.
  // resetting the whole form after a successful submit) rather than only
  // reacting to this component's own edits.
  useEffect(() => {
    setQuery(value?.displayName ?? '');
  }, [value]);

  // No minimum query length: an empty query matches every roster entry (a
  // substring check against '' is always true), so focusing the field opens
  // a full dropdown of eligible players — like a native <select> — and each
  // keystroke narrows it further.
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return roster
      .filter((p) => !excludeIds.includes(p.tournamentPlayerId))
      .filter((p) => fullName(p).toLowerCase().includes(q))
      .slice(0, MAX_RESULTS);
  }, [roster, query, excludeIds]);

  function selectPlayer(p: TournamentPlayer) {
    onChange({ tournamentPlayerId: p.tournamentPlayerId, displayName: fullName(p) });
    setQuery(fullName(p));
    setIsOpen(false);
  }

  function handleInputChange(next: string) {
    setQuery(next);
    setIsOpen(true);
    // Typing after a selection invalidates it: holding onto a stale id while
    // the visible text says something else would silently submit the wrong
    // player.
    if (value) onChange(null);
  }

  return (
    <label className="player-autocomplete">
      {label}
      <div className="player-autocomplete-input">
        <input
          role="combobox"
          aria-expanded={isOpen && matches.length > 0}
          aria-controls={listboxId}
          aria-autocomplete="list"
          value={query}
          onChange={(e) => handleInputChange(e.target.value)}
          onFocus={() => setIsOpen(true)}
          // A click on a dropdown option fires this blur first; the option's
          // own onMouseDown (below) commits the selection before the timeout
          // runs, so closing here doesn't race it away.
          onBlur={() => window.setTimeout(() => setIsOpen(false), 150)}
          placeholder="Choose a player…"
          autoComplete="off"
          spellCheck={false}
          required
        />
        {isOpen && matches.length > 0 && (
          <ul className="player-autocomplete-dropdown" id={listboxId} role="listbox">
            {matches.map((p) => (
              <li key={p.tournamentPlayerId}>
                <button
                  type="button"
                  role="option"
                  aria-selected={value?.tournamentPlayerId === p.tournamentPlayerId}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    selectPlayer(p);
                  }}
                >
                  {fullName(p)}
                  {p.club && <span className="player-autocomplete-club">{p.club}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </label>
  );
}
