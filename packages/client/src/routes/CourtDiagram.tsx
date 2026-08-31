import type { CourtPositions, MatchType, Side } from '@courtside/shared';

/**
 * A plan view of the court, which is how an umpire actually reads a match:
 * who is serving, from which service court, and therefore who receives
 * (always the diagonal box). See docs/umpire-screen-spec.md.
 *
 * Geometry is deliberately schematic rather than to scale — the boxes exist
 * to hold names legibly on a phone, so they are equal halves rather than the
 * real court's uneven service/rear court split.
 */

export interface CourtDiagramProps {
  matchType: MatchType;
  /** Which side is drawn on the left. Ends alternate each game. */
  leftSide: Side;
  courtPositions: CourtPositions;
  servingSide: Side | null;
  /** Doubles only; null in singles, where the side alone identifies the server. */
  serverPlayerId: string | null;
  /** Score per side, used to place the singles server without a player id. */
  scoreFor: (side: Side) => number;
  nameFor: (playerId: string) => string;
  singlesNameFor: (side: Side) => string;
  /** Rendered inside each half, e.g. the swap controls during setup. */
  overlayFor?: ((side: Side) => React.ReactNode) | undefined;
}

/**
 * Which service court a side serves from is pure score parity: even scores
 * are served from the right, odd from the left. In doubles the player
 * standing there is whoever `courtPositions` currently puts in that box; in
 * singles the side has only one player, who simply moves.
 */
function servingCourtFor(score: number): 'right' | 'left' {
  return score % 2 === 0 ? 'right' : 'left';
}

interface BoxProps {
  label: string;
  serving: boolean;
  side: Side;
}

function CourtBox({ label, serving, side }: BoxProps) {
  return (
    <div
      className={`court-box side-${side.toLowerCase()}${serving ? ' court-box-serving' : ''}`}
      data-serving={serving || undefined}
    >
      <span className="court-box-name">{label}</span>
      {serving && <span className="court-box-flag">Serving</span>}
    </div>
  );
}

export function CourtDiagram({
  matchType,
  leftSide,
  courtPositions,
  servingSide,
  serverPlayerId,
  scoreFor,
  nameFor,
  singlesNameFor,
  overlayFor,
}: CourtDiagramProps) {
  const rightSide: Side = leftSide === 'A' ? 'B' : 'A';

  const occupiedCourt: 'right' | 'left' = servingSide
    ? servingCourtFor(scoreFor(servingSide))
    : 'right';

  function half(side: Side, isLeftHalf: boolean) {
    const isServingSide = servingSide === side;
    // A plan view mirrors the two halves. Each player's right service court
    // is on their own right as they face the net, and the two sides face
    // opposite ways — so "right" is the lower box on the left half and the
    // upper box on the right half. That mirroring is what makes the serve
    // read as diagonal, which is the whole point of drawing a court.
    const order = isLeftHalf ? (['left', 'right'] as const) : (['right', 'left'] as const);
    const positions = courtPositions[side];

    if (matchType === 'singles') {
      // The serve travels right-court-to-right-court (that pairing IS the
      // diagonal across the net), so both players stand in the same-named
      // court, chosen by the *server's* score parity. Before the opening
      // serve, both start right, as the laws require.
      const name = singlesNameFor(side);
      return (
        <div className="court-half" key={side} data-side={side}>
          {order.map((court) => (
            <CourtBox
              key={court}
              side={side}
              label={court === occupiedCourt ? name : ''}
              serving={isServingSide && court === occupiedCourt}
            />
          ))}
          {overlayFor?.(side)}
        </div>
      );
    }

    return (
      <div className="court-half" key={side} data-side={side}>
        {order.map((court) => {
          const playerId = positions?.[court];
          return (
            <CourtBox
              key={court}
              side={side}
              label={playerId ? nameFor(playerId) : ''}
              serving={isServingSide && !!playerId && playerId === serverPlayerId}
            />
          );
        })}
        {overlayFor?.(side)}
      </div>
    );
  }

  return (
    <div className="court-diagram" aria-label="Court positions">
      {half(leftSide, true)}
      <div className="court-net" aria-hidden="true" />
      {half(rightSide, false)}
    </div>
  );
}
