import type { Player } from './types.js';

/**
 * Scoreboard rendering of a player's name: `J. Pérez`.
 *
 * Badminton scoreboards are read at distance and are width-constrained, so the
 * convention is an initial plus the family name — which also disambiguates the
 * two players a "Juan" could be, where a bare given name does not.
 */
export function formatPlayerName(player: Pick<Player, 'name' | 'lastName' | 'shortName'>): string {
  const given = player.name?.trim() ?? '';
  const family = player.lastName?.trim() ?? '';

  if (given && family) return `${initial(given)}. ${family}`;

  // Only a family name: nothing to abbreviate.
  if (family) return family;

  if (given) {
    // Players created before first/last name were captured separately keep the
    // whole name in `name`. Treat the last whitespace-separated word as the
    // family name so those rows still render in the new format instead of
    // silently looking different from every row beside them.
    const parts = given.split(/\s+/).filter(Boolean);
    if (parts.length > 1) {
      const last = parts[parts.length - 1] as string;
      return `${initial(parts[0] as string)}. ${last}`;
    }
    return given;
  }

  // Nothing usable — the TV short name is better than an empty cell.
  return player.shortName?.trim() ?? '';
}

/** Uppercased first character, which is not always the first code unit. */
function initial(word: string): string {
  return [...word][0]?.toUpperCase() ?? '';
}

/**
 * One side's players as a scoreboard reads them: `J. Pérez / A. Gómez`.
 *
 * `fallback` covers a side with no named players yet. It defaults to the bare
 * side letter, which is what the space-constrained TV and stream overlays
 * want; the admin history passes something more explicit.
 */
export function formatSideNames(
  players: Array<Pick<Player, 'side' | 'name' | 'lastName' | 'shortName'>>,
  side: Player['side'],
  fallback: string = side,
): string {
  return (
    players
      .filter((p) => p.side === side)
      .map(formatPlayerName)
      .filter(Boolean)
      .join(' / ') || fallback
  );
}
