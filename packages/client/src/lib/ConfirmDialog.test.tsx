import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfirmDialog } from './ConfirmDialog.js';

describe('ConfirmDialog', () => {
  const onCancel = jest.fn();
  const onSelect = jest.fn();
  beforeEach(() => {
    onCancel.mockReset();
    onSelect.mockReset();
  });

  const show = (props: Partial<React.ComponentProps<typeof ConfirmDialog>> = {}) =>
    render(
      <ConfirmDialog
        title="End this match?"
        choices={[{ label: 'End', onSelect }]}
        onCancel={onCancel}
        {...props}
      />,
    );

  it('announces itself as a modal alert dialog titled by its heading', () => {
    show();
    expect(screen.getByRole('alertdialog', { name: 'End this match?' })).toHaveAttribute(
      'aria-modal',
      'true',
    );
  });

  it('focuses the first action so a keyboard or remote can act at once', () => {
    show();
    expect(screen.getByRole('button', { name: 'End' })).toHaveFocus();
  });

  it('runs the chosen action', async () => {
    show();
    await userEvent.click(screen.getByRole('button', { name: 'End' }));
    expect(onSelect).toHaveBeenCalled();
  });

  it('offers every choice, so an outcome is never hidden behind Cancel', async () => {
    const other = jest.fn();
    show({
      choices: [
        { label: 'Alice wins', onSelect, danger: true },
        { label: 'Bilal wins', onSelect: other, danger: true },
      ],
    });
    await userEvent.click(screen.getByRole('button', { name: 'Bilal wins' }));
    expect(other).toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('marks destructive choices', () => {
    show({ choices: [{ label: 'End', onSelect, danger: true }] });
    expect(screen.getByRole('button', { name: 'End' })).toHaveClass('danger-button');
  });

  it('shows the optional supporting message', () => {
    show({ message: 'This cannot be undone.' });
    expect(screen.getByText('This cannot be undone.')).toBeInTheDocument();
  });

  it('cancels from the button, the backdrop, and Escape', async () => {
    show({ cancelLabel: 'Back' });
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    await userEvent.click(screen.getByTestId('confirm-backdrop'));
    await userEvent.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(3);
  });

  it('does not cancel when the panel itself is clicked', async () => {
    show();
    await userEvent.click(screen.getByRole('alertdialog'));
    expect(onCancel).not.toHaveBeenCalled();
  });
});
