import { render, screen } from '@testing-library/react';
import { NotFound } from './NotFound.js';

describe('NotFound', () => {
  it('tells the viewer their link did not match anything', () => {
    render(<NotFound />);
    expect(screen.getByText(/doesn.t match anything/i)).toBeInTheDocument();
  });
});
