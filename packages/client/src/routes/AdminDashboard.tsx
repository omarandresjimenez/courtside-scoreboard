import { useEffect, useState } from 'react';
import {
  SCORING_PRESETS,
  type Court,
  type Match,
  type MatchStatePayload,
  type MatchSummary,
  type MatchType,
  type Side,
  type ScoringPresetName,
  type Umpire,
} from '@courtside/shared';
import { QRCodeSVG } from 'qrcode.react';
import { copyToClipboard } from '../lib/clipboard.js';

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
  const [matchType, setMatchType] = useState<MatchType>('singles');
  const [preset, setPreset] = useState<ScoringPresetName>('standard');
  const [names, setNames] = useState({ a1: '', a2: '', b1: '', b2: '' });
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
      setStatus((await res.json()).error ?? 'Failed to remove court.');
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
      setStatus((await res.json()).error ?? 'Failed to remove umpire.');
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

  useEffect(() => {
    void refreshMatches();
    void refreshCourts();
    void refreshUmpires();
    const refreshInterval = window.setInterval(() => void refreshMatches(), 5_000);
    return () => window.clearInterval(refreshInterval);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-fetch whenever the password changes
  }, [adminPassword]);

  async function createCourt(e: React.FormEvent) {
    e.preventDefault();
    setStatus(null);

    const res = await fetch('/api/courts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-password': adminPassword },
      body: JSON.stringify({ label: newCourtLabel, tournamentId }),
    });

    if (!res.ok) {
      setStatus((await res.json()).error ?? 'Failed to create court.');
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
      setStatus((await res.json()).error ?? 'Failed to add umpire.');
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

  async function createMatch(e: React.FormEvent) {
    e.preventDefault();
    setStatus(null);
    setLastCreated(null);

    const players =
      matchType === 'singles'
        ? [
            { side: 'A' as const, name: names.a1 },
            { side: 'B' as const, name: names.b1 },
          ]
        : [
            { side: 'A' as const, name: names.a1 },
            { side: 'A' as const, name: names.a2 },
            { side: 'B' as const, name: names.b1 },
            { side: 'B' as const, name: names.b2 },
          ];

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
      }),
    });

    if (!res.ok) {
      setStatus((await res.json()).error ?? 'Failed to create match.');
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
    setNames({ a1: '', a2: '', b1: '', b2: '' });
    setTeams({ A: { name: '', country: '' }, B: { name: '', country: '' } });
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

      {tournamentId && (
        <div className="admin-grid">
          <div className="admin-column">
            <section className="admin-card">
              <h2>Courts</h2>
              <form onSubmit={createCourt}>
                <fieldset>
                  <input
                    aria-label="Court label"
                    placeholder="Court label (e.g. Court 1)"
                    value={newCourtLabel}
                    onChange={(e) => setNewCourtLabel(e.target.value)}
                    required
                  />
                  <button type="submit">Add court</button>
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
                        <span className="status-tag">{c.currentMatchId ? 'Live' : 'Idle'}</span>
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
              <form onSubmit={createUmpire}>
                <fieldset>
                  <input
                    aria-label="Umpire name"
                    placeholder="Name Lastname"
                    value={newUmpireName}
                    onChange={(e) => setNewUmpireName(e.target.value)}
                    required
                  />
                  <button type="submit">Add umpire</button>
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
            <form onSubmit={createMatch}>
              <fieldset>
                <legend>Create match</legend>

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
                          placeholder="Optional"
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
                          placeholder="Optional"
                        />
                      </label>
                    </fieldset>
                  ))}
                </div>

                <div className="match-player-fields">
                  <label>
                    Side A player 1
                    <input
                      placeholder="Side A player 1"
                      value={names.a1}
                      onChange={(e) => setNames({ ...names, a1: e.target.value })}
                      required
                    />
                  </label>
                  <label>
                    Side B player 1
                    <input
                      placeholder="Side B player 1"
                      value={names.b1}
                      onChange={(e) => setNames({ ...names, b1: e.target.value })}
                      required
                    />
                  </label>
                  {matchType === 'doubles' && (
                    <>
                      <label>
                        Side A player 2
                        <input
                          placeholder="Side A player 2"
                          value={names.a2}
                          onChange={(e) => setNames({ ...names, a2: e.target.value })}
                          required
                        />
                      </label>
                      <label>
                        Side B player 2
                        <input
                          placeholder="Side B player 2"
                          value={names.b2}
                          onChange={(e) => setNames({ ...names, b2: e.target.value })}
                          required
                        />
                      </label>
                    </>
                  )}
                </div>

                <button type="submit">Create match</button>
              </fieldset>
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
                          const names = m.players
                            .filter((player) => player.side === side)
                            .map((player) => player.name)
                            .join(' / ');
                          return (
                            <div
                              className={`tv-player-row side-${side.toLowerCase()}${m.derived.matchWinner === side ? ' match-winner' : ''}`}
                              key={side}
                            >
                              <strong className="tv-player-name">
                                {names || `Side ${side}`}
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
