import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MatchStatePayload } from '@courtside/shared';
import { TvScreen } from './TvScreen.js';

const mockUseMatchState = jest.fn();
jest.mock('../lib/useMatchState.js', () => ({
  useMatchState: (...args: unknown[]) => mockUseMatchState(...args),
}));

function renderAt(courtId: string) {
  return render(
    <MemoryRouter initialEntries={[`/tv/court/${courtId}`]}>
      <Routes>
        <Route path="/tv/court/:courtId" element={<TvScreen />} />
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
      retireReason: null,
      ...overrides,
    },
  };
}

beforeEach(() => {
  mockUseMatchState.mockReset();
});

describe('TvScreen', () => {
  it('shows the category instead of the match type, which it already implies', () => {
    const state = buildState();
    state.match.category = 'MS U19';
    mockUseMatchState.mockReturnValue({ state, isFromCache: false, error: null });
    renderAt('c1');

    expect(screen.getByText('MS U19')).toBeInTheDocument();
    // "MS U19" already says men's singles; repeating "singles" beside it is noise.
    expect(screen.queryByText('singles')).not.toBeInTheDocument();
  });

  it('falls back to the match type when no category was entered', () => {
    const state = buildState();
    state.match.category = null;
    mockUseMatchState.mockReturnValue({ state, isFromCache: false, error: null });
    const { container } = renderAt('c1');

    expect(screen.getByText('singles')).toBeInTheDocument();
    expect(container.querySelector('.category-pill')).toBeNull();
  });

  it('reports a missing court ID rather than connecting with an empty one', () => {
    mockUseMatchState.mockReturnValue({ state: null, isFromCache: false, error: null });
    render(
      <MemoryRouter>
        <TvScreen />
      </MemoryRouter>,
    );
    expect(screen.getByText(/missing a court ID/)).toBeInTheDocument();
  });

  it('shows a connecting message before any state has arrived', () => {
    mockUseMatchState.mockReturnValue({ state: null, isFromCache: false, error: null });
    renderAt('c1');
    expect(screen.getByText(/Connecting/)).toBeInTheDocument();
  });

  it('shows a waiting message when the court has no match and no cached state', () => {
    mockUseMatchState.mockReturnValue({
      state: null,
      isFromCache: false,
      error: 'No match found.',
    });
    renderAt('c1');
    expect(screen.getByText(/Waiting for a match/)).toBeInTheDocument();
  });

  it('renders the live score with player names and a serving marker', () => {
    mockUseMatchState.mockReturnValue({ state: buildState(), isFromCache: false, error: null });
    renderAt('c1');
    expect(screen.getByText('A. Adams')).toBeInTheDocument();
    expect(screen.getByText('B. Bruno')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.getByText('Serving')).toBeInTheDocument();
  });

  it('shows a reconnecting banner when rendering from the offline cache', () => {
    mockUseMatchState.mockReturnValue({ state: buildState(), isFromCache: true, error: null });
    renderAt('c1');
    expect(screen.getByText(/Reconnecting/)).toBeInTheDocument();
  });

  it('shows an interval banner when the set is on its mid-set break', () => {
    mockUseMatchState.mockReturnValue({
      state: buildState({ onInterval: true, interval: { kind: 'MID_GAME', seconds: 60 } }),
      isFromCache: false,
      error: null,
    });
    renderAt('c1');
    expect(screen.getByText('Interval')).toBeInTheDocument();
  });

  it('shows a game-interval banner when the set is on its between-games break', () => {
    mockUseMatchState.mockReturnValue({
      state: buildState({ interval: { kind: 'BETWEEN_GAMES', seconds: 120 } }),
      isFromCache: false,
      error: null,
    });
    renderAt('c1');
    expect(screen.getByText('Game interval')).toBeInTheDocument();
  });

  it('announces the match winner by name instead of the live score', async () => {
    const state = buildState({
      matchWinner: 'A',
      currentSet: {
        setNumber: 4,
        scoreA: 0,
        scoreB: 0,
        winner: null,
        intervalTriggered: false,
        intervalResumed: false,
      },
      sets: [
        {
          setNumber: 1,
          scoreA: 21,
          scoreB: 11,
          winner: 'A',
          intervalTriggered: true,
          intervalResumed: true,
        },
        {
          setNumber: 2,
          scoreA: 9,
          scoreB: 21,
          winner: 'B',
          intervalTriggered: true,
          intervalResumed: true,
        },
        {
          setNumber: 3,
          scoreA: 21,
          scoreB: 7,
          winner: 'A',
          intervalTriggered: true,
          intervalResumed: true,
        },
      ],
    });
    state.match.startedAt = '2026-08-29T10:00:00.000Z';
    state.match.completedAt = '2026-08-29T10:03:12.000Z';
    mockUseMatchState.mockReturnValue({
      state,
      isFromCache: false,
      error: null,
    });
    renderAt('c1');
    expect(screen.getByText(/A. Adams wins the match/)).toBeInTheDocument();
    expect(screen.getByLabelText('Match score')).toBeInTheDocument();
    expect(screen.getByText('Set 3')).toBeInTheDocument();
    expect(screen.queryByText('Set 4')).not.toBeInTheDocument();
    expect(screen.getAllByText('21')[0]).toHaveClass('set-score-winner');
    expect(screen.getAllByText('21')[1]).toHaveClass('set-score-winner');
    expect(screen.getByText('A. Adams').closest('.tv-player-row')).toHaveClass('match-winner');
    expect(screen.getByText('Match time 3 min 12 sec')).toBeInTheDocument();
    const reloadSpy = jest.fn();
    Object.defineProperty(window, 'location', {
      value: { ...window.location, reload: reloadSpy },
      configurable: true,
      writable: true,
    });

    await userEvent.click(screen.getByRole('button', { name: 'Refresh display' }));

    expect(reloadSpy).toHaveBeenCalled();
  });

  it('shows completed and current set scores, highlighting the current set', () => {
    mockUseMatchState.mockReturnValue({
      state: buildState({
        currentSet: {
          setNumber: 2,
          scoreA: 3,
          scoreB: 5,
          winner: null,
          intervalTriggered: false,
          intervalResumed: false,
        },
        sets: [
          {
            setNumber: 1,
            scoreA: 21,
            scoreB: 15,
            winner: 'A',
            intervalTriggered: true,
            intervalResumed: false,
          },
          {
            setNumber: 2,
            scoreA: 3,
            scoreB: 5,
            winner: null,
            intervalTriggered: false,
            intervalResumed: false,
          },
        ],
      }),
      isFromCache: false,
      error: null,
    });
    renderAt('c1');
    expect(screen.getByText('Set 1')).toBeInTheDocument();
    expect(screen.getByText('Set 2')).toBeInTheDocument();
    expect(screen.getAllByText('21')).toHaveLength(1);
    expect(screen.getByText('3')).toHaveClass('current-set');
  });

  it('falls back to the side letter when a side has no players yet', () => {
    const state = buildState();
    state.match.players = [];
    mockUseMatchState.mockReturnValue({ state, isFromCache: false, error: null });
    renderAt('c1');
    expect(screen.getByText('A')).toBeInTheDocument();
    expect(screen.getByText('B')).toBeInTheDocument();
  });

  it("falls back to a player's shortName when their given name has no usable first word", () => {
    const state = buildState();
    state.match.players = [
      { playerId: 'a1', side: 'A', name: '  ', lastName: '', shortName: 'ALI' },
      { playerId: 'b1', side: 'B', name: 'Bilal', lastName: 'Bruno', shortName: 'BIL' },
    ];
    mockUseMatchState.mockReturnValue({ state, isFromCache: false, error: null });
    renderAt('c1');
    expect(screen.getByText('ALI')).toBeInTheDocument();
  });

  it('omits the match duration for a winning match with no recorded start time', () => {
    const state = buildState({ matchWinner: 'A' });
    state.match.startedAt = null;
    state.match.completedAt = null;
    mockUseMatchState.mockReturnValue({ state, isFromCache: false, error: null });
    renderAt('c1');
    expect(screen.getByText(/A. Adams wins the match/)).toBeInTheDocument();
    expect(screen.queryByText(/Match time/)).not.toBeInTheDocument();
  });

  it('computes the match duration against the current time when a winning match has no completedAt', () => {
    const state = buildState({ matchWinner: 'A' });
    state.match.startedAt = new Date().toISOString();
    state.match.completedAt = null;
    mockUseMatchState.mockReturnValue({ state, isFromCache: false, error: null });
    renderAt('c1');
    expect(screen.getByText(/Match time \d+ min \d+ sec/)).toBeInTheDocument();
  });
});

describe('TvScreen — teams, retirement and the wall clock', () => {
  it('shows the elapsed time while a match is running', () => {
    const state = buildState();
    state.match.startedAt = new Date(Date.now() - 95_000).toISOString();
    mockUseMatchState.mockReturnValue({ state, isFromCache: false, error: null });
    renderAt('c1');
    expect(screen.getByLabelText('Elapsed match time')).toHaveTextContent(/1 min 35 sec/);
  });

  it('shows each side team and country when the match carries them', () => {
    const state = buildState();
    state.match.teams = {
      A: { name: 'Riverside', country: 'COL' },
      B: { name: null, country: 'ESP' },
    };
    mockUseMatchState.mockReturnValue({ state, isFromCache: false, error: null });
    renderAt('c1');
    expect(screen.getByText('Riverside · COL')).toBeInTheDocument();
    // A country with no club name still gets shown, on its own.
    expect(screen.getByText('ESP')).toBeInTheDocument();
  });

  it('marks the side that retired, and says so in the result', () => {
    const state = buildState({ matchWinner: 'B', retiredSide: 'A', finalised: true });
    mockUseMatchState.mockReturnValue({ state, isFromCache: false, error: null });
    renderAt('c1');
    expect(screen.getByText('Retired')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/retired/i);
  });

  it('marks a walkover distinctly from a retirement', () => {
    const state = buildState({
      matchWinner: 'B',
      retiredSide: 'A',
      retireReason: 'WALKOVER',
      finalised: true,
    });
    mockUseMatchState.mockReturnValue({ state, isFromCache: false, error: null });
    renderAt('c1');
    expect(screen.getByText('W.O.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/did not show up/i);
  });

  it('leaves the retirement marker off a match played to its end', () => {
    const state = buildState({ matchWinner: 'B', finalised: true });
    mockUseMatchState.mockReturnValue({ state, isFromCache: false, error: null });
    renderAt('c1');
    expect(screen.queryByText('Retired')).not.toBeInTheDocument();
  });
});

describe('TvScreen — the wall clock advances', () => {
  it('re-renders every second so the elapsed time keeps moving', () => {
    jest.useFakeTimers();
    try {
      const state = buildState();
      state.match.startedAt = new Date(Date.now() - 20_000).toISOString();
      mockUseMatchState.mockReturnValue({ state, isFromCache: false, error: null });
      renderAt('c1');
      expect(screen.getByLabelText('Elapsed match time')).toHaveTextContent('0 min 20 sec');
      act(() => {
        jest.advanceTimersByTime(4000);
      });
      expect(screen.getByLabelText('Elapsed match time')).toHaveTextContent('0 min 24 sec');
    } finally {
      jest.useRealTimers();
    }
  });
});
