import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { render, screen } from '@testing-library/react';
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
      players: [
        { playerId: 'a1', side: 'A', name: 'Alice', shortName: 'ALI' },
        { playerId: 'b1', side: 'B', name: 'Bilal', shortName: 'BIL' },
      ],
      umpireToken: 'tok',
      assignedCourtId: 'c1',
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      completedAt: null,
    },
    derived: {
      sets: [{ setNumber: 1, scoreA: 0, scoreB: 0, winner: null, intervalTriggered: false }],
      currentSet: { setNumber: 1, scoreA: 3, scoreB: 5, winner: null, intervalTriggered: false },
      setsWon: { A: 0, B: 0 },
      matchWinner: null,
      serve: { servingSide: 'A', serverPlayerId: 'a1', courtPositions: {} },
      onInterval: false,
      ...overrides,
    },
  };
}

beforeEach(() => {
  mockUseMatchState.mockReset();
});

describe('TvScreen', () => {
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

  it('renders the live score with both players by shortName', () => {
    mockUseMatchState.mockReturnValue({ state: buildState(), isFromCache: false, error: null });
    renderAt('c1');
    expect(screen.getByText('ALI')).toBeInTheDocument();
    expect(screen.getByText('BIL')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
  });

  it('shows a reconnecting banner when rendering from the offline cache', () => {
    mockUseMatchState.mockReturnValue({ state: buildState(), isFromCache: true, error: null });
    renderAt('c1');
    expect(screen.getByText(/Reconnecting/)).toBeInTheDocument();
  });

  it('shows an interval banner when the set is on its mid-set break', () => {
    mockUseMatchState.mockReturnValue({
      state: buildState({ onInterval: true }),
      isFromCache: false,
      error: null,
    });
    renderAt('c1');
    expect(screen.getByText('Interval')).toBeInTheDocument();
  });

  it('announces the match winner by name instead of the live score', () => {
    mockUseMatchState.mockReturnValue({
      state: buildState({ matchWinner: 'A' }),
      isFromCache: false,
      error: null,
    });
    renderAt('c1');
    expect(screen.getByText(/ALI wins the match/)).toBeInTheDocument();
  });

  it('lists completed sets, skipping any set still in progress', () => {
    mockUseMatchState.mockReturnValue({
      state: buildState({
        sets: [
          { setNumber: 1, scoreA: 21, scoreB: 15, winner: 'A', intervalTriggered: true },
          { setNumber: 2, scoreA: 3, scoreB: 5, winner: null, intervalTriggered: false },
        ],
      }),
      isFromCache: false,
      error: null,
    });
    renderAt('c1');
    expect(screen.getByText('Set 1: 21–15')).toBeInTheDocument();
    expect(screen.queryByText(/Set 2:/)).not.toBeInTheDocument();
  });

  it('falls back to the side letter when a side has no players yet', () => {
    const state = buildState();
    state.match.players = [];
    mockUseMatchState.mockReturnValue({ state, isFromCache: false, error: null });
    renderAt('c1');
    expect(screen.getByText('A')).toBeInTheDocument();
    expect(screen.getByText('B')).toBeInTheDocument();
  });
});
