import { useEffect, useState } from 'react';
import {
  SCORING_PRESETS,
  type MatchSummary,
  type MatchType,
  type ScoringPresetName,
} from '@courtside/shared';

/**
 * Set 09's admin dashboard, in scaffold form: create a match and see the
 * list. Court assignment, live per-court tiles, and match editing are the
 * next wiring pass — see the design doc's "Set 09" for the full shape.
 */
export function AdminDashboard() {
  const [adminPassword, setAdminPassword] = useState(
    () => localStorage.getItem('courtside:adminPassword') ?? '',
  );
  const [matches, setMatches] = useState<MatchSummary[]>([]);
  const [matchType, setMatchType] = useState<MatchType>('singles');
  const [preset, setPreset] = useState<ScoringPresetName>('standard');
  const [names, setNames] = useState({ a1: '', a2: '', b1: '', b2: '' });
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    localStorage.setItem('courtside:adminPassword', adminPassword);
  }, [adminPassword]);

  async function refreshMatches() {
    if (!adminPassword) return;
    const res = await fetch('/api/matches', { headers: { 'x-admin-password': adminPassword } });
    if (res.ok) setMatches(await res.json());
  }

  useEffect(() => {
    void refreshMatches();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-fetch whenever the password changes
  }, [adminPassword]);

  async function createMatch(e: React.FormEvent) {
    e.preventDefault();
    setStatus(null);

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
        scoringConfig: preset === 'custom' ? SCORING_PRESETS.standard : SCORING_PRESETS[preset],
      }),
    });

    if (!res.ok) {
      setStatus((await res.json()).error ?? 'Failed to create match.');
      return;
    }
    setStatus('Match created.');
    setNames({ a1: '', a2: '', b1: '', b2: '' });
    void refreshMatches();
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
