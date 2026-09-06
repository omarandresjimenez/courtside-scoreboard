import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TournamentPlayer } from '@courtside/shared';
import { PlayerAutocomplete } from './PlayerAutocomplete.js';

const rosterPlayer = (over: Partial<TournamentPlayer> = {}): TournamentPlayer => ({
  tournamentPlayerId: 'tp-1',
  tournamentId: 't-1',
  memberId: null,
  firstName: 'Jane',
  lastName: 'Doe',
  gender: null,
  country: null,
  club: null,
  birthDate: null,
  categories: '',
  status: 'Accepted',
  ...over,
});

describe('PlayerAutocomplete', () => {
  it('shows the full roster as soon as the field is focused, before typing anything', async () => {
    const roster = [rosterPlayer(), rosterPlayer({ tournamentPlayerId: 'tp-2', firstName: 'Bob' })];
    render(
      <PlayerAutocomplete label="Side A player 1" roster={roster} value={null} onChange={jest.fn()} />,
    );

    await userEvent.click(screen.getByRole('combobox'));
    expect(screen.getByRole('option', { name: /Jane Doe/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Bob Doe/ })).toBeInTheDocument();
  });

  it('narrows the list starting from the very first character typed', async () => {
    const roster = [rosterPlayer(), rosterPlayer({ tournamentPlayerId: 'tp-2', firstName: 'Bob' })];
    render(
      <PlayerAutocomplete label="Side A player 1" roster={roster} value={null} onChange={jest.fn()} />,
    );

    await userEvent.type(screen.getByRole('combobox'), 'J');
    expect(screen.getByRole('option', { name: /Jane Doe/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Bob Doe/ })).not.toBeInTheDocument();
  });

  it('lists matching roster players after 3 characters', async () => {
    const roster = [rosterPlayer(), rosterPlayer({ tournamentPlayerId: 'tp-2', firstName: 'Bob' })];
    render(
      <PlayerAutocomplete label="Side A player 1" roster={roster} value={null} onChange={jest.fn()} />,
    );

    await userEvent.type(screen.getByRole('combobox'), 'Jan');
    expect(screen.getByRole('option', { name: /Jane Doe/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Bob/ })).not.toBeInTheDocument();
  });

  it('matches on the last name too', async () => {
    const roster = [rosterPlayer()];
    render(
      <PlayerAutocomplete label="Side A player 1" roster={roster} value={null} onChange={jest.fn()} />,
    );

    await userEvent.type(screen.getByRole('combobox'), 'Doe');
    expect(screen.getByRole('option', { name: /Jane Doe/ })).toBeInTheDocument();
  });

  it('selects a player and fills the input with their full name', async () => {
    const onChange = jest.fn();
    const roster = [rosterPlayer()];
    render(
      <PlayerAutocomplete label="Side A player 1" roster={roster} value={null} onChange={onChange} />,
    );

    await userEvent.type(screen.getByRole('combobox'), 'Jan');
    await userEvent.click(screen.getByRole('option', { name: /Jane Doe/ }));

    expect(onChange).toHaveBeenCalledWith({ tournamentPlayerId: 'tp-1', displayName: 'Jane Doe' });
    expect(screen.getByRole('combobox')).toHaveValue('Jane Doe');
  });

  it('clears the selection once the text is edited afterwards', async () => {
    const onChange = jest.fn();
    const roster = [rosterPlayer()];
    render(
      <PlayerAutocomplete
        label="Side A player 1"
        roster={roster}
        value={{ tournamentPlayerId: 'tp-1', displayName: 'Jane Doe' }}
        onChange={onChange}
      />,
    );

    await userEvent.type(screen.getByRole('combobox'), 'x');
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('excludes ids already picked for another slot', async () => {
    const roster = [rosterPlayer(), rosterPlayer({ tournamentPlayerId: 'tp-2', firstName: 'Janet' })];
    render(
      <PlayerAutocomplete
        label="Side A player 1"
        roster={roster}
        value={null}
        onChange={jest.fn()}
        excludeIds={['tp-1']}
      />,
    );

    await userEvent.type(screen.getByRole('combobox'), 'Jan');
    expect(screen.queryByRole('option', { name: /Jane Doe/ })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Janet Doe/ })).toBeInTheDocument();
  });

  it('shows the player\'s club alongside their name when known', async () => {
    const roster = [rosterPlayer({ club: 'Bay Badminton Club' })];
    render(
      <PlayerAutocomplete label="Side A player 1" roster={roster} value={null} onChange={jest.fn()} />,
    );

    await userEvent.type(screen.getByRole('combobox'), 'Jan');
    expect(screen.getByText('Bay Badminton Club')).toBeInTheDocument();
  });

  it('syncs the visible text when the parent clears the value externally', () => {
    const roster = [rosterPlayer()];
    const { rerender } = render(
      <PlayerAutocomplete
        label="Side A player 1"
        roster={roster}
        value={{ tournamentPlayerId: 'tp-1', displayName: 'Jane Doe' }}
        onChange={jest.fn()}
      />,
    );
    expect(screen.getByRole('combobox')).toHaveValue('Jane Doe');

    rerender(
      <PlayerAutocomplete label="Side A player 1" roster={roster} value={null} onChange={jest.fn()} />,
    );
    expect(screen.getByRole('combobox')).toHaveValue('');
  });
});
