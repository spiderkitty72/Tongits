import { randomInt, randomUUID } from 'node:crypto';
import {
  Action,
  DEFAULT_RULES,
  GameError,
  GameState,
  PlayerView,
  RuleSet,
  SEATS,
  applyAction,
  autoAction,
  newRound,
  normalizeRules,
  playerView,
} from '@tongits/engine';
import { recordRound } from './profiles.js';

export interface Member {
  userId: number;
  displayName: string;
  avatar: string;
}

interface Seat extends Member {
  ready: boolean;
}

export type RoomStatus = 'lobby' | 'playing' | 'roundOver' | 'finished';

export interface RoomView {
  code: string;
  hostId: number;
  mySeat: number;
  seats: ({ userId: number; displayName: string; avatar: string; ready: boolean; connected: boolean; total: number } | null)[];
  spectators: number;
  rules: RuleSet;
  status: RoomStatus;
  roundNo: number;
  game: PlayerView | null;
  /** Epoch ms when the current turn timer runs out, or null. */
  turnDeadline: number | null;
}

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const IDLE_ROOM_MS = 30 * 60 * 1000;
const secureRng = () => randomInt(2 ** 32) / 2 ** 32;

export class Room {
  seats: (Seat | null)[] = [null, null, null];
  spectators = new Set<number>();
  rules: RuleSet = structuredClone(DEFAULT_RULES);
  status: RoomStatus = 'lobby';
  game: GameState | null = null;
  roundNo = 0;
  dealer = 0;
  matchId = '';
  totals = [0, 0, 0];
  roundStartedAt = new Date();
  turnDeadline: number | null = null;
  timer: NodeJS.Timeout | null = null;
  lastActive = Date.now();

  constructor(public code: string, public hostId: number) {}

  seatOf(userId: number): number {
    return this.seats.findIndex((s) => s?.userId === userId);
  }
}

export class RoomManager {
  rooms = new Map<string, Room>();
  /** Which room each user is in. A user is in at most one room. */
  userRoom = new Map<number, string>();

  constructor(
    private isConnected: (userId: number) => boolean,
    private push: (userId: number, room: Room | null) => void,
  ) {
    setInterval(() => this.sweep(), 60 * 1000).unref();
  }

  roomOf(userId: number): Room | null {
    const code = this.userRoom.get(userId);
    return code ? (this.rooms.get(code) ?? null) : null;
  }

  create(m: Member): Room {
    this.leave(m.userId);
    let code = '';
    do {
      code = Array.from({ length: 4 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join('');
    } while (this.rooms.has(code));
    const room = new Room(code, m.userId);
    room.seats[0] = { ...m, ready: false };
    this.rooms.set(code, room);
    this.userRoom.set(m.userId, code);
    this.broadcast(room);
    return room;
  }

  join(m: Member, rawCode: string): Room {
    const code = String(rawCode ?? '').toUpperCase().trim();
    const room = this.rooms.get(code);
    if (!room) throw new GameError(`No room with code ${code || '(blank)'}.`);
    const current = this.roomOf(m.userId);
    if (current && current !== room) this.leave(m.userId);
    if (room.seatOf(m.userId) >= 0 || room.spectators.has(m.userId)) {
      this.broadcast(room);
      return room;
    }
    const free = room.seats.findIndex((s) => s === null);
    if (room.status === 'lobby' && free >= 0) room.seats[free] = { ...m, ready: false };
    else room.spectators.add(m.userId);
    this.userRoom.set(m.userId, code);
    this.broadcast(room);
    return room;
  }

  leave(userId: number): void {
    const room = this.roomOf(userId);
    if (!room) return;
    const seat = room.seatOf(userId);
    if (seat >= 0 && (room.status === 'playing' || room.status === 'roundOver')) {
      throw new GameError('You are in a match. Finish it first; the turn timer plays for you while you are away.');
    }
    this.userRoom.delete(userId);
    room.spectators.delete(userId);
    if (seat >= 0) {
      room.seats[seat] = null;
      if (room.hostId === userId) {
        const nextHost = room.seats.find((s) => s !== null);
        if (nextHost) room.hostId = nextHost.userId;
      }
    }
    this.push(userId, null);
    if (room.seats.every((s) => s === null)) {
      this.close(room);
      return;
    }
    this.broadcast(room);
  }

  setRules(userId: number, rules: unknown): void {
    const room = this.mustRoom(userId);
    if (room.hostId !== userId) throw new GameError('Only the host can change the rules.');
    if (room.status !== 'lobby' && room.status !== 'finished') throw new GameError('Rules are locked once the game starts.');
    room.rules = normalizeRules(rules);
    for (const s of room.seats) if (s) s.ready = false;
    this.broadcast(room);
  }

  setReady(userId: number, ready: boolean): void {
    const room = this.mustRoom(userId);
    const seat = room.seatOf(userId);
    if (seat < 0 || room.status !== 'lobby') return;
    room.seats[seat]!.ready = !!ready;
    this.broadcast(room);
  }

  start(userId: number): void {
    const room = this.mustRoom(userId);
    if (room.hostId !== userId) throw new GameError('Only the host can start.');
    if (room.status !== 'lobby') throw new GameError('The game has already started.');
    if (room.seats.some((s) => s === null)) throw new GameError('Tong-its needs three players.');
    if (room.seats.some((s) => !s!.ready)) throw new GameError('Everyone must be ready.');
    room.matchId = randomUUID();
    room.totals = [0, 0, 0];
    room.roundNo = 0;
    room.dealer = randomInt(SEATS);
    this.startRound(room);
  }

  nextRound(userId: number): void {
    const room = this.mustRoom(userId);
    if (room.seatOf(userId) < 0) throw new GameError('Only players can deal the next round.');
    if (room.status !== 'roundOver') throw new GameError('The round is not over.');
    this.startRound(room);
  }

  /** After a finished match, return to the lobby with the same players. */
  playAgain(userId: number): void {
    const room = this.mustRoom(userId);
    if (room.hostId !== userId) throw new GameError('Only the host can set up a new match.');
    if (room.status !== 'finished') throw new GameError('The match is still going.');
    room.status = 'lobby';
    room.game = null;
    room.roundNo = 0;
    room.totals = [0, 0, 0];
    for (const s of room.seats) if (s) s.ready = false;
    this.broadcast(room);
  }

  act(userId: number, action: Action): void {
    const room = this.mustRoom(userId);
    const seat = room.seatOf(userId);
    if (seat < 0) throw new GameError('Spectators cannot play.');
    if (room.status !== 'playing' || !room.game) throw new GameError('No round is being played.');
    this.apply(room, seat, action);
  }

  /** Re-sends the room to a user, e.g. after they reconnect. */
  refresh(userId: number): void {
    const room = this.roomOf(userId);
    this.push(userId, room);
    if (room) this.broadcast(room);
  }

  view(room: Room, userId: number): RoomView {
    const mySeat = room.seatOf(userId);
    return {
      code: room.code,
      hostId: room.hostId,
      mySeat,
      seats: room.seats.map((s, i) =>
        s
          ? {
              userId: s.userId,
              displayName: s.displayName,
              avatar: s.avatar,
              ready: s.ready,
              connected: this.isConnected(s.userId),
              total: room.totals[i],
            }
          : null,
      ),
      spectators: room.spectators.size,
      rules: room.rules,
      status: room.status,
      roundNo: room.roundNo,
      game: room.game ? playerView(room.game, mySeat) : null,
      turnDeadline: room.turnDeadline,
    };
  }

  private mustRoom(userId: number): Room {
    const room = this.roomOf(userId);
    if (!room) throw new GameError('You are not in a room.');
    room.lastActive = Date.now();
    return room;
  }

  private startRound(room: Room): void {
    room.roundNo += 1;
    room.game = newRound(room.rules, room.dealer, secureRng);
    room.roundStartedAt = new Date();
    room.status = 'playing';
    this.afterChange(room);
  }

  private apply(room: Room, seat: number, action: Action): void {
    room.game = applyAction(room.game!, seat, action);
    this.afterChange(room);
  }

  private afterChange(room: Room): void {
    const g = room.game!;
    if (g.phase === 'ended' && room.status === 'playing') this.finishRound(room);
    this.armTimer(room);
    this.broadcast(room);
  }

  private finishRound(room: Room): void {
    const g = room.game!;
    const result = g.result!;
    for (let i = 0; i < SEATS; i++) room.totals[i] += result.payouts[i];
    const r = room.rules;
    const over =
      r.gameLength === 'single' ||
      (r.gameLength === 'rounds' && room.roundNo >= r.rounds) ||
      (r.gameLength === 'chipTarget' && room.totals.some((t) => t >= r.chipTarget));
    room.status = over ? 'finished' : 'roundOver';
    room.dealer = r.nextDealer === 'winner' && result.winner !== null ? result.winner : (room.dealer + 1) % SEATS;
    recordRound({
      matchId: room.matchId,
      roomCode: room.code,
      roundNo: room.roundNo,
      startedAt: room.roundStartedAt,
      rules: room.rules,
      seats: room.seats.map((s) => ({ userId: s!.userId, displayName: s!.displayName })),
      result,
    }).catch((err) => console.error('Could not save round', err));
  }

  private armTimer(room: Room): void {
    if (room.timer) clearTimeout(room.timer);
    room.timer = null;
    room.turnDeadline = null;
    const g = room.game;
    if (!g || room.status !== 'playing' || g.phase === 'ended' || room.rules.turnSeconds === 0) return;
    const ms = room.rules.turnSeconds * 1000;
    room.turnDeadline = Date.now() + ms;
    room.timer = setTimeout(() => this.timeout(room), ms);
  }

  /** The turn timer ran out: play the safe move for whoever is holding up the game. */
  private timeout(room: Room): void {
    room.timer = null;
    if (room.status !== 'playing' || !room.game) return;
    try {
      const g = room.game;
      const waiting = g.phase === 'drawCall' && g.drawCall ? Object.entries(g.drawCall.responses).filter(([, r]) => r === null).map(([k]) => Number(k)) : [g.turn];
      let state = g;
      for (const seat of waiting) {
        // In the play phase this may take two steps: draw, then discard.
        for (let i = 0; i < 2 && state.phase !== 'ended'; i++) {
          const a = autoAction(state, seat);
          if (!a) break;
          state = applyAction(state, seat, a);
          if (a.type === 'discard' || a.type === 'respondDraw') break;
        }
      }
      room.game = state;
      this.afterChange(room);
    } catch (err) {
      console.error('Auto-play failed', err);
    }
  }

  private broadcast(room: Room): void {
    for (const s of room.seats) if (s) this.push(s.userId, room);
    for (const u of room.spectators) this.push(u, room);
  }

  private close(room: Room): void {
    if (room.timer) clearTimeout(room.timer);
    this.rooms.delete(room.code);
    for (const s of room.seats) if (s) this.userRoom.delete(s.userId);
    for (const u of room.spectators) this.userRoom.delete(u);
  }

  private sweep(): void {
    const now = Date.now();
    for (const room of this.rooms.values()) {
      const anyone = [...room.seats.filter(Boolean).map((s) => s!.userId), ...room.spectators].some(this.isConnected);
      if (anyone) room.lastActive = now;
      else if (now - room.lastActive > IDLE_ROOM_MS) this.close(room);
    }
  }
}
