import { CardId, cardPoints, cardRank, fullDeck, shuffle } from './cards.js';
import { MeldKind, classifyMeld, findSecretSets, orderMeld } from './melds.js';
import { RuleSet } from './rules.js';

export const SEATS = 3;

export interface Meld {
  id: string;
  owner: number;
  kind: MeldKind;
  cards: CardId[];
}

export interface PlayerState {
  hand: CardId[];
  /** Has laid down at least one meld of their own this round. */
  hasExposed: boolean;
  /** Someone sapawed onto this player's meld: no Draw call on their next turn. */
  drawBlocked: boolean;
}

export type Phase = 'draw' | 'play' | 'drawCall' | 'ended';

export interface DrawCall {
  caller: number;
  /** Seat -> answer. Seats that may not fight (burned) are absent. */
  responses: Partial<Record<number, 'fight' | 'fold' | null>>;
}

export type EndReason = 'tongits' | 'draw' | 'stockOut';

export interface RoundResult {
  endedBy: EndReason;
  /** Winning seat, or null when nobody wins (stock-out tie under the "no winner" rule). */
  winner: number | null;
  /** Unmelded card points per seat at the end. */
  points: number[];
  burned: boolean[];
  fought: boolean[];
  folded: boolean[];
  /** Net chips per seat for this round (winner positive, losers negative). */
  payouts: number[];
  /** Every hand, revealed. */
  hands: CardId[][];
}

export interface GameState {
  rules: RuleSet;
  players: PlayerState[];
  stock: CardId[];
  discard: CardId[];
  melds: Meld[];
  dealer: number;
  turn: number;
  phase: Phase;
  drawCall: DrawCall | null;
  /** Seat that took the last card from the stock. */
  lastDrawer: number | null;
  meldSeq: number;
  result: RoundResult | null;
  /** Short human-readable history of the round. */
  log: string[];
}

export type Action =
  | { type: 'drawStock' }
  | { type: 'pickDiscard'; cards: CardId[] }
  | { type: 'meld'; cards: CardId[] }
  | { type: 'sapaw'; cards: CardId[]; meldId: string }
  | { type: 'discard'; card: CardId }
  | { type: 'callDraw' }
  | { type: 'respondDraw'; fight: boolean };

export class GameError extends Error {}

const next = (seat: number) => (seat + 1) % SEATS;

export function newRound(rules: RuleSet, dealer: number, rng: () => number = Math.random): GameState {
  const deck = shuffle(fullDeck(), rng);
  const players: PlayerState[] = [];
  for (let s = 0; s < SEATS; s++) players.push({ hand: [], hasExposed: false, drawBlocked: false });
  // Dealer gets 13, others 12, dealt one at a time starting with the dealer.
  let seat = dealer;
  for (let i = 0; i < 37; i++) {
    players[seat].hand.push(deck.pop()!);
    seat = next(seat);
  }
  return {
    rules,
    players,
    stock: deck,
    discard: [],
    melds: [],
    dealer,
    turn: dealer,
    // The dealer already holds 13 cards, so they skip the draw on the first turn.
    phase: 'play',
    drawCall: null,
    lastDrawer: null,
    meldSeq: 0,
    result: null,
    log: [`Seat ${dealer + 1} deals and starts.`],
  };
}

/** Points of the cards in hand, leaving out secret four-of-a-kinds when the rule allows. */
export function handPoints(hand: CardId[], rules: RuleSet): number {
  const hidden = new Set(rules.secretSetCounts ? findSecretSets(hand).flat() : []);
  return hand.filter((c) => !hidden.has(c)).reduce((sum, c) => sum + cardPoints(c), 0);
}

/** A player who has a meld (or a counted secret set) is not burned and may fight a Draw. */
export function hasMelded(state: GameState, seat: number): boolean {
  const p = state.players[seat];
  return p.hasExposed || (state.rules.secretSetCounts && findSecretSets(p.hand).length > 0);
}

export function canCallDraw(state: GameState, seat: number): boolean {
  return (
    state.phase === 'draw' &&
    state.turn === seat &&
    state.players[seat].hasExposed &&
    !state.players[seat].drawBlocked
  );
}

function takeFromHand(p: PlayerState, cards: CardId[]): void {
  if (new Set(cards).size !== cards.length) throw new GameError('The same card was chosen twice.');
  for (const c of cards) if (!p.hand.includes(c)) throw new GameError('That card is not in your hand.');
  p.hand = p.hand.filter((c) => !cards.includes(c));
}

function addMeld(s: GameState, seat: number, cards: CardId[], kind: MeldKind): void {
  s.meldSeq += 1;
  s.melds.push({ id: `m${s.meldSeq}`, owner: seat, kind, cards: orderMeld(cards) });
  s.players[seat].hasExposed = true;
}

/** Applies one player's action and returns the new state. Throws GameError when the move is illegal. */
export function applyAction(state: GameState, seat: number, action: Action): GameState {
  if (state.phase === 'ended') throw new GameError('The round is over.');
  const s: GameState = structuredClone(state);
  const me = s.players[seat];
  if (!me) throw new GameError('No such seat.');

  if (action.type === 'respondDraw') {
    if (s.phase !== 'drawCall' || !s.drawCall) throw new GameError('Nobody has called Draw.');
    if (!(seat in s.drawCall.responses) || s.drawCall.responses[seat] !== null)
      throw new GameError('You have nothing to answer.');
    s.drawCall.responses[seat] = action.fight ? 'fight' : 'fold';
    s.log.push(`Seat ${seat + 1} ${action.fight ? 'fights' : 'folds'}.`);
    if (Object.values(s.drawCall.responses).every((r) => r !== null)) resolveDraw(s);
    return s;
  }

  if (s.turn !== seat) throw new GameError('It is not your turn.');

  switch (action.type) {
    case 'drawStock': {
      if (s.phase !== 'draw') throw new GameError('You have already drawn this turn.');
      const card = s.stock.pop();
      if (!card) throw new GameError('The stock is empty.');
      me.hand.push(card);
      s.lastDrawer = seat;
      s.phase = 'play';
      s.log.push(`Seat ${seat + 1} draws from the stock.`);
      return s;
    }
    case 'pickDiscard': {
      if (s.phase !== 'draw') throw new GameError('You have already drawn this turn.');
      const top = s.discard.at(-1);
      if (!top) throw new GameError('The discard pile is empty.');
      const kind = classifyMeld([...action.cards, top], s.rules);
      if (!kind) throw new GameError('The top discard must form a meld with the cards you chose.');
      takeFromHand(me, action.cards);
      s.discard.pop();
      addMeld(s, seat, [...action.cards, top], kind);
      s.phase = 'play';
      s.log.push(`Seat ${seat + 1} takes the discard and melds it.`);
      checkTongits(s, seat);
      return s;
    }
    case 'meld': {
      if (s.phase !== 'play') throw new GameError('Draw a card first.');
      const kind = classifyMeld(action.cards, s.rules);
      if (!kind) throw new GameError('Those cards are not a meld.');
      takeFromHand(me, action.cards);
      addMeld(s, seat, action.cards, kind);
      s.log.push(`Seat ${seat + 1} lays down a ${kind}.`);
      checkTongits(s, seat);
      return s;
    }
    case 'sapaw': {
      if (s.phase !== 'play') throw new GameError('Draw a card first.');
      const meld = s.melds.find((m) => m.id === action.meldId);
      if (!meld) throw new GameError('No such meld.');
      if (action.cards.length === 0) throw new GameError('Choose cards to add.');
      const combined = [...meld.cards, ...action.cards];
      if (classifyMeld(combined, s.rules) !== meld.kind) throw new GameError('Those cards do not fit that meld.');
      takeFromHand(me, action.cards);
      meld.cards = orderMeld(combined);
      if (meld.owner !== seat && s.rules.sapawBlocksDraw) s.players[meld.owner].drawBlocked = true;
      s.log.push(`Seat ${seat + 1} sapaws onto seat ${meld.owner + 1}'s meld.`);
      checkTongits(s, seat);
      return s;
    }
    case 'discard': {
      if (s.phase !== 'play') throw new GameError('Draw a card first.');
      takeFromHand(me, [action.card]);
      s.discard.push(action.card);
      // A sapaw block lasts through the owner's next turn only.
      me.drawBlocked = false;
      s.log.push(`Seat ${seat + 1} discards.`);
      if (checkTongits(s, seat)) return s;
      if (s.stock.length === 0) {
        endRound(s, 'stockOut', stockOutWinner(s));
        return s;
      }
      s.turn = next(seat);
      s.phase = 'draw';
      return s;
    }
    case 'callDraw': {
      if (!canCallDraw(s, seat)) {
        if (s.phase !== 'draw') throw new GameError('Draw can only be called before you take a card.');
        if (!me.hasExposed) throw new GameError('You need a meld on the table to call Draw.');
        throw new GameError('Your meld was sapawed, so you cannot call Draw this turn.');
      }
      const responses: DrawCall['responses'] = {};
      for (let o = 0; o < SEATS; o++) if (o !== seat && hasMelded(s, o)) responses[o] = null;
      s.drawCall = { caller: seat, responses };
      s.phase = 'drawCall';
      s.log.push(`Seat ${seat + 1} calls Draw.`);
      if (Object.keys(responses).length === 0) resolveDraw(s);
      return s;
    }
    default:
      throw new GameError('Unknown action.');
  }
}

function checkTongits(s: GameState, seat: number): boolean {
  if (s.players[seat].hand.length > 0) return false;
  s.log.push(`Seat ${seat + 1} calls Tong-its!`);
  endRound(s, 'tongits', seat);
  return true;
}

/** Lowest points wins; ties go to the first tied seat in turn order starting from `from`. */
function lowest(s: GameState, seats: number[], from: number): number[] {
  const pts = (x: number) => handPoints(s.players[x].hand, s.rules);
  const best = Math.min(...seats.map(pts));
  const tied = seats.filter((x) => pts(x) === best);
  const order = [from, next(from), next(next(from))];
  return order.filter((x) => tied.includes(x));
}

function resolveDraw(s: GameState): void {
  const call = s.drawCall!;
  const fighters = Object.entries(call.responses)
    .filter(([, r]) => r === 'fight')
    .map(([k]) => Number(k));
  const tied = lowest(s, [call.caller, ...fighters], call.caller);
  let winner = tied[0];
  if (tied.length > 1 && tied.includes(call.caller)) {
    winner = s.rules.drawTie === 'caller' ? call.caller : tied.find((x) => x !== call.caller)!;
  }
  endRound(s, 'draw', winner);
}

function stockOutWinner(s: GameState): number | null {
  const contenders = [0, 1, 2].filter((x) => hasMelded(s, x));
  if (contenders.length === 0) return null;
  const from = s.lastDrawer ?? s.turn;
  const tied = lowest(s, contenders, from);
  if (tied.length === 1) return tied[0];
  if (s.rules.stockOutTie === 'noWinner') return null;
  // The player who drew last loses the tie; the next tied seat after them wins.
  return tied.find((x) => x !== s.lastDrawer) ?? tied[0];
}

function endRound(s: GameState, endedBy: EndReason, winner: number | null): void {
  const seats = [0, 1, 2];
  const burned = seats.map((x) => !hasMelded(s, x));
  // The Draw caller always shows their hand, so a caller who loses counts as having fought.
  const fought = seats.map((x) => s.drawCall?.responses[x] === 'fight' || s.drawCall?.caller === x);
  const folded = seats.map((x) => s.drawCall?.responses[x] === 'fold');
  const points = seats.map((x) => handPoints(s.players[x].hand, s.rules));
  const payouts = [0, 0, 0];
  if (winner !== null) {
    const p = s.rules.payouts;
    const owned = s.melds.filter((m) => m.owner === winner);
    const held = [...owned.flatMap((m) => m.cards), ...s.players[winner].hand];
    const fours =
      owned.filter((m) => m.kind === 'set' && m.cards.length === 4).length +
      (s.rules.secretSetCounts ? findSecretSets(s.players[winner].hand).length : 0);
    const aces = held.filter((c) => cardRank(c) === 1).length;
    for (const x of seats) {
      if (x === winner) continue;
      let owe = p.base + fours * p.fourOfAKind + aces * p.ace;
      if (endedBy === 'tongits') owe += p.tongits;
      if (burned[x]) owe += p.burned;
      if (endedBy === 'draw' && fought[x]) owe += p.fightLoss;
      payouts[x] -= owe;
      payouts[winner] += owe;
    }
  }
  s.phase = 'ended';
  s.result = {
    endedBy,
    winner,
    points,
    burned,
    fought,
    folded,
    payouts,
    hands: s.players.map((p) => p.hand.slice()),
  };
  s.log.push(winner === null ? 'Nobody wins this round.' : `Seat ${winner + 1} wins the round.`);
}

/** What one seat is allowed to see. Opponents' hands and the stock stay hidden until the round ends. */
export interface PlayerView {
  seat: number;
  rules: RuleSet;
  hand: CardId[];
  players: { handCount: number; hasExposed: boolean; drawBlocked: boolean }[];
  melds: Meld[];
  discard: CardId[];
  stockCount: number;
  dealer: number;
  turn: number;
  phase: Phase;
  drawCall: { caller: number; waitingOn: number[]; responses: Partial<Record<number, 'fight' | 'fold' | null>> } | null;
  canCallDraw: boolean;
  myPoints: number;
  result: RoundResult | null;
  log: string[];
}

export function playerView(s: GameState, seat: number): PlayerView {
  return {
    seat,
    rules: s.rules,
    hand: s.players[seat]?.hand.slice() ?? [],
    players: s.players.map((p) => ({ handCount: p.hand.length, hasExposed: p.hasExposed, drawBlocked: p.drawBlocked })),
    melds: structuredClone(s.melds),
    discard: s.discard.slice(),
    stockCount: s.stock.length,
    dealer: s.dealer,
    turn: s.turn,
    phase: s.phase,
    drawCall: s.drawCall
      ? {
          caller: s.drawCall.caller,
          waitingOn: Object.entries(s.drawCall.responses)
            .filter(([, r]) => r === null)
            .map(([k]) => Number(k)),
          // Answers stay hidden until the round ends, so nobody is swayed by the others.
          responses: s.phase === 'ended' ? { ...s.drawCall.responses } : {},
        }
      : null,
    canCallDraw: seat >= 0 && canCallDraw(s, seat),
    myPoints: seat >= 0 ? handPoints(s.players[seat].hand, s.rules) : 0,
    result: s.result,
    log: s.log.slice(-12),
  };
}

/** The move the server makes for a player whose turn timer ran out. */
export function autoAction(s: GameState, seat: number): Action | null {
  if (s.phase === 'drawCall') {
    return s.drawCall && s.drawCall.responses[seat] === null ? { type: 'respondDraw', fight: false } : null;
  }
  if (s.turn !== seat) return null;
  if (s.phase === 'draw') return { type: 'drawStock' };
  if (s.phase === 'play') {
    const hand = s.players[seat].hand;
    const worst = hand.reduce((a, b) => (cardPoints(b) > cardPoints(a) ? b : a));
    return { type: 'discard', card: worst };
  }
  return null;
}
