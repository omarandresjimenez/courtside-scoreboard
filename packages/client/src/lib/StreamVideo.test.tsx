import { render } from '@testing-library/react';
import { StreamVideo } from './StreamVideo.js';

const play = jest.fn(() => Promise.resolve());

function fakeStream(id: string): MediaStream {
  return { id } as unknown as MediaStream;
}

beforeAll(() => {
  // jsdom implements neither; both are needed for the attach path.
  Object.defineProperty(HTMLMediaElement.prototype, 'play', { value: play, writable: true });
});

beforeEach(() => play.mockClear());

describe('StreamVideo', () => {
  it('is muted and autoplaying, without which browsers refuse to start the stream', () => {
    const { container } = render(<StreamVideo stream={null} />);
    const video = container.querySelector('video');

    expect(video).toHaveAttribute('autoplay');
    expect(video?.muted).toBe(true);
    expect(video).toHaveAttribute('playsinline');
  });

  it('attaches the stream and starts playback', () => {
    const stream = fakeStream('s1');
    const { container } = render(<StreamVideo stream={stream} />);
    const video = container.querySelector('video') as HTMLVideoElement;

    expect(video.srcObject).toBe(stream);
    expect(play).toHaveBeenCalled();
  });

  it('hides the element until a stream exists, and shows it once one does', () => {
    const { container, rerender } = render(<StreamVideo stream={null} />);
    const video = container.querySelector('video') as HTMLVideoElement;
    expect(video.style.display).toBe('none');

    rerender(<StreamVideo stream={fakeStream('s1')} />);
    expect(video.style.display).toBe('block');
  });

  it('does not attempt playback when there is no stream', () => {
    render(<StreamVideo stream={null} />);
    expect(play).not.toHaveBeenCalled();
  });

  it('re-attaches when the stream is replaced', () => {
    const { container, rerender } = render(<StreamVideo stream={fakeStream('s1')} />);
    const video = container.querySelector('video') as HTMLVideoElement;

    const next = fakeStream('s2');
    rerender(<StreamVideo stream={next} />);

    expect(video.srcObject).toBe(next);
  });

  it('releases srcObject on unmount so the element stops holding the decoder', () => {
    const { container, unmount } = render(<StreamVideo stream={fakeStream('s1')} />);
    const video = container.querySelector('video') as HTMLVideoElement;

    unmount();

    expect(video.srcObject).toBeNull();
  });

  it('swallows an autoplay rejection instead of raising an unhandled rejection', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    play.mockImplementationOnce(() => Promise.reject(new Error('NotAllowedError')));

    render(<StreamVideo stream={fakeStream('s1')} />);
    await Promise.resolve();
    await Promise.resolve();

    expect(warn).toHaveBeenCalledWith('Stream autoplay was blocked:', expect.any(Error));
    warn.mockRestore();
  });
});
