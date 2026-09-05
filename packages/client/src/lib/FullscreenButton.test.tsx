import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FullscreenButton } from './FullscreenButton.js';

const state = (overrides = {}) => ({
  isFullscreen: false,
  isSupported: true,
  toggle: jest.fn(),
  ...overrides,
});

describe('FullscreenButton', () => {
  it('renders nothing where the browser cannot go fullscreen', () => {
    const { container } = render(<FullscreenButton state={state({ isSupported: false })} />);
    // Better than a control that silently does nothing when tapped.
    expect(container).toBeEmptyDOMElement();
  });

  it('offers to enter fullscreen', () => {
    render(<FullscreenButton state={state()} />);
    expect(screen.getByRole('button', { name: 'Full screen' })).toBeInTheDocument();
  });

  it('offers to leave once fullscreen', () => {
    render(<FullscreenButton state={state({ isFullscreen: true })} />);
    expect(screen.getByRole('button', { name: 'Exit full screen' })).toBeInTheDocument();
  });

  it('toggles when pressed', async () => {
    const s = state();
    render(<FullscreenButton state={s} />);

    await userEvent.click(screen.getByRole('button'));

    expect(s.toggle).toHaveBeenCalled();
  });
});
