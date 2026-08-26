import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Court, Match, MatchSummary } from '@courtside/shared';
import { AdminDashboard } from './AdminDashboard.js';

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response;
}

const sampleMatches: MatchSummary[] = [
  { matchId: 'm1', matchType: 'singles', status: 'CREATED', assignedCourtId: null, createdAt: '' },
];

const sampleCourts: Court[] = [{ courtId: 'c1', label: 'Court 1', currentMatchId: null }];

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
  postMatches?: Response;
  postCourts?: Response;
}) {
  (global.fetch as jest.Mock).mockImplementation(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (url === '/api/matches' && method === 'GET') return routes.getMatches ?? jsonResponse([]);
    if (url === '/api/courts' && method === 'GET') return routes.getCourts ?? jsonResponse([]);
    if (url === '/api/matches' && method === 'POST') {
      return routes.postMatches ?? jsonResponse(sampleCreatedMatch());
    }
    if (url === '/api/courts' && method === 'POST') {
      return routes.postCourts ?? jsonResponse(sampleCourts[0]);
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  });
}

beforeEach(() => {
  localStorage.clear();
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

  it('remembers a previously entered admin password across renders, refreshing both lists', async () => {
    localStorage.setItem('courtside:adminPassword', 'stored-pw');

    render(<AdminDashboard />);

    expect(screen.getByLabelText('Admin password')).toHaveValue('stored-pw');
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith('/api/matches', expect.anything()),
    );
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith('/api/courts', expect.anything()),
    );
  });

  it('fetches and lists matches once a password is entered, persisting it to localStorage', async () => {
    mockFetchRoutes({ getMatches: jsonResponse(sampleMatches) });

    render(<AdminDashboard />);
    await userEvent.type(screen.getByLabelText('Admin password'), 'secret');

    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith('/api/matches', {
        headers: { 'x-admin-password': 'secret' },
      }),
    );
    expect(await screen.findByText(/m1 — singles — CREATED/)).toBeInTheDocument();
    expect(localStorage.getItem('courtside:adminPassword')).toBe('secret');
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
      render(<AdminDashboard />);
      await userEvent.type(screen.getByLabelText('Admin password'), 'secret');

      expect(await screen.findByText(/No courts yet/)).toBeInTheDocument();
    });

    it('lists courts with a tap-to-select TV link', async () => {
      mockFetchRoutes({ getCourts: jsonResponse(sampleCourts) });

      render(<AdminDashboard />);
      await userEvent.type(screen.getByLabelText('Admin password'), 'secret');

      expect(await screen.findByText('Court 1', { selector: 'span' })).toBeInTheDocument();
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
          expect.objectContaining({ method: 'POST', body: JSON.stringify({ label: 'Court 2' }) }),
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
      await userEvent.type(screen.getByPlaceholderText('Side A player 1'), 'Alice');
      await userEvent.type(screen.getByPlaceholderText('Side B player 1'), 'Bilal');
      mockFetchRoutes({
        postMatches: jsonResponse(
          sampleCreatedMatch({ matchId: 'm-42', umpireToken: 'secret-tok' }),
        ),
      });

      await userEvent.click(screen.getByRole('button', { name: 'Create match' }));

      const umpireLinkInput = await screen.findByLabelText('Umpire link');
      expect(umpireLinkInput).toHaveValue('http://localhost/umpire/m-42?token=secret-tok');
      expect(screen.getByText('m-42', { exact: false })).toBeInTheDocument();

      await userEvent.click(umpireLinkInput);
      await userEvent.click(screen.getByRole('button', { name: 'Copy' }));
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        'http://localhost/umpire/m-42?token=secret-tok',
      );
    });

    it('includes the selected court in the create payload', async () => {
      mockFetchRoutes({ getCourts: jsonResponse(sampleCourts) });

      render(<AdminDashboard />);
      await userEvent.type(screen.getByLabelText('Admin password'), 'secret');
      await screen.findByText('Court 1', { selector: 'span' });
      await userEvent.selectOptions(screen.getByLabelText(/Court \(optional/), 'c1');
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

    it('omits courtId from the payload when no court is selected', async () => {
      render(<AdminDashboard />);
      await userEvent.type(screen.getByLabelText('Admin password'), 'secret');
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
      expect(JSON.parse(postCall[1].body)).not.toHaveProperty('courtId');
    });

    it('shows extra name fields and sends 4 players for doubles', async () => {
      render(<AdminDashboard />);
      await userEvent.type(screen.getByLabelText('Admin password'), 'secret');
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
      await userEvent.type(screen.getByPlaceholderText('Side A player 1'), 'Alice');
      await userEvent.type(screen.getByPlaceholderText('Side B player 1'), 'Bilal');
      mockFetchRoutes({ postMatches: jsonResponse({ error: 'Scoring is locked.' }, false) });

      await userEvent.click(screen.getByRole('button', { name: 'Create match' }));

      expect(await screen.findByText('Scoring is locked.')).toBeInTheDocument();
    });

    it('falls back to a generic message when a failed creation has no error field', async () => {
      render(<AdminDashboard />);
      await userEvent.type(screen.getByLabelText('Admin password'), 'secret');
      await userEvent.type(screen.getByPlaceholderText('Side A player 1'), 'Alice');
      await userEvent.type(screen.getByPlaceholderText('Side B player 1'), 'Bilal');
      mockFetchRoutes({ postMatches: jsonResponse({}, false) });

      await userEvent.click(screen.getByRole('button', { name: 'Create match' }));

      expect(await screen.findByText('Failed to create match.')).toBeInTheDocument();
    });
  });
});
