import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MatchStatePayload } from '@courtside/shared';
import { UmpireScreen } from './UmpireScreen.js';

const mockUseMatchState = jest.fn();
jest.mock('../lib/useMatchState.js', () => ({
  useMatchState: (...args: unknown[]) => mockUseMatchState(...args),
}));

function renderAt(matchId: string, token?: string) {
  const search = token !== undefined ? `?token=${token}` : '';
  return render(
    <MemoryRouter initialEntries={[`/umpire/${matchId}${search}`]}>
      <Routes>
        <Route path="/umpire/:matchId" element={<UmpireScreen />} />
      </Routes>
    </MemoryRouter>,
  );
}

function buildState(overrides: Partial<MatchStatePayload['derived']> = {}): MatchStatePayload {
  return {
    match: {
      matchId: 'm1',
      matchType: 'singles',
      status: 'IN_PROGRESS',
      scoringConfig: { pointsToWin: 21, capScore: 30, intervalAt: 11 },
      scoringLocked: true,
      teams: { A: { name: null, country: null }, B: { name: null, country: null } },
      players: [
        { playerId: 'a1', side: 'A', name: 'Alice', lastName: 'Adams', shortName: 'ALI' },
        { playerId: 'b1', side: 'B', name: 'Bilal', lastName: 'Bruno', shortName: 'BIL' },
      ],
      umpireToken: 'tok',
      umpireCode: 'CODE01',
      assignedCourtId: 'c1',
      courtLabel: 'Court 1',
      assignedUmpireId: 'u1',
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      completedAt: null,
    },
    derived: {
      sets: [
        {
          setNumber: 1,
          scoreA: 0,
          scoreB: 0,
          winner: null,
          intervalTriggered: false,
          intervalResumed: false,
        },
      ],
      currentSet: {
        setNumber: 1,
        scoreA: 3,
        scoreB: 5,
        winner: null,
        intervalTriggered: false,
        intervalResumed: false,
      },
      setsWon: { A: 0, B: 0 },
      matchWinner: null,
      serve: { servingSide: 'A', serverPlayerId: 'a1', courtPositions: {} },
      onInterval: false,
      interval: null,
      serviceOver: false,
      finalised: false,
      retiredSide: null,
      ...overrides,
    },
  };
}

function buildDoublesState(
  overrides: Partial<MatchStatePayload['derived']> = {},
): MatchStatePayload {
  const state = buildState(overrides);
  state.match.matchType = 'doubles';
  state.match.players = [
    { playerId: 'a1', side: 'A', name: 'Alice', lastName: 'Adams', shortName: 'ALI' },
    { playerId: 'a2', side: 'A', name: 'A. Stone', lastName: 'Stone', shortName: 'AMY' },
    { playerId: 'b1', side: 'B', name: 'Bilal', lastName: 'Bruno', shortName: 'BIL' },
    { playerId: 'b2', side: 'B', name: 'B. Clark', lastName: 'Clark', shortName: 'BEN' },
  ];
  return state;
}

const noopHandlers = {
  addPoint: jest.fn(),
  undoLastPoint: jest.fn(),
  startSet: jest.fn(),
  resumeFromInterval: jest.fn(),
  retireMatch: jest.fn(),
};

beforeEach(() => {
  mockUseMatchState.mockReset();
  noopHandlers.addPoint.mockReset();
  noopHandlers.undoLastPoint.mockReset();
  noopHandlers.startSet.mockReset();
  noopHandlers.resumeFromInterval.mockReset();
  noopHandlers.retireMatch.mockReset();
});

describe('UmpireScreen', () => {
  const ready = (payload: MatchStatePayload, overrides: Record<string, unknown> = {}) => {
    mockUseMatchState.mockReturnValue({
      state: payload,
      connected: true,
      isFromCache: false,
      error: null,
      ...noopHandlers,
      ...overrides,
    });
  };

  // The diagram places names in service-court boxes; this reads back which
  // box (if any) is flagged as serving, which is the screen's core claim.
  const servingBoxName = () =>
    document.querySelector('.court-box-serving .court-box-name')?.textContent ?? null;
  const boxNames = () =>
    [...document.querySelectorAll('.court-box-name')].map((n) => n.textContent);

  beforeEach(() => localStorage.clear());

  describe('guards', () => {
    it('reports a link missing its token', () => {
      ready(buildState());
      renderAt('m1');
      expect(screen.getByText(/missing its match ID or token/)).toBeInTheDocument();
    });

    it('surfaces a connection error', () => {
      mockUseMatchState.mockReturnValue({
        state: null,
        connected: false,
        error: 'nope',
        ...noopHandlers,
      });
      renderAt('m1', 'tok');
      expect(screen.getByText('nope')).toBeInTheDocument();
    });

    it('shows a connecting message before the first state arrives', () => {
      mockUseMatchState.mockReturnValue({
        state: null,
        connected: false,
        error: null,
        ...noopHandlers,
      });
      renderAt('m1', 'tok');
      expect(screen.getByText('Connecting…')).toBeInTheDocument();
    });

    it('reports a missing matchId when rendered outside its route', () => {
      mockUseMatchState.mockReturnValue({
        state: null,
        connected: false,
        error: null,
        ...noopHandlers,
      });
      render(
        <MemoryRouter initialEntries={['/umpire']}>
          <Routes>
            <Route path="/umpire" element={<UmpireScreen />} />
          </Routes>
        </MemoryRouter>,
      );
      expect(screen.getByText(/missing its match ID or token/)).toBeInTheDocument();
    });

    it('shows a reconnecting indicator when the socket drops', () => {
      ready(buildState(), { connected: false });
      renderAt('m1', 'tok');
      expect(screen.getByText('Reconnecting…')).toBeInTheDocument();
    });
  });

  it('shows the category instead of the match type, which it already implies', () => {
    const state = buildState();
    state.match.category = 'MD U15';
    ready(state);
    renderAt('m1', 'tok');

    expect(screen.getByText('MD U15')).toBeInTheDocument();
    // "MD U15" already says men's doubles; repeating the match type is noise.
    expect(screen.queryByText('singles')).not.toBeInTheDocument();
  });

  describe('scoring', () => {
    it('shows both teams with their sets and current score', () => {
      ready(
        buildState({
          currentSet: {
            setNumber: 1,
            scoreA: 7,
            scoreB: 4,
            winner: null,
            intervalTriggered: false,
            intervalResumed: false,
          },
          setsWon: { A: 1, B: 0 },
        }),
      );
      renderAt('m1', 'tok');
      // Names appear in both the header and a court box, so scope to the header.
      expect([...document.querySelectorAll('.umpire-team-name')].map((n) => n.textContent)).toEqual(
        ['A. Adams', 'B. Bruno'],
      );
      expect(
        [...document.querySelectorAll('.umpire-team-score')].map((n) => n.textContent),
      ).toEqual(['7', '4']);
      expect([...document.querySelectorAll('.umpire-team-sets')].map((n) => n.textContent)).toEqual(
        ['1', '0'],
      );
    });

    it('shows the assigned court name, same as the TV screen', () => {
      ready(buildState());
      renderAt('m1', 'tok');
      expect(screen.getByText('Court 1')).toBeInTheDocument();
    });

    it('falls back to a generic court label when none is assigned', () => {
      const state = buildState();
      state.match.courtLabel = null;
      ready(state);
      renderAt('m1', 'tok');
      expect(screen.getByText('Court')).toBeInTheDocument();
    });

    it('awards the point to the side that owns the tapped end', async () => {
      ready(buildState());
      renderAt('m1', 'tok');
      // Side A is drawn left in game 1, so the left button must score for A.
      await userEvent.click(screen.getByLabelText('Point to A. Adams'));
      expect(noopHandlers.addPoint).toHaveBeenCalledWith('A');
      await userEvent.click(screen.getByLabelText('Point to B. Bruno'));
      expect(noopHandlers.addPoint).toHaveBeenCalledWith('B');
    });

    it('shows the umpire call for the current score', () => {
      ready(
        buildState({
          currentSet: {
            setNumber: 1,
            scoreA: 5,
            scoreB: 4,
            winner: null,
            intervalTriggered: false,
            intervalResumed: false,
          },
        }),
      );
      renderAt('m1', 'tok');
      expect(screen.getByRole('status')).toHaveTextContent('5, 4');
    });

    it('prefixes the call with "Service over" when the serve just changed hands', () => {
      ready(
        buildState({
          currentSet: {
            setNumber: 1,
            scoreA: 1,
            scoreB: 0,
            winner: null,
            intervalTriggered: false,
            intervalResumed: false,
          },
          serviceOver: true,
        }),
      );
      renderAt('m1', 'tok');
      expect(screen.getByRole('status')).toHaveTextContent('Service over, 1, love');
    });

    it('undoes the last point', async () => {
      ready(
        buildState({
          currentSet: {
            setNumber: 1,
            scoreA: 1,
            scoreB: 0,
            winner: null,
            intervalTriggered: false,
            intervalResumed: false,
          },
        }),
      );
      renderAt('m1', 'tok');
      await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
      expect(noopHandlers.undoLastPoint).toHaveBeenCalled();
    });

    it('hides undo before any point has been scored', () => {
      ready(
        buildState({
          currentSet: {
            setNumber: 1,
            scoreA: 0,
            scoreB: 0,
            winner: null,
            intervalTriggered: false,
            intervalResumed: false,
          },
        }),
      );
      renderAt('m1', 'tok');
      expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
    });

    const midGameInterval = () =>
      buildState({
        currentSet: {
          setNumber: 1,
          scoreA: 11,
          scoreB: 4,
          winner: null,
          intervalTriggered: true,
          intervalResumed: false,
        },
        onInterval: true,
        interval: { kind: 'MID_GAME', seconds: 60 },
      });

    it('locks scoring during the interval and shows the 60-second countdown', () => {
      ready(midGameInterval());
      renderAt('m1', 'tok');
      expect(screen.getByLabelText('Point to A. Adams')).toBeDisabled();
      expect(screen.getByRole('button', { name: /Interval 1:00/ })).toBeInTheDocument();
    });

    it('asks before resuming, and only resumes once confirmed', async () => {
      ready(midGameInterval());
      renderAt('m1', 'tok');
      await userEvent.click(screen.getByRole('button', { name: /Interval/ }));
      // The dialog is the gate: nothing has been sent yet.
      expect(noopHandlers.resumeFromInterval).not.toHaveBeenCalled();
      expect(screen.getByRole('alertdialog', { name: 'Resume play?' })).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Resume' }));
      expect(noopHandlers.resumeFromInterval).toHaveBeenCalled();
    });

    it('says the interval is over once the clock has run out', async () => {
      ready(
        buildState({
          currentSet: {
            setNumber: 1,
            scoreA: 11,
            scoreB: 4,
            winner: null,
            intervalTriggered: true,
            intervalResumed: false,
          },
          onInterval: true,
          interval: { kind: 'MID_GAME', seconds: 0 },
        }),
      );
      renderAt('m1', 'tok');
      await userEvent.click(screen.getByRole('button', { name: /Interval/ }));
      expect(screen.getByText('The interval is over.')).toBeInTheDocument();
    });

    it('backs out of the resume dialog without resuming', async () => {
      ready(midGameInterval());
      renderAt('m1', 'tok');
      await userEvent.click(screen.getByRole('button', { name: /Interval/ }));
      await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(noopHandlers.resumeFromInterval).not.toHaveBeenCalled();
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });

    it('locks scoring for the longer break between games', () => {
      ready(
        buildState({
          currentSet: {
            setNumber: 2,
            scoreA: 0,
            scoreB: 0,
            winner: null,
            intervalTriggered: false,
            intervalResumed: false,
          },
          setsWon: { A: 1, B: 0 },
          interval: { kind: 'BETWEEN_GAMES', seconds: 120 },
        }),
      );
      renderAt('m1', 'tok');
      expect(screen.getByLabelText('Point to A. Adams')).toBeDisabled();
      expect(screen.getByRole('button', { name: /Game interval 2:00/ })).toBeInTheDocument();
    });

    it('asks to start the next game after the between-games break', async () => {
      ready(
        buildState({
          currentSet: {
            setNumber: 2,
            scoreA: 0,
            scoreB: 0,
            winner: null,
            intervalTriggered: false,
            intervalResumed: false,
          },
          setsWon: { A: 1, B: 0 },
          interval: { kind: 'BETWEEN_GAMES', seconds: 120 },
        }),
      );
      renderAt('m1', 'tok');
      await userEvent.click(screen.getByRole('button', { name: /Game interval/ }));
      expect(screen.getByRole('alertdialog', { name: 'Start the next game?' })).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Resume' }));
      expect(noopHandlers.resumeFromInterval).toHaveBeenCalled();
    });

    it('ends the match early, awarding it to the chosen side', async () => {
      ready(buildState());
      renderAt('m1', 'tok');
      await userEvent.click(screen.getByRole('button', { name: 'End match' }));
      expect(
        screen.getByRole('alertdialog', { name: 'End this match early?' }),
      ).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'B. Bruno wins' }));
      expect(noopHandlers.retireMatch).toHaveBeenCalledWith('B');
    });

    it('does not end the match when the retire dialog is dismissed', async () => {
      ready(buildState());
      renderAt('m1', 'tok');
      await userEvent.click(screen.getByRole('button', { name: 'End match' }));
      await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(noopHandlers.retireMatch).not.toHaveBeenCalled();
    });

    it('advances the elapsed clock as the match runs', () => {
      jest.useFakeTimers();
      try {
        const s = buildState();
        s.match.startedAt = new Date(Date.now() - 10_000).toISOString();
        ready(s);
        renderAt('m1', 'tok');
        expect(screen.getByLabelText('Elapsed match time')).toHaveTextContent('0 min 10 sec');
        act(() => {
          jest.advanceTimersByTime(5000);
        });
        expect(screen.getByLabelText('Elapsed match time')).toHaveTextContent('0 min 15 sec');
      } finally {
        jest.useRealTimers();
      }
    });

    it('shows the elapsed clock while the match runs', () => {
      const s = buildState();
      s.match.startedAt = new Date(Date.now() - 125_000).toISOString();
      ready(s);
      renderAt('m1', 'tok');
      expect(screen.getByLabelText('Elapsed match time')).toHaveTextContent(/2 min 5 sec/);
    });

    it('announces the winner and stops offering point buttons', () => {
      const s = buildState({ matchWinner: 'A', setsWon: { A: 2, B: 0 } });
      s.match.completedAt = new Date(Date.parse(s.match.startedAt!) + 65_000).toISOString();
      ready(s);
      renderAt('m1', 'tok');
      expect(screen.getByText('A. Adams wins the match')).toBeInTheDocument();
      expect(screen.getByText(/Match time 1 min 5 sec/)).toBeInTheDocument();
      expect(screen.queryByLabelText('Point to A. Adams')).not.toBeInTheDocument();
      expect(screen.getByRole('status')).toHaveTextContent('Match won by A. Adams');
    });

    it('counts match time up to now while the result is in but the clock has not stopped', () => {
      const s = buildState({ matchWinner: 'A' });
      s.match.startedAt = new Date(Date.now() - 30_000).toISOString();
      s.match.completedAt = null;
      ready(s);
      renderAt('m1', 'tok');
      expect(screen.getByText(/Match time 0 min 3[01] sec/)).toBeInTheDocument();
    });

    it('replaces the court with a game-by-game summary once the match is won', () => {
      ready(
        buildState({
          matchWinner: 'A',
          setsWon: { A: 2, B: 1 },
          sets: [
            {
              setNumber: 1,
              scoreA: 21,
              scoreB: 15,
              winner: 'A',
              intervalTriggered: true,
              intervalResumed: true,
            },
            {
              setNumber: 2,
              scoreA: 18,
              scoreB: 21,
              winner: 'B',
              intervalTriggered: true,
              intervalResumed: true,
            },
            {
              setNumber: 3,
              scoreA: 21,
              scoreB: 9,
              winner: 'A',
              intervalTriggered: true,
              intervalResumed: true,
            },
          ],
        }),
      );
      renderAt('m1', 'tok');
      // The court is gone; the record replaces it.
      expect(document.querySelector('.court-diagram')).toBeNull();
      const summary = screen.getByLabelText('Match summary');
      expect(summary).toBeInTheDocument();
      expect(
        [...summary.querySelectorAll('.tv-set-labels span')].map((n) => n.textContent),
      ).toEqual(['', 'Set 1', 'Set 2', 'Set 3']);
      // Winner's row is flagged, and so is each game they actually won.
      const rows = [...summary.querySelectorAll('.tv-player-row')];
      expect(rows[0]).toHaveClass('match-winner');
      expect(rows[1]).not.toHaveClass('match-winner');
      expect([...rows[0]!.querySelectorAll('.set-score-winner')].map((n) => n.textContent)).toEqual(
        ['21', '21'],
      );
      expect([...rows[1]!.querySelectorAll('.set-score-winner')].map((n) => n.textContent)).toEqual(
        ['21'],
      );
    });

    it('requires the umpire to finalise a decided match', async () => {
      ready(buildState({ matchWinner: 'A', setsWon: { A: 2, B: 0 } }));
      renderAt('m1', 'tok');
      await userEvent.click(screen.getByRole('button', { name: 'Finalise match' }));
      expect(noopHandlers.retireMatch).not.toHaveBeenCalled();
      await userEvent.click(screen.getByRole('button', { name: 'Finalise' }));
      expect(noopHandlers.retireMatch).toHaveBeenCalledWith('A');
    });

    it('stops offering to finalise a match the umpire already signed off', () => {
      const s = buildState({ matchWinner: 'A', setsWon: { A: 2, B: 0 }, finalised: true });
      ready(s);
      renderAt('m1', 'tok');
      expect(screen.queryByRole('button', { name: 'Finalise match' })).not.toBeInTheDocument();
    });

    it('marks the retired side in the summary and in the result line', () => {
      ready(buildState({ matchWinner: 'B', retiredSide: 'A', finalised: true }));
      renderAt('m1', 'tok');
      const summary = screen.getByLabelText('Match summary');
      expect(summary.querySelector('.retired-tag')).toBeInTheDocument();
      expect(
        summary.querySelectorAll('.tv-player-row')[0]!.querySelector('.retired-tag'),
      ).toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
        'B. Bruno wins the match',
      );
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('A. Adams retired');
    });

    it('shows no retirement marker for a match played out', () => {
      ready(buildState({ matchWinner: 'B', finalised: true }));
      renderAt('m1', 'tok');
      expect(document.querySelector('.retired-tag')).toBeNull();
    });

    it('shows each side team and country in the header when present', () => {
      const s = buildState();
      s.match.teams = {
        A: { name: 'Riverside', country: 'COL' },
        B: { name: null, country: null },
      };
      ready(s);
      renderAt('m1', 'tok');
      expect(screen.getByText('Riverside · COL')).toBeInTheDocument();
    });

    it('omits the match time when the match never started', () => {
      const s = buildState({ matchWinner: 'A' });
      s.match.startedAt = null;
      ready(s);
      renderAt('m1', 'tok');
      expect(screen.queryByText(/Match time/)).not.toBeInTheDocument();
    });

    it('falls back to the side letter when a side has no players', () => {
      const s = buildState();
      s.match.players = [
        { playerId: 'a1', side: 'A', name: 'Alice', lastName: 'Adams', shortName: 'ALI' },
      ];
      ready(s);
      renderAt('m1', 'tok');
      expect(screen.getByText('Side B')).toBeInTheDocument();
    });
  });

  describe('court diagram', () => {
    it('puts the singles server in the right court on an even score', () => {
      ready(
        buildState({
          currentSet: {
            setNumber: 1,
            scoreA: 4,
            scoreB: 2,
            winner: null,
            intervalTriggered: false,
            intervalResumed: false,
          },
        }),
      );
      renderAt('m1', 'tok');
      expect(servingBoxName()).toBe('A. Adams');
      // Mirrored halves: each player's right court is the lower box on the
      // left half and the upper box on the right half, so the pair reads
      // diagonally — which is what a service actually is.
      expect(boxNames()).toEqual(['', 'A. Adams', 'B. Bruno', '']);
    });

    it('moves the singles server to the left court on an odd score', () => {
      ready(
        buildState({
          currentSet: {
            setNumber: 1,
            scoreA: 5,
            scoreB: 2,
            winner: null,
            intervalTriggered: false,
            intervalResumed: false,
          },
        }),
      );
      renderAt('m1', 'tok');
      expect(boxNames()).toEqual(['A. Adams', '', '', 'B. Bruno']);
      expect(servingBoxName()).toBe('A. Adams');
    });

    it('highlights side B when side B is serving', () => {
      ready(buildState({ serve: { servingSide: 'B', serverPlayerId: null, courtPositions: {} } }));
      renderAt('m1', 'tok');
      expect(servingBoxName()).toBe('B. Bruno');
    });

    it('places doubles partners from courtPositions and flags only the server', () => {
      ready(
        buildDoublesState({
          currentSet: {
            setNumber: 1,
            scoreA: 3,
            scoreB: 2,
            winner: null,
            intervalTriggered: false,
            intervalResumed: false,
          },
          serve: {
            servingSide: 'A',
            serverPlayerId: 'a2',
            courtPositions: { A: { right: 'a1', left: 'a2' }, B: { right: 'b1', left: 'b2' } },
          },
        }),
      );
      renderAt('m1', 'tok');
      expect(boxNames()).toEqual(['A. Stone', 'A. Adams', 'B. Bruno', 'B. Clark']);
      expect(servingBoxName()).toBe('A. Stone');
      expect(document.querySelectorAll('.court-box-serving')).toHaveLength(1);
    });

    it('leaves a box blank when a recorded position names a player off the roster', () => {
      ready(
        buildDoublesState({
          serve: {
            servingSide: 'A',
            serverPlayerId: 'a1',
            courtPositions: { A: { right: 'a1', left: 'ghost' }, B: { right: 'b1', left: 'b2' } },
          },
        }),
      );
      renderAt('m1', 'tok');
      expect(boxNames()).toEqual(['', 'A. Adams', 'B. Bruno', 'B. Clark']);
    });

    it('leaves a doubles box blank when positions are unknown', () => {
      ready(
        buildDoublesState({
          serve: { servingSide: 'A', serverPlayerId: 'a1', courtPositions: {} },
        }),
      );
      renderAt('m1', 'tok');
      expect(boxNames()).toEqual(['', '', '', '']);
      expect(servingBoxName()).toBeNull();
    });

    it('swaps ends every game, so game 2 draws side B on the left', () => {
      ready(
        buildState({
          currentSet: {
            setNumber: 2,
            scoreA: 0,
            scoreB: 0,
            winner: null,
            intervalTriggered: false,
            intervalResumed: false,
          },
        }),
      );
      renderAt('m1', 'tok');
      const names = [...document.querySelectorAll('.umpire-team-name')].map((n) => n.textContent);
      expect(names).toEqual(['B. Bruno', 'A. Adams']);
    });
  });

  describe('setup', () => {
    const pending = { servingSide: null, serverPlayerId: null, courtPositions: {} } as const;

    it('starts a singles match with the chosen end serving', async () => {
      ready(buildState({ serve: pending }));
      renderAt('m1', 'tok');
      await userEvent.click(screen.getByRole('button', { name: 'Start match' }));
      expect(noopHandlers.startSet).toHaveBeenCalledWith('A', 'a1', undefined);
    });

    it('lets the umpire hand the opening serve to the other end', async () => {
      ready(buildState({ serve: pending }));
      renderAt('m1', 'tok');
      await userEvent.click(screen.getByLabelText('Right serves'));
      await userEvent.click(screen.getByRole('button', { name: 'Start match' }));
      expect(noopHandlers.startSet).toHaveBeenCalledWith('B', 'b1', undefined);
    });

    it('starts a doubles match with the right-court player serving', async () => {
      ready(buildDoublesState({ serve: pending }));
      renderAt('m1', 'tok');
      await userEvent.click(screen.getByRole('button', { name: 'Start match' }));
      expect(noopHandlers.startSet).toHaveBeenCalledWith('A', 'a1', {
        A: { right: 'a1', left: 'a2' },
        B: { right: 'b1', left: 'b2' },
      });
    });

    it('swaps a pair between service courts, changing who serves first', async () => {
      ready(buildDoublesState({ serve: pending }));
      renderAt('m1', 'tok');
      await userEvent.click(screen.getByLabelText('Swap A. Adams / A. Stone service courts'));
      await userEvent.click(screen.getByRole('button', { name: 'Start match' }));
      expect(noopHandlers.startSet).toHaveBeenCalledWith('A', 'a2', {
        A: { right: 'a2', left: 'a1' },
        B: { right: 'b1', left: 'b2' },
      });
    });

    it('swaps ends and remembers the arrangement for the match', async () => {
      ready(buildState({ serve: pending }));
      const view = renderAt('m1', 'tok');
      await userEvent.click(screen.getByLabelText('Swap ends'));
      expect([...document.querySelectorAll('.umpire-team-name')].map((n) => n.textContent)).toEqual(
        ['B. Bruno', 'A. Adams'],
      );
      expect(localStorage.getItem('courtside:ends:m1')).toBe('B');
      // A refresh must not silently mirror the court back.
      view.unmount();
      renderAt('m1', 'tok');
      expect([...document.querySelectorAll('.umpire-team-name')].map((n) => n.textContent)).toEqual(
        ['B. Bruno', 'A. Adams'],
      );
    });

    it('survives storage being unavailable', async () => {
      const getItem = jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('blocked');
      });
      const setItem = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('blocked');
      });
      ready(buildState({ serve: pending }));
      renderAt('m1', 'tok');
      await userEvent.click(screen.getByLabelText('Swap ends'));
      expect(screen.getByRole('button', { name: 'Start match' })).toBeInTheDocument();
      getItem.mockRestore();
      setItem.mockRestore();
    });

    it('leaves positions alone when a doubles side is short a partner', async () => {
      // Defensive: a half-filled doubles roster has nobody to swap with, so
      // the control must be a no-op rather than blanking the court.
      const s = buildDoublesState({ serve: pending });
      s.match.players = s.match.players.filter((p) => p.playerId !== 'a2');
      ready(s);
      renderAt('m1', 'tok');
      await userEvent.click(screen.getByLabelText('Swap A. Adams service courts'));
      await userEvent.click(screen.getByRole('button', { name: 'Start match' }));
      expect(noopHandlers.startSet).toHaveBeenCalledWith('A', 'a1', {
        A: { right: 'a1', left: '' },
        B: { right: 'b1', left: 'b2' },
      });
    });

    it('does not start a match for a side with no players', async () => {
      const s = buildState({ serve: pending });
      s.match.players = [
        { playerId: 'b1', side: 'B', name: 'Bilal', lastName: 'Bruno', shortName: 'BIL' },
      ];
      ready(s);
      renderAt('m1', 'tok');
      await userEvent.click(screen.getByRole('button', { name: 'Start match' }));
      expect(noopHandlers.startSet).not.toHaveBeenCalled();
    });

    it('disables the point buttons until the opening serve is set', () => {
      ready(buildState({ serve: pending }));
      renderAt('m1', 'tok');
      expect(screen.getByLabelText('Point to A. Adams')).toBeDisabled();
    });

    it('offers no swap controls in singles', () => {
      ready(buildState({ serve: pending }));
      renderAt('m1', 'tok');
      expect(document.querySelector('.court-swap')).toBeNull();
    });
  });
});
