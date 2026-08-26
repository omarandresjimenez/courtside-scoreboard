import { useEffect, useState } from 'react';
import {
  SCORING_PRESETS,
  type Court,
  type Match,
  type MatchSummary,
  type MatchType,
  type ScoringPresetName,
} from '@courtside/shared';

interface CreatedMatchLinks {
  matchId: string;
  umpireLink: string;
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

/** Best-effort clipboard copy — the Clipboard API needs a secure context,
 * which a plain http://<lan-ip> address on match day isn't, so every link
 * is also shown in a tap-to-select input as a fallback that always works. */
async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Ignored — the visible, selectable link field is the reliable path.
  }
}

/**
 * Set 09's admin dashboard: create courts, create matches (optionally onto
 * a court), and get back the two links that matter — the umpire link
 * (shown once, right after creation, since the server never re-serves the
 * umpireToken afterwards) and each court's TV link. Live per-court tiles
 * and match editing are the next wiring pass — see the design doc's "Set 09".
 */
export function AdminDashboard() {
  const [adminPassword, setAdminPassword] = useState(
    () => localStorage.getItem('courtside:adminPassword') ?? '',
  );
  const [matches, setMatches] = useState<MatchSummary[]>([]);
  const [courts, setCourts] = useState<Court[]>([]);
  const [matchType, setMatchType] = useState<MatchType>('singles');
  const [preset, setPreset] = useState<ScoringPresetName>('standard');
  const [names, setNames] = useState({ a1: '', a2: '', b1: '', b2: '' });
  const [courtId, setCourtId] = useState('');
  const [newCourtLabel, setNewCourtLabel] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [lastCreated, setLastCreated] = useState<CreatedMatchLinks | null>(null);

  useEffect(() => {
    localStorage.setItem('courtside:adminPassword', adminPassword);
  }, [adminPassword]);

  async function refreshMatches() {
    if (!adminPassword) return;
    const res = await fetch('/api/matches', { headers: { 'x-admin-password': adminPassword } });
    if (res.ok) setMatches(await res.json());
  }

  async function refreshCourts() {
    if (!adminPassword) return;
    const res = await fetch('/api/courts', { headers: { 'x-admin-password': adminPassword } });
    if (res.ok) setCourts(await res.json());
  }

  useEffect(() => {
    void refreshMatches();
    void refreshCourts();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-fetch whenever the password changes
  }, [adminPassword]);

  async function createCourt(e: React.FormEvent) {
    e.preventDefault();
    setStatus(null);

    const res = await fetch('/api/courts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-password': adminPassword },
      body: JSON.stringify({ label: newCourtLabel }),
    });

    if (!res.ok) {
      setStatus((await res.json()).error ?? 'Failed to create court.');
      return;
    }
    setNewCourtLabel('');
    void refreshCourts();
  }

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
        ...(courtId ? { courtId } : {}),
      }),
    });

    if (!res.ok) {
      setStatus((await res.json()).error ?? 'Failed to create match.');
      return;
    }
    const created = (await res.json()) as { match: Match };
    setStatus('Match created.');
    setLastCreated({ matchId: created.match.matchId, umpireLink: umpireLinkFor(created.match) });
    setNames({ a1: '', a2: '', b1: '', b2: '' });
    void refreshMatches();
    if (courtId) void refreshCourts();
  }

  return (
    <main className="admin-dashboard">
      <h1>Courtside Scoreboard — Admin</h1>

      <label>
        Admin password
        <input
          type="password"
          value={adminPassword}
          onChange={(e) => setAdminPassword(e.target.value)}
        />
      </label>

      <form onSubmit={createCourt}>
        <fieldset>
          <legend>Add a court</legend>
          <input
            placeholder="Court label (e.g. Court 1)"
            value={newCourtLabel}
            onChange={(e) => setNewCourtLabel(e.target.value)}
            required
          />
          <button type="submit">Add court</button>
        </fieldset>
      </form>

      <h2>Courts</h2>
      {courts.length === 0 ? (
        <p>No courts yet — add one above, then its TV link appears here.</p>
      ) : (
        <ul className="court-list">
          {courts.map((c) => (
            <li key={c.courtId}>
              <span>{c.label}</span>
              <label>
                TV link
                <input readOnly value={tvLinkFor(c)} onFocus={(e) => e.target.select()} />
              </label>
              <button type="button" onClick={() => void copyToClipboard(tvLinkFor(c))}>
                Copy
              </button>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={createMatch}>
        <fieldset>
          <legend>Create match</legend>

          <label>
            Match type
            <select value={matchType} onChange={(e) => setMatchType(e.target.value as MatchType)}>
              <option value="singles">Singles</option>
              <option value="doubles">Doubles</option>
            </select>
          </label>

          <label>
            Scoring format
            <select value={preset} onChange={(e) => setPreset(e.target.value as ScoringPresetName)}>
              <option value="standard">Standard (21 / 30 / 11)</option>
              <option value="short">Short (15 / 21 / 8)</option>
            </select>
          </label>

          <label>
            Court (optional — can assign later)
            <select value={courtId} onChange={(e) => setCourtId(e.target.value)}>
              <option value="">Not assigned yet</option>
              {courts.map((c) => (
                <option key={c.courtId} value={c.courtId}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>

          <input
            placeholder="Side A player 1"
            value={names.a1}
            onChange={(e) => setNames({ ...names, a1: e.target.value })}
            required
          />
          {matchType === 'doubles' && (
            <input
              placeholder="Side A player 2"
              value={names.a2}
              onChange={(e) => setNames({ ...names, a2: e.target.value })}
              required
            />
          )}
          <input
            placeholder="Side B player 1"
            value={names.b1}
            onChange={(e) => setNames({ ...names, b1: e.target.value })}
            required
          />
          {matchType === 'doubles' && (
            <input
              placeholder="Side B player 2"
              value={names.b2}
              onChange={(e) => setNames({ ...names, b2: e.target.value })}
              required
            />
          )}

          <button type="submit">Create match</button>
        </fieldset>
      </form>

      {status && <p role="status">{status}</p>}

      {lastCreated && (
        <div className="created-match-links">
          <p>
            Umpire link for <strong>{lastCreated.matchId}</strong> — give this only to the umpire,
            it won&rsquo;t be shown again:
          </p>
          <label>
            Umpire link
            <input readOnly value={lastCreated.umpireLink} onFocus={(e) => e.target.select()} />
          </label>
          <button type="button" onClick={() => void copyToClipboard(lastCreated.umpireLink)}>
            Copy
          </button>
        </div>
      )}

      <h2>Matches</h2>
      <ul>
        {matches.map((m) => (
          <li key={m.matchId}>
            {m.matchId} — {m.matchType} — {m.status}
          </li>
        ))}
      </ul>
    </main>
  );
}
