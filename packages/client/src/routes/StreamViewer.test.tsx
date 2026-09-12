import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { render, screen } from '@testing-library/react';
import type { MatchStatePayload } from '@courtside/shared';
import { StreamViewer } from './StreamViewer.js';

const mockUseMatchState = jest.fn();
jest.mock('../lib/useMatchState.js', () => ({
  useMatchState: (...args: unknown[]) => mockUseMatchState(...args),
}));

const mockUseStreamViewer = jest.fn();
jest.mock('../lib/useStreamViewer.js', () => ({
  useStreamViewer: (...args: unknown[]) => mockUseStreamViewer(...args),
}));

jest.mock('../lib/StreamVideo.js', () => ({
  StreamVideo: ({ stream }: { stream: MediaStream | null }) => (
    <div data-testid="stream-video">{stream ? 'attached' : 'empty'}</div>
  ),
}));

const fakeStream = {} as MediaStream;

function buildState(overrides: Record<string, unknown> = {}): MatchStatePayload {
  return {
    match: {
      matchId: 'm1',
      matchType: 'singles',
      status: 'IN_PROGRESS',
      scoringConfig: { pointsToWin: 21, capScore: 30, intervalAt: 11 },
      scoringLocked: true,
      teams: { A: { name: null, country: null }, B: { name: null, country: null } },
      players: [
        { playerId: 'a1', side: 'A', name: 'Alice Adams', lastName: 'Adams', shortName: 'ALI' },
        { playerId: 'b1', side: 'B', name: 'Bilal Bruno', lastName: 'Bruno', shortName: 'BIL' },
      ],
      umpireToken: 'tok',
      umpireCode: 'CODE01',
      assignedCourtId: 'c1',
      assignedUmpireId: 'u1',
      courtLabel: 'Court 1',
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
        scoreA: 7,
        scoreB: 4,
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
  } as unknown as MatchStatePayload;
}

function renderAt(courtId = 'court1') {
  return render(
    <MemoryRouter initialEntries={[`/stream/view/court/${courtId}`]}>
      <Routes>
        <Route path="/stream/view/court/:courtId" element={<StreamViewer />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUseMatchState.mockReturnValue({ state: null, isFromCache: false, error: null });
  mockUseStreamViewer.mockReturnValue({ stream: null, isPaused: false });
});

describe('StreamViewer', () => {
  it('reports a missing court ID rather than connecting with an empty one', () => {
    render(
      <MemoryRouter>
        <StreamViewer />
      </MemoryRouter>,
    );
    expect(screen.getByText('Missing court ID.')).toBeInTheDocument();
  });

  it('waits for the court while no stream has arrived', () => {
    renderAt();
    expect(screen.getByText(/Waiting for the court to start streaming/)).toBeInTheDocument();
    expect(screen.getByTestId('stream-video')).toHaveTextContent('empty');
  });

  it('shows the video without waiting for a score', () => {
    // A court transmits while players warm up, before any match exists.
    // Blanking the screen until a score arrived hid a live feed — the
    // regression this pins down.
    mockUseStreamViewer.mockReturnValue({ stream: fakeStream, isPaused: false });
    renderAt();

    expect(screen.getByTestId('stream-video')).toHaveTextContent('attached');
    expect(screen.queryByText(/Waiting for the court/)).not.toBeInTheDocument();
    expect(screen.getByText('Connecting…')).toBeInTheDocument();
  });

  it('explains a paused broadcast, which otherwise looks like a frozen picture', () => {
    mockUseStreamViewer.mockReturnValue({ stream: fakeStream, isPaused: true });
    renderAt();

    expect(screen.getByText('Camera paused')).toBeInTheDocument();
    // The whole point of the message: reassure the viewer their own screen
    // is not the problem.
    expect(screen.getByText(/Nothing is wrong with your connection/)).toBeInTheDocument();
  });

  it('announces the pause to a screen reader, not just visually', () => {
    mockUseStreamViewer.mockReturnValue({ stream: fakeStream, isPaused: true });
    renderAt();
    expect(screen.getByRole('status')).toHaveTextContent('Camera paused');
  });

  it('does not claim "paused" before any stream exists', () => {
    mockUseStreamViewer.mockReturnValue({ stream: null, isPaused: true });
    renderAt();
    expect(screen.queryByText('Camera paused')).not.toBeInTheDocument();
  });

  it('renders the scoreboard once a match is live', () => {
    mockUseMatchState.mockReturnValue({ state: buildState(), isFromCache: false, error: null });
    mockUseStreamViewer.mockReturnValue({ stream: fakeStream, isPaused: false });
    renderAt();

    expect(screen.getByText('Court 1')).toBeInTheDocument();
    expect(screen.getByText('A. Adams')).toBeInTheDocument();
    expect(screen.getByText('B. Bruno')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
  });

  it('shows the match category on the score overlay', () => {
    const state = buildState();
    (state.match as { category?: string | null }).category = 'WS U15';
    mockUseMatchState.mockReturnValue({ state, isFromCache: false, error: null });
    renderAt();

    expect(screen.getByText('WS U15')).toBeInTheDocument();
  });

  it('announces the winner when the match is decided', () => {
    mockUseMatchState.mockReturnValue({
      state: buildState({ matchWinner: 'A' }),
      isFromCache: false,
      error: null,
    });
    renderAt();
    expect(screen.getByText('A. Adams wins')).toBeInTheDocument();
  });

  it('says how the match ended early, alongside the winner', () => {
    mockUseMatchState.mockReturnValue({
      state: buildState({ matchWinner: 'A', retiredSide: 'B', retireReason: 'WALKOVER' }),
      isFromCache: false,
      error: null,
    });
    renderAt();
    expect(screen.getByText(/B\. Bruno did not show up \(W\.O\.\)/)).toBeInTheDocument();
  });

  it('defaults to a retirement label when no reason is recorded', () => {
    mockUseMatchState.mockReturnValue({
      state: buildState({ matchWinner: 'A', retiredSide: 'B' }),
      isFromCache: false,
      error: null,
    });
    renderAt();
    expect(screen.getByText(/B\. Bruno retired/)).toBeInTheDocument();
  });

  it('tells the viewer no match is on this court yet when state errored', () => {
    mockUseMatchState.mockReturnValue({ state: null, isFromCache: false, error: 'no match' });
    renderAt();
    expect(screen.getByText(/Waiting for a match on this court/)).toBeInTheDocument();
  });

  it('flags a cached reconnection', () => {
    mockUseMatchState.mockReturnValue({ state: buildState(), isFromCache: true, error: null });
    renderAt();
    expect(screen.getByText('Reconnecting…')).toBeInTheDocument();
  });

  it('views the court named in the URL', () => {
    renderAt('court-42');
    expect(mockUseStreamViewer).toHaveBeenCalledWith('court-42');
  });

  it('shows the completed sets once the match is over', () => {
    mockUseMatchState.mockReturnValue({
      state: buildState({
        matchWinner: 'A',
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
            scoreA: 21,
            scoreB: 18,
            winner: 'A',
            intervalTriggered: true,
            intervalResumed: true,
          },
        ],
        setsWon: { A: 2, B: 0 },
      }),
      isFromCache: false,
      error: null,
    });
    renderAt();

    expect(screen.getByText('S1')).toBeInTheDocument();
    expect(screen.getByText('S2')).toBeInTheDocument();
    expect(screen.getByText('15')).toBeInTheDocument();
    expect(screen.getByText('18')).toBeInTheDocument();
  });

  it('marks a decided set and leaves the one in progress unmarked', () => {
    mockUseMatchState.mockReturnValue({
      state: buildState({
        sets: [
          {
            setNumber: 1,
            scoreA: 21,
            scoreB: 12,
            winner: 'A',
            intervalTriggered: true,
            intervalResumed: true,
          },
        ],
        currentSet: {
          setNumber: 2,
          scoreA: 5,
          scoreB: 3,
          winner: null,
          intervalTriggered: false,
          intervalResumed: false,
        },
        setsWon: { A: 1, B: 0 },
      }),
      isFromCache: false,
      error: null,
    });
    const { container } = renderAt();

    expect(container.querySelector('.set-winner')?.textContent).toBe('21');
    expect(container.querySelector('.current-set')?.textContent).toBe('S2');
  });

  it("falls back to a player's short name when they have no full name", () => {
    const state = buildState();
    state.match.players = [
      { playerId: 'a1', side: 'A', name: '', lastName: '', shortName: 'ALI' },
      { playerId: 'b1', side: 'B', name: '', lastName: '', shortName: 'BIL' },
    ];
    mockUseMatchState.mockReturnValue({ state, isFromCache: false, error: null });
    renderAt();

    expect(screen.getByText('ALI')).toBeInTheDocument();
  });

  it('falls back to the side letter when a side has no players', () => {
    const state = buildState();
    state.match.players = [];
    mockUseMatchState.mockReturnValue({ state, isFromCache: false, error: null });
    const { container } = renderAt();

    const names = [...container.querySelectorAll('.stream-player-name')].map((n) => n.textContent);
    expect(names).toEqual(['A', 'B']);
  });

  it('names both players of a doubles pair', () => {
    const state = buildState();
    state.match.players = [
      { playerId: 'a1', side: 'A', name: 'Alice Adams', lastName: 'Adams', shortName: 'ALI' },
      { playerId: 'a2', side: 'A', name: 'Anna Ames', lastName: 'Ames', shortName: 'ANN' },
      { playerId: 'b1', side: 'B', name: 'Bilal Bruno', lastName: 'Bruno', shortName: 'BIL' },
      { playerId: 'b2', side: 'B', name: 'Bea Blue', lastName: 'Blue', shortName: 'BEA' },
    ];
    mockUseMatchState.mockReturnValue({ state, isFromCache: false, error: null });
    renderAt();

    expect(screen.getByText('A. Adams / A. Ames')).toBeInTheDocument();
  });
});
