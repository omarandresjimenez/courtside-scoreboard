import { render } from '@testing-library/react';
import type { Side } from '@courtside/shared';
import { CourtDiagram, type CourtDiagramProps } from './CourtDiagram.js';

const names: Record<string, string> = {
  a1: 'Alice',
  a2: 'Amy',
  b1: 'Bilal',
  b2: 'Ben',
};

function draw(overrides: Partial<CourtDiagramProps> = {}) {
  const props: CourtDiagramProps = {
    matchType: 'singles',
    leftSide: 'A',
    courtPositions: {},
    servingSide: 'A',
    serverPlayerId: null,
    scoreFor: () => 0,
    nameFor: (id) => names[id] ?? '',
    singlesNameFor: (side: Side) => (side === 'A' ? 'Alice' : 'Bilal'),
    ...overrides,
  };
  render(<CourtDiagram {...props} />);
  return {
    boxes: [...document.querySelectorAll('.court-box-name')].map((n) => n.textContent),
    serving: document.querySelector('.court-box-serving .court-box-name')?.textContent ?? null,
  };
}

describe('CourtDiagram', () => {
  it('starts both singles players in the right court before anyone serves', () => {
    // No server yet: the laws open every game from the right service court.
    // Boxes read top-to-bottom per half, and the halves are mirrored, so the
    // two right courts are the lower-left and upper-right boxes — diagonal.
    const { boxes, serving } = draw({ servingSide: null });
    expect(boxes).toEqual(['', 'Alice', 'Bilal', '']);
    expect(serving).toBeNull();
  });

  it('places server and receiver diagonally, never straight across the net', () => {
    // The defining property of a service in badminton. Indices 0/1 are the
    // left half top/bottom, 2/3 the right half top/bottom.
    const { boxes } = draw({ servingSide: 'A', scoreFor: () => 0 });
    const occupied = boxes.flatMap((name, i) => (name ? [i] : []));
    expect(occupied).toEqual([1, 2]); // bottom-left and top-right
  });

  it('puts both singles players in the same-named court, chosen by the server', () => {
    // Right-to-right IS the diagonal across the net, so an odd server score
    // moves *both* players to their left court.
    const { boxes, serving } = draw({ servingSide: 'B', scoreFor: (s) => (s === 'B' ? 3 : 8) });
    // Odd server score -> both in their left court: upper-left and lower-right.
    expect(boxes).toEqual(['Alice', '', '', 'Bilal']);
    expect(serving).toBe('Bilal');
  });

  it('draws the right-hand side first when ends have been swapped', () => {
    const { boxes } = draw({ leftSide: 'B' });
    expect(boxes).toEqual(['', 'Bilal', 'Alice', '']);
  });

  it('seats doubles partners in their recorded service courts', () => {
    const { boxes, serving } = draw({
      matchType: 'doubles',
      courtPositions: { A: { right: 'a1', left: 'a2' }, B: { right: 'b2', left: 'b1' } },
      servingSide: 'B',
      serverPlayerId: 'b1',
    });
    // Left half is drawn left-court-first, right half right-court-first.
    expect(boxes).toEqual(['Amy', 'Alice', 'Ben', 'Bilal']);
    expect(serving).toBe('Bilal');
  });

  it('flags nothing when the recorded server is not on court', () => {
    const { serving } = draw({
      matchType: 'doubles',
      courtPositions: { A: { right: 'a1', left: 'a2' } },
      servingSide: 'A',
      serverPlayerId: 'someone-else',
    });
    expect(serving).toBeNull();
  });

  it('renders an overlay into each half when one is supplied', () => {
    draw({
      matchType: 'doubles',
      courtPositions: { A: { right: 'a1', left: 'a2' }, B: { right: 'b1', left: 'b2' } },
      overlayFor: (side) => <button type="button">swap {side}</button>,
    });
    expect(document.querySelectorAll('.court-half button')).toHaveLength(2);
  });
});
