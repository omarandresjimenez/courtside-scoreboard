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
import { useTranslation, type Translation } from '../i18n/useTranslation.js';
import { LOCALE_NAMES, SUPPORTED_LOCALES, type Locale } from '../i18n/locale.js';
import { useTheme, type Theme } from '../theme/useTheme.js';

/** The four player slots a match form ever has — singles uses only a1/b1. */
type PlayerSlot = 'a1' | 'a2' | 'b1' | 'b2';

const EMPTY_ROSTER_SELECTIONS: Record<PlayerSlot, PlayerSelection | null> = {
  a1: null,
  a2: null,
  b1: null,
  b2: null,
};

/** Which player slots belong to which side — used to lay the match form out
 * one column per side (player field(s), then that side's Team/Country). */
const SIDE_SLOTS: Record<Side, PlayerSlot[]> = { A: ['a1', 'a2'], B: ['b1', 'b2'] };

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

function displayStatus(match: MatchSummary, t: Translation['t']): string {
  if (match.derived.retiredSide) return t('status.finalizedRetired');
  if (match.derived.matchWinner || match.status === 'COMPLETED') return t('status.finalized');
  if (
    match.status === 'IN_PROGRESS' ||
    match.derived.sets.some((set) => set.scoreA > 0 || set.scoreB > 0)
  ) {
    return t('status.inProgress');
  }
  return t('status.ready');
}

function formatDuration(
  startedAt: string | null | undefined,
  completedAt: string | null | undefined,
  t: Translation['t'],
): string | null {
  if (!startedAt) return null;
  const end = completedAt ? Date.parse(completedAt) : Date.now();
  const elapsedSeconds = Math.max(0, Math.floor((end - Date.parse(startedAt)) / 1000));
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  return t('duration.format', { minutes, seconds });
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

/**
 * The camera-capture link for a court — one stable URL for its whole
 * lifetime, since it's keyed by courtId rather than any particular match.
 * Whoever is filming keeps this open across matches; a new match on the
 * same court doesn't need a new link.
 *
 * `mdnsHost` — `config.mdnsHostname` fetched from `GET /api/config`, or
 * null while that request is still in flight or mDNS is disabled — is
 * preferred over this browser's own address when available. The persistent,
 * CA-signed cert (integrations/local-tls.ts) lists both as valid, but only
 * the hostname survives the venue's DHCP handing out a different IP next
 * time; a link built from `window.location.hostname` would need re-trusting
 * the moment that happens even though the CA itself never changed.
 */
function streamBroadcastLinkFor(court: Pick<Court, 'courtId'>, mdnsHost: string | null): string {
  const path = `/stream/court/${court.courtId}`;
  // Camera capture needs a secure context. If this dashboard itself was
  // opened over plain http:// (the Electron/production server, which has
  // no TLS on its main port), point at the server's dedicated HTTPS
  // listener instead — see config.ts's httpsPort, index.ts, and
  // integrations/local-tls.ts for the persistent, CA-signed cert that
  // makes this a one-time browser warning instead of one per restart.
  if (window.location.protocol === 'https:') return absoluteUrl(path);
  const httpsPort = window.location.port ? Number(window.location.port) + 1 : 443;
  const host = mdnsHost ?? window.location.hostname;
  return `https://${host}:${httpsPort}${path}`;
}

/**
 * Set 09's admin dashboard: create courts, create matches (optionally onto
 * a court), and get back the two links that matter — the umpire link
 * (shown once, right after creation, since the server never re-serves the
 * umpireToken afterwards) and each court's TV link. Live per-court tiles
 * and match editing are the next wiring pass — see the design doc's "Set 09".
 */
export function AdminDashboard() {
  const { t, locale, setLocale } = useTranslation();
  const { theme, setTheme } = useTheme();
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
  const [historyPage, setHistoryPage] = useState(0);
  const [historyPageSize, setHistoryPageSize] = useState(10);
  const [courts, setCourts] = useState<Court[]>([]);
  const [umpires, setUmpires] = useState<Umpire[]>([]);
  const [tournamentPlayers, setTournamentPlayers] = useState<TournamentPlayer[]>([]);
  const [isImportingRoster, setIsImportingRoster] = useState(false);
  // Which court's detail panel is open, if any — closed by default, and
  // opening one closes whatever else was open (see the courts list below).
  const [expandedCourtId, setExpandedCourtId] = useState<string | null>(null);
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
  // Kept separate from `status` above: Create match sits far down what has
  // become a long, multi-section page, so its own error/success feedback
  // renders right under that section's form instead of at the top of the
  // page, where an admin scrolled down to press the button would never see
  // it without being scrolled back up.
  const [matchStatus, setMatchStatus] = useState<string | null>(null);
  const [lastCreated, setLastCreated] = useState<CreatedMatchLinks | null>(null);
  // Null until GET /api/config resolves (or if mDNS is disabled server-side)
  // — streamBroadcastLinkFor falls back to this browser's own address in
  // either case, so a broadcast link is never blocked on this fetch.
  const [mdnsHostname, setMdnsHostname] = useState<string | null>(null);

  useEffect(() => {
    localStorage.setItem('courtside:adminPassword', adminPassword);
  }, [adminPassword]);

  // On `document.body` rather than just this component's own root element:
  // the light-theme CSS overrides (see styles.css) need to repaint the
  // whole page background, which lives on `body`, not something inside it.
  // Removed on unmount so this stays admin-only — any other screen opened
  // afterwards in the same tab (TV, umpire, ...) starts clean rather than
  // inheriting whatever this admin session last had set.
  useEffect(() => {
    document.body.dataset.theme = theme;
    return () => {
      delete document.body.dataset.theme;
    };
  }, [theme]);

  useEffect(() => {
    // Public and unauthenticated — no admin password needed, so this can
    // (and should) run before one is even known to be valid.
    fetch('/api/config')
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { mdnsHostname?: string; mdnsEnabled?: boolean } | null) => {
        if (body?.mdnsEnabled) setMdnsHostname(body.mdnsHostname ?? null);
      })
      .catch(() => {
        // A broadcast link still works via the browser's own address — this
        // is purely an upgrade to a more durable one, never a requirement.
      });
  }, []);

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
    setStatus(t(copied ? 'clipboard.copied' : 'clipboard.copyFailed'));
  }

  async function deleteCourt(courtIdToDelete: string) {
    const res = await fetch(`/api/courts/${courtIdToDelete}`, {
      method: 'DELETE',
      headers: { 'x-admin-password': adminPassword },
    });

    if (!res.ok) {
      setStatus(await readErrorMessage(res, t('courts.removeFailed')));
      return;
    }
    setStatus(t('courts.removed'));
    void refreshCourts();
  }

  async function deleteUmpire(umpireIdToDelete: string) {
    const res = await fetch(`/api/umpires/${umpireIdToDelete}`, {
      method: 'DELETE',
      headers: { 'x-admin-password': adminPassword },
    });

    if (!res.ok) {
      setStatus(await readErrorMessage(res, t('umpires.removeFailed')));
      return;
    }
    setStatus(t('umpires.removed'));
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
        setStatus(t('roster.noUsableRows'));
        return;
      }

      const res = await fetch('/api/tournament-players/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-password': adminPassword },
        body: JSON.stringify({ tournamentId, players: rows }),
      });
      if (!res.ok) {
        setStatus(await readErrorMessage(res, t('roster.importFailed')));
        return;
      }

      const summary = (await res.json()) as { imported: number; updated: number; skipped: number };
      const totalSkipped = summary.skipped + unreadableRows;
      setStatus(
        t('roster.importResult', {
          count: summary.imported,
          playerWord: t(summary.imported === 1 ? 'common.player' : 'common.players'),
          updated: summary.updated,
        }) +
          (totalSkipped
            ? t('roster.importSkippedClause', {
                count: totalSkipped,
                rowWord: t(totalSkipped === 1 ? 'common.row' : 'common.rows'),
              })
            : '') +
          '.',
      );
      void refreshTournamentPlayers();
    } catch {
      // A thrown exception here (the fetch itself rejecting — offline, or a
      // server that isn't listening at all — or FileReader failing) would
      // otherwise propagate out of this `void`-called async function as an
      // unhandled rejection: no status message, no visible failure at all.
      setStatus(t('roster.importNetworkFailure'));
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
      setStatus(await readErrorMessage(res, t('courts.createFailed')));
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
      setStatus(await readErrorMessage(res, t('umpires.addFailed')));
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
    setMatchStatus(null);
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
        setMatchStatus(t('createMatch.pickEveryPlayer'));
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
      setMatchStatus(await readErrorMessage(res, t('createMatch.createFailed')));
      return;
    }
    const created = (await res.json()) as { match: Match };
    setMatchStatus(t('createMatch.created'));
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

  // The server already returns matches newest-first (see GET /api/matches),
  // so pagination here is a plain slice — no re-sorting needed. Clamped
  // rather than stored pre-validated: the match list can shrink or grow
  // between the 5-second polls that drive it, and a stale page number would
  // otherwise render an empty page instead of quietly settling on the last
  // real one.
  const historyPageCount = Math.max(1, Math.ceil(matches.length / historyPageSize));
  const currentHistoryPage = Math.min(historyPage, historyPageCount - 1);
  const paginatedMatches = matches.slice(
    currentHistoryPage * historyPageSize,
    (currentHistoryPage + 1) * historyPageSize,
  );

  return (
    <main className="admin-dashboard">
      <div className="admin-header-row">
        <h1>
          {tournamentName || t('header.defaultTournamentName')} {t('header.titleSuffix')}
        </h1>
        <div className="admin-header-controls">
          {/* Defaults to the browser/system language (falling back to
              English), but an explicit pick here overrides that from now on
              — see useTranslation's stored-preference logic. */}
          <label className="language-switcher">
            {t('header.languageLabel')}
            <select value={locale} onChange={(e) => setLocale(e.target.value as Locale)}>
              {SUPPORTED_LOCALES.map((code) => (
                <option key={code} value={code}>
                  {LOCALE_NAMES[code]}
                </option>
              ))}
            </select>
          </label>
          {/* Admin-dashboard-only — see useTheme. Defaults to dark; an
              explicit pick here is remembered from now on, the same way
              the language choice is. */}
          <label className="language-switcher">
            {t('header.themeLabel')}
            <select value={theme} onChange={(e) => setTheme(e.target.value as Theme)}>
              <option value="dark">{t('header.themeDark')}</option>
              <option value="light">{t('header.themeLight')}</option>
            </select>
          </label>
        </div>
      </div>
      {tournamentDate && (
        <p className="tournament-date">{new Date(tournamentDate).toLocaleDateString()}</p>
      )}

      {!tournamentId && <p className="field-error">{t('header.noTournamentSelected')}</p>}

      {/* One shared status line for every admin action (add/remove a court
          or umpire, create a match, copy a link) — rendered here, at the
          top, so it's in the same predictable spot regardless of which
          card the triggering action lives in. */}
      {status && (
        <p role="status" className="admin-status">
          {status}
        </p>
      )}

      {tournamentId && (
        <section className="admin-card roster-import-card">
          <h2>{t('roster.cardHeading')}</h2>
          <p className="section-hint">{t('roster.cardHint')}</p>
          <div className="field-row">
            <label className="file-input-label">
              {t('roster.fileLabel')}
              <input
                type="file"
                accept=".csv,text/csv"
                aria-label={t('roster.fileAriaLabel')}
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
              {t('roster.importedCount', {
                count: tournamentPlayers.length,
                playerWord: t(tournamentPlayers.length === 1 ? 'common.player' : 'common.players'),
              })}
            </p>
          )}
        </section>
      )}

      {tournamentId && (
        <div className="admin-grid">
          <div className="admin-column">
            <section className="admin-card">
              <h2>{t('courts.heading')}</h2>
              <p className="section-hint">{t('courts.hint')}</p>
              <form onSubmit={createCourt}>
                <fieldset>
                  <label>
                    {t('courts.nameLabel')}
                    <input
                      aria-label={t('courts.nameAriaLabel')}
                      placeholder={t('courts.namePlaceholder')}
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
                    <button type="submit">{t('courts.addButton')}</button>
                  </div>
                </fieldset>
              </form>

              {courts.length === 0 ? (
                <p>{t('courts.empty')}</p>
              ) : (
                <ul className="court-list court-accordion">
                  {courts.map((c) => (
                    <li key={c.courtId}>
                      {/* A native <details>, controlled rather than
                          uncontrolled: `open` always reflects whether *this*
                          court is the expanded one, so opening a different
                          court's panel closes this one on the next render —
                          "only one at a time" falls out of that for free,
                          with no extra bookkeeping beyond the single
                          expandedCourtId this whole list shares. */}
                      <details
                        open={expandedCourtId === c.courtId}
                        onToggle={(e) => {
                          const isOpen = (e.target as HTMLDetailsElement).open;
                          setExpandedCourtId(isOpen ? c.courtId : null);
                        }}
                      >
                        {/* Everything a glance needs, and nothing else — the
                            detail below (join code, links, QR, Remove) is
                            exactly what "detailed info" meant to hide. */}
                        <summary className="court-summary">
                          {/* Purely decorative — the status tag and the
                              summary's own cursor/hover already say
                              "clickable"; this just makes it visible at a
                              glance that the row expands. */}
                          <span className="court-chevron" aria-hidden="true">
                            ▸
                          </span>
                          <span>{c.label}</span>
                          {/* Derived from the polled match list, not
                              Court.currentMatchId: that field only ever gets
                              set (at match creation) and never cleared, so a
                              court that has ever hosted a match would show
                              "busy" forever, even long after that match
                              finished. occupiedCourtIds — already the source
                              of truth for disabling this same court in the
                              "Create match" dropdown below — reflects
                              whether a CREATED/IN_PROGRESS match is on it
                              right now. */}
                          <span className="status-tag">
                            {occupiedCourtIds.has(c.courtId)
                              ? t('common.busy')
                              : t('common.available')}
                          </span>
                        </summary>
                        <div className="court-details-body">
                          <div className="court-row-info">
                            <span>
                              {t('courts.codeOn')} <a href="/tv">/tv</a>:{' '}
                              <strong className="join-code">{c.tvCode}</strong>
                            </span>
                          </div>
                          <div className="court-row-actions">
                            <input
                              aria-label={t('courts.tvLinkAriaLabel')}
                              readOnly
                              value={tvLinkFor(c)}
                              onFocus={(e) => e.target.select()}
                            />
                            {/* Labelled rather than left as a bare "Copy": there are
                            two copy buttons per court now, and by voice alone
                            they were indistinguishable. */}
                            <button
                              type="button"
                              aria-label={t('courts.copyTvLink', { label: c.label })}
                              onClick={() => void handleCopy(tvLinkFor(c))}
                            >
                              {t('common.copy')}
                            </button>
                            <button
                              type="button"
                              className="danger-button"
                              onClick={() => void deleteCourt(c.courtId)}
                            >
                              {t('common.remove')}
                            </button>
                          </div>
                          {/* Kept visually distinct from the LAN links above: this
                          is the one address that leaves the venue, so mixing it
                          in unlabelled invites sharing a 192.168.x link with
                          someone at home (or this one with the TV). */}
                          <div className="court-row-actions public-link-row">
                            <span
                              className="public-link-label"
                              title={t('courts.publicScoreTitle')}
                            >
                              🌐 {t('courts.publicScoreLabel')}
                            </span>
                            <input
                              aria-label={t('courts.publicLinkAriaLabel')}
                              readOnly
                              value={publicScoreLinkFor(c)}
                              onFocus={(e) => e.target.select()}
                            />
                            <button
                              type="button"
                              aria-label={t('courts.copyPublicLink', { label: c.label })}
                              onClick={() => void handleCopy(publicScoreLinkFor(c))}
                            >
                              {t('common.copy')}
                            </button>
                          </div>
                          {/* One stable link per court (see streamBroadcastLinkFor)
                          rather than a new one shown per match — whoever is
                          filming keeps this page open across matches on this
                          court. QR is deliberately small: a tournament can
                          have well over half a dozen courts live at once, and
                          a full-size code per court would make this list
                          impossible to scan at a glance. */}
                          <div className="court-row-actions broadcast-link-row">
                            <span className="public-link-label" title={t('courts.broadcastTitle')}>
                              📷 {t('courts.broadcastLabel')}
                            </span>
                            <input
                              aria-label={t('courts.broadcastLinkAriaLabel')}
                              readOnly
                              value={streamBroadcastLinkFor(c, mdnsHostname)}
                              onFocus={(e) => e.target.select()}
                            />
                            <button
                              type="button"
                              aria-label={t('courts.copyBroadcastLink', { label: c.label })}
                              onClick={() =>
                                void handleCopy(streamBroadcastLinkFor(c, mdnsHostname))
                              }
                            >
                              {t('common.copy')}
                            </button>
                            <QRCodeSVG
                              value={streamBroadcastLinkFor(c, mdnsHostname)}
                              size={32}
                              bgColor="#ffffff"
                              fgColor="#0a0e1a"
                              marginSize={1}
                              className="broadcast-qr"
                              title={t('courts.broadcastQrTitle', { label: c.label })}
                            />
                          </div>
                        </div>
                      </details>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="admin-card">
              <h2>{t('umpires.heading')}</h2>
              <p className="section-hint">{t('umpires.hint')}</p>
              <form onSubmit={createUmpire}>
                <fieldset>
                  <label>
                    {t('umpires.nameLabel')}
                    <input
                      aria-label={t('umpires.nameLabel')}
                      placeholder={t('umpires.namePlaceholder')}
                      value={newUmpireName}
                      onChange={(e) => setNewUmpireName(e.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                      required
                    />
                  </label>
                  <div className="form-actions">
                    <button type="submit">{t('umpires.addButton')}</button>
                  </div>
                </fieldset>
              </form>

              {umpires.length === 0 ? (
                <p>{t('umpires.empty')}</p>
              ) : (
                <ul className="court-list umpire-list">
                  {umpires.map((u) => {
                    const busy = occupiedUmpireIds.has(u.umpireId);
                    return (
                      <li key={u.umpireId}>
                        <div className="court-header">
                          <span>{u.name}</span>
                          <span className="status-tag">
                            {busy ? t('common.busy') : t('common.available')}
                          </span>
                        </div>
                        <div className="inline-actions">
                          <button
                            type="button"
                            className="danger-button"
                            onClick={() => void deleteUmpire(u.umpireId)}
                          >
                            {t('common.remove')}
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            <section className="admin-card trust-camera-card">
              {/* Closed by default, same as the Courts accordion above — this
                  is a one-time-per-phone setup step, not something an admin
                  needs open while running a tournament. */}
              <details>
                <summary className="section-accordion-summary">
                  <span className="section-chevron" aria-hidden="true">
                    ▸
                  </span>
                  <h2>{t('trustCamera.heading')}</h2>
                </summary>
                <div className="section-accordion-body">
                  <p className="section-hint">{t('trustCamera.hint')}</p>
                  <div className="trust-camera-body">
                    <figure className="qr-code">
                      <QRCodeSVG
                        value={absoluteUrl('/api/local-ca.pem')}
                        size={96}
                        bgColor="#ffffff"
                        fgColor="#0a0e1a"
                        marginSize={1}
                        title={t('trustCamera.qrTitle')}
                      />
                      <figcaption>{t('trustCamera.scanCaption')}</figcaption>
                    </figure>
                    <details>
                      <summary>{t('trustCamera.showSteps')}</summary>
                      <ol className="trust-camera-steps">
                        <li>
                          <strong>{t('trustCamera.iphoneLabel')}</strong>{' '}
                          {t('trustCamera.iphoneSteps')}
                        </li>
                        <li>
                          <strong>{t('trustCamera.androidLabel')}</strong>{' '}
                          {t('trustCamera.androidSteps')}
                        </li>
                      </ol>
                    </details>
                  </div>
                </div>
              </details>
            </section>
          </div>

          <section className="admin-card">
            <h2>{t('createMatch.heading')}</h2>
            <p className="section-hint">{t('createMatch.hint')}</p>
            <form onSubmit={createMatch} className="admin-form">
              <fieldset>
                <legend>{t('createMatch.formatLegend')}</legend>

                <div className="field-row">
                  <label>
                    {t('createMatch.matchTypeLabel')}
                    <select
                      value={matchType}
                      onChange={(e) => setMatchType(e.target.value as MatchType)}
                    >
                      <option value="singles">{t('createMatch.singles')}</option>
                      <option value="doubles">{t('createMatch.doubles')}</option>
                    </select>
                  </label>

                  <label>
                    {t('createMatch.scoringFormatLabel')}
                    <select
                      value={preset}
                      onChange={(e) => setPreset(e.target.value as ScoringPresetName)}
                    >
                      <option value="standard">{t('createMatch.presetStandard')}</option>
                      <option value="short">{t('createMatch.presetShort')}</option>
                    </select>
                  </label>
                </div>

                <label>
                  {t('createMatch.categoryLabel')}
                  {availableCategories.length > 0 ? (
                    <select
                      value={category}
                      onChange={(e) => setCategory(e.target.value)}
                      required
                      aria-describedby="category-hint"
                    >
                      <option value="">{t('createMatch.chooseCategory')}</option>
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
                      placeholder={t('createMatch.categoryPlaceholder')}
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
                    ? t('createMatch.categoryHintRoster')
                    : t('createMatch.categoryHintFree')}
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
                <legend>{t('createMatch.assignmentLegend')}</legend>

                <label>
                  {t('createMatch.courtLabel')}
                  <select value={courtId} onChange={(e) => setCourtId(e.target.value)} required>
                    <option value="">{t('createMatch.chooseCourt')}</option>
                    {courts.map((c) => {
                      const busy = occupiedCourtIds.has(c.courtId);
                      return (
                        <option key={c.courtId} value={c.courtId} disabled={busy}>
                          {c.label}
                          {busy ? t('courts.inUseSuffix') : ''}
                        </option>
                      );
                    })}
                  </select>
                </label>

                <label>
                  {t('createMatch.umpireLabel')}
                  <select value={umpireId} onChange={(e) => setUmpireId(e.target.value)} required>
                    <option value="">{t('createMatch.chooseUmpire')}</option>
                    {umpires.map((u) => {
                      const busy = occupiedUmpireIds.has(u.umpireId);
                      return (
                        <option key={u.umpireId} value={u.umpireId} disabled={busy}>
                          {u.name}
                          {busy ? t('umpires.busySuffix') : ''}
                        </option>
                      );
                    })}
                  </select>
                </label>
              </fieldset>

              <fieldset>
                <legend>{t('createMatch.playersLegend')}</legend>
                {/* Team and country used to be their own "Sides" fieldset
                    ahead of Players; now they sit right under the player(s)
                    they belong to on each side, and — once a roster is
                    active — fill in from that player's own club/country
                    instead of being retyped. */}
                <p className="field-hint">
                  {hasRoster
                    ? t('createMatch.teamCountryHintRoster')
                    : t('createMatch.teamCountryHintFree')}
                </p>
                <div className="match-sides-fields">
                  {(['A', 'B'] as const).map((side) => (
                    <div key={side} className={`side-fieldset side-${side.toLowerCase()}`}>
                      {SIDE_SLOTS[side]
                        .filter((key) => matchType === 'doubles' || !key.endsWith('2'))
                        .map((key) => {
                          const legend = t('createMatch.sidePlayerLegend', {
                            side,
                            number: key.endsWith('2') ? 2 : 1,
                          });
                          return hasRoster ? (
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
                                onChange={(selection) => {
                                  setRosterSelections((current) => ({
                                    ...current,
                                    [key]: selection,
                                  }));
                                  // Auto-fill this side's Team/Country from
                                  // the player's own roster record — see the
                                  // field-hint above. Left alone on a cleared
                                  // selection: the admin is mid-search, not
                                  // saying this side no longer has a team.
                                  if (!selection) return;
                                  const player = tournamentPlayers.find(
                                    (p) => p.tournamentPlayerId === selection.tournamentPlayerId,
                                  );
                                  if (!player) return;
                                  setTeams((current) => ({
                                    ...current,
                                    [side]: {
                                      name: player.club ?? '',
                                      country: player.country ?? '',
                                    },
                                  }));
                                }}
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
                                  {t('createMatch.firstNameLabel')}
                                  <input
                                    aria-label={`${legend} ${t('createMatch.firstNameLabel').toLowerCase()}`}
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
                                  {t('createMatch.lastNameLabel')}
                                  <input
                                    aria-label={`${legend} ${t('createMatch.lastNameLabel').toLowerCase()}`}
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
                          );
                        })}

                      <fieldset className={`team-fieldset side-${side.toLowerCase()}`}>
                        <legend>{t('createMatch.sideTeamLegend', { side })}</legend>
                        <label>
                          {t('createMatch.teamLabel')}
                          <input
                            value={teams[side].name}
                            onChange={(e) =>
                              setTeams((current) => ({
                                ...current,
                                [side]: { ...current[side], name: e.target.value },
                              }))
                            }
                            placeholder={t('common.optionalPlaceholder')}
                            autoComplete="off"
                            spellCheck={false}
                          />
                        </label>
                        <label>
                          {t('createMatch.countryLabel')}
                          <input
                            value={teams[side].country}
                            onChange={(e) =>
                              setTeams((current) => ({
                                ...current,
                                [side]: { ...current[side], country: e.target.value },
                              }))
                            }
                            placeholder={t('common.optionalPlaceholder')}
                            autoComplete="off"
                            spellCheck={false}
                          />
                        </label>
                      </fieldset>
                    </div>
                  ))}
                </div>
              </fieldset>

              <div className="form-actions">
                <button type="submit" aria-busy={isCreating} disabled={isCreating}>
                  {isCreating ? t('createMatch.submitCreating') : t('createMatch.submitCreate')}
                </button>
              </div>
              {/* Its own feedback, separate from the page-wide `status` banner
                  at the top: this section sits far down a long page, and an
                  admin who scrolled here to press the button shouldn't be
                  pulled back to the top (or need to scroll there themselves)
                  to see whether it worked. */}
              {matchStatus && (
                <p role="status" className="admin-status match-status">
                  {matchStatus}
                </p>
              )}
            </form>

            {lastCreated && (
              <div className="created-match-links">
                <p>{t('createMatch.umpireAccessIntro')}</p>
                <p>
                  {t('createMatch.assignedCourt')}{' '}
                  <strong>{lastCreated.courtLabel ?? t('createMatch.courtUnavailable')}</strong>
                </p>
                <div className="umpire-handoff">
                  <div className="umpire-handoff-details">
                    <p>
                      {t('courts.codeOn')} <a href="/umpire">/umpire</a>:{' '}
                      <strong className="join-code">{lastCreated.umpireCode}</strong>
                    </p>
                    <label>
                      {t('createMatch.umpireLinkLabel')}
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
                      title={t('createMatch.umpireQrTitle', { matchId: lastCreated.matchId })}
                    />
                    <figcaption>{t('createMatch.umpireCaption')}</figcaption>
                  </figure>
                </div>
                <button type="button" onClick={() => void handleCopy(lastCreated.umpireLink)}>
                  {t('createMatch.copyUmpireLink')}
                </button>
                {/* No streaming links here anymore — the broadcast link is
                    the same URL for every match on a court (it's keyed by
                    courtId, not matchId), so it now lives once, permanently,
                    in the Courts list below instead of being regenerated
                    and shown here every time a new match starts. */}
              </div>
            )}
          </section>
        </div>
      )}

      {tournamentId && (
        <>
          <div className="history-header">
            <h2>{t('matchHistory.heading')}</h2>
            {matches.length > 0 && (
              <label className="history-page-size">
                {t('matchHistory.rowsPerPage')}
                <select
                  value={historyPageSize}
                  onChange={(e) => {
                    setHistoryPageSize(Number(e.target.value));
                    // A different page size makes the old page number mean
                    // something else entirely — start back at the top
                    // rather than land on a now-arbitrary slice.
                    setHistoryPage(0);
                  }}
                >
                  <option value={10}>10</option>
                  <option value={20}>20</option>
                  <option value={50}>50</option>
                </select>
              </label>
            )}
          </div>
          <ul className="history-list">
            {matches.length === 0 ? (
              <li className="empty-state">{t('matchHistory.empty')}</li>
            ) : (
              paginatedMatches.map((m) =>
                (() => {
                  const courtName =
                    m.courtLabel ??
                    courts.find((court) => court.courtId === m.assignedCourtId)?.label ??
                    t('matchHistory.courtFallback');
                  const umpireName =
                    m.umpireName ?? umpires.find((u) => u.umpireId === m.assignedUmpireId)?.name;
                  const duration = formatDuration(m.startedAt, m.completedAt, t);
                  return (
                    <li key={m.matchId}>
                      <div className="history-topline">
                        {/* Same category ?? matchType fallback as the TV,
                            umpire and stream-viewer screens: the category
                            already implies "singles"/"doubles" when set, so
                            it replaces that label instead of sitting beside
                            it — this list used to show both at once. */}
                        <span className="category-tag">{m.category ?? m.matchType}</span>
                        <span className="status-tag">{displayStatus(m, t)}</span>
                      </div>
                      <small>
                        {courtName} · {new Date(m.createdAt).toLocaleString()}
                        {duration && ` · ${duration}`}
                        {umpireName && ` · ${t('matchHistory.umpirePrefix')} ${umpireName}`}
                      </small>
                      <div
                        className="tv-scoreboard history-scoreboard"
                        aria-label={t('matchHistory.matchScoreAriaLabel')}
                        style={{ '--set-count': m.derived.sets.length } as React.CSSProperties}
                      >
                        <div className="tv-set-labels" aria-hidden="true">
                          <span />
                          {m.derived.sets.map((set) => (
                            <span key={set.setNumber} className={set.winner ? '' : 'current-set'}>
                              {t('matchHistory.setLabel', { number: set.setNumber })}
                            </span>
                          ))}
                        </div>
                        {(['A', 'B'] as const).map((side) => {
                          const names = formatSideNames(
                            m.players,
                            side,
                            t('matchHistory.sideFallback', { side }),
                          );
                          return (
                            <div
                              className={`tv-player-row side-${side.toLowerCase()}${m.derived.matchWinner === side ? ' match-winner' : ''}`}
                              key={side}
                            >
                              <strong className="tv-player-name">
                                {names}
                                {m.derived.retiredSide === side && (
                                  <span className="retired-tag">{t('matchHistory.retired')}</span>
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
          {matches.length > historyPageSize && (
            <div className="history-pagination">
              <button
                type="button"
                onClick={() => setHistoryPage((page) => Math.max(0, page - 1))}
                disabled={currentHistoryPage === 0}
              >
                {t('matchHistory.previous')}
              </button>
              <span>
                {t('matchHistory.pageOf', {
                  current: currentHistoryPage + 1,
                  total: historyPageCount,
                })}
              </span>
              <button
                type="button"
                onClick={() => setHistoryPage((page) => Math.min(historyPageCount - 1, page + 1))}
                disabled={currentHistoryPage >= historyPageCount - 1}
              >
                {t('matchHistory.next')}
              </button>
            </div>
          )}
        </>
      )}
    </main>
  );
}
