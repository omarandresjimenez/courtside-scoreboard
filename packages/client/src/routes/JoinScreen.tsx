import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

interface JoinScreenProps {
  role: 'tv' | 'umpire';
}

interface RoleConfig {
  heading: string;
  prompt: string;
  resolvePath: (code: string) => string;
  destination: (data: { courtId?: string; matchId?: string; token?: string }) => string;
}

const CONFIG: Record<JoinScreenProps['role'], RoleConfig> = {
  tv: {
    heading: 'TV Display',
    prompt: 'Enter the court code shown in the admin dashboard.',
    resolvePath: (code) => `/api/courts/resolve/${code}`,
    destination: (data) => `/tv/court/${data.courtId}`,
  },
  umpire: {
    heading: 'Umpire',
    prompt: 'Enter the match code shown in the admin dashboard.',
    resolvePath: (code) => `/api/matches/resolve/${code}`,
    destination: (data) => `/umpire/${data.matchId}?token=${data.token}`,
  },
};

/**
 * The generic landing page for a TV or umpire device that only has this
 * one bookmarked address — types in the short code from the admin
 * dashboard instead of the admin having to hand over a full URL (see
 * AdminDashboard's tvCode / umpireCode display).
 */
export function JoinScreen({ role }: JoinScreenProps) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const navigate = useNavigate();
  const config = CONFIG[role];

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const normalized = code.trim().toUpperCase();
    if (!normalized) return;

    setError(null);
    setSubmitting(true);
    const res = await fetch(config.resolvePath(normalized));
    setSubmitting(false);

    if (!res.ok) {
      setError("That code wasn't found — check it and try again.");
      return;
    }
    const data = (await res.json()) as { courtId?: string; matchId?: string; token?: string };
    navigate(config.destination(data));
  }

  return (
    <main className="join-screen">
      <h1>{config.heading}</h1>
      <p>{config.prompt}</p>
      <form onSubmit={(e) => void handleSubmit(e)}>
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="CODE"
          autoCapitalize="characters"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          maxLength={8}
          aria-label="Code"
        />
        <button type="submit" disabled={submitting || !code.trim()}>
          {submitting ? 'Connecting…' : 'Connect'}
        </button>
      </form>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </main>
  );
}
