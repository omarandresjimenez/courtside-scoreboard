import { createServer, type Server as HttpServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { Server as SocketIoServer } from 'socket.io';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { SERVER_EVENTS, STREAM_EVENTS, TV_EVENTS, UMPIRE_EVENTS } from '@courtside/shared';
import { Prisma } from '../../generated/prisma/index.js';
import { createFakePrisma } from '../testUtils/fakePrisma.js';

const mockPrisma = createFakePrisma();
jest.mock('../db/client.js', () => ({ prisma: mockPrisma.prisma }));

// After the mock, so registerSocketHandlers (and the replay engine it
// calls) resolve '../db/client.js' to the fake above.
import { createScoreEventIdempotent, registerSocketHandlers, roomForCourt } from './index.js';
import { registerStreamSocketHandlers } from './stream.js';

let httpServer: HttpServer;
let io: SocketIoServer;
let port: number;
const openSockets: ClientSocket[] = [];

beforeAll(async () => {
  httpServer = createServer();
  io = new SocketIoServer(httpServer);
  registerSocketHandlers(io);
  registerStreamSocketHandlers(io);
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
      { side: 'A', name: 'Alice', lastName: 'Adams', shortName: 'ALI' },
      { side: 'B', name: 'Bilal', lastName: 'Bruno', shortName: 'BIL' },
    ]);
    const socket = connect({ role: 'umpire', matchId: match.id, token: 'good-token' });
    const state = await waitFor<{ match: { matchId: string } }>(socket, SERVER_EVENTS.MATCH_STATE);
    expect(state.match.matchId).toBe(match.id);
  });
});

describe('createScoreEventIdempotent', () => {
  it('rethrows errors that are not a duplicate eventId', async () => {
    const dbError = new Prisma.PrismaClientKnownRequestError('Foreign key constraint failed', {
      code: 'P2003',
      clientVersion: 'test',
    });
    mockPrisma.prisma.scoreEvent.create.mockRejectedValueOnce(dbError);

    await expect(
      createScoreEventIdempotent({
        matchId: 'm1',
        eventId: 'ev-1',
        type: 'POINT',
        side: 'A',
        timestamp: BigInt(1),
      }),
    ).rejects.toBe(dbError);
  });
});

type StatePayload = { derived: { matchWinner: string | null; finalised: boolean } };

describe('scoring over the socket', () => {
  it('applies ADD_POINT and broadcasts the updated state to the room', async () => {
    const match = mockPrisma.seedMatch({ umpireToken: 'tok' });
    mockPrisma.seedEvent(match.id, {
      type: 'START_SET',
      payload: JSON.stringify({ firstServerSide: 'A' }),
    });
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

  it('treats a replayed (duplicate) eventId as a safe no-op instead of crashing', async () => {
    // The doc comment on ScoreEvent.eventId promises exactly this: an
    // offline-queued umpire action retried after reconnecting must be safe
    // to replay, not take the whole server down.
    const match = mockPrisma.seedMatch({ umpireToken: 'tok-dup' });
    mockPrisma.seedEvent(match.id, {
      type: 'START_SET',
      payload: JSON.stringify({ firstServerSide: 'A' }),
    });
    const umpire = connect({ role: 'umpire', matchId: match.id, token: 'tok-dup' });
    await waitFor(umpire, SERVER_EVENTS.MATCH_STATE);

    const firstUpdate = waitFor<{ derived: { currentSet: { scoreA: number } } }>(
      umpire,
      SERVER_EVENTS.MATCH_STATE,
    );
    umpire.emit(UMPIRE_EVENTS.ADD_POINT, { matchId: match.id, eventId: 'dup-ev', side: 'A' });
    expect((await firstUpdate).derived.currentSet.scoreA).toBe(1);

    const secondUpdate = waitFor<{ derived: { currentSet: { scoreA: number } } }>(
      umpire,
      SERVER_EVENTS.MATCH_STATE,
    );
    umpire.emit(UMPIRE_EVENTS.ADD_POINT, { matchId: match.id, eventId: 'dup-ev', side: 'A' });
    expect((await secondUpdate).derived.currentSet.scoreA).toBe(1);
  });

  it('records and broadcasts the umpire-selected opening server', async () => {
    const match = mockPrisma.seedMatch({ umpireToken: 'tok-start', matchType: 'doubles' });
    mockPrisma.seedPlayers(match.id, [
      { side: 'A', name: 'Alice', lastName: 'Adams', shortName: 'ALI' },
      { side: 'A', name: 'Ava', lastName: 'Ava', shortName: 'AVA' },
      { side: 'B', name: 'Bilal', lastName: 'Bruno', shortName: 'BIL' },
      { side: 'B', name: 'Bea', lastName: 'Blue', shortName: 'BEA' },
    ]);
    const umpire = connect({ role: 'umpire', matchId: match.id, token: 'tok-start' });
    const initial = await waitFor<{
      match: { players: Array<{ playerId: string; side: string }> };
    }>(umpire, SERVER_EVENTS.MATCH_STATE);
    const aPlayers = initial.match.players.filter((player) => player.side === 'A');
    const bPlayers = initial.match.players.filter((player) => player.side === 'B');
    const update = waitFor<{ derived: { serve: { servingSide: string; serverPlayerId: string } } }>(
      umpire,
      SERVER_EVENTS.MATCH_STATE,
    );

    umpire.emit(UMPIRE_EVENTS.START_SET, {
      matchId: match.id,
      eventId: 'ev-start',
      firstServerSide: 'A',
      firstServerPlayerId: aPlayers[0]!.playerId,
      courtPositions: {
        A: { right: aPlayers[0]!.playerId, left: aPlayers[1]!.playerId },
        B: { right: bPlayers[0]!.playerId, left: bPlayers[1]!.playerId },
      },
    });

    const state = await update;
    expect(state.derived.serve).toMatchObject({
      servingSide: 'A',
      serverPlayerId: aPlayers[0]!.playerId,
    });
    expect(mockPrisma.prisma.match.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'IN_PROGRESS' }) }),
    );
  });

  it('rejects ADD_POINT before the opening server has been set', async () => {
    const match = mockPrisma.seedMatch({ umpireToken: 'tok-noserve' });
    const umpire = connect({ role: 'umpire', matchId: match.id, token: 'tok-noserve' });
    await waitFor(umpire, SERVER_EVENTS.MATCH_STATE);

    const errorPromise = waitFor<{ message: string }>(umpire, SERVER_EVENTS.ERROR);
    umpire.emit(UMPIRE_EVENTS.ADD_POINT, { matchId: match.id, eventId: 'ev-early', side: 'A' });
    const error = await errorPromise;

    expect(error.message).toMatch(/opening server/i);
  });

  it('rejects START_SET once service has already been set for the match', async () => {
    const match = mockPrisma.seedMatch({ umpireToken: 'tok-already' });
    mockPrisma.seedEvent(match.id, {
      type: 'START_SET',
      payload: JSON.stringify({ firstServerSide: 'A' }),
    });
    const umpire = connect({ role: 'umpire', matchId: match.id, token: 'tok-already' });
    await waitFor(umpire, SERVER_EVENTS.MATCH_STATE);

    const errorPromise = waitFor<{ message: string }>(umpire, SERVER_EVENTS.ERROR);
    umpire.emit(UMPIRE_EVENTS.START_SET, {
      matchId: match.id,
      eventId: 'ev-restart',
      firstServerSide: 'B',
      firstServerPlayerId: 'whoever',
    });
    const error = await errorPromise;

    expect(error.message).toMatch(/already been set/i);
  });

  it('rejects START_SET when the chosen player is not on the declared serving side', async () => {
    const match = mockPrisma.seedMatch({ umpireToken: 'tok-badserver' });
    mockPrisma.seedPlayers(match.id, [
      { side: 'A', name: 'Alice', lastName: 'Adams', shortName: 'ALI' },
      { side: 'B', name: 'Bilal', lastName: 'Bruno', shortName: 'BIL' },
    ]);
    const umpire = connect({ role: 'umpire', matchId: match.id, token: 'tok-badserver' });
    const state = await waitFor<{ match: { players: Array<{ playerId: string; side: string }> } }>(
      umpire,
      SERVER_EVENTS.MATCH_STATE,
    );
    const bilal = state.match.players.find((player) => player.side === 'B')!;

    const errorPromise = waitFor<{ message: string }>(umpire, SERVER_EVENTS.ERROR);
    umpire.emit(UMPIRE_EVENTS.START_SET, {
      matchId: match.id,
      eventId: 'ev-mismatch',
      firstServerSide: 'A',
      firstServerPlayerId: bilal.playerId, // Bilal is on side B, not A
    });
    const error = await errorPromise;

    expect(error.message).toMatch(/serving side/i);
  });

  it('rejects a doubles START_SET missing valid court positions', async () => {
    const match = mockPrisma.seedMatch({ umpireToken: 'tok-doubles', matchType: 'doubles' });
    mockPrisma.seedPlayers(match.id, [
      { side: 'A', name: 'Alice', lastName: 'Adams', shortName: 'ALI' },
      { side: 'A', name: 'Ava', lastName: 'Ava', shortName: 'AVA' },
      { side: 'B', name: 'Bilal', lastName: 'Bruno', shortName: 'BIL' },
      { side: 'B', name: 'Bea', lastName: 'Blue', shortName: 'BEA' },
    ]);
    const umpire = connect({ role: 'umpire', matchId: match.id, token: 'tok-doubles' });
    const state = await waitFor<{ match: { players: Array<{ playerId: string; side: string }> } }>(
      umpire,
      SERVER_EVENTS.MATCH_STATE,
    );
    const alice = state.match.players.find((player) => player.side === 'A')!;

    const errorPromise = waitFor<{ message: string }>(umpire, SERVER_EVENTS.ERROR);
    umpire.emit(UMPIRE_EVENTS.START_SET, {
      matchId: match.id,
      eventId: 'ev-doubles-bad',
      firstServerSide: 'A',
      firstServerPlayerId: alice.playerId,
      // courtPositions omitted entirely — doubles requires both sides set.
    });
    const error = await errorPromise;

    expect(error.message).toMatch(/court positions/i);
  });

  it('no-ops START_SET if the match vanished between authorizing and the action running', async () => {
    const match = mockPrisma.seedMatch({ umpireToken: 'tok-vanish-start' });
    mockPrisma.seedPlayers(match.id, [
      { side: 'A', name: 'Alice', lastName: 'Adams', shortName: 'ALI' },
      { side: 'B', name: 'Bilal', lastName: 'Bruno', shortName: 'BIL' },
    ]);
    const umpire = connect({ role: 'umpire', matchId: match.id, token: 'tok-vanish-start' });
    const initial = await waitFor<{
      match: { players: Array<{ playerId: string; side: string }> };
    }>(umpire, SERVER_EVENTS.MATCH_STATE);
    const alice = initial.match.players.find((player) => player.side === 'A')!;

    await mockPrisma.prisma.match.delete({ where: { id: match.id } });
    mockPrisma.prisma.scoreEvent.create.mockClear();

    umpire.emit(UMPIRE_EVENTS.START_SET, {
      matchId: match.id,
      eventId: 'ev-vanish-start',
      firstServerSide: 'A',
      firstServerPlayerId: alice.playerId,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockPrisma.prisma.scoreEvent.create).not.toHaveBeenCalled();
  });

  it('no-ops the post-action state refresh if the match vanished during the write', async () => {
    const match = mockPrisma.seedMatch({ umpireToken: 'tok-vanish-refresh' });
    const umpire = connect({ role: 'umpire', matchId: match.id, token: 'tok-vanish-refresh' });
    await waitFor(umpire, SERVER_EVENTS.MATCH_STATE);

    await mockPrisma.prisma.match.delete({ where: { id: match.id } });

    const errorPromise = waitFor<{ message: string }>(umpire, SERVER_EVENTS.ERROR);
    umpire.emit(UMPIRE_EVENTS.ADD_POINT, {
      matchId: match.id,
      eventId: 'ev-vanish-add',
      side: 'A',
    });

    // addPoint's own guard fires first ("no servingSide" once the match is
    // gone) — the interesting assertion is that withAuthorizedMatch's own
    // post-action loadMatchState() also comes back null and is a quiet
    // no-op rather than a crash trying to broadcast to a deleted match.
    await expect(errorPromise).resolves.toEqual(
      expect.objectContaining({ message: expect.stringMatching(/opening server/i) }),
    );
  });

  it('leaves a decided match IN_PROGRESS until the umpire finalises it', async () => {
    // The scoring engine decides the winner; the umpire decides the match is
    // over. Winning the deciding game must not close the record on its own.
    // pointsToWin:1/capScore:2 closes a game at 2-0, so this seeds three
    // points and plays the fourth — the one that wins the second game.
    const match = mockPrisma.seedMatch({ umpireToken: 'tok-fin', pointsToWin: 1, capScore: 2 });
    for (let i = 1; i <= 3; i += 1) {
      mockPrisma.seedEvent(match.id, { type: 'POINT', side: 'A', timestamp: BigInt(i) });
    }
    const umpire = connect({ role: 'umpire', matchId: match.id, token: 'tok-fin' });
    await waitFor(umpire, SERVER_EVENTS.MATCH_STATE);

    const winUpdate = waitFor<StatePayload>(umpire, SERVER_EVENTS.MATCH_STATE);
    umpire.emit(UMPIRE_EVENTS.ADD_POINT, { matchId: match.id, eventId: 'ev-win', side: 'A' });
    const decided = await winUpdate;

    expect(decided.derived.matchWinner).toBe('A');
    expect(decided.derived.finalised).toBe(false);
    expect(mockPrisma.prisma.match.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'COMPLETED' }) }),
    );

    const finalPromise = waitFor<StatePayload>(umpire, SERVER_EVENTS.MATCH_STATE);
    umpire.emit(UMPIRE_EVENTS.RETIRE_MATCH, {
      matchId: match.id,
      eventId: 'ev-final',
      winnerSide: 'A',
    });
    expect((await finalPromise).derived.finalised).toBe(true);
    expect(mockPrisma.prisma.match.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'COMPLETED' }) }),
    );
  });

  it('tells the court broadcaster to stop once the umpire finalises the match on it', async () => {
    // Optimises real-time broadcasting: a phone left filming an empty court
    // after its match ends has nothing left worth transmitting.
    const match = mockPrisma.seedMatch({
      umpireToken: 'tok-stream-fin',
      pointsToWin: 1,
      capScore: 2,
      assignedCourtId: 'court-stream-1',
    });
    for (let i = 1; i <= 3; i += 1) {
      mockPrisma.seedEvent(match.id, { type: 'POINT', side: 'A', timestamp: BigInt(i) });
    }
    const umpire = connect({ role: 'umpire', matchId: match.id, token: 'tok-stream-fin' });
    await waitFor(umpire, SERVER_EVENTS.MATCH_STATE);
    const broadcaster = connect({ role: 'stream-broadcaster', courtId: 'court-stream-1' });
    await waitFor(broadcaster, 'connect');

    umpire.emit(UMPIRE_EVENTS.ADD_POINT, {
      matchId: match.id,
      eventId: 'ev-win-stream',
      side: 'A',
    });
    await waitFor(umpire, SERVER_EVENTS.MATCH_STATE);

    const finalizedNotice = waitFor(broadcaster, STREAM_EVENTS.MATCH_FINALIZED);
    umpire.emit(UMPIRE_EVENTS.RETIRE_MATCH, {
      matchId: match.id,
      eventId: 'ev-final-stream',
      winnerSide: 'A',
    });

    await expect(finalizedNotice).resolves.toBeUndefined();
  });

  it('tells a standby court phone to start itself once the umpire starts the match on it', async () => {
    // Mirrors the finalise-side notification: lets a phone that already has
    // camera permission begin transmitting the instant play starts, with no
    // tap needed.
    const match = mockPrisma.seedMatch({
      umpireToken: 'tok-stream-start',
      assignedCourtId: 'court-stream-2',
    });
    mockPrisma.seedPlayers(match.id, [
      { side: 'A', name: 'Alice', lastName: 'Adams', shortName: 'ALI' },
      { side: 'B', name: 'Bilal', lastName: 'Bruno', shortName: 'BIL' },
    ]);
    const umpire = connect({ role: 'umpire', matchId: match.id, token: 'tok-stream-start' });
    const initial = await waitFor<{
      match: { players: Array<{ playerId: string; side: string }> };
    }>(umpire, SERVER_EVENTS.MATCH_STATE);
    const alice = initial.match.players.find((player) => player.side === 'A')!;
    const standby = connect({ role: 'stream-standby', courtId: 'court-stream-2' });
    await waitFor(standby, 'connect');

    const startedNotice = waitFor(standby, STREAM_EVENTS.MATCH_STARTED);
    umpire.emit(UMPIRE_EVENTS.START_SET, {
      matchId: match.id,
      eventId: 'ev-start-stream',
      firstServerSide: 'A',
      firstServerPlayerId: alice.playerId,
    });

    await expect(startedNotice).resolves.toBeUndefined();
  });

  it('reopens a match recorded COMPLETED that no longer has a finalising event', async () => {
    // Reconciliation for drifted data (an admin closing a match by hand, an
    // interrupted write): the event log is the authority, not the row.
    const match = mockPrisma.seedMatch({ umpireToken: 'tok-reopen', status: 'COMPLETED' });
    const umpire = connect({ role: 'umpire', matchId: match.id, token: 'tok-reopen' });
    await waitFor(umpire, SERVER_EVENTS.MATCH_STATE);

    const updatePromise = waitFor(umpire, SERVER_EVENTS.MATCH_STATE);
    umpire.emit(UMPIRE_EVENTS.ADD_POINT, { matchId: match.id, eventId: 'p-reopen', side: 'A' });
    await updatePromise;

    expect(mockPrisma.prisma.match.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'IN_PROGRESS' }) }),
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

  it('applies RESUME_FROM_INTERVAL and broadcasts the cleared interval flag', async () => {
    const match = mockPrisma.seedMatch({ umpireToken: 'tok4' });
    for (let i = 0; i < 11; i += 1) {
      mockPrisma.seedEvent(match.id, { type: 'POINT', side: 'A', timestamp: BigInt(i + 1) });
    }
    const umpire = connect({ role: 'umpire', matchId: match.id, token: 'tok4' });
    const initial = await waitFor<{ derived: { onInterval: boolean } }>(
      umpire,
      SERVER_EVENTS.MATCH_STATE,
    );
    expect(initial.derived.onInterval).toBe(true);

    const updatePromise = waitFor<{ derived: { onInterval: boolean } }>(
      umpire,
      SERVER_EVENTS.MATCH_STATE,
    );
    umpire.emit(UMPIRE_EVENTS.RESUME_FROM_INTERVAL, { matchId: match.id, eventId: 'ev-resume' });
    const updated = await updatePromise;

    expect(updated.derived.onInterval).toBe(false);
    expect(mockPrisma.prisma.scoreEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ type: 'RESUME_INTERVAL' }) }),
    );
  });

  it('applies RETIRE_MATCH and broadcasts the awarded winner', async () => {
    // A retirement ends the match at whatever score it had reached, which is
    // why the winner travels in the payload instead of being derived.
    const match = mockPrisma.seedMatch({ umpireToken: 'tok-retire' });
    mockPrisma.seedEvent(match.id, { type: 'POINT', side: 'A', timestamp: BigInt(1) });
    const umpire = connect({ role: 'umpire', matchId: match.id, token: 'tok-retire' });
    const initial = await waitFor<{ derived: { matchWinner: string | null } }>(
      umpire,
      SERVER_EVENTS.MATCH_STATE,
    );
    expect(initial.derived.matchWinner).toBeNull();

    const updatePromise = waitFor<{ derived: { matchWinner: string | null } }>(
      umpire,
      SERVER_EVENTS.MATCH_STATE,
    );
    umpire.emit(UMPIRE_EVENTS.RETIRE_MATCH, {
      matchId: match.id,
      eventId: 'ev-retire',
      winnerSide: 'B',
    });
    const updated = await updatePromise;

    expect(updated.derived.matchWinner).toBe('B');
    expect(mockPrisma.prisma.scoreEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: 'RETIRE', side: 'B' }),
      }),
    );
  });

  it('records a walkover reason on the RETIRE event when the umpire picks one', async () => {
    const match = mockPrisma.seedMatch({ umpireToken: 'tok-wo' });
    mockPrisma.seedEvent(match.id, { type: 'POINT', side: 'A', timestamp: BigInt(1) });
    const umpire = connect({ role: 'umpire', matchId: match.id, token: 'tok-wo' });
    await waitFor(umpire, SERVER_EVENTS.MATCH_STATE);

    const updatePromise = waitFor<{ derived: { retireReason: string | null } }>(
      umpire,
      SERVER_EVENTS.MATCH_STATE,
    );
    umpire.emit(UMPIRE_EVENTS.RETIRE_MATCH, {
      matchId: match.id,
      eventId: 'ev-wo',
      winnerSide: 'B',
      reason: 'WALKOVER',
    });
    const updated = await updatePromise;

    expect(updated.derived.retireReason).toBe('WALKOVER');
    expect(mockPrisma.prisma.scoreEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: 'RETIRE',
          side: 'B',
          payload: JSON.stringify({ reason: 'WALKOVER' }),
        }),
      }),
    );
  });

  it('refuses to retire a match for a socket that never authorized', async () => {
    const match = mockPrisma.seedMatch({ umpireToken: 'tok-retire2' });
    const impostor = connect({});
    const errorPromise = waitFor<{ message: string }>(impostor, SERVER_EVENTS.ERROR);
    impostor.emit(UMPIRE_EVENTS.RETIRE_MATCH, {
      matchId: match.id,
      eventId: 'ev-x',
      winnerSide: 'A',
    });
    const error = await errorPromise;
    expect(error.message).toMatch(/Not authorized/);
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
    expect(io.sockets.adapter.rooms.get(roomForCourt(court.id))?.size).toBe(1);
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

  it('keeps live-updating a TV that connected before any match existed for its court', async () => {
    // Regression: a TV opened while a court had nothing assigned used to
    // join no room at all (see joinCourt), so it never heard about a match
    // created and played afterwards — not the start, not a single point,
    // not how it ended — until the page was manually reloaded.
    const court = mockPrisma.seedCourt({ currentMatchId: null });
    const tv = connect({ role: 'tv', courtId: court.id });
    await waitFor(tv, SERVER_EVENTS.MATCH_NOT_FOUND);

    const match = mockPrisma.seedMatch({ umpireToken: 'tok-late', assignedCourtId: court.id });
    mockPrisma.seedPlayers(match.id, [
      { side: 'A', name: 'Alice', lastName: 'Adams', shortName: 'ALI' },
      { side: 'B', name: 'Bilal', lastName: 'Bruno', shortName: 'BIL' },
    ]);
    // Simulates POST /matches assigning the new match to the court.
    mockPrisma.seedCourt({ id: court.id, currentMatchId: match.id });

    const nextState = waitFor<{
      match: { matchId: string };
      derived: { matchWinner: string | null; retireReason: string | null };
    }>(tv, SERVER_EVENTS.MATCH_STATE);
    const umpire = connect({ role: 'umpire', matchId: match.id, token: 'tok-late' });
    await waitFor(umpire, SERVER_EVENTS.MATCH_STATE); // umpire's own initial state
    umpire.emit(UMPIRE_EVENTS.RETIRE_MATCH, {
      matchId: match.id,
      eventId: 'ev-late',
      winnerSide: 'B',
      reason: 'WALKOVER',
    });

    const state = await nextState;
    expect(state.match.matchId).toBe(match.id);
    expect(state.derived.matchWinner).toBe('B');
    expect(state.derived.retireReason).toBe('WALKOVER');
  });

  it('delivers exactly one MATCH_STATE per update to a TV joined to both the match and court rooms', async () => {
    // Regression: broadcasting to the match room and the court room as two
    // separate .emit() calls would double-deliver to any TV in both — the
    // ordinary case once a court's match has actually started.
    const match = mockPrisma.seedMatch({ umpireToken: 'tok-once', assignedCourtId: 'court-once' });
    mockPrisma.seedCourt({ id: 'court-once', currentMatchId: match.id });
    const tv = connect({ role: 'tv', courtId: 'court-once' });
    await waitFor(tv, SERVER_EVENTS.MATCH_STATE); // initial state on connect

    const received: unknown[] = [];
    tv.on(SERVER_EVENTS.MATCH_STATE, (payload) => received.push(payload));

    const umpire = connect({ role: 'umpire', matchId: match.id, token: 'tok-once' });
    await waitFor(umpire, SERVER_EVENTS.MATCH_STATE);
    const tvUpdate = waitFor(tv, SERVER_EVENTS.MATCH_STATE);
    umpire.emit(UMPIRE_EVENTS.ADD_POINT, { matchId: match.id, eventId: 'ev-once', side: 'A' });
    await tvUpdate;

    expect(received).toHaveLength(1);
  });
});
