import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Court, Match, MatchSummary, Umpire } from '@courtside/shared';
import { QRCodeSVG } from 'qrcode.react';
import { AdminDashboard } from './AdminDashboard.js';

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response;
}

const sampleMatches: MatchSummary[] = [
  {
    matchId: 'm1',
    matchType: 'singles',
    status: 'CREATED',
    assignedCourtId: 'c1',
    courtLabel: 'Court 1',
    createdAt: '2026-08-29T10:00:00.000Z',
    teams: { A: { name: null, country: null }, B: { name: null, country: null } },
    players: [
      { playerId: 'a1', side: 'A', name: 'Alice', shortName: 'ALI' },
      { playerId: 'b1', side: 'B', name: 'Bilal', shortName: 'BIL' },
    ],
    derived: {
      sets: [{ setNumber: 1, scoreA: 0, scoreB: 0, winner: null }],
      setsWon: { A: 0, B: 0 },
      matchWinner: null,
    },
  },
];

const sampleCourts: Court[] = [
  { courtId: 'c1', label: 'Court 1', currentMatchId: null, tvCode: 'TVC001' },
];

const sampleUmpires: Umpire[] = [
  { umpireId: 'u1', tournamentId: 'tournament-1', name: 'Uma Umpire' },
];

function sampleCreatedMatch(overrides: Partial<Match> = {}): { match: Match; derived: unknown } {
  return {
    match: {
      matchId: 'm-new',
      matchType: 'singles',
      status: 'CREATED',
      scoringConfig: { pointsToWin: 21, capScore: 30, intervalAt: 11 },
      scoringLocked: false,
      players: [],
      teams: { A: { name: null, country: null }, B: { name: null, country: null } },
      umpireToken: 'tok-xyz',
      umpireCode: 'UMP001',
      assignedCourtId: null,
      assignedUmpireId: null,
      createdAt: '',
      startedAt: null,
      completedAt: null,
      ...overrides,
    },
    derived: {},
  };
}

/**
 * The component makes four distinct fetch calls (GET/POST for both
 * /api/matches and /api/courts), all through the same `global.fetch` — this
 * routes each by URL + method instead of one blanket mock answering all of
 * them the same way (which previously caused courts to be silently filled
 * in with match data and vice versa).
 */
function mockFetchRoutes(routes: {
  getMatches?: Response;
  getCourts?: Response;
  getUmpires?: Response;
  getMatch?: Response;
  postMatches?: Response;
  postCourts?: Response;
  postUmpires?: Response;
  deleteCourt?: Response;
  deleteUmpire?: Response;
}) {
  (global.fetch as jest.Mock).mockImplementation(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const pathname = url.split('?')[0];
    if (pathname === '/api/matches' && method === 'GET')
      return routes.getMatches ?? jsonResponse([]);
    if (url === '/api/matches/m1' && method === 'GET')
      return routes.getMatch ?? jsonResponse(sampleCreatedMatch());
    if (pathname === '/api/courts' && method === 'GET')
      return routes.getCourts ?? jsonResponse(sampleCourts);
    if (pathname === '/api/umpires' && method === 'GET')
      return routes.getUmpires ?? jsonResponse(sampleUmpires);
    if (url === '/api/matches' && method === 'POST') {
      return routes.postMatches ?? jsonResponse(sampleCreatedMatch());
    }
    if (url === '/api/courts' && method === 'POST') {
      return routes.postCourts ?? jsonResponse(sampleCourts[0]);
    }
    if (url === '/api/umpires' && method === 'POST') {
      return routes.postUmpires ?? jsonResponse(sampleUmpires[0]);
    }
    if (url.startsWith('/api/courts/') && method === 'DELETE') {
      return routes.deleteCourt ?? jsonResponse({});
    }
    if (url.startsWith('/api/umpires/') && method === 'DELETE') {
      return routes.deleteUmpire ?? jsonResponse({});
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  });
}

// Both the court list and the umpire list render a "Remove" button, so a
// bare role query is ambiguous — scope to the first (court) list, which
// renders before the umpire one.
function courtRemoveButton(): HTMLElement {
  return within(document.querySelector('.court-list')!).getByRole('button', { name: 'Remove' });
}

async function selectCourt() {
  await screen.findByRole('option', { name: 'Court 1' });
  await userEvent.selectOptions(screen.getByLabelText('Court'), 'c1');
  await userEvent.selectOptions(screen.getByLabelText('Umpire'), 'u1');
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('courtside:tournamentId', 'tournament-1');
  window.history.replaceState({}, '', '/admin');
  global.fetch = jest.fn();
  mockFetchRoutes({});
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: jest.fn().mockResolvedValue(undefined) },
    configurable: true,
  });
});

describe('AdminDashboard', () => {
  it('never shows a password prompt — this is a single-admin, LAN-only tool', () => {
    render(<AdminDashboard />);
    expect(screen.queryByLabelText('Admin password')).not.toBeInTheDocument();
  });

  it('fetches immediately on mount, using the generic default password', async () => {
    render(<AdminDashboard />);

    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/matches?tournamentId=tournament-1',
        expect.objectContaining({ headers: { 'x-admin-password': 'change-me' } }),
      ),
    );
  });

  it('picks up an admin password handed off via the URL (the desktop app flow)', async () => {
    window.history.replaceState({}, '', '/admin?adminPassword=from-url-pw');

    render(<AdminDashboard />);

    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/matches?tournamentId=tournament-1',
        expect.objectContaining({ headers: { 'x-admin-password': 'from-url-pw' } }),
      ),
    );
    expect(localStorage.getItem('courtside:adminPassword')).toBe('from-url-pw');
  });

  it('scrubs the password back out of the address bar after picking it up', () => {
    window.history.replaceState({}, '', '/admin?adminPassword=from-url-pw&foo=bar');

    render(<AdminDashboard />);

    expect(window.location.search).not.toContain('adminPassword');
    expect(window.location.search).toContain('foo=bar');
  });

  it('leaves the URL alone when no password was handed off', () => {
    render(<AdminDashboard />);
    expect(window.location.search).toBe('');
  });

  it('shows the tournament name, date, and a warning when no tournament is selected', () => {
    localStorage.removeItem('courtside:tournamentId');
    window.history.replaceState(
      {},
      '',
      '/admin?tournamentName=Winter+Open&tournamentDate=2026-09-01',
    );

    render(<AdminDashboard />);

    expect(screen.getByText('Winter Open — Admin')).toBeInTheDocument();
    expect(screen.getByText(new Date('2026-09-01').toLocaleDateString())).toBeInTheDocument();
    expect(
      screen.getByText('Select a tournament in the desktop launcher first.'),
    ).toBeInTheDocument();
  });

  it('remembers a previously entered admin password across renders, refreshing both lists', async () => {
    localStorage.setItem('courtside:adminPassword', 'stored-pw');

    render(<AdminDashboard />);

    expect(screen.queryByLabelText('Admin password')).not.toBeInTheDocument();
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/matches?tournamentId=tournament-1',
        expect.objectContaining({ headers: { 'x-admin-password': 'stored-pw' } }),
      ),
    );
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/courts?tournamentId=tournament-1',
        expect.objectContaining({ headers: { 'x-admin-password': 'stored-pw' } }),
      ),
    );
  });

  it('fetches and lists matches once a password is entered, persisting it to localStorage', async () => {
    mockFetchRoutes({ getMatches: jsonResponse(sampleMatches) });

    render(<AdminDashboard />);

    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith('/api/matches?tournamentId=tournament-1', {
        headers: { 'x-admin-password': 'change-me' },
      }),
    );
    await waitFor(() =>
      expect(document.querySelector('.history-list')).toHaveTextContent('singles'),
    );
    expect(document.querySelector('.history-list')).toHaveTextContent('Match ready');
    expect(localStorage.getItem('courtside:adminPassword')).toBe('change-me');
  });

  it('shows a scored match as in progress even when a stale server status is still created', async () => {
    const scoredMatch: MatchSummary = {
      ...sampleMatches[0]!,
      derived: {
        ...sampleMatches[0]!.derived,
        sets: [{ setNumber: 1, scoreA: 4, scoreB: 3, winner: null }],
      },
    };
    mockFetchRoutes({ getMatches: jsonResponse([scoredMatch]) });

    render(<AdminDashboard />);

    expect(await screen.findByText('Match in progress')).toBeInTheDocument();
    expect(screen.queryByText('Match ready')).not.toBeInTheDocument();
  });

  it('hydrates a legacy match summary into a populated history table', async () => {
    const fullState = sampleCreatedMatch({
      assignedCourtId: 'c1',
      courtLabel: 'Court 1',
      players: [
        { playerId: 'a1', side: 'A', name: 'Alice', shortName: 'ALI' },
        { playerId: 'b1', side: 'B', name: 'Bilal', shortName: 'BIL' },
      ],
      startedAt: '2026-08-29T10:00:00.000Z',
      completedAt: '2026-08-29T10:02:30.000Z',
      status: 'COMPLETED',
      createdAt: '2026-08-29T09:58:00.000Z',
    });
    fullState.derived = {
      sets: [{ setNumber: 1, scoreA: 21, scoreB: 17, winner: 'A' }],
      currentSet: { setNumber: 2, scoreA: 0, scoreB: 0, winner: null },
      setsWon: { A: 2, B: 0 },
      matchWinner: 'A',
      serve: { servingSide: null, serverPlayerId: null, courtPositions: {} },
      onInterval: false,
    };
    mockFetchRoutes({
      getMatches: jsonResponse([
        {
          matchId: 'm1',
          matchType: 'singles',
          status: 'COMPLETED',
          assignedCourtId: 'c1',
          createdAt: '2026-08-29T10:00:00.000Z',
        },
      ]),
      getMatch: jsonResponse(fullState),
    });

    render(<AdminDashboard />);

    expect(await screen.findByText('Alice', { selector: 'strong' })).toBeInTheDocument();
    expect(screen.getByText('Bilal', { selector: 'strong' })).toBeInTheDocument();
    expect(screen.getByText('Finalized')).toBeInTheDocument();
    expect(document.querySelector('.history-list')).toHaveTextContent('2 min 30 sec');
    expect(screen.getByText('21')).toHaveClass('set-score-winner');
  });

  it('shows court, players, set scores, and winner emphasis in match history', async () => {
    const completedMatch: MatchSummary = {
      ...sampleMatches[0]!,
      status: 'COMPLETED',
      derived: {
        sets: [
          { setNumber: 1, scoreA: 21, scoreB: 15, winner: 'A' },
          { setNumber: 2, scoreA: 21, scoreB: 18, winner: 'A' },
        ],
        setsWon: { A: 2, B: 0 },
        matchWinner: 'A',
      },
    };
    mockFetchRoutes({ getMatches: jsonResponse([completedMatch]) });

    render(<AdminDashboard />);

    await waitFor(() =>
      expect(document.querySelector('.history-list')).toHaveTextContent('Finalized'),
    );
    expect(document.querySelector('.history-list')).toHaveTextContent('Court 1');
    expect(document.querySelector('.history-scoreboard')).toBeInTheDocument();
    expect(screen.getByText('Alice', { selector: 'strong' }).closest('.tv-player-row')).toHaveClass(
      'match-winner',
    );
    expect(screen.getAllByText('21')).toHaveLength(2);
    expect(screen.getAllByText('21')[0]).toHaveClass('set-score-winner');
    expect(screen.getAllByText('21')[1]).toHaveClass('set-score-winner');
  });

  it('looks up a court label from the fetched courts list when the match summary has none', async () => {
    const matchWithoutCourtLabel: MatchSummary = { ...sampleMatches[0]!, courtLabel: null };
    mockFetchRoutes({
      getMatches: jsonResponse([matchWithoutCourtLabel]),
      getCourts: jsonResponse(sampleCourts),
    });

    render(<AdminDashboard />);

    await waitFor(() =>
      expect(document.querySelector('.history-list')).toHaveTextContent('Court 1'),
    );
  });

  it('falls back to a generic "Court" label when the assigned court is unknown', async () => {
    const matchWithUnknownCourt: MatchSummary = {
      ...sampleMatches[0]!,
      courtLabel: null,
      assignedCourtId: 'no-such-court',
    };
    mockFetchRoutes({
      getMatches: jsonResponse([matchWithUnknownCourt]),
      getCourts: jsonResponse(sampleCourts),
    });

    render(<AdminDashboard />);

    await waitFor(() => expect(document.querySelector('.history-list')).toHaveTextContent('Court'));
    expect(document.querySelector('.history-list')).not.toHaveTextContent('Court 1');
  });

  it('falls back to a normalized summary when the match detail fetch fails', async () => {
    mockFetchRoutes({
      getMatches: jsonResponse([
        {
          matchId: 'm1',
          matchType: 'singles',
          status: 'CREATED',
          createdAt: '2026-08-29T10:00:00.000Z',
        },
      ]),
      getMatch: jsonResponse({ error: 'nope' }, false),
    });

    render(<AdminDashboard />);

    await waitFor(() =>
      expect(document.querySelector('.history-list')).toHaveTextContent('singles'),
    );
    expect(document.querySelector('.history-list')).toHaveTextContent('Match ready');
  });

  it('falls back to no court label when the hydrated match state omits one', async () => {
    const fullState = sampleCreatedMatch({
      assignedCourtId: 'c1',
      players: [{ playerId: 'a1', side: 'A', name: 'Solo', shortName: 'SOL' }],
    });
    fullState.derived = { sets: [], setsWon: { A: 0, B: 0 }, matchWinner: null };
    mockFetchRoutes({
      getMatches: jsonResponse([
        {
          matchId: 'm1',
          matchType: 'singles',
          status: 'CREATED',
          createdAt: '2026-08-29T10:00:00.000Z',
        },
      ]),
      getMatch: jsonResponse(fullState),
    });

    render(<AdminDashboard />);

    await waitFor(() =>
      expect(document.querySelector('.history-list')).toHaveTextContent('Court 1'),
    );
  });

  it('computes an in-progress match duration against the current time when not yet completed', async () => {
    const inProgressMatch: MatchSummary = {
      ...sampleMatches[0]!,
      startedAt: '2026-08-29T09:59:00.000Z',
      completedAt: null,
    };
    mockFetchRoutes({ getMatches: jsonResponse([inProgressMatch]) });

    render(<AdminDashboard />);

    await waitFor(() =>
      expect(document.querySelector('.history-list')).toHaveTextContent(/\d+ min \d+ sec/),
    );
  });

  it('falls back to a "Side X" label when a match has no named players on that side', async () => {
    const matchWithoutPlayers: MatchSummary = { ...sampleMatches[0]!, players: [] };
    mockFetchRoutes({ getMatches: jsonResponse([matchWithoutPlayers]) });

    render(<AdminDashboard />);

    expect(await screen.findByText('Side A')).toBeInTheDocument();
    expect(screen.getByText('Side B')).toBeInTheDocument();
  });

  it('polls for match updates every 5 seconds', async () => {
    jest.useFakeTimers({ advanceTimers: true });
    mockFetchRoutes({ getMatches: jsonResponse(sampleMatches) });

    render(<AdminDashboard />);
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/matches?tournamentId=tournament-1',
        expect.objectContaining({ headers: { 'x-admin-password': 'change-me' } }),
      ),
    );
    const callsBeforePoll = (global.fetch as jest.Mock).mock.calls.length;

    jest.advanceTimersByTime(5_000);
    await waitFor(() =>
      expect((global.fetch as jest.Mock).mock.calls.length).toBeGreaterThan(callsBeforePoll),
    );

    jest.useRealTimers();
  });

  it('leaves the match list empty when the list request fails', async () => {
    mockFetchRoutes({ getMatches: jsonResponse({ error: 'nope' }, false) });

    render(<AdminDashboard />);

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(screen.queryByText(/m1/)).not.toBeInTheDocument();
  });

  describe('courts', () => {
    it('shows a placeholder message when there are no courts yet', async () => {
      mockFetchRoutes({ getCourts: jsonResponse([]) });
      render(<AdminDashboard />);

      expect(await screen.findByText(/No courts yet/)).toBeInTheDocument();
    });

    it('shows a court as Live when it has a current match assigned', async () => {
      mockFetchRoutes({
        getCourts: jsonResponse([{ ...sampleCourts[0]!, currentMatchId: 'm1' }]),
      });

      render(<AdminDashboard />);

      expect(await screen.findByText('Live')).toBeInTheDocument();
    });

    it('lists courts with a tap-to-select TV link', async () => {
      mockFetchRoutes({ getCourts: jsonResponse(sampleCourts) });

      render(<AdminDashboard />);

      expect(await screen.findByText('Court 1', { selector: 'span' })).toBeInTheDocument();
      expect(screen.getByText('TVC001')).toBeInTheDocument();
      const tvLinkInput = screen.getByLabelText('TV link');
      expect(tvLinkInput).toHaveValue('http://localhost/tv/court/c1');

      // Tapping the (readOnly) link field selects its contents, so a phone's
      // long-press-to-copy works even where the Clipboard API can't (see
      // copyToClipboard's doc comment).
      await userEvent.click(tvLinkInput);
    });

    it('copies the TV link when Copy is clicked', async () => {
      mockFetchRoutes({ getCourts: jsonResponse(sampleCourts) });

      render(<AdminDashboard />);
      await screen.findByText('Court 1', { selector: 'span' });

      await userEvent.click(screen.getByRole('button', { name: 'Copy TV link for Court 1' }));

      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('http://localhost/tv/court/c1');
      expect(await screen.findByText('Link copied.')).toBeInTheDocument();
    });

    it('removes a court when Remove is clicked and refreshes the list', async () => {
      mockFetchRoutes({ getCourts: jsonResponse(sampleCourts) });

      render(<AdminDashboard />);
      await screen.findByText('Court 1', { selector: 'span' });
      mockFetchRoutes({ getCourts: jsonResponse([]) });

      await userEvent.click(courtRemoveButton());

      await waitFor(() =>
        expect(global.fetch).toHaveBeenCalledWith(
          '/api/courts/c1',
          expect.objectContaining({
            method: 'DELETE',
            headers: { 'x-admin-password': 'change-me' },
          }),
        ),
      );
      expect(await screen.findByText('Court removed.')).toBeInTheDocument();
      expect(await screen.findByText(/No courts yet/)).toBeInTheDocument();
    });

    it('shows the server error message when court removal fails', async () => {
      mockFetchRoutes({
        getCourts: jsonResponse(sampleCourts),
        deleteCourt: jsonResponse({ error: 'Court is in use.' }, false),
      });

      render(<AdminDashboard />);
      await screen.findByText('Court 1', { selector: 'span' });

      await userEvent.click(courtRemoveButton());

      expect(await screen.findByText('Court is in use.')).toBeInTheDocument();
    });

    it('falls back to a generic message when a failed court removal has no error field', async () => {
      mockFetchRoutes({
        getCourts: jsonResponse(sampleCourts),
        deleteCourt: jsonResponse({}, false),
      });

      render(<AdminDashboard />);
      await screen.findByText('Court 1', { selector: 'span' });

      await userEvent.click(courtRemoveButton());

      expect(await screen.findByText('Failed to remove court.')).toBeInTheDocument();
    });

    it("tells the admin to copy manually when the clipboard isn't available", async () => {
      mockFetchRoutes({ getCourts: jsonResponse(sampleCourts) });
      Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
      // jsdom doesn't implement document.execCommand at all, so it's stubbed
      // directly rather than via jest.spyOn (which requires the property to
      // already exist).
      document.execCommand = jest.fn(() => false) as unknown as typeof document.execCommand;

      render(<AdminDashboard />);
      await screen.findByText('Court 1', { selector: 'span' });

      await userEvent.click(screen.getByRole('button', { name: 'Copy TV link for Court 1' }));

      expect(
        await screen.findByText("Couldn't copy — select the link above and copy manually."),
      ).toBeInTheDocument();

      // @ts-expect-error -- undoing the stub above; jsdom never had this method.
      delete document.execCommand;
    });

    it('creates a court with the entered label and refreshes the list', async () => {
      render(<AdminDashboard />);
      await userEvent.type(screen.getByPlaceholderText('Court label (e.g. Court 1)'), 'Court 2');
      mockFetchRoutes({
        postCourts: jsonResponse({ courtId: 'c2', label: 'Court 2', currentMatchId: null }),
      });

      await userEvent.click(screen.getByRole('button', { name: 'Add court' }));

      await waitFor(() =>
        expect(global.fetch).toHaveBeenCalledWith(
          '/api/courts',
          expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({ label: 'Court 2', tournamentId: 'tournament-1' }),
          }),
        ),
      );
      expect(screen.getByPlaceholderText('Court label (e.g. Court 1)')).toHaveValue('');
    });

    it('shows the server error message when court creation fails', async () => {
      render(<AdminDashboard />);
      await userEvent.type(screen.getByPlaceholderText('Court label (e.g. Court 1)'), 'Court 2');
      mockFetchRoutes({ postCourts: jsonResponse({ error: 'A court label is required.' }, false) });

      await userEvent.click(screen.getByRole('button', { name: 'Add court' }));

      expect(await screen.findByText('A court label is required.')).toBeInTheDocument();
    });

    it('falls back to a generic message when a failed court creation has no error field', async () => {
      render(<AdminDashboard />);
      await userEvent.type(screen.getByPlaceholderText('Court label (e.g. Court 1)'), 'Court 2');
      mockFetchRoutes({ postCourts: jsonResponse({}, false) });

      await userEvent.click(screen.getByRole('button', { name: 'Add court' }));

      expect(await screen.findByText('Failed to create court.')).toBeInTheDocument();
    });
  });

  describe('umpires', () => {
    function umpireList(): HTMLElement {
      return document.querySelectorAll('.court-list')[1] as HTMLElement;
    }

    it('shows a placeholder message when there are no umpires yet', async () => {
      mockFetchRoutes({ getUmpires: jsonResponse([]) });
      render(<AdminDashboard />);

      expect(await screen.findByText(/No umpires yet/)).toBeInTheDocument();
    });

    it('lists an umpire as Available by default', async () => {
      mockFetchRoutes({ getUmpires: jsonResponse(sampleUmpires) });

      render(<AdminDashboard />);

      expect(await screen.findByText('Uma Umpire', { selector: 'span' })).toBeInTheDocument();
      expect(within(umpireList()).getByText('Available')).toBeInTheDocument();
    });

    it('shows an umpire as Busy when assigned to a live match', async () => {
      mockFetchRoutes({
        getUmpires: jsonResponse(sampleUmpires),
        getMatches: jsonResponse([{ ...sampleMatches[0]!, assignedUmpireId: 'u1' }]),
      });

      render(<AdminDashboard />);

      await screen.findByText('Uma Umpire', { selector: 'span' });
      expect(within(umpireList()).getByText('Busy')).toBeInTheDocument();
    });

    it('creates an umpire with the entered name and refreshes the list', async () => {
      render(<AdminDashboard />);
      await userEvent.type(screen.getByPlaceholderText('Name Lastname'), 'Uma Umpire');
      mockFetchRoutes({ postUmpires: jsonResponse(sampleUmpires[0]) });

      await userEvent.click(screen.getByRole('button', { name: 'Add umpire' }));

      await waitFor(() =>
        expect(global.fetch).toHaveBeenCalledWith(
          '/api/umpires',
          expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({ name: 'Uma Umpire', tournamentId: 'tournament-1' }),
          }),
        ),
      );
      expect(screen.getByPlaceholderText('Name Lastname')).toHaveValue('');
    });

    it('shows the server error message when umpire creation fails', async () => {
      render(<AdminDashboard />);
      await userEvent.type(screen.getByPlaceholderText('Name Lastname'), 'Uma Umpire');
      mockFetchRoutes({
        postUmpires: jsonResponse({ error: 'An umpire name is required.' }, false),
      });

      await userEvent.click(screen.getByRole('button', { name: 'Add umpire' }));

      expect(await screen.findByText('An umpire name is required.')).toBeInTheDocument();
    });

    it('falls back to a generic message when a failed umpire creation has no error field', async () => {
      render(<AdminDashboard />);
      await userEvent.type(screen.getByPlaceholderText('Name Lastname'), 'Uma Umpire');
      mockFetchRoutes({ postUmpires: jsonResponse({}, false) });

      await userEvent.click(screen.getByRole('button', { name: 'Add umpire' }));

      expect(await screen.findByText('Failed to add umpire.')).toBeInTheDocument();
    });

    it('removes an umpire when Remove is clicked and refreshes the list', async () => {
      mockFetchRoutes({ getUmpires: jsonResponse(sampleUmpires) });

      render(<AdminDashboard />);
      await screen.findByText('Uma Umpire', { selector: 'span' });
      mockFetchRoutes({ getUmpires: jsonResponse([]) });

      await userEvent.click(within(umpireList()).getByRole('button', { name: 'Remove' }));

      await waitFor(() =>
        expect(global.fetch).toHaveBeenCalledWith(
          '/api/umpires/u1',
          expect.objectContaining({
            method: 'DELETE',
            headers: { 'x-admin-password': 'change-me' },
          }),
        ),
      );
      expect(await screen.findByText('Umpire removed.')).toBeInTheDocument();
      expect(await screen.findByText(/No umpires yet/)).toBeInTheDocument();
    });

    it('shows the server error message when umpire removal fails', async () => {
      mockFetchRoutes({
        getUmpires: jsonResponse(sampleUmpires),
        deleteUmpire: jsonResponse({ error: 'Umpire is busy.' }, false),
      });

      render(<AdminDashboard />);
      await screen.findByText('Uma Umpire', { selector: 'span' });

      await userEvent.click(within(umpireList()).getByRole('button', { name: 'Remove' }));

      expect(await screen.findByText('Umpire is busy.')).toBeInTheDocument();
    });

    it('falls back to a generic message when a failed umpire removal has no error field', async () => {
      mockFetchRoutes({
        getUmpires: jsonResponse(sampleUmpires),
        deleteUmpire: jsonResponse({}, false),
      });

      render(<AdminDashboard />);
      await screen.findByText('Uma Umpire', { selector: 'span' });

      await userEvent.click(within(umpireList()).getByRole('button', { name: 'Remove' }));

      expect(await screen.findByText('Failed to remove umpire.')).toBeInTheDocument();
    });
  });

  describe('creating a match', () => {
    it('creates a singles match with the entered names and standard preset by default', async () => {
      render(<AdminDashboard />);
      await selectCourt();
      await userEvent.type(screen.getByPlaceholderText('Side A player 1'), 'Alice');
      await userEvent.type(screen.getByPlaceholderText('Side B player 1'), 'Bilal');

      await userEvent.click(screen.getByRole('button', { name: 'Create match' }));

      await waitFor(() =>
        expect(global.fetch).toHaveBeenCalledWith(
          '/api/matches',
          expect.objectContaining({
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-admin-password': 'change-me' },
            body: JSON.stringify({
              matchType: 'singles',
              players: [
                { side: 'A', name: 'Alice' },
                { side: 'B', name: 'Bilal' },
              ],
              scoringConfig: { pointsToWin: 21, capScore: 30, intervalAt: 11 },
              courtId: 'c1',
              umpireId: 'u1',
              tournamentId: 'tournament-1',
              teams: {
                A: { name: '', country: '' },
                B: { name: '', country: '' },
              },
            }),
          }),
        ),
      );
      expect(await screen.findByText('Match created.')).toBeInTheDocument();
      expect(screen.getByPlaceholderText('Side A player 1')).toHaveValue('');
    });

    it('shows the umpire link once, built from the created match id and token', async () => {
      render(<AdminDashboard />);
      await selectCourt();
      await userEvent.type(screen.getByPlaceholderText('Side A player 1'), 'Alice');
      await userEvent.type(screen.getByPlaceholderText('Side B player 1'), 'Bilal');
      mockFetchRoutes({
        postMatches: jsonResponse(
          sampleCreatedMatch({ matchId: 'm-42', umpireToken: 'secret-tok', umpireCode: 'M42CODE' }),
        ),
      });

      await userEvent.click(screen.getByRole('button', { name: 'Create match' }));

      const umpireLinkInput = await screen.findByLabelText('Umpire link');
      expect(umpireLinkInput).toHaveValue('http://localhost/umpire/m-42?token=secret-tok');
      expect(screen.getByText('M42CODE')).toBeInTheDocument();

      await userEvent.click(umpireLinkInput);
      await userEvent.click(
        umpireLinkInput.closest('.created-match-links')!.querySelector('button')!,
      );
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        'http://localhost/umpire/m-42?token=secret-tok',
      );
    });

    // qrcode.react emits two <path>s: a plain background plate, then the
    // encoded symbol. The plate is identical for every value, so a test that
    // reads the first path proves nothing — always read the foreground one.
    const symbolPath = (title: string) => {
      const svg = screen.getByTitle(title).closest('svg')!;
      return svg.querySelector('path[fill="#0a0e1a"]')!.getAttribute('d');
    };

    it('renders a scannable QR code for the umpire link beside the join code', async () => {
      render(<AdminDashboard />);
      await selectCourt();
      await userEvent.type(screen.getByPlaceholderText('Side A player 1'), 'Alice');
      await userEvent.type(screen.getByPlaceholderText('Side B player 1'), 'Bilal');
      mockFetchRoutes({
        postMatches: jsonResponse(
          sampleCreatedMatch({ matchId: 'm-42', umpireToken: 'secret-tok', umpireCode: 'M42CODE' }),
        ),
      });

      await userEvent.click(screen.getByRole('button', { name: 'Create match' }));

      const qr = await screen.findByTitle('QR code for the umpire link to match m-42');
      // It sits inside the same block as the code the umpire would otherwise
      // have to type, which is the whole point of it being there.
      const handoff = qr.closest('.umpire-handoff');
      expect(handoff).not.toBeNull();
      expect(handoff!.querySelector('.join-code')!).toHaveTextContent('M42CODE');
      // A real encoded symbol, not just the background plate.
      expect(symbolPath('QR code for the umpire link to match m-42')!.length).toBeGreaterThan(500);
    });

    it('encodes the umpire link itself, not some other value', async () => {
      render(<AdminDashboard />);
      await selectCourt();
      await userEvent.type(screen.getByPlaceholderText('Side A player 1'), 'Alice');
      await userEvent.type(screen.getByPlaceholderText('Side B player 1'), 'Bilal');
      mockFetchRoutes({
        postMatches: jsonResponse(
          sampleCreatedMatch({ matchId: 'm-42', umpireToken: 'secret-tok' }),
        ),
      });

      await userEvent.click(screen.getByRole('button', { name: 'Create match' }));
      await screen.findByTitle('QR code for the umpire link to match m-42');
      const renderedPath = symbolPath('QR code for the umpire link to match m-42');

      // Encode the link we expect independently and compare the symbols. If the
      // dashboard ever passed the code, the match id, or a stale link instead,
      // these would diverge.
      const { container } = render(
        <QRCodeSVG
          value="http://localhost/umpire/m-42?token=secret-tok"
          size={64}
          bgColor="#ffffff"
          fgColor="#0a0e1a"
          marginSize={1}
        />,
      );
      expect(renderedPath).toEqual(
        container.querySelector('path[fill="#0a0e1a"]')!.getAttribute('d'),
      );
    });

    it('flags a retired match in the history, on the side that retired', async () => {
      const retired = JSON.parse(JSON.stringify(sampleMatches)) as typeof sampleMatches;
      retired[0]!.status = 'COMPLETED';
      retired[0]!.derived.matchWinner = 'B';
      retired[0]!.derived.retiredSide = 'A';
      mockFetchRoutes({ getMatches: jsonResponse(retired) });
      render(<AdminDashboard />);
      await waitFor(() =>
        expect(document.querySelector('.history-list')).toHaveTextContent('Finalized — retired'),
      );
      const rows = document.querySelectorAll('.history-list .tv-player-row');
      expect(rows[0]!.querySelector('.retired-tag')).toBeInTheDocument();
      expect(rows[1]!.querySelector('.retired-tag')).toBeNull();
    });

    it('sends the team names and countries the admin typed', async () => {
      render(<AdminDashboard />);
      await selectCourt();
      await userEvent.type(screen.getByPlaceholderText('Side A player 1'), 'Alice');
      await userEvent.type(screen.getByPlaceholderText('Side B player 1'), 'Bilal');
      const teamInputs = screen.getAllByLabelText('Team');
      const countryInputs = screen.getAllByLabelText('Country');
      await userEvent.type(teamInputs[0]!, 'Riverside');
      await userEvent.type(countryInputs[0]!, 'COL');
      await userEvent.type(countryInputs[1]!, 'ESP');
      mockFetchRoutes({ postMatches: jsonResponse(sampleCreatedMatch()) });

      await userEvent.click(screen.getByRole('button', { name: 'Create match' }));

      const body = JSON.parse(
        (
          (global.fetch as jest.Mock).mock.calls.find((c) => c[0] === '/api/matches')?.[1] as {
            body: string;
          }
        ).body,
      );
      expect(body.teams).toEqual({
        A: { name: 'Riverside', country: 'COL' },
        B: { name: '', country: 'ESP' },
      });
    });

    it('disables a court that still has a live match on it', async () => {
      // sampleMatches[0] is CREATED on court c1, so c1 is occupied until it
      // is finalised — the same rule the server enforces on POST. The default
      // mock returns an empty list, so hand it the fixture that occupies c1.
      mockFetchRoutes({ getMatches: jsonResponse(sampleMatches) });
      render(<AdminDashboard />);
      // Wait for the match list to arrive, which is what marks c1 occupied.
      // The empty-state row is also an <li>, so wait for a real match row.
      await waitFor(() =>
        expect(
          document.querySelectorAll('.history-list li:not(.empty-state)').length,
        ).toBeGreaterThan(0),
      );
      const option = screen
        .getByLabelText('Court')
        .querySelector<HTMLOptionElement>('option[value="c1"]');
      expect(option).toBeDisabled();
      expect(option).toHaveTextContent('in use');
    });

    it('disables an umpire that is already umpiring another live match', async () => {
      mockFetchRoutes({
        getUmpires: jsonResponse(sampleUmpires),
        getMatches: jsonResponse([{ ...sampleMatches[0]!, assignedUmpireId: 'u1' }]),
      });
      render(<AdminDashboard />);
      await waitFor(() =>
        expect(
          document.querySelectorAll('.history-list li:not(.empty-state)').length,
        ).toBeGreaterThan(0),
      );
      const option = screen
        .getByLabelText('Umpire')
        .querySelector<HTMLOptionElement>('option[value="u1"]');
      expect(option).toBeDisabled();
      expect(option).toHaveTextContent('busy');
    });

    it('uses the court label returned directly on the created match, when present', async () => {
      render(<AdminDashboard />);
      await selectCourt();
      await userEvent.type(screen.getByPlaceholderText('Side A player 1'), 'Alice');
      await userEvent.type(screen.getByPlaceholderText('Side B player 1'), 'Bilal');
      mockFetchRoutes({
        postMatches: jsonResponse(sampleCreatedMatch({ courtLabel: 'Center Court' })),
      });

      await userEvent.click(screen.getByRole('button', { name: 'Create match' }));

      expect(await screen.findByText('Center Court')).toBeInTheDocument();
    });

    it('includes the selected court in the create payload', async () => {
      mockFetchRoutes({ getCourts: jsonResponse(sampleCourts) });

      render(<AdminDashboard />);
      await screen.findByText('Court 1', { selector: 'span' });
      await userEvent.selectOptions(screen.getByLabelText('Court'), 'c1');
      await userEvent.selectOptions(screen.getByLabelText('Umpire'), 'u1');
      await userEvent.type(screen.getByPlaceholderText('Side A player 1'), 'Alice');
      await userEvent.type(screen.getByPlaceholderText('Side B player 1'), 'Bilal');

      await userEvent.click(screen.getByRole('button', { name: 'Create match' }));

      const postCall = await waitFor(() => {
        const call = (global.fetch as jest.Mock).mock.calls.find(
          (c) => c[0] === '/api/matches' && c[1]?.method === 'POST',
        );
        if (!call) throw new Error('POST /api/matches not called yet');
        return call;
      });
      expect(JSON.parse(postCall[1].body).courtId).toBe('c1');
    });

    it('does not submit a match until a court is selected', async () => {
      render(<AdminDashboard />);
      await userEvent.type(screen.getByPlaceholderText('Side A player 1'), 'Alice');
      await userEvent.type(screen.getByPlaceholderText('Side B player 1'), 'Bilal');

      await userEvent.click(screen.getByRole('button', { name: 'Create match' }));

      expect(
        (global.fetch as jest.Mock).mock.calls.some(
          (call) => call[0] === '/api/matches' && call[1]?.method === 'POST',
        ),
      ).toBe(false);
    });

    it('shows extra name fields and sends 4 players for doubles', async () => {
      render(<AdminDashboard />);
      await selectCourt();
      await userEvent.selectOptions(screen.getByLabelText('Match type'), 'doubles');

      expect(screen.getByPlaceholderText('Side A player 2')).toBeInTheDocument();
      expect(screen.getByPlaceholderText('Side B player 2')).toBeInTheDocument();

      await userEvent.type(screen.getByPlaceholderText('Side A player 1'), 'A1');
      await userEvent.type(screen.getByPlaceholderText('Side A player 2'), 'A2');
      await userEvent.type(screen.getByPlaceholderText('Side B player 1'), 'B1');
      await userEvent.type(screen.getByPlaceholderText('Side B player 2'), 'B2');

      await userEvent.click(screen.getByRole('button', { name: 'Create match' }));

      const postCall = await waitFor(() => {
        const call = (global.fetch as jest.Mock).mock.calls.find(
          (c) => c[0] === '/api/matches' && c[1]?.method === 'POST',
        );
        if (!call) throw new Error('POST /api/matches not called yet');
        return call;
      });
      const body = JSON.parse(postCall[1].body);
      expect(body.players).toHaveLength(4);
    });

    it('uses the short preset scoring config when selected', async () => {
      render(<AdminDashboard />);
      await selectCourt();
      await userEvent.selectOptions(screen.getByLabelText('Scoring format'), 'short');
      await userEvent.type(screen.getByPlaceholderText('Side A player 1'), 'Alice');
      await userEvent.type(screen.getByPlaceholderText('Side B player 1'), 'Bilal');

      await userEvent.click(screen.getByRole('button', { name: 'Create match' }));

      const postCall = await waitFor(() => {
        const call = (global.fetch as jest.Mock).mock.calls.find(
          (c) => c[0] === '/api/matches' && c[1]?.method === 'POST',
        );
        if (!call) throw new Error('POST /api/matches not called yet');
        return call;
      });
      const body = JSON.parse(postCall[1].body);
      expect(body.scoringConfig).toEqual({ pointsToWin: 15, capScore: 21, intervalAt: 8 });
    });

    it('shows the server error message when creation fails', async () => {
      render(<AdminDashboard />);
      await selectCourt();
      await userEvent.type(screen.getByPlaceholderText('Side A player 1'), 'Alice');
      await userEvent.type(screen.getByPlaceholderText('Side B player 1'), 'Bilal');
      mockFetchRoutes({ postMatches: jsonResponse({ error: 'Scoring is locked.' }, false) });

      await userEvent.click(screen.getByRole('button', { name: 'Create match' }));

      expect(await screen.findByText('Scoring is locked.')).toBeInTheDocument();
    });

    it('falls back to a generic message when a failed creation has no error field', async () => {
      render(<AdminDashboard />);
      await selectCourt();
      await userEvent.type(screen.getByPlaceholderText('Side A player 1'), 'Alice');
      await userEvent.type(screen.getByPlaceholderText('Side B player 1'), 'Bilal');
      mockFetchRoutes({ postMatches: jsonResponse({}, false) });

      await userEvent.click(screen.getByRole('button', { name: 'Create match' }));

      expect(await screen.findByText('Failed to create match.')).toBeInTheDocument();
    });
  });
});
