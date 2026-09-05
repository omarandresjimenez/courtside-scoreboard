import {
  cameraErrorMessage,
  getCameraUnavailableReason,
  requestCameraStream,
} from './camera-stream.js';

function setSecureContext(value: boolean) {
  Object.defineProperty(window, 'isSecureContext', { value, configurable: true });
}

function setMediaDevices(value: unknown) {
  Object.defineProperty(navigator, 'mediaDevices', { value, configurable: true });
}

describe('getCameraUnavailableReason', () => {
  it('explains the HTTPS requirement outside a secure context', () => {
    setSecureContext(false);
    expect(getCameraUnavailableReason()).toMatch(/requires HTTPS/);
  });

  it('reports an unsupported browser when getUserMedia is missing', () => {
    setSecureContext(true);
    setMediaDevices(undefined);
    expect(getCameraUnavailableReason()).toMatch(/does not support camera capture/);
  });

  it('returns null when capture is available', () => {
    setSecureContext(true);
    setMediaDevices({ getUserMedia: jest.fn() });
    expect(getCameraUnavailableReason()).toBeNull();
  });
});

describe('requestCameraStream', () => {
  it('asks for the rear camera at 720p without audio', async () => {
    const stream = {} as MediaStream;
    const getUserMedia = jest.fn(async () => stream);
    setSecureContext(true);
    setMediaDevices({ getUserMedia });

    await expect(requestCameraStream()).resolves.toBe(stream);
    expect(getUserMedia).toHaveBeenCalledWith({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'environment' },
      audio: false,
    });
  });

  it('rejects with the unavailability reason rather than a confusing type error', async () => {
    setSecureContext(false);
    await expect(requestCameraStream()).rejects.toThrow(/requires HTTPS/);
  });
});

describe('cameraErrorMessage', () => {
  it('gives actionable advice when permission was denied', () => {
    const err = new Error('denied');
    err.name = 'NotAllowedError';
    expect(cameraErrorMessage(err)).toMatch(/Allow camera access/);
  });

  it('reports a missing camera', () => {
    const err = new Error('none');
    err.name = 'NotFoundError';
    expect(cameraErrorMessage(err)).toBe('No camera was found on this device.');
  });

  it("passes through an unrecognised error's own message", () => {
    expect(cameraErrorMessage(new Error('overconstrained'))).toBe('overconstrained');
  });

  it('falls back for a non-Error rejection', () => {
    expect(cameraErrorMessage('nope')).toBe('Failed to access the camera.');
  });
});
