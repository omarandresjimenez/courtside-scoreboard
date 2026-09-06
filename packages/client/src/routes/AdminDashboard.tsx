import { useEffect, useState } from 'react';
import {
  SCORING_PRESETS,
  parseCategoryList,
  parseTournamentPlayersCsv,
  type Court,
  type Match,
  type MatchStatePayload,
  type MatchSummary,
  formatSideNames,
  type MatchType,
  type Side,
  type ScoringPresetName,
  type TournamentPlayer,
  type Umpire,
} from '@courtside/shared';
import { QRCodeSVG } from 'qrcode.react';
import { copyToClipboard } from '../lib/clipboard.js';
import { PlayerAutocomplete, type PlayerSelection } from '../lib/PlayerAutocomplete.js';

/** The four player slots a match form ever has — singles uses only a1/b1. */
type PlayerSlot = 'a1' | 'a2' | 'b1' | 'b2';

const EMPTY_ROSTER_SELECTIONS: Record<PlayerSlot, PlayerSelection | null> = {
  a1: null,
  a2: null,
  b1: null,
  b2: null,
};

/** `File.text()` reads the same bytes but isn't implemented everywhere this
 * app's test environment runs — FileReader is the one CSV-reading path with
 * universal support (jsdom included). */
function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

interface CreatedMatchLinks {
  matchId: string;
  courtLabel: string | null;
  umpireLink: string;
  umpireCode: string;
  /** Court-side phone link — camera only, no score. */
  streamBroadcastLink: string;
  /** Internet-facing link — video plus the live score overlay. */
  streamViewLink: string;
}

type MatchSummaryResponse = Partial<MatchSummary> &
  Pick<MatchSummary, 'matchId' | 'matchType' | 'status' | 'createdAt'>;

function normalizeMatchSummary(match: MatchSummaryResponse): MatchSummary {
  return {
    ...match,
    assignedCourtId: match.assignedCourtId ?? null,
    courtLabel: match.courtLabel ?? null,
    players: match.players ?? [],
    derived: match.derived ?? {
      sets: [],
      setsWon: { A: 0, B: 0 },
      matchWinner: null,
    },
  };
}

function summaryFromMatchState(state: MatchStatePayload): MatchSummary {
  return {
    matchId: state.match.matchId,
    matchType: state.match.matchType,
    status: state.match.status,
    assignedCourtId: state.match.assignedCourtId,
    courtLabel: state.match.courtLabel ?? null,
    createdAt: state.match.createdAt,
    startedAt: state.match.startedAt,
    completedAt: state.match.completedAt,
    category: state.match.category ?? null,
    players: state.match.players,
    derived: {
      sets: state.derived.sets.map(({ setNumber, scoreA, scoreB, winner }) => ({
        setNumber,
        scoreA,
        scoreB,
        winner,
      })),
      setsWon: state.derived.setsWon,
      matchWinner: state.derived.matchWinner,
    },
  };
}

function needsMatchDetail(match: MatchSummaryResponse): boolean {
  return !match.players || !match.derived || match.courtLabel === undefined;
}

function displayStatus(match: MatchSummary): string {
  if (match.derived.retiredSide) return 'Finalized — retired';
  if (match.derived.matchWinner || match.status === 'COMPLETED') return 'Finalized';
  if (
    match.status === 'IN_PROGRESS' ||
    match.derived.sets.some((set) => set.scoreA > 0 || set.scoreB > 0)
  ) {
    return 'Match in progress';
  }
  return 'Match ready';
}

function formatDuration(startedAt?: string | null, completedAt?: string | null): string | null {
  if (!startedAt) return null;
  const end = completedAt ? Date.parse(completedAt) : Date.now();
  const elapsedSeconds = Math.max(0, Math.floor((end - Date.parse(startedAt)) / 1000));
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  return `${minutes} min ${seconds} sec`;
}

function absoluteUrl(pathAndQuery: string): string {
  return `${window.location.origin}${pathAndQuery}`;
}

/**
 * Reads `{ error }` from a failed response, falling back to `fallback` when
 * the body isn't JSON at all — e.g. a stale server build (no matching route
 * yet) returning its default HTML 404 page, or a proxy/gateway error page.
 * Every "show the server's error message" call site went through a bare
 * `(await res.json()).error` before this, so any such response threw inside
 * an `async` handler with no `catch`, which silently swallowed it: the admin
 * saw no status message at all rather than a wrong one. Caught in the wild —
 * a not-yet-restarted server made the roster import look like it did
 * nothing, with no error to explain why.
 */
async function readErrorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? fallback;
  } catch {
    return fallback;
  }
}

function umpireLinkFor(match: Pick<Match, 'matchId' | 'umpireToken'>): string {
  return absoluteUrl(`/umpire/${match.matchId}?token=${match.umpireToken}`);
}

function tvLinkFor(court: Pick<Court, 'courtId'>): string {
  return absoluteUrl(`/tv/court/${court.courtId}`);
}

/**
 * Firebase Hosting site for the public scoreboard. Must match the project in
 * `.firebaserc` — deploying to a different project means changing this too.
 *
 * Not derived from window.location like the links above: every other link here
 * points back at this LAN server, but this one deliberately does not. It is the
 * only address that works from outside the venue.
 */
const PUBLIC_SCOREBOARD_ORIGIN = 'https://courtside-scoreboard-86e96.web.app';

/**
 * The internet-facing view of a court — safe to share publicly.
 *
 * Shows the live score and, when the court is broadcasting, the video too. It
 * needs no access to this machine at all: the score arrives via Firestore (see
 * syncScoreToCloud) and the video is negotiated through Firestore signalling
 * (see firestore-signal.ts), then flows peer-to-peer from the phone.
 */
function publicScoreLinkFor(court: Pick<Court, 'courtId'>): string {
  return `${PUBLIC_SCOREBOARD_ORIGIN}/?court=${encodeURIComponent(court.courtId)}`;
}

function streamBroadcastLinkFor(match: Pick<Match, 'assignedCourtId'>): string {
  if (!match.assignedCourtId) return '#';
  const path = `/stream/court/${match.assignedCourtId}`;
  // Camera capture needs a secure context. If this dashboard itself was
  // opened over plain http:// (the Electron/production server, which has
  // no TLS on its main port), point at the server's dedicated self-signed
  // HTTPS listener instead — see config.ts's httpsPort and index.ts.
  if (window.location.protocol === 'https:') return absoluteUrl(path);
  const httpsPort = window.location.port ? Number(window.location.port) + 1 : 443;
  return `https://${window.location.hostname}:${httpsPort}${path}`;
}

function streamViewLinkFor(match: Pick<Match, 'assignedCourtId'>): string {
  if (!match.assignedCourtId) return '#';
  return absoluteUrl(`/stream/live/court/${match.assignedCourtId}`);
}

/**
 * Set 09's admin dashboard: create courts, create matches (optionally onto
 * a court), and get back the two links that matter — the umpire link
 * (shown once, right after creation, since the server never re-serves the
 * umpireToken afterwards) and each court's TV link. Live per-court tiles
 * and match editing are the next wiring pass — see the design doc's "Set 09".
 */
export function AdminDashboard() {
  const tournamentId =
    new URLSearchParams(window.location.search).get('tournamentId') ??
    localStorage.getItem('courtside:tournamentId') ??
    '';
  const tournamentName = new URLSearchParams(window.location.search).get('tournamentName') ?? '';
  const tournamentDate = new URLSearchParams(window.location.search).get('tournamentDate');
  const [adminPassword] = useState(() => {
    // The desktop app opens this URL with the password already in hand, and
    // a plain `npm run dev` server defaults to the same generic value (see
    // config.ts) — this is a LAN-only, single-admin tool, so there's no
    // password prompt to show or control to hide here.
    const fromUrl = new URLSearchParams(window.location.search).get('adminPassword');
    return fromUrl || localStorage.getItem('courtside:adminPassword') || 'change-me';
  });
  const [matches, setMatches] = useState<MatchSummary[]>([]);
  const [courts, setCourts] = useState<Court[]>([]);
  const [umpires, setUmpires] = useState<Umpire[]>([]);
  const [tournamentPlayers, setTournamentPlayers] = useState<TournamentPlayer[]>([]);
  const [isImportingRoster, setIsImportingRoster] = useState(false);
  const [matchType, setMatchType] = useState<MatchType>('singles');
  const [preset, setPreset] = useState<ScoringPresetName>('standard');
  // First and family name are captured separately: scoreboards render
  // "J. Pérez", which cannot be derived reliably from one free-text field
  // (compound family names, and given names that are two words). Used only
  // when no roster has been imported for this tournament — see
  // `rosterSelections` below for the picked-from-import path.
  const [names, setNames] = useState({
    a1: { first: '', last: '' },
    a2: { first: '', last: '' },
    b1: { first: '', last: '' },
    b2: { first: '', last: '' },
  });
  // Per-slot roster pick, once a tournament has an imported player list —
  // see PlayerAutocomplete. A slot's player is looked up server-side by id
  // at creation time rather than trusting whatever name text is on screen.
  const [rosterSelections, setRosterSelections] =
    useState<Record<PlayerSlot, PlayerSelection | null>>(EMPTY_ROSTER_SELECTIONS);
  const [category, setCategory] = useState('');
  /** Guards a double submit and drives the button's busy state. */
  const [isCreating, setIsCreating] = useState(false);
  const [courtId, setCourtId] = useState('');
  const [umpireId, setUmpireId] = useState('');
  const [newUmpireName, setNewUmpireName] = useState('');
  const [teams, setTeams] = useState<Record<Side, { name: string; country: string }>>({
    A: { name: '', country: '' },
    B: { name: '', country: '' },
  });
  const [newCourtLabel, setNewCourtLabel] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [lastCreated, setLastCreated] = useState<CreatedMatchLinks | null>(null);

  useEffect(() => {
    localStorage.setItem('courtside:adminPassword', adminPassword);
  }, [adminPassword]);

  useEffect(() => {
    if (tournamentId) localStorage.setItem('courtside:tournamentId', tournamentId);
  }, [tournamentId]);

  useEffect(() => {
    // Scrub the password back out of the address bar/history once it's
    // been picked up above — it's done its job as a one-time handoff.
    const params = new URLSearchParams(window.location.search);
    if (!params.has('adminPassword')) return;
    params.delete('adminPassword');
    const search = params.toString();
    window.history.replaceState({}, '', window.location.pathname + (search ? `?${search}` : ''));
  }, []);

  async function handleCopy(text: string) {
    const copied = await copyToClipboard(text);
    setStatus(copied ? 'Link copied.' : "Couldn't copy — select the link above and copy manually.");
  }

  async function deleteCourt(courtIdToDelete: string) {
    const res = await fetch(`/api/courts/${courtIdToDelete}`, {
      method: 'DELETE',
      headers: { 'x-admin-password': adminPassword },
    });

    if (!res.ok) {
      setStatus(await readErrorMessage(res, 'Failed to remove court.'));
      return;
    }
    setStatus('Court removed.');
    void refreshCourts();
  }

  async function deleteUmpire(umpireIdToDelete: string) {
    const res = await fetch(`/api/umpires/${umpireIdToDelete}`, {
      method: 'DELETE',
      headers: { 'x-admin-password': adminPassword },
    });

    if (!res.ok) {
      setStatus(await readErrorMessage(res, 'Failed to remove umpire.'));
      return;
    }
    setStatus('Umpire removed.');
    void refreshUmpires();
  }

  async function refreshMatches() {
    if (!adminPassword || !tournamentId) return;
    const res = await fetch(`/api/matches?tournamentId=${encodeURIComponent(tournamentId)}`, {
      headers: { 'x-admin-password': adminPassword },
    });
    if (res.ok) {
      const response = (await res.json()) as MatchSummaryResponse[];
      const summaries = await Promise.all(
        response.map(async (match) => {
          if (!needsMatchDetail(match)) return normalizeMatchSummary(match);
          const detail = await fetch(`/api/matches/${match.matchId}`);
          return detail.ok
            ? summaryFromMatchState((await detail.json()) as MatchStatePayload)
            : normalizeMatchSummary(match);
        }),
      );
      setMatches(summaries);
    }
  }

  async function refreshCourts() {
    if (!adminPassword || !tournamentId) return;
    const res = await fetch(`/api/courts?tournamentId=${encodeURIComponent(tournamentId)}`, {
      headers: { 'x-admin-password': adminPassword },
    });
    if (res.ok) setCourts(await res.json());
  }

  async function refreshUmpires() {
    if (!adminPassword || !tournamentId) return;
    const res = await fetch(`/api/umpires?tournamentId=${encodeURIComponent(tournamentId)}`, {
      headers: { 'x-admin-password': adminPassword },
    });
    if (res.ok) setUmpires(await res.json());
  }

  async function refreshTournamentPlayers() {
    if (!adminPassword || !tournamentId) return;
    const res = await fetch(
      `/api/tournament-players?tournamentId=${encodeURIComponent(tournamentId)}`,
      { headers: { 'x-admin-password': adminPassword } },
    );
    if (res.ok) setTournamentPlayers(await res.json());
  }

  useEffect(() => {
    void refreshMatches();
    void refreshCourts();
    void refreshUmpires();
    void refreshTournamentPlayers();
    const refreshInterval = window.setInterval(() => void refreshMatches(), 5_000);
    return () => window.clearInterval(refreshInterval);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-fetch whenever the password changes
  }, [adminPassword]);

  async function importRosterCsv(file: File) {
    setStatus(null);
    setIsImportingRoster(true);
    try {
      const text = await readFileAsText(file);
      const { rows, skipped: unreadableRows } = parseTournamentPlayersCsv(text);
      if (rows.length === 0) {
        setStatus(
          'No usable rows found in that file — every row needs at least a first and last name.',
        );
        return;
      }

      const res = await fetch('/api/tournament-players/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-password': adminPassword },
        body: JSON.stringify({ tournamentId, players: rows }),
      });
      if (!res.ok) {
        setStatus(await readErrorMessage(res, 'Failed to import players.'));
        return;
      }

      const summary = (await res.json()) as { imported: number; updated: number; skipped: number };
      const totalSkipped = summary.skipped + unreadableRows;
      setStatus(
        `Imported ${summary.imported} player${summary.imported === 1 ? '' : 's'}, updated ${summary.updated}` +
          (totalSkipped ? `, skipped ${totalSkipped} row${totalSkipped === 1 ? '' : 's'}` : '') +
          '.',
      );
      void refreshTournamentPlayers();
    } catch {
      // A thrown exception here (the fetch itself rejecting — offline, or a
      // server that isn't listening at all — or FileReader failing) would
      // otherwise propagate out of this `void`-called async function as an
      // unhandled rejection: no status message, no visible failure at all.
      setStatus('Failed to import players — check the connection and try again.');
    } finally {
      setIsImportingRoster(false);
    }
  }

  async function createCourt(e: React.FormEvent) {
    e.preventDefault();
    setStatus(null);

    const res = await fetch('/api/courts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-password': adminPassword },
      body: JSON.stringify({ label: newCourtLabel, tournamentId }),
    });

    if (!res.ok) {
      setStatus(await readErrorMessage(res, 'Failed to create court.'));
      return;
    }
    setNewCourtLabel('');
    void refreshCourts();
  }

  async function createUmpire(e: React.FormEvent) {
    e.preventDefault();
    setStatus(null);

    const res = await fetch('/api/umpires', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-password': adminPassword },
      body: JSON.stringify({ name: newUmpireName, tournamentId }),
    });

    if (!res.ok) {
      setStatus(await readErrorMessage(res, 'Failed to add umpire.'));
      return;
    }
    setNewUmpireName('');
    void refreshUmpires();
  }

  // Courts already holding a match that has not been finalised. Derived from
  // the list the dashboard already polls, so it stays in step with the
  // server rule that rejects a second match on the same court.
  const occupiedCourtIds = new Set(
    matches
      .filter((m) => m.status === 'CREATED' || m.status === 'IN_PROGRESS')
      .map((m) => m.assignedCourtId)
      .filter((id): id is string => Boolean(id)),
  );

  // Same rule for umpires — one person can't officiate two live matches.
  const occupiedUmpireIds = new Set(
    matches
      .filter((m) => m.status === 'CREATED' || m.status === 'IN_PROGRESS')
      .map((m) => m.assignedUmpireId)
      .filter((id): id is string => Boolean(id)),
  );

  // Once a roster has been imported, players are picked by name instead of
  // typed — see PlayerAutocomplete — and category becomes a closed choice
  // instead of free text, since only these codes have any registered player.
  const hasRoster = tournamentPlayers.length > 0;
  const availableCategories = Array.from(
    new Set(tournamentPlayers.flatMap((p) => parseCategoryList(p.categories))),
  ).sort();
  // Narrows the player search to people actually registered for the chosen
  // category — picking from an unfiltered roster of a hundred players for a
  // "WS U15" match is exactly the busywork the search was meant to remove.
  // Unfiltered until a category is chosen, so the search still works while
  // filling the form top-to-bottom hasn't reached Category yet.
  const rosterForCategory = category
    ? tournamentPlayers.filter((p) => parseCategoryList(p.categories).includes(category))
    : tournamentPlayers;

  async function createMatch(e: React.FormEvent) {
    e.preventDefault();
    if (isCreating) return;
    setStatus(null);
    setLastCreated(null);
    setIsCreating(true);
    try {
      await submitMatch();
    } finally {
      // Always clears, so a failed create leaves the form usable rather than
      // stuck behind a permanently disabled button.
      setIsCreating(false);
    }
  }

  async function submitMatch() {
    const slots: PlayerSlot[] = matchType === 'singles' ? ['a1', 'b1'] : ['a1', 'a2', 'b1', 'b2'];
    const sideOf = (key: PlayerSlot): Side => (key.startsWith('a') ? 'A' : 'B');

    let players: Array<{
      side: Side;
      tournamentPlayerId?: string;
      name?: string;
      lastName?: string;
    }>;

    if (hasRoster) {
      const missingSlot = slots.find((key) => !rosterSelections[key]);
      if (missingSlot) {
        setStatus('Pick every player from the list before creating the match.');
        return;
      }
      players = slots.map((key) => ({
        side: sideOf(key),
        // Safe: the check above already rejected any slot left unpicked.
        tournamentPlayerId: rosterSelections[key]!.tournamentPlayerId,
      }));
    } else {
      players = slots.map((key) => ({
        side: sideOf(key),
        name: names[key].first.trim(),
        lastName: names[key].last.trim(),
      }));
    }

    const res = await fetch('/api/matches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-password': adminPassword },
      body: JSON.stringify({
        matchType,
        players,
        // The `preset` <select> below only ever offers 'standard' | 'short'
        // — 'custom' is reserved for the not-yet-built raw-values form (see
        // "Set 09 — Admin & tournament dashboard"), so this branch is
        // unreachable today. Falling back to 'standard' here is a safe
        // placeholder for when that form lands, not dead code to delete.
        scoringConfig: preset === 'custom' ? SCORING_PRESETS.standard : SCORING_PRESETS[preset],
        courtId,
        umpireId,
        tournamentId,
        teams,
        category: category.trim() || undefined,
      }),
    });

    if (!res.ok) {
      setStatus(await readErrorMessage(res, 'Failed to create match.'));
      return;
    }
    const created = (await res.json()) as { match: Match };
    setStatus('Match created.');
    setLastCreated({
      matchId: created.match.matchId,
      courtLabel:
        created.match.courtLabel ??
        courts.find((court) => court.courtId === courtId)?.label ??
        // Only reachable if the selected court was removed from `courts`
        // between selection and submit (another admin deleting it
        // concurrently) — a state race, not exercised by these
        // component-level tests, which can only pick courtId from an
        // option that's actually rendered.
        null,
      umpireLink: umpireLinkFor(created.match),
      umpireCode: created.match.umpireCode,
      streamBroadcastLink: streamBroadcastLinkFor(created.match),
      streamViewLink: streamViewLinkFor(created.match),
    });
    setNames({
      a1: { first: '', last: '' },
      a2: { first: '', last: '' },
      b1: { first: '', last: '' },
      b2: { first: '', last: '' },
    });
    setRosterSelections(EMPTY_ROSTER_SELECTIONS);
    setTeams({ A: { name: '', country: '' }, B: { name: '', country: '' } });
    // Category deliberately survives: a session usually enters a run of
    // matches in the same category, and retyping "BS U19" every time is a
    // needless step.
    void refreshMatches();
    void refreshCourts();
  }

  return (
    <main className="admin-dashboard">
      <h1>{tournamentName || 'Tournament'} — Admin</h1>
      {tournamentDate && (
        <p className="tournament-date">{new Date(tournamentDate).toLocaleDateString()}</p>
      )}

      {!tournamentId && (
        <p className="field-error">Select a tournament in the desktop launcher first.</p>
      )}

      {/* One shared status line for every admin action (add/remove a court
          or umpire, create a match, copy a link) — rendered here, at the
          top, so it's in the same predictable spot regardless of which
          card the triggering action lives in. */}
      {status && (
        <p role="status" className="admin-status">
          {status}
        </p>
      )}

      <section className="admin-card trust-camera-card">
        <h2>Trust this phone for camera streaming</h2>
        <p className="section-hint">
          The camera page needs a secure connection, so browsers show a one-time security warning
          the first time a phone opens it. Scan this once per phone that will ever film a match —
          after that, the warning won&rsquo;t come back, even across restarts or a different court.
        </p>
        <div className="trust-camera-body">
          <figure className="qr-code">
            <QRCodeSVG
              value={absoluteUrl('/api/local-ca.pem')}
              size={96}
              bgColor="#ffffff"
              fgColor="#0a0e1a"
              marginSize={1}
              title="QR code to install this server's camera-streaming certificate"
            />
            <figcaption>Scan on the filming phone</figcaption>
          </figure>
          <details>
            <summary>Show install steps</summary>
            <ol className="trust-camera-steps">
              <li>
                <strong>iPhone:</strong> tap the downloaded profile, then Settings → General → VPN
                &amp; Device Management → tap it again → Install. Then Settings → General → About →
                Certificate Trust Settings → turn on full trust for &ldquo;Courtside Scoreboard
                Local CA&rdquo;.
              </li>
              <li>
                <strong>Android:</strong> tap the downloaded file, choose &ldquo;CA
                certificate&rdquo; when asked what kind of certificate this is.
              </li>
            </ol>
          </details>
        </div>
      </section>

      {tournamentId && (
        <section className="admin-card roster-import-card">
          <h2>Import players</h2>
          <p className="section-hint">
            Upload this tournament&rsquo;s player list once (a CSV export from your tournament
            software) to pick players by name below instead of retyping them, and to restrict
            category to the ones players are actually registered for.
          </p>
          <div className="field-row">
            <label className="file-input-label">
              Player list CSV
              <input
                type="file"
                accept=".csv,text/csv"
                aria-label="Player list CSV file"
                disabled={isImportingRoster}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  // Cleared immediately so choosing the same filename again
                  // (a corrected re-export) still fires this handler — the
                  // browser otherwise treats an unchanged value as a no-op.
                  e.target.value = '';
                  if (file) void importRosterCsv(file);
                }}
              />
            </label>
          </div>
          {tournamentPlayers.length > 0 && (
            <p className="field-hint">
              {tournamentPlayers.length} player{tournamentPlayers.length === 1 ? '' : 's'} imported
              for this tournament.
            </p>
          )}
        </section>
      )}

      {tournamentId && (
        <div className="admin-grid">
          <div className="admin-column">
            <section className="admin-card">
              <h2>Courts</h2>
              <p className="section-hint">
                Courts hold the TV and public links, and a match is assigned to one.
              </p>
              <form onSubmit={createCourt}>
                <fieldset>
                  <label>
                    Court name
                    <input
                      aria-label="Court label"
                      placeholder="e.g. Court 1…"
                      value={newCourtLabel}
                      onChange={(e) => setNewCourtLabel(e.target.value)}
                      /* A venue's court names are not the browser's to guess,
                         and offering a saved-password prompt here is noise. */
                      autoComplete="off"
                      spellCheck={false}
                      required
                    />
                  </label>
                  <div className="form-actions">
                    <button type="submit">Add court</button>
                  </div>
                </fieldset>
              </form>

              {courts.length === 0 ? (
                <p>No courts yet — add one above, then its TV link appears here.</p>
              ) : (
                <ul className="court-list">
                  {courts.map((c) => (
                    <li key={c.courtId}>
                      <div className="court-row-info">
                        <span>{c.label}</span>
                        {/* Derived from the polled match list, not
                            Court.currentMatchId: that field only ever gets
                            set (at match creation) and never cleared, so a
                            court that has ever hosted a match would show
                            "busy" forever, even long after that match
                            finished. occupiedCourtIds — already the source
                            of truth for disabling this same court in the
                            "Create match" dropdown below — reflects whether
                            a CREATED/IN_PROGRESS match is on it right now. */}
                        <span className="status-tag">
                          {occupiedCourtIds.has(c.courtId) ? 'Busy' : 'Available'}
                        </span>
                        <span>
                          Code on <a href="/tv">/tv</a>:{' '}
                          <strong className="join-code">{c.tvCode}</strong>
                        </span>
                      </div>
                      <div className="court-row-actions">
                        <input
                          aria-label="TV link"
                          readOnly
                          value={tvLinkFor(c)}
                          onFocus={(e) => e.target.select()}
                        />
                        {/* Labelled rather than left as a bare "Copy": there are
                            two copy buttons per court now, and by voice alone
                            they were indistinguishable. */}
                        <button
                          type="button"
                          aria-label={`Copy TV link for ${c.label}`}
                          onClick={() => void handleCopy(tvLinkFor(c))}
                        >
                          Copy
                        </button>
                        <button
                          type="button"
                          className="danger-button"
                          onClick={() => void deleteCourt(c.courtId)}
                        >
                          Remove
                        </button>
                      </div>
                      {/* Kept visually distinct from the LAN links above: this
                          is the one address that leaves the venue, so mixing it
                          in unlabelled invites sharing a 192.168.x link with
                          someone at home (or this one with the TV). */}
                      <div className="court-row-actions public-link-row">
                        <span
                          className="public-link-label"
                          title="Anyone on the internet can open this"
                        >
                          🌐 Public score
                        </span>
                        <input
                          aria-label="Public internet scoreboard link"
                          readOnly
                          value={publicScoreLinkFor(c)}
                          onFocus={(e) => e.target.select()}
                        />
                        <button
                          type="button"
                          aria-label={`Copy public internet link for ${c.label}`}
                          onClick={() => void handleCopy(publicScoreLinkFor(c))}
                        >
                          Copy
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="admin-card">
              <h2>Umpires</h2>
              <p className="section-hint">
                An umpire can only be assigned to one live match at a time.
              </p>
              <form onSubmit={createUmpire}>
                <fieldset>
                  <label>
                    Umpire name
                    <input
                      aria-label="Umpire name"
                      placeholder="e.g. Ana Gómez…"
                      value={newUmpireName}
                      onChange={(e) => setNewUmpireName(e.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                      required
                    />
                  </label>
                  <div className="form-actions">
                    <button type="submit">Add umpire</button>
                  </div>
                </fieldset>
              </form>

              {umpires.length === 0 ? (
                <p>No umpires yet — add one above to assign them to matches.</p>
              ) : (
                <ul className="court-list">
                  {umpires.map((u) => {
                    const busy = occupiedUmpireIds.has(u.umpireId);
                    return (
                      <li key={u.umpireId}>
                        <div className="court-header">
                          <span>{u.name}</span>
                          <span className="status-tag">{busy ? 'Busy' : 'Available'}</span>
                        </div>
                        <div className="inline-actions">
                          <button
                            type="button"
                            className="danger-button"
                            onClick={() => void deleteUmpire(u.umpireId)}
                          >
                            Remove
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </div>

          <section className="admin-card">
            <h2>Create match</h2>
            <p className="section-hint">
              The umpire link is shown once after creating, so keep this tab open.
            </p>
            <form onSubmit={createMatch} className="admin-form">
              <fieldset>
                <legend>Format</legend>

                <div className="field-row">
                  <label>
                    Match type
                    <select
                      value={matchType}
                      onChange={(e) => setMatchType(e.target.value as MatchType)}
                    >
                      <option value="singles">Singles</option>
                      <option value="doubles">Doubles</option>
                    </select>
                  </label>

                  <label>
                    Scoring format
                    <select
                      value={preset}
                      onChange={(e) => setPreset(e.target.value as ScoringPresetName)}
                    >
                      <option value="standard">Standard (21 / 30 / 11)</option>
                      <option value="short">Short (15 / 21 / 8)</option>
                    </select>
                  </label>
                </div>

                <label>
                  Category
                  {availableCategories.length > 0 ? (
                    <select
                      value={category}
                      onChange={(e) => setCategory(e.target.value)}
                      required
                      aria-describedby="category-hint"
                    >
                      <option value="">Choose category</option>
                      {availableCategories.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      value={category}
                      onChange={(e) => setCategory(e.target.value)}
                      placeholder="e.g. MS U19…"
                      list="category-suggestions"
                      autoComplete="off"
                      spellCheck={false}
                      /* Described by, not labelled by: hint text inside the
                         <label> becomes part of the control's accessible name,
                         so a screen reader would announce the whole sentence
                         every time the field is focused. */
                      aria-describedby="category-hint"
                    />
                  )}
                </label>
                <p className="field-hint" id="category-hint">
                  {availableCategories.length > 0
                    ? 'From the imported player list — only categories a player is actually registered for.'
                    : 'Free text. Shown on the TV, umpire and viewer screens in place of ' +
                      '“singles”/“doubles”, which it already implies.'}
                </p>
                {/* Suggestions, not a closed list: category codes vary by
                    federation and age group, so anything fixed would be wrong
                    somewhere. Only offered once nothing has been imported —
                    once it has, the <select> above replaces this entirely. */}
                {availableCategories.length === 0 && (
                  <datalist id="category-suggestions">
                    {['MS U19', 'WS U19', 'MD U19', 'WD U19', 'XD U19', 'MS U15', 'WS U15'].map(
                      (c) => (
                        <option key={c} value={c} />
                      ),
                    )}
                  </datalist>
                )}
              </fieldset>

              <fieldset>
                <legend>Assignment</legend>

                <label>
                  Court
                  <select value={courtId} onChange={(e) => setCourtId(e.target.value)} required>
                    <option value="">Choose court</option>
                    {courts.map((c) => {
                      const busy = occupiedCourtIds.has(c.courtId);
                      return (
                        <option key={c.courtId} value={c.courtId} disabled={busy}>
                          {c.label}
                          {busy ? ' — in use' : ''}
                        </option>
                      );
                    })}
                  </select>
                </label>

                <label>
                  Umpire
                  <select value={umpireId} onChange={(e) => setUmpireId(e.target.value)} required>
                    <option value="">Choose umpire</option>
                    {umpires.map((u) => {
                      const busy = occupiedUmpireIds.has(u.umpireId);
                      return (
                        <option key={u.umpireId} value={u.umpireId} disabled={busy}>
                          {u.name}
                          {busy ? ' — busy' : ''}
                        </option>
                      );
                    })}
                  </select>
                </label>
              </fieldset>

              <fieldset>
                <legend>Sides</legend>
                <p className="field-hint">
                  Team and country are optional — club play usually has neither.
                </p>
                <div className="match-team-fields">
                  {(['A', 'B'] as const).map((side) => (
                    <fieldset key={side} className={`team-fieldset side-${side.toLowerCase()}`}>
                      <legend>Side {side} team</legend>
                      <label>
                        Team
                        <input
                          value={teams[side].name}
                          onChange={(e) =>
                            setTeams((current) => ({
                              ...current,
                              [side]: { ...current[side], name: e.target.value },
                            }))
                          }
                          placeholder="Optional…"
                          autoComplete="off"
                          spellCheck={false}
                        />
                      </label>
                      <label>
                        Country
                        <input
                          value={teams[side].country}
                          onChange={(e) =>
                            setTeams((current) => ({
                              ...current,
                              [side]: { ...current[side], country: e.target.value },
                            }))
                          }
                          placeholder="Optional…"
                          autoComplete="off"
                          spellCheck={false}
                        />
                      </label>
                    </fieldset>
                  ))}
                </div>
              </fieldset>

              <fieldset>
                <legend>Players</legend>
                <div className="match-player-fields">
                  {(
                    [
                      ['a1', 'Side A player 1'],
                      ['b1', 'Side B player 1'],
                      ['a2', 'Side A player 2'],
                      ['b2', 'Side B player 2'],
                    ] as const
                  )
                    .filter(([key]) => matchType === 'doubles' || !key.endsWith('2'))
                    .map(([key, legend]) =>
                      hasRoster ? (
                        // Once a roster has been imported, players are found
                        // by name instead of typed — see PlayerAutocomplete —
                        // so this slot can't fall out of sync with a roster
                        // row that no longer exists or was never selected.
                        <fieldset key={key} className="player-fieldset">
                          <legend>{legend}</legend>
                          <PlayerAutocomplete
                            label={legend}
                            roster={rosterForCategory}
                            value={rosterSelections[key]}
                            onChange={(selection) =>
                              setRosterSelections((current) => ({ ...current, [key]: selection }))
                            }
                            excludeIds={Object.entries(rosterSelections)
                              .filter(([slot]) => slot !== key)
                              .map(([, selection]) => selection?.tournamentPlayerId)
                              .filter((id): id is string => Boolean(id))}
                          />
                        </fieldset>
                      ) : (
                        <fieldset key={key} className="player-fieldset">
                          <legend>{legend}</legend>
                          {/* Wrapper, not the fieldset itself: a flex/grid
                              fieldset turns its legend into a layout item and
                              pulls it out of the border gap. */}
                          <div className="field-row">
                            <label>
                              First name
                              <input
                                aria-label={`${legend} first name`}
                                value={names[key].first}
                                onChange={(e) =>
                                  setNames((current) => ({
                                    ...current,
                                    [key]: { ...current[key], first: e.target.value },
                                  }))
                                }
                                /* Not the operator's own name, so browser
                                 autofill would offer the wrong person entirely. */
                                autoComplete="off"
                                spellCheck={false}
                                required
                              />
                            </label>
                            <label>
                              Last name
                              <input
                                aria-label={`${legend} last name`}
                                value={names[key].last}
                                onChange={(e) =>
                                  setNames((current) => ({
                                    ...current,
                                    [key]: { ...current[key], last: e.target.value },
                                  }))
                                }
                                autoComplete="off"
                                spellCheck={false}
                                required
                              />
                            </label>
                          </div>
                        </fieldset>
                      ),
                    )}
                </div>
              </fieldset>

              <div className="form-actions">
                <button type="submit" aria-busy={isCreating} disabled={isCreating}>
                  {isCreating ? 'Creating…' : 'Create match'}
                </button>
              </div>
            </form>

            {lastCreated && (
              <div className="created-match-links">
                <p>Umpire access — give this only to the umpire, it won&rsquo;t be shown again:</p>
                <p>
                  Assigned court: <strong>{lastCreated.courtLabel ?? 'Court unavailable'}</strong>
                </p>
                <div className="umpire-handoff">
                  <div className="umpire-handoff-details">
                    <p>
                      Code on <a href="/umpire">/umpire</a>:{' '}
                      <strong className="join-code">{lastCreated.umpireCode}</strong>
                    </p>
                    <label>
                      Umpire link
                      <input
                        readOnly
                        value={lastCreated.umpireLink}
                        onFocus={(e) => e.target.select()}
                      />
                    </label>
                  </div>
                  {/* Scanning this beats typing a 6-char code plus a token on a
                      phone, and it works offline — the SVG is generated in the
                      browser, not fetched from a chart API. Rendered on a white
                      plate with dark modules regardless of the dark theme,
                      because that is the contrast polarity scanners expect. */}
                  <figure className="qr-code">
                    <QRCodeSVG
                      value={lastCreated.umpireLink}
                      size={64}
                      bgColor="#ffffff"
                      fgColor="#0a0e1a"
                      marginSize={1}
                      title={`QR code for the umpire link to match ${lastCreated.matchId}`}
                    />
                    <figcaption>Umpire</figcaption>
                  </figure>
                </div>
                <button type="button" onClick={() => void handleCopy(lastCreated.umpireLink)}>
                  Copy umpire link
                </button>

                <p className="stream-links-heading">
                  Video streaming — two separate links, give each to the right person:
                </p>

                <div className="stream-handoff">
                  <div className="stream-handoff-details">
                    <p>Give this to whoever is filming at the court (camera only, no score):</p>
                    <label>
                      Broadcast link (court phone)
                      <input
                        readOnly
                        value={lastCreated.streamBroadcastLink}
                        onFocus={(e) => e.target.select()}
                      />
                    </label>
                  </div>
                  <figure className="qr-code">
                    <QRCodeSVG
                      value={lastCreated.streamBroadcastLink}
                      size={64}
                      bgColor="#ffffff"
                      fgColor="#0a0e1a"
                      marginSize={1}
                      title={`QR code for the broadcast link to match ${lastCreated.matchId}`}
                    />
                    <figcaption>Broadcast</figcaption>
                  </figure>
                </div>
                <button
                  type="button"
                  onClick={() => void handleCopy(lastCreated.streamBroadcastLink)}
                >
                  Copy broadcast link
                </button>

                <div className="stream-handoff">
                  <div className="stream-handoff-details">
                    <p>Give this to anyone who wants to watch (video plus live score):</p>
                    <label>
                      Viewer link (internet)
                      <input
                        readOnly
                        value={lastCreated.streamViewLink}
                        onFocus={(e) => e.target.select()}
                      />
                    </label>
                  </div>
                  <figure className="qr-code">
                    <QRCodeSVG
                      value={lastCreated.streamViewLink}
                      size={64}
                      bgColor="#ffffff"
                      fgColor="#0a0e1a"
                      marginSize={1}
                      title={`QR code for the viewer link to match ${lastCreated.matchId}`}
                    />
                    <figcaption>Viewer</figcaption>
                  </figure>
                </div>
                <button type="button" onClick={() => void handleCopy(lastCreated.streamViewLink)}>
                  Copy viewer link
                </button>
              </div>
            )}
          </section>
        </div>
      )}

      {tournamentId && (
        <>
          <h2>Match history</h2>
          <ul className="history-list">
            {matches.length === 0 ? (
              <li className="empty-state">No matches yet.</li>
            ) : (
              matches.map((m) =>
                (() => {
                  const courtName =
                    m.courtLabel ??
                    courts.find((court) => court.courtId === m.assignedCourtId)?.label ??
                    'Court';
                  const umpireName =
                    m.umpireName ?? umpires.find((u) => u.umpireId === m.assignedUmpireId)?.name;
                  const duration = formatDuration(m.startedAt, m.completedAt);
                  return (
                    <li key={m.matchId}>
                      <div className="history-topline">
                        <strong>{m.matchType}</strong>
                        {m.category && <span className="category-tag">{m.category}</span>}
                        <span className="status-tag">{displayStatus(m)}</span>
                      </div>
                      <small>
                        {courtName} · {new Date(m.createdAt).toLocaleString()}
                        {duration && ` · ${duration}`}
                        {umpireName && ` · Umpire: ${umpireName}`}
                      </small>
                      <div
                        className="tv-scoreboard history-scoreboard"
                        aria-label="Match score"
                        style={{ '--set-count': m.derived.sets.length } as React.CSSProperties}
                      >
                        <div className="tv-set-labels" aria-hidden="true">
                          <span />
                          {m.derived.sets.map((set) => (
                            <span key={set.setNumber} className={set.winner ? '' : 'current-set'}>
                              Set {set.setNumber}
                            </span>
                          ))}
                        </div>
                        {(['A', 'B'] as const).map((side) => {
                          const names = formatSideNames(m.players, side, `Side ${side}`);
                          return (
                            <div
                              className={`tv-player-row side-${side.toLowerCase()}${m.derived.matchWinner === side ? ' match-winner' : ''}`}
                              key={side}
                            >
                              <strong className="tv-player-name">
                                {names}
                                {m.derived.retiredSide === side && (
                                  <span className="retired-tag">Retired</span>
                                )}
                              </strong>
                              {m.derived.sets.map((set) => (
                                <strong
                                  key={set.setNumber}
                                  className={`${set.winner ? '' : 'current-set'}${set.winner === side ? ' set-score-winner' : ''}`}
                                >
                                  {side === 'A' ? set.scoreA : set.scoreB}
                                </strong>
                              ))}
                            </div>
                          );
                        })}
                      </div>
                    </li>
                  );
                })(),
              )
            )}
          </ul>
        </>
      )}
    </main>
  );
}
