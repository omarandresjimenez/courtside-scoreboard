import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StreamBroadcast } from './StreamBroadcast.js';
import type { CameraBroadcast } from '../lib/useCameraBroadcast.js';

const mockUseCameraBroadcast = jest.fn();
jest.mock('../lib/useCameraBroadcast.js', () => ({
  useCameraBroadcast: (...args: unknown[]) => mockUseCameraBroadcast(...args),
}));

const mockUseCourtLabel = jest.fn();
jest.mock('../lib/useCourtLabel.js', () => ({
  useCourtLabel: (...args: unknown[]) => mockUseCourtLabel(...args),
}));

jest.mock('../lib/StreamVideo.js', () => ({
  StreamVideo: ({ stream }: { stream: MediaStream | null }) => (
    <div data-testid="stream-video">{stream ? 'attached' : 'empty'}</div>
  ),
}));

const actions = { start: jest.fn(), togglePause: jest.fn(), stop: jest.fn() };

function broadcast(overrides: Partial<CameraBroadcast> = {}): CameraBroadcast {
  return {
    status: 'idle',
    errorMessage: null,
    internetViewers: 0,
    stream: null,
    ...actions,
    ...overrides,
  } as CameraBroadcast;
}

function renderAt(courtId = 'court1') {
  return render(
    <MemoryRouter initialEntries={[`/stream/live/court/${courtId}`]}>
      <Routes>
        <Route path="/stream/live/court/:courtId" element={<StreamBroadcast />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUseCameraBroadcast.mockReturnValue(broadcast());
  mockUseCourtLabel.mockReturnValue(null);
});

describe('StreamBroadcast', () => {
  it('reports a missing court ID instead of broadcasting to nowhere', () => {
    render(
      <MemoryRouter>
        <StreamBroadcast />
      </MemoryRouter>,
    );
    expect(screen.getByText('Missing court ID.')).toBeInTheDocument();
  });

  it('offers the start control while idle', () => {
    renderAt();
    expect(screen.getByRole('button', { name: /Start transmission/ })).toBeEnabled();
    expect(screen.getByText(/Status: Idle/)).toBeInTheDocument();
  });

  it('starts the broadcast when pressed', async () => {
    renderAt();
    await userEvent.click(screen.getByRole('button', { name: /Start transmission/ }));
    expect(actions.start).toHaveBeenCalled();
  });

  it('disables the button while the camera is opening', () => {
    mockUseCameraBroadcast.mockReturnValue(broadcast({ status: 'starting' }));
    renderAt();
    expect(screen.getByRole('button', { name: /Starting/ })).toBeDisabled();
  });

  it('shows pause and stop once live, and hides the placeholder', () => {
    mockUseCameraBroadcast.mockReturnValue(
      broadcast({ status: 'live', stream: {} as MediaStream }),
    );
    renderAt();

    expect(screen.getByRole('button', { name: /Pause/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Stop/ })).toBeInTheDocument();
    expect(screen.queryByText(/Camera preview appears here/)).not.toBeInTheDocument();
    expect(screen.getByText(/Status: Transmitting/)).toBeInTheDocument();
  });

  it('offers resume and marks the preview while paused', () => {
    mockUseCameraBroadcast.mockReturnValue(broadcast({ status: 'paused' }));
    renderAt();

    expect(screen.getByRole('button', { name: /Resume/ })).toBeInTheDocument();
    expect(screen.getByText('Paused')).toBeInTheDocument();
  });

  it('wires the pause and stop controls', async () => {
    mockUseCameraBroadcast.mockReturnValue(broadcast({ status: 'live' }));
    renderAt();

    await userEvent.click(screen.getByRole('button', { name: /Pause/ }));
    expect(actions.togglePause).toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: /Stop/ }));
    expect(actions.stop).toHaveBeenCalled();
  });

  it('surfaces a camera error and returns to the start control', () => {
    mockUseCameraBroadcast.mockReturnValue(
      broadcast({ status: 'error', errorMessage: 'Camera permission was denied.' }),
    );
    renderAt();

    expect(screen.getByText('Camera permission was denied.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Start transmission/ })).toBeInTheDocument();
  });

  it('pluralises the internet viewer count', () => {
    mockUseCameraBroadcast.mockReturnValue(broadcast({ status: 'live', internetViewers: 1 }));
    const { rerender } = renderAt();
    expect(screen.getByRole('status')).toHaveTextContent('1 internet viewer');

    mockUseCameraBroadcast.mockReturnValue(broadcast({ status: 'live', internetViewers: 3 }));
    rerender(
      <MemoryRouter initialEntries={['/stream/live/court/court1']}>
        <Routes>
          <Route path="/stream/live/court/:courtId" element={<StreamBroadcast />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('3 internet viewers');
  });

  it('hides the viewer count when nothing is being transmitted', () => {
    renderAt();
    expect(screen.getByRole('status')).not.toHaveTextContent('internet viewer');
  });

  it('broadcasts for the court in the URL', () => {
    renderAt('court-42');
    expect(mockUseCameraBroadcast).toHaveBeenCalledWith('court-42');
  });

  it('names the court, not its id', () => {
    mockUseCourtLabel.mockReturnValue('Center Court');
    renderAt('cmtovm7pi0019ig0osnyudvtr');

    expect(screen.getByText('Center Court')).toBeInTheDocument();
    // A raw cuid tells the person holding the phone nothing.
    expect(screen.queryByText(/cmtovm7pi/)).not.toBeInTheDocument();
  });

  it('falls back to the id until the name is known', () => {
    mockUseCourtLabel.mockReturnValue(null);
    renderAt('court-42');

    expect(screen.getByText('Court court-42')).toBeInTheDocument();
  });
});
