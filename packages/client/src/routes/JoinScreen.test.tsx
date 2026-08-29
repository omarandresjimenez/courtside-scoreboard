import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { JoinScreen } from './JoinScreen.js';

function LocationDisplay() {
  const location = useLocation();
  return <p data-testid="location">{`${location.pathname}${location.search}`}</p>;
}

function renderJoin(role: 'tv' | 'umpire') {
  return render(
    <MemoryRouter initialEntries={[`/${role}`]}>
      <Routes>
        <Route path={`/${role}`} element={<JoinScreen role={role} />} />
        <Route path="*" element={<LocationDisplay />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  global.fetch = jest.fn();
});

describe('JoinScreen', () => {
  it('shows the TV heading and prompt', () => {
    renderJoin('tv');
    expect(screen.getByRole('heading', { name: 'TV Display' })).toBeInTheDocument();
    expect(screen.getByText(/court code/)).toBeInTheDocument();
  });

  it('shows the umpire heading and prompt', () => {
    renderJoin('umpire');
    expect(screen.getByRole('heading', { name: 'Umpire' })).toBeInTheDocument();
    expect(screen.getByText(/match code/)).toBeInTheDocument();
  });

  it('disables Connect until a code is entered', async () => {
    renderJoin('tv');
    expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled();

    await userEvent.type(screen.getByLabelText('Code'), 'abc123');
    expect(screen.getByRole('button', { name: 'Connect' })).toBeEnabled();
  });

  it('ignores a bare-whitespace submission without calling the resolve endpoint', () => {
    renderJoin('tv');
    fireEvent.submit(screen.getByRole('button', { name: 'Connect' }).closest('form')!);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('resolves a TV code (normalized to uppercase) and navigates to that court', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ courtId: 'c1' }),
    });
    renderJoin('tv');

    await userEvent.type(screen.getByLabelText('Code'), 'abc123');
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));

    expect(global.fetch).toHaveBeenCalledWith('/api/courts/resolve/ABC123');
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/tv/court/c1'));
  });

  it('resolves an umpire code and navigates to the umpire screen with its token', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ matchId: 'm1', token: 'tok-1' }),
    });
    renderJoin('umpire');

    await userEvent.type(screen.getByLabelText('Code'), 'xyz789');
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));

    expect(global.fetch).toHaveBeenCalledWith('/api/matches/resolve/XYZ789');
    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent('/umpire/m1?token=tok-1'),
    );
  });

  it('shows an error and stays put when the code is not found', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false });
    renderJoin('tv');

    await userEvent.type(screen.getByLabelText('Code'), 'nope00');
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/wasn't found/);
    expect(screen.getByRole('heading', { name: 'TV Display' })).toBeInTheDocument();
  });
});
