import { useEffect, useRef, useState } from 'react';
import { SERVER_EVENTS, UMPIRE_EVENTS, type MatchStatePayload } from '@courtside/shared';
import { connectSocket, type SocketConnectionOptions } from './socket.js';
import { cacheMatchState, readCachedMatchState } from './offlineCache.js';

interface UseMatchStateResult {
  state: MatchStatePayload | null;
  connected: boolean;
  /** True the first time we're rendering from the IndexedDB cache, not a live server push. */
  isFromCache: boolean;
  error: string | null;
  addPoint: (side: 'A' | 'B') => void;
  undoLastPoint: () => void;
}

/**
 * Shared by the umpire and TV screens: connects the socket, keeps state in
 * sync, and falls back to the IndexedDB cache while (re)connecting — the
 * client half of the resilience story in "Set 02 — Architecture".
 */
export function useMatchState(
  options: SocketConnectionOptions,
  cacheKey: string,
): UseMatchStateResult {
  const [state, setState] = useState<MatchStatePayload | null>(null);
  const [connected, setConnected] = useState(false);
  const [isFromCache, setIsFromCache] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const socketRef = useRef<ReturnType<typeof connectSocket> | null>(null);

  // Options only ever contain primitive fields (role/matchId/token/courtId),
  // so a joined string is a safe, stable effect key.
  const optionsKey = Object.values(options).join('|');

  useEffect(() => {
    let cancelled = false;

    readCachedMatchState(cacheKey).then((cached) => {
      if (!cancelled && cached) {
        setState(cached);
        setIsFromCache(true);
      }
    });

    const socket = connectSocket(options);
    socketRef.current = socket;

    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));

    socket.on(SERVER_EVENTS.MATCH_STATE, (payload: MatchStatePayload) => {
      setState(payload);
      setIsFromCache(false);
      setError(null);
      void cacheMatchState(cacheKey, payload);
    });

    socket.on(SERVER_EVENTS.MATCH_NOT_FOUND, () => {
      setError('No match found for this link yet.');
    });

    socket.on(SERVER_EVENTS.ERROR, (payload: { message: string }) => {
      setError(payload.message);
    });

    return () => {
      cancelled = true;
      socket.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- optionsKey stands in for options
  }, [cacheKey, optionsKey]);

  return {
    state,
    connected,
    isFromCache,
    error,
    addPoint: (side) => {
      if (!('matchId' in options)) return;
      socketRef.current?.emit(UMPIRE_EVENTS.ADD_POINT, {
        matchId: options.matchId,
        eventId: crypto.randomUUID(),
        side,
      });
    },
    undoLastPoint: () => {
      if (!('matchId' in options)) return;
      socketRef.current?.emit(UMPIRE_EVENTS.UNDO_LAST_POINT, {
        matchId: options.matchId,
        eventId: crypto.randomUUID(),
      });
    },
  };
}
