import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

export interface StreamVideoProps {
  stream: MediaStream | null;
  className?: string;
}

/**
 * The `<video>` element paired with a MediaStream, and the one place that
 * knows how to attach one to the other safely.
 *
 * Forwards its element because iPhone Safari can only go fullscreen on a
 * video, never on a container (see useFullscreen).
 */
export const StreamVideo = forwardRef<HTMLVideoElement, StreamVideoProps>(function StreamVideo(
  { stream, className },
  forwardedRef,
) {
  const videoRef = useRef<HTMLVideoElement>(null);
  useImperativeHandle(forwardedRef, () => videoRef.current as HTMLVideoElement, []);

  // Driven from an effect rather than assigned where the stream arrives: the
  // WebRTC track routinely lands before this element is mounted, and assigning
  // `srcObject` to a null ref silently dropped the stream for good — nothing
  // re-attached it once the element appeared. Re-running on both dependencies
  // means neither ordering can lose the race.
  useEffect(() => {
    const element = videoRef.current;
    if (!element) return;
    element.srcObject = stream;

    // Belt and braces alongside the `muted` attribute below: some older
    // browsers (smart TVs especially) don't act on `autoPlay` when the source
    // is a MediaStream assigned after mount, and sit at a black first frame.
    // Muted playback is always permitted, so this can only fail for reasons
    // worth seeing in the console.
    if (stream) {
      void element.play().catch((err) => {
        console.warn('Stream autoplay was blocked:', err);
      });
    }

    // Release the element's hold on the stream when it goes away or this
    // unmounts; a media element keeps a decoder attached to whatever it last
    // pointed at.
    return () => {
      element.srcObject = null;
    };
  }, [stream]);

  return (
    /* `muted` is load-bearing, not cosmetic: browsers refuse to autoplay
       audible media without a user gesture, and a viewer arriving by QR code
       has made no gesture — so `autoPlay` alone left the element stuck at
       paused/black while a perfectly healthy 30 FPS stream arrived behind it.
       The broadcast is video-only (see camera-stream.ts, `audio: false`), so
       muting costs nothing. */
    <video
      ref={videoRef}
      autoPlay
      playsInline
      muted
      className={className}
      style={{ display: stream ? 'block' : 'none' }}
    />
  );
});
