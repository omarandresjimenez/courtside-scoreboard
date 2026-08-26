import { render, screen } from '@testing-library/react';
import { App } from './App.js';

jest.mock('./routes/AdminDashboard.js', () => ({ AdminDashboard: () => <p>admin-stub</p> }));
jest.mock('./routes/UmpireScreen.js', () => ({ UmpireScreen: () => <p>umpire-stub</p> }));
jest.mock('./routes/TvScreen.js', () => ({ TvScreen: () => <p>tv-stub</p> }));
jest.mock('./routes/NotFound.js', () => ({ NotFound: () => <p>not-found-stub</p> }));

function renderAt(path: string) {
  window.history.pushState({}, '', path);
  return render(<App />);
}

describe('App routing', () => {
  it('redirects "/" to the admin dashboard', () => {
    renderAt('/');
    expect(screen.getByText('admin-stub')).toBeInTheDocument();
  });

  it('routes /admin to the admin dashboard', () => {
    renderAt('/admin');
    expect(screen.getByText('admin-stub')).toBeInTheDocument();
  });

  it('routes /umpire/:matchId to the umpire screen', () => {
    renderAt('/umpire/m1');
    expect(screen.getByText('umpire-stub')).toBeInTheDocument();
  });

  it('routes /tv/court/:courtId to the tv screen', () => {
    renderAt('/tv/court/c1');
    expect(screen.getByText('tv-stub')).toBeInTheDocument();
  });

  it('routes anything else to NotFound', () => {
    renderAt('/some/nonsense');
    expect(screen.getByText('not-found-stub')).toBeInTheDocument();
  });
});
