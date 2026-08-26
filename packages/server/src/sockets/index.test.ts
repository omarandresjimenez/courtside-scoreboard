import { createServer, type Server as HttpServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { Server as SocketIoServer } from 'socket.io';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { SERVER_EVENTS, TV_EVENTS, UMPIRE_EVENTS } from '@courtside/shared';
import { createFakePrisma } from '../testUtils/fakePrisma.js';

const mockPrisma = createFakePrisma();
jest.mock('../db/client.js', () => ({ prisma: mockPrisma.prisma }));

// After the mock, so registerSocketHandlers (and the replay engine it
// calls) resolve '../db/client.js' to the fake above.
import { registerSocketHandlers } from './index.js';

let httpServer: HttpServer;
let port: number;
const openSockets: ClientSocket[] = [];

beforeAll(async () => {
  httpServer = createServer();
  const io = new SocketIoServer(httpServer);
  registerSocketHandlers(io);
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  port = (httpServer.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

afterEach(() => {
  openSockets.forEach((socket) => socket.disconnect());
  openSockets.length = 0;
});

function connect(query: Record<string, string>): ClientSocket {
  const socket = ioClient(`http://localhost:${port}`, { query, transports: ['websocket'] });
  openSockets.push(socket);
  return socket;
}

function waitFor<T = unknown>(socket: ClientSocket, event: string): Promise<T> {
  return new Promise((resolve) => socket.once(event, resolve));
}

describe('umpire connections', () => {
  it('rejects and disconnects a socket missing matchId/token', async () => {
    const socket = connect({ role: 'umpire' });
    const error = await waitFor<{ message: string }>(socket, SERVER_EVENTS.ERROR);
    expect(error.message).toMatch(/Missing matchId or token/);
  });

  it('rejects an invalid umpire token', async () => {
    const match = mockPrisma.seedMatch({ umpireToken: 'the-real-token' });
    const socket = connect({ role: 'umpire', matchId: match.id, token: 'wrong-token' });
    const error = await waitFor<{ message: string }>(socket, SERVER_EVENTS.ERROR);
    expect(error.message).toMatch(/Invalid umpire token/);
  });

  it('sends the current match state once authorized', async () => {
    const match = mockPrisma.seedMatch({ umpireToken: 'good-token' });
    mockPrisma.seedPlayers(match.id, [
      { side: 'A', name: 'Alice', shortName: 'ALI' },
      { side: 'B', name: 'Bilal', shortName: 'BIL' },
    ]);
    const socket = connect({ role: 'umpire', matchId: match.id, token: 'good-token' });
    const state = await waitFor<{ match: { matchId: string } }>(socket, SERVER_EVENTS.MATCH_STATE);
    expect(state.match.matchId).toBe(match.id);
  });
});

describe('scoring over the socket', () => {
  it('applies ADD_POINT and broadcasts the updated state to the room', async () => {
    const match = mockPrisma.seedMatch({ umpireToken: 'tok' });
    const umpire = connect({ role: 'umpire', matchId: match.id, token: 'tok' });
    await waitFor(umpire, SERVER_EVENTS.MATCH_STATE); // initial state on join

    const updatePromise = waitFor<{ derived: { currentSet: { scoreA: number } } }>(
      umpire,
      SERVER_EVENTS.MATCH_STATE,
    );
    umpire.emit(UMPIRE_EVENTS.ADD_POINT, { matchId: match.id, eventId: 'ev-1', side: 'A' });
    const updated = await updatePromise;

    expect(updated.derived.currentSet.scoreA).toBe(1);
    expect(mockPrisma.prisma.scoreEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ type: 'POINT', side: 'A' }) }),
    );
  });

  it('applies UNDO_LAST_POINT and broadcasts the reverted state', async () => {
    const match = mockPrisma.seedMatch({ umpireToken: 'tok2' });
    mockPrisma.seedEvent(match.id, { type: 'POINT', side: 'B', timestamp: BigInt(1) });
    const umpire = connect({ role: 'umpire', matchId: match.id, token: 'tok2' });
    await waitFor(umpire, SERVER_EVENTS.MATCH_STATE);

    const updatePromise = waitFor<{ derived: { currentSet: { scoreB: number } } }>(
      umpire,
      SERVER_EVENTS.MATCH_STATE,
    );
    umpire.emit(UMPIRE_EVENTS.UNDO_LAST_POINT, { matchId: match.id, eventId: 'ev-undo' });
    const updated = await updatePromise;

    expect(updated.derived.currentSet.scoreB).toBe(0);
  });

  it('rejects a scoring attempt from a socket that never authorized for that match', async () => {
    const match = mockPrisma.seedMatch({ umpireToken: 'tok3' });
    const impostor = connect({}); // no role/matchId/token at all
    const errorPromise = waitFor<{ message: string }>(impostor, SERVER_EVENTS.ERROR);
    impostor.emit(UMPIRE_EVENTS.ADD_POINT, { matchId: match.id, eventId: 'ev-x', side: 'A' });
    const error = await errorPromise;
    expect(error.message).toMatch(/Not authorized/);
  });

  it('rejects scoring a different match than the one a socket authorized for', async () => {
    const matchA = mockPrisma.seedMatch({ umpireToken: 'tokA' });
    const matchB = mockPrisma.seedMatch({ umpireToken: 'tokB' });
    const umpire = connect({ role: 'umpire', matchId: matchA.id, token: 'tokA' });
    await waitFor(umpire, SERVER_EVENTS.MATCH_STATE);

    const errorPromise = waitFor<{ message: string }>(umpire, SERVER_EVENTS.ERROR);
    umpire.emit(UMPIRE_EVENTS.ADD_POINT, { matchId: matchB.id, eventId: 'ev-y', side: 'A' });
    const error = await errorPromise;
    expect(error.message).toMatch(/Not authorized/);
  });
});

describe('TV / court subscriptions', () => {
  it('reports MATCH_NOT_FOUND for a court with nothing assigned', async () => {
    const court = mockPrisma.seedCourt({ currentMatchId: null });
    const socket = connect({ role: 'tv', courtId: court.id });
    const notFound = await waitFor<{ courtId: string }>(socket, SERVER_EVENTS.MATCH_NOT_FOUND);
    expect(notFound.courtId).toBe(court.id);
  });

  it('follows a court to its currently assigned match, via the connection query', async () => {
    const match = mockPrisma.seedMatch();
    const court = mockPrisma.seedCourt({ currentMatchId: match.id });
    const socket = connect({ role: 'tv', courtId: court.id });
    const state = await waitFor<{ match: { matchId: string } }>(socket, SERVER_EVENTS.MATCH_STATE);
    expect(state.match.matchId).toBe(match.id);
  });

  it('also supports subscribing to a court explicitly via SUBSCRIBE_COURT', async () => {
    const match = mockPrisma.seedMatch();
    const court = mockPrisma.seedCourt({ currentMatchId: match.id });
    const socket = connect({}); // connects with no role at all
    const statePromise = waitFor<{ match: { matchId: string } }>(socket, SERVER_EVENTS.MATCH_STATE);
    socket.emit(TV_EVENTS.SUBSCRIBE_COURT, { courtId: court.id });
    const state = await statePromise;
    expect(state.match.matchId).toBe(match.id);
  });

  it('reports MATCH_NOT_FOUND when a court points at a match that no longer exists', async () => {
    // A court can be assigned to a matchId whose row has since been removed
    // (or was never created) — joinCourt still finds the court, but the
    // replay engine finds nothing to load, exercising sendCurrentState's
    // "no state" branch rather than joinCourt's "no court" branch above.
    const court = mockPrisma.seedCourt({ currentMatchId: 'match-does-not-exist' });
    const socket = connect({ role: 'tv', courtId: court.id });
    const notFound = await waitFor<{ matchId: string }>(socket, SERVER_EVENTS.MATCH_NOT_FOUND);
    expect(notFound.matchId).toBe('match-does-not-exist');
  });
});
