import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Court, Match, MatchSummary } from '@courtside/shared';
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

function sampleCreatedMatch(overrides: Partial<Match> = {}): { match: Match; derived: unknown } {
  return {
    match: {
      matchId: 'm-new',
      matchType: 'singles',
      status: 'CREATED',
      scoringConfig: { pointsToWin: 21, capScore: 30, intervalAt: 11 },
      scoringLocked: false,
      players: [],
      umpireToken: 'tok-xyz',
      umpireCode: 'UMP001',
      assignedCourtId: null,
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
  getMatch?: Response;
  postMatches?: Response;
  postCourts?: Response;
  deleteCourt?: Response;
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
    if (url === '/api/matches' && method === 'POST') {
      return routes.postMatches ?? jsonResponse(sampleCreatedMatch());
    }
    if (url === '/api/courts' && method === 'POST') {
      return routes.postCourts ?? jsonResponse(sampleCourts[0]);
    }
    if (url.startsWith('/api/courts/') && method === 'DELETE') {
      return routes.deleteCourt ?? jsonResponse({});
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  });
}

async function selectCourt() {
  await screen.findByRole('option', { name: 'Court 1' });
  await userEvent.selectOptions(screen.getByLabelText('Court'), 'c1');
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
  it('does not fetch anything until an admin password is entered', () => {
    render(<AdminDashboard />);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('picks up an admin password handed off via the URL (the desktop app flow)', async () => {
    window.history.replaceState({}, '', '/admin?adminPassword=from-url-pw');

    render(<AdminDashboard />);

    // Picked up silently — no password field shown at all for this flow.
    expect(screen.queryByLabelText('Admin password')).not.toBeInTheDocument();
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
    await userEvent.type(screen.getByLabelText('Admin password'), 'secret');

    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith('/api/matches?tournamentId=tournament-1', {
        headers: { 'x-admin-password': 'secret' },
      }),
    );
    await waitFor(() =>
      expect(document.querySelector('.history-list')).toHaveTextContent('singles'),
    );
    expect(document.querySelector('.history-list')).toHaveTextContent('Match ready');
    expect(localStorage.getItem('courtside:adminPassword')).toBe('secret');
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
    await userEvent.type(screen.getByLabelText('Admin password'), 'secret');

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
    await userEvent.type(screen.getByLabelText('Admin password'), 'secret');

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
    await userEvent.type(screen.getByLabelText('Admin password'), 'secret');

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
    await userEvent.type(screen.getByLabelText('Admin password'), 'secret');

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
    await userEvent.type(screen.getByLabelText('Admin password'), 'secret');

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
    await userEvent.type(screen.getByLabelText('Admin password'), 'secret');

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
    await userEvent.type(screen.getByLabelText('Admin password'), 'secret');

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
    await userEvent.type(screen.getByLabelText('Admin password'), 'secret');

    await waitFor(() =>
      expect(document.querySelector('.history-list')).toHaveTextContent(/\d+ min \d+ sec/),
    );
  });

  it('falls back to a "Side X" label when a match has no named players on that side', async () => {
    const matchWithoutPlayers: MatchSummary = { ...sampleMatches[0]!, players: [] };
    mockFetchRoutes({ getMatches: jsonResponse([matchWithoutPlayers]) });

    render(<AdminDashboard />);
    await userEvent.type(screen.getByLabelText('Admin password'), 'secret');

    expect(await screen.findByText('Side A')).toBeInTheDocument();
    expect(screen.getByText('Side B')).toBeInTheDocument();
  });

  it('polls for match updates every 5 seconds', async () => {
    jest.useFakeTimers({ advanceTimers: true });
    mockFetchRoutes({ getMatches: jsonResponse(sampleMatches) });

    render(<AdminDashboard />);
    await userEvent.setup({ delay: null }).type(screen.getByLabelText('Admin password'), 'secret');
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/matches?tournamentId=tournament-1',
        expect.objectContaining({ headers: { 'x-admin-password': 'secret' } }),
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
    await userEvent.type(screen.getByLabelText('Admin password'), 'secret');

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(screen.queryByText(/m1/)).not.toBeInTheDocument();
  });

  describe('courts', () => {
    it('shows a placeholder message when there are no courts yet', async () => {
      mockFetchRoutes({ getCourts: jsonResponse([]) });
      render(<AdminDashboard />);
      await userEvent.type(screen.getByLabelText('Admin password'), 'secret');

      expect(await screen.findByText(/No courts yet/)).toBeInTheDocument();
    });

    it('shows a court as Live when it has a current match assigned', async () => {
      mockFetchRoutes({
        getCourts: jsonResponse([{ ...sampleCourts[0]!, currentMatchId: 'm1' }]),
      });

      render(<AdminDashboard />);
      await userEvent.type(screen.getByLabelText('Admin password'), 'secret');

      expect(await screen.findByText('Live')).toBeInTheDocument();
    });

    it('lists courts with a tap-to-select TV link', async () => {
      mockFetchRoutes({ getCourts: jsonResponse(sampleCourts) });

      render(<AdminDashboard />);
      await userEvent.type(screen.getByLabelText('Admin password'), 'secret');

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
      await userEvent.type(screen.getByLabelText('Admin password'), 'secret');
      await screen.findByText('Court 1', { selector: 'span' });

      await userEvent.click(screen.getByRole('button', { name: 'Copy' }));

      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('http://localhost/tv/court/c1');
      expect(await screen.findByText('Link copied.')).toBeInTheDocument();
    });

    it('removes a court when Remove is clicked and refreshes the list', async () => {
      mockFetchRoutes({ getCourts: jsonResponse(sampleCourts) });

      render(<AdminDashboard />);
      await userEvent.type(screen.getByLabelText('Admin password'), 'secret');
      await screen.findByText('Court 1', { selector: 'span' });
      mockFetchRoutes({ getCourts: jsonResponse([]) });

      await userEvent.click(screen.getByRole('button', { name: 'Remove' }));

      await waitFor(() =>
        expect(global.fetch).toHaveBeenCalledWith(
          '/api/courts/c1',
          expect.objectContaining({
            method: 'DELETE',
            headers: { 'x-admin-password': 'secret' },
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
      await userEvent.type(screen.getByLabelText('Admin password'), 'secret');
      await screen.findByText('Court 1', { selector: 'span' });

      await userEvent.click(screen.getByRole('button', { name: 'Remove' }));

      expect(await screen.findByText('Court is in use.')).toBeInTheDocument();
    });

    it('falls back to a generic message when a failed court removal has no error field', async () => {
      mockFetchRoutes({
        getCourts: jsonResponse(sampleCourts),
        deleteCourt: jsonResponse({}, false),
      });

      render(<AdminDashboard />);
      await userEvent.type(screen.getByLabelText('Admin password'), 'secret');
      await screen.findByText('Court 1', { selector: 'span' });

      await userEvent.click(screen.getByRole('button', { name: 'Remove' }));

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
      await userEvent.type(screen.getByLabelText('Admin password'), 'secret');
      await screen.findByText('Court 1', { selector: 'span' });

      await userEvent.click(screen.getByRole('button', { name: 'Copy' }));

      expect(
        await screen.findByText("Couldn't copy — select the link above and copy manually."),
      ).toBeInTheDocument();

      // @ts-expect-error -- undoing the stub above; jsdom never had this method.
      delete document.execCommand;
    });

    it('creates a court with the entered label and refreshes the list', async () => {
      render(<AdminDashboard />);
      await userEvent.type(screen.getByLabelText('Admin password'), 'secret');
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
      await userEvent.type(screen.getByLabelText('Admin password'), 'secret');
      await userEvent.type(screen.getByPlaceholderText('Court label (e.g. Court 1)'), 'Court 2');
      mockFetchRoutes({ postCourts: jsonResponse({ error: 'A court label is required.' }, false) });

      await userEvent.click(screen.getByRole('button', { name: 'Add court' }));

      expect(await screen.findByText('A court label is required.')).toBeInTheDocument();
    });

    it('falls back to a generic message when a failed court creation has no error field', async () => {
      render(<AdminDashboard />);
      await userEvent.type(screen.getByLabelText('Admin password'), 'secret');
      await userEvent.type(screen.getByPlaceholderText('Court label (e.g. Court 1)'), 'Court 2');
      mockFetchRoutes({ postCourts: jsonResponse({}, false) });

      await userEvent.click(screen.getByRole('button', { name: 'Add court' }));

      expect(await screen.findByText('Failed to create court.')).toBeInTheDocument();
    });
  });

  describe('creating a match', () => {
    it('creates a singles match with the entered names and standard preset by default', async () => {
      render(<AdminDashboard />);
      await userEvent.type(screen.getByLabelText('Admin password'), 'secret');
      await selectCourt();
      await userEvent.type(screen.getByPlaceholderText('Side A player 1'), 'Alice');
      await userEvent.type(screen.getByPlaceholderText('Side B player 1'), 'Bilal');

      await userEvent.click(screen.getByRole('button', { name: 'Create match' }));

      await waitFor(() =>
        expect(global.fetch).toHaveBeenCalledWith(
          '/api/matches',
          expect.objectContaining({
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-admin-password': 'secret' },
            body: JSON.stringify({
              matchType: 'singles',
              players: [
                { side: 'A', name: 'Alice' },
                { side: 'B', name: 'Bilal' },
              ],
              scoringConfig: { pointsToWin: 21, capScore: 30, intervalAt: 11 },
              courtId: 'c1',
              tournamentId: 'tournament-1',
            }),
          }),
        ),
      );
      expect(await screen.findByText('Match created.')).toBeInTheDocument();
      expect(screen.getByPlaceholderText('Side A player 1')).toHaveValue('');
    });

    it('shows the umpire link once, built from the created match id and token', async () => {
      render(<AdminDashboard />);
      await userEvent.type(screen.getByLabelText('Admin password'), 'secret');
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

    it('uses the court label returned directly on the created match, when present', async () => {
      render(<AdminDashboard />);
      await userEvent.type(screen.getByLabelText('Admin password'), 'secret');
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
      await userEvent.type(screen.getByLabelText('Admin password'), 'secret');
      await screen.findByText('Court 1', { selector: 'span' });
      await userEvent.selectOptions(screen.getByLabelText('Court'), 'c1');
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
      await userEvent.type(screen.getByLabelText('Admin password'), 'secret');
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
      await userEvent.type(screen.getByLabelText('Admin password'), 'secret');
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
      await userEvent.type(screen.getByLabelText('Admin password'), 'secret');
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
      await userEvent.type(screen.getByLabelText('Admin password'), 'secret');
      await selectCourt();
      await userEvent.type(screen.getByPlaceholderText('Side A player 1'), 'Alice');
      await userEvent.type(screen.getByPlaceholderText('Side B player 1'), 'Bilal');
      mockFetchRoutes({ postMatches: jsonResponse({ error: 'Scoring is locked.' }, false) });

      await userEvent.click(screen.getByRole('button', { name: 'Create match' }));

      expect(await screen.findByText('Scoring is locked.')).toBeInTheDocument();
    });

    it('falls back to a generic message when a failed creation has no error field', async () => {
      render(<AdminDashboard />);
      await userEvent.type(screen.getByLabelText('Admin password'), 'secret');
      await selectCourt();
      await userEvent.type(screen.getByPlaceholderText('Side A player 1'), 'Alice');
      await userEvent.type(screen.getByPlaceholderText('Side B player 1'), 'Bilal');
      mockFetchRoutes({ postMatches: jsonResponse({}, false) });

      await userEvent.click(screen.getByRole('button', { name: 'Create match' }));

      expect(await screen.findByText('Failed to create match.')).toBeInTheDocument();
    });
  });
});
