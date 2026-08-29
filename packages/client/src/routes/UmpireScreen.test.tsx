import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { fireEvent, render, screen } from '@testing-library/react';
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
      umpireCode: 'CODE01',
      assignedCourtId: 'c1',
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
    { playerId: 'a1', side: 'A', name: 'Alice', shortName: 'ALI' },
    { playerId: 'a2', side: 'A', name: 'Amy', shortName: 'AMY' },
    { playerId: 'b1', side: 'B', name: 'Bilal', shortName: 'BIL' },
    { playerId: 'b2', side: 'B', name: 'Ben', shortName: 'BEN' },
  ];
  return state;
}

const noopHandlers = {
  addPoint: jest.fn(),
  undoLastPoint: jest.fn(),
  startSet: jest.fn(),
  resumeFromInterval: jest.fn(),
};

beforeEach(() => {
  mockUseMatchState.mockReset();
  noopHandlers.addPoint.mockReset();
  noopHandlers.undoLastPoint.mockReset();
  noopHandlers.startSet.mockReset();
  noopHandlers.resumeFromInterval.mockReset();
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

  it('renders each side by full player name with the running score, serving info, and the sets summary', () => {
    mockUseMatchState.mockReturnValue({
      state: buildState(),
      connected: true,
      error: null,
      ...noopHandlers,
    });
    renderAt('m1', 'good-token');
    expect(screen.getByRole('button', { name: 'Alice: 3' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Bilal: 5' })).toBeInTheDocument();
    expect(screen.getByText(/Serving: Side A/)).toBeInTheDocument();
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

  it('collects the opening singles server before enabling scoring', async () => {
    mockUseMatchState.mockReturnValue({
      state: buildState({ serve: { servingSide: null, serverPlayerId: null, courtPositions: {} } }),
      connected: true,
      error: null,
      ...noopHandlers,
    });
    renderAt('m1', 'good-token');

    await userEvent.click(screen.getByRole('radio', { name: 'Side B' }));
    await userEvent.selectOptions(screen.getByLabelText('First server (right court)'), 'b1');
    await userEvent.click(screen.getByRole('button', { name: 'Start scoring' }));

    expect(noopHandlers.startSet).toHaveBeenCalledWith('B', 'b1', undefined);
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
    expect(screen.getByRole('button', { name: /Interval/ })).toBeInTheDocument();
  });

  it('locks scoring and hides undo until an interval is resumed', () => {
    mockUseMatchState.mockReturnValue({
      state: buildState({ onInterval: true }),
      connected: true,
      error: null,
      ...noopHandlers,
    });
    renderAt('m1', 'good-token');

    expect(screen.getByRole('button', { name: 'Alice: 3' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Bilal: 5' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Undo last point' })).not.toBeInTheDocument();
  });

  it('calls resumeFromInterval when the umpire taps the interval banner to end it', async () => {
    mockUseMatchState.mockReturnValue({
      state: buildState({ onInterval: true }),
      connected: true,
      error: null,
      ...noopHandlers,
    });
    renderAt('m1', 'good-token');

    await userEvent.click(screen.getByRole('button', { name: /Interval/ }));
    expect(noopHandlers.resumeFromInterval).toHaveBeenCalled();
  });

  it('hides the interval banner once play has resumed', () => {
    mockUseMatchState.mockReturnValue({
      state: buildState({ onInterval: false }),
      connected: true,
      error: null,
      ...noopHandlers,
    });
    renderAt('m1', 'good-token');
    expect(screen.queryByRole('button', { name: /Interval/ })).not.toBeInTheDocument();
  });

  it('shows the completed score table, duration, and winner without serving or undo controls', () => {
    const state = buildState({
      matchWinner: 'B',
      sets: [
        {
          setNumber: 1,
          scoreA: 15,
          scoreB: 21,
          winner: 'B',
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
      ],
    });
    state.match.startedAt = '2026-08-29T10:00:00.000Z';
    state.match.completedAt = '2026-08-29T10:02:30.000Z';
    mockUseMatchState.mockReturnValue({
      state,
      connected: true,
      error: null,
      ...noopHandlers,
    });
    renderAt('m1', 'good-token');
    expect(screen.getByText(/Bilal wins the match/)).toBeInTheDocument();
    expect(screen.getByLabelText('Match score')).toBeInTheDocument();
    expect(screen.getByText('Match time 2 min 30 sec')).toBeInTheDocument();
    expect(document.querySelector('.match-summary-card')).not.toHaveTextContent(/^Set \d+$/);
    expect(document.querySelector('.match-summary-card')).not.toHaveTextContent(/Serving: Side/);
    expect(screen.queryByText('Serving now')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Undo last point' })).not.toBeInTheDocument();
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

  it('falls back to "Court Unassigned" when neither a court label nor an assigned court is known', () => {
    const state = buildState();
    state.match.assignedCourtId = null;
    mockUseMatchState.mockReturnValue({ state, connected: true, error: null, ...noopHandlers });
    renderAt('m1', 'good-token');
    expect(screen.getByText('Court Unassigned')).toBeInTheDocument();
  });

  it('omits the match duration line for a winning match with no recorded start time', () => {
    const state = buildState({ matchWinner: 'A' });
    state.match.startedAt = null;
    state.match.completedAt = null;
    mockUseMatchState.mockReturnValue({ state, connected: true, error: null, ...noopHandlers });
    renderAt('m1', 'good-token');
    expect(screen.getByText(/Alice wins the match/)).toBeInTheDocument();
    expect(screen.queryByText(/Match time/)).not.toBeInTheDocument();
  });

  it('computes the match duration against the current time when a winning match has no completedAt', () => {
    const state = buildState({ matchWinner: 'A' });
    state.match.startedAt = new Date().toISOString();
    state.match.completedAt = null;
    mockUseMatchState.mockReturnValue({ state, connected: true, error: null, ...noopHandlers });
    renderAt('m1', 'good-token');
    expect(screen.getByText(/Match time \d+ min \d+ sec/)).toBeInTheDocument();
  });

  it('shows "Right court" when the serving side is on an even score', () => {
    const state = buildState({
      currentSet: {
        setNumber: 1,
        scoreA: 4,
        scoreB: 5,
        winner: null,
        intervalTriggered: false,
        intervalResumed: false,
      },
      serve: { servingSide: 'A', serverPlayerId: 'a1', courtPositions: {} },
    });
    mockUseMatchState.mockReturnValue({ state, connected: true, error: null, ...noopHandlers });
    renderAt('m1', 'good-token');
    expect(screen.getByText('right court')).toBeInTheDocument();
  });

  it('marks side B as serving when it is side B on serve', () => {
    const state = buildState({
      currentSet: {
        setNumber: 1,
        scoreA: 3,
        scoreB: 4,
        winner: null,
        intervalTriggered: false,
        intervalResumed: false,
      },
      serve: { servingSide: 'B', serverPlayerId: 'b1', courtPositions: {} },
    });
    mockUseMatchState.mockReturnValue({ state, connected: true, error: null, ...noopHandlers });
    renderAt('m1', 'good-token');
    expect(document.querySelector('.serve-box.side-b')).toHaveClass('serving-player');
    expect(screen.getAllByText('Serving now')).toHaveLength(1);
  });

  describe('doubles opening service', () => {
    it('starts a doubles match once both right-court players and the first server are chosen', async () => {
      mockUseMatchState.mockReturnValue({
        state: buildDoublesState({
          serve: { servingSide: null, serverPlayerId: null, courtPositions: {} },
        }),
        connected: true,
        error: null,
        ...noopHandlers,
      });
      renderAt('m1', 'good-token');

      await userEvent.selectOptions(screen.getByLabelText('Side A, right service court'), 'a1');
      await userEvent.selectOptions(screen.getByLabelText('Side B, right service court'), 'b1');
      await userEvent.selectOptions(screen.getByLabelText('First server (right court)'), 'a1');
      await userEvent.click(screen.getByRole('button', { name: 'Start scoring' }));

      expect(noopHandlers.startSet).toHaveBeenCalledWith('A', 'a1', {
        A: { right: 'a1', left: 'a2' },
        B: { right: 'b1', left: 'b2' },
      });
    });

    it('does not start scoring if one side never got a right-court player assigned', () => {
      mockUseMatchState.mockReturnValue({
        state: buildDoublesState({
          serve: { servingSide: null, serverPlayerId: null, courtPositions: {} },
        }),
        connected: true,
        error: null,
        ...noopHandlers,
      });
      renderAt('m1', 'good-token');

      // Bypasses the <select required> gate directly, the way a stale or
      // scripted submit could — side B's right-court select was never
      // touched, so its rightPlayerIds entry is still ''.
      fireEvent.submit(document.querySelector('form.service-setup')!);

      expect(noopHandlers.startSet).not.toHaveBeenCalled();
    });

    it('refuses to start scoring if the first server no longer matches the reassigned right-court player', async () => {
      mockUseMatchState.mockReturnValue({
        state: buildDoublesState({
          serve: { servingSide: null, serverPlayerId: null, courtPositions: {} },
        }),
        connected: true,
        error: null,
        ...noopHandlers,
      });
      renderAt('m1', 'good-token');

      await userEvent.selectOptions(screen.getByLabelText('Side A, right service court'), 'a1');
      await userEvent.selectOptions(screen.getByLabelText('Side B, right service court'), 'b1');
      await userEvent.selectOptions(screen.getByLabelText('First server (right court)'), 'a1');
      // Reassign side A's right-court player without re-picking the first
      // server — firstServerPlayerId is only reset when the serving side
      // changes, so it's now stale relative to the new right-court pick.
      await userEvent.selectOptions(screen.getByLabelText('Side A, right service court'), 'a2');

      fireEvent.submit(document.querySelector('form.service-setup')!);

      expect(noopHandlers.startSet).not.toHaveBeenCalled();
    });
  });

  it('does not start scoring for singles if no first server was ever chosen', () => {
    mockUseMatchState.mockReturnValue({
      state: buildState({ serve: { servingSide: null, serverPlayerId: null, courtPositions: {} } }),
      connected: true,
      error: null,
      ...noopHandlers,
    });
    renderAt('m1', 'good-token');

    fireEvent.submit(document.querySelector('form.service-setup')!);

    expect(noopHandlers.startSet).not.toHaveBeenCalled();
  });

  describe('doubles live serving text', () => {
    it('names the server and their service court once scoring has started', () => {
      const state = buildDoublesState({
        serve: {
          servingSide: 'A',
          serverPlayerId: 'a1',
          courtPositions: { A: { right: 'a1', left: 'a2' }, B: { right: 'b1', left: 'b2' } },
        },
      });
      mockUseMatchState.mockReturnValue({ state, connected: true, error: null, ...noopHandlers });
      renderAt('m1', 'good-token');
      expect(screen.getByText(/Serving: Side A · Alice \(right court\)/)).toBeInTheDocument();
    });

    it('names the server on the left court when they are not the right-court player', () => {
      const state = buildDoublesState({
        serve: {
          servingSide: 'A',
          serverPlayerId: 'a2',
          courtPositions: { A: { right: 'a1', left: 'a2' }, B: { right: 'b1', left: 'b2' } },
        },
      });
      mockUseMatchState.mockReturnValue({ state, connected: true, error: null, ...noopHandlers });
      renderAt('m1', 'good-token');
      expect(screen.getByText(/Serving: Side A · Amy \(left court\)/)).toBeInTheDocument();
    });

    it('falls back to a generic "service court" label when court positions are unknown for the serving side', () => {
      const state = buildDoublesState({
        serve: { servingSide: 'A', serverPlayerId: 'a1', courtPositions: {} },
      });
      mockUseMatchState.mockReturnValue({ state, connected: true, error: null, ...noopHandlers });
      renderAt('m1', 'good-token');
      expect(screen.getByText(/Serving: Side A · Alice \(service court\)/)).toBeInTheDocument();
    });
  });
});
