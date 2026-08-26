const mockSocket = { on: jest.fn(), emit: jest.fn(), disconnect: jest.fn() };
const mockIo = jest.fn(() => mockSocket);
jest.mock('socket.io-client', () => ({ io: mockIo }));

import { connectSocket } from './socket.js';

describe('connectSocket', () => {
  afterEach(() => {
    mockIo.mockClear();
  });

  it('connects with the umpire role, matchId, and token as the query', () => {
    connectSocket({ role: 'umpire', matchId: 'm1', token: 'tok' });

    expect(mockIo).toHaveBeenCalledWith('/', {
      query: { role: 'umpire', matchId: 'm1', token: 'tok' },
      transports: ['websocket'],
    });
  });

  it('connects with the tv role and courtId as the query', () => {
    connectSocket({ role: 'tv', courtId: 'c1' });

    expect(mockIo).toHaveBeenCalledWith('/', {
      query: { role: 'tv', courtId: 'c1' },
      transports: ['websocket'],
    });
  });

  it('returns the socket instance from io()', () => {
    const socket = connectSocket({ role: 'tv', courtId: 'c1' });
    expect(socket).toBe(mockSocket);
  });
});
