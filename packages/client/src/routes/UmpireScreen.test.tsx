import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { render, screen } from '@testing-library/react';
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

const noopHandlers = { addPoint: jest.fn(), undoLastPoint: jest.fn() };

beforeEach(() => {
  mockUseMatchState.mockReset();
  noopHandlers.addPoint.mockReset();
  noopHandlers.undoLastPoint.mockReset();
});

describe('UmpireScreen', () => {
  it('reports a missing matchId (not just a missing token) when rendered outside its route', () => {
    mockUseMatchState.mockReturnValue({
      state: null,
      connected: false,
      error: null,
      ...noopHandlers,
    });
    render(
      <MemoryRouter>
        <UmpireScreen />
      </MemoryRouter>,
    );
    expect(screen.getByText(/missing its match ID or token/)).toBeInTheDocument();
  });

  it('reports a missing token/matchId rather than connecting with empty ones', () => {
    mockUseMatchState.mockReturnValue({
      state: null,
      connected: false,
      error: null,
      ...noopHandlers,
    });
    renderAt('m1'); // no ?token=
    expect(screen.getByText(/missing its match ID or token/)).toBeInTheDocument();
  });

  it('shows the server error message when one is present', () => {
    mockUseMatchState.mockReturnValue({
      state: null,
      connected: false,
      error: 'Invalid umpire token.',
      ...noopHandlers,
    });
    renderAt('m1', 'bad-token');
    expect(screen.getByText('Invalid umpire token.')).toBeInTheDocument();
  });

  it('shows a connecting message before any state has arrived', () => {
    mockUseMatchState.mockReturnValue({
      state: null,
      connected: false,
      error: null,
      ...noopHandlers,
    });
    renderAt('m1', 'good-token');
    expect(screen.getByText(/Connecting/)).toBeInTheDocument();
  });

  it('shows Live when connected', () => {
    mockUseMatchState.mockReturnValue({
      state: buildState(),
      connected: true,
      error: null,
      ...noopHandlers,
    });
    renderAt('m1', 'good-token');
    expect(screen.getByText('Live')).toBeInTheDocument();
  });

  it('shows Reconnecting… when not connected', () => {
    mockUseMatchState.mockReturnValue({
      state: buildState(),
      connected: false,
      error: null,
      ...noopHandlers,
    });
    renderAt('m1', 'good-token');
    expect(screen.getByText('Reconnecting…')).toBeInTheDocument();
  });

  it('renders each side by full player name with the running score, and the sets summary', () => {
    mockUseMatchState.mockReturnValue({
      state: buildState(),
      connected: true,
      error: null,
      ...noopHandlers,
    });
    renderAt('m1', 'good-token');
    expect(screen.getByRole('button', { name: 'Alice: 3' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Bilal: 5' })).toBeInTheDocument();
    expect(screen.getByText(/Sets — Alice 0 : 0 Bilal/)).toBeInTheDocument();
  });

  it('calls addPoint for the tapped side', async () => {
    mockUseMatchState.mockReturnValue({
      state: buildState(),
      connected: true,
      error: null,
      ...noopHandlers,
    });
    renderAt('m1', 'good-token');

    await userEvent.click(screen.getByRole('button', { name: 'Alice: 3' }));
    expect(noopHandlers.addPoint).toHaveBeenCalledWith('A');

    await userEvent.click(screen.getByRole('button', { name: 'Bilal: 5' }));
    expect(noopHandlers.addPoint).toHaveBeenCalledWith('B');
  });

  it('calls undoLastPoint when the undo button is tapped', async () => {
    mockUseMatchState.mockReturnValue({
      state: buildState(),
      connected: true,
      error: null,
      ...noopHandlers,
    });
    renderAt('m1', 'good-token');

    await userEvent.click(screen.getByRole('button', { name: 'Undo last point' }));
    expect(noopHandlers.undoLastPoint).toHaveBeenCalled();
  });

  it('shows an interval banner during a mid-set break', () => {
    mockUseMatchState.mockReturnValue({
      state: buildState({ onInterval: true }),
      connected: true,
      error: null,
      ...noopHandlers,
    });
    renderAt('m1', 'good-token');
    expect(screen.getByText('Interval')).toBeInTheDocument();
  });

  it('announces the match winner instead of the live scoring controls', () => {
    mockUseMatchState.mockReturnValue({
      state: buildState({ matchWinner: 'B' }),
      connected: true,
      error: null,
      ...noopHandlers,
    });
    renderAt('m1', 'good-token');
    expect(screen.getByText(/Bilal wins the match/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Alice/ })).not.toBeInTheDocument();
  });

  it('falls back to the side letter when a side has no players yet', () => {
    const state = buildState();
    state.match.players = [];
    mockUseMatchState.mockReturnValue({ state, connected: true, error: null, ...noopHandlers });
    renderAt('m1', 'good-token');
    expect(screen.getByRole('button', { name: 'A: 3' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'B: 5' })).toBeInTheDocument();
  });
});
