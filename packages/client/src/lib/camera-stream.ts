/** Broadcaster-side camera access — grabs the phone's back camera as a
 * MediaStream for WebRTC (see webrtc-stream.ts) to send directly to viewers. */

/** getUserMedia is only exposed in a secure context (HTTPS, or localhost).
 * Over a plain http:// LAN address — the common way to open this page on a
 * phone — the browser hides the API entirely, which otherwise surfaces as a
 * confusing "not a function" error instead of a permissions problem. */
export function getCameraUnavailableReason(): string | null {
  if (!window.isSecureContext) {
    return 'Camera access requires HTTPS. Open this page using the https:// link/QR code provided by the admin, not http://.';
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    return 'This browser does not support camera capture.';
  }
  return null;
}

export async function requestCameraStream(): Promise<MediaStream> {
  const unavailable = getCameraUnavailableReason();
  if (unavailable) throw new Error(unavailable);

  return navigator.mediaDevices.getUserMedia({
    video: {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      facingMode: 'environment',
    },
    audio: false,
  });
}

/** Turn a getUserMedia rejection into something a court-side volunteer can act
 *  on. The DOMException names are the actionable cases; anything else falls
 *  through to the browser's own message rather than being flattened. */
export function cameraErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'NotAllowedError') {
      return 'Camera permission was denied. Allow camera access in your browser settings and try again.';
    }
    if (err.name === 'NotFoundError') {
      return 'No camera was found on this device.';
    }
    return err.message;
  }
  return 'Failed to access the camera.';
}
