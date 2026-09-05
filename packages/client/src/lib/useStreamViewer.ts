import { useEffect, useState } from 'react';
import { startViewing } from './webrtc-stream.js';

export interface StreamViewerState {
  stream: MediaStream | null;
  isPaused: boolean;
}

/**
 * Owns the viewer-side WebRTC lifecycle for a court, so screens never hold an
 * RTCPeerConnection or a socket themselves — they just render the state.
 */
export function useStreamViewer(courtId: string | undefined): StreamViewerState {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [isPaused, setIsPaused] = useState(false);

  useEffect(() => {
    if (!courtId) return;
    const handle = startViewing(courtId, setStream, setIsPaused);
    return () => {
      handle.stop();
      // Switching courts must not leave the previous court's frame on screen
      // while the new connection is still being negotiated.
      setStream(null);
      setIsPaused(false);
    };
  }, [courtId]);

  return { stream, isPaused };
}
