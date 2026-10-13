import { CardId, cardPoints, cardRank, cardSuit, fullDeck } from './cards.js';
import { classifyMeld, findSecretSets } from './melds.js';
import { Action, GameState, canCallDraw, handPoints } from './game.js';

export type BotLevel = 'easy' | 'normal' | 'hard';
export const BOT_LEVELS: BotLevel[] = ['easy', 'normal', 'hard'];

/** Fight a Draw or call one when holding this many points or fewer. */
const LOW_HAND = 8;

/** Every legal meld that can be made from cards in this hand (sets of 3–4, runs of 3+). */
function allMelds(hand: CardId[], rules: GameState['rules']): CardId[][] {
  const out: CardId[][] = [];
  const byRank = new Map<number, CardId[]>();
  const bySuit = new Map<string, CardId[]>();
  for (const c of hand) {
    byRank.set(cardRank(c), [...(byRank.get(cardRank(c)) ?? []), c]);
    bySuit.set(cardSuit(c), [...(bySuit.get(cardSuit(c)) ?? []), c]);
  }
  for (const group of byRank.values()) {
    if (group.length === 4) out.push(group);
    if (group.length >= 3) for (let skip = 0; skip < group.length; skip++) {
      const three = group.filter((_, i) => i !== skip);
      if (three.length === 3) out.push(three);
    }
  }
  for (const suited of bySuit.values()) {
    // Ace counts low, and also high after a King when the rules allow it.
    const ranked = suited.map((c) => ({ c, r: cardRank(c) }));
    if (rules.aceHighRun) for (const x of suited) if (cardRank(x) === 1) ranked.push({ c: x, r: 14 });
    ranked.sort((a, b) => a.r - b.r);
    for (let i = 0; i < ranked.length; i++) {
      const run = [ranked[i]];
      for (let j = i + 1; j < ranked.length && ranked[j].r === run[run.length - 1].r + 1; j++) {
        run.push(ranked[j]);
        const cards = run.map((x) => x.c);
        if (run.length >= 3 && classifyMeld(cards, rules)) out.push(cards);
      }
    }
  }
  return out;
}

const points = (cards: CardId[]) => cards.reduce((n, c) => n + cardPoints(c), 0);

/** The meld that sheds the most points, or null. */
function bestMeld(hand: CardId[], rules: GameState['rules']): CardId[] | null {
  let best: CardId[] | null = null;
  for (const m of allMelds(hand, rules)) if (!best || points(m) > points(best) || (points(m) === points(best) && m.length > best.length)) best = m;
  return best;
}

/** True if another card in hand could later make a meld with this one. */
function hasPartner(card: CardId, hand: CardId[]): boolean {
  return hand.some((o) => o !== card && (cardRank(o) === cardRank(card) || (cardSuit(o) === cardSuit(card) && Math.abs(cardRank(o) - cardRank(card)) <= 2)));
}

/**
 * Like hasPartner, but only counts pairs that can still become a meld: some card
 * that would complete them has not been seen in the discard pile or on the table.
 */
function hasLivePartner(card: CardId, hand: CardId[], unseen: CardId[], rules: GameState['rules']): boolean {
  return hand.some((o) => o !== card && hasPartner(card, [card, o]) && unseen.some((x) => classifyMeld([card, o, x], rules)));
}

/** Cards this seat cannot see anywhere: not in its hand, the discard pile or the melds. */
function unseenCards(s: GameState, seat: number): CardId[] {
  const seen = new Set<CardId>([...s.players[seat].hand, ...s.discard, ...s.melds.flatMap((m) => m.cards)]);
  return fullDeck().filter((c) => !seen.has(c));
}

/** A rough guess at an opponent's hand points from how many cards they hold. */
const guessPoints = (cards: number) => cards * 5;

/**
 * A computer player at one of three levels.
 * - easy: often passes up the discard, never sapaws, is slow to meld, discards carelessly, never calls Draw.
 * - normal: melds and sapaws whenever it can, takes the discard when it makes a meld,
 *   calls or fights a Draw on a low hand, and throws away its highest loose card.
 * - hard: plays like normal but keeps secret four-of-a-kinds hidden, tracks which cards
 *   are gone so it only keeps pairs that can still become melds, and times Draw calls
 *   against how many cards its opponents still hold.
 */
export function botAction(s: GameState, seat: number, level: BotLevel = 'normal', rng: () => number = Math.random): Action | null {
  const me = s.players[seat];
  const hand = me.hand;
  const pts = handPoints(hand, s.rules);
  if (s.phase === 'drawCall') {
    if (!s.drawCall || s.drawCall.responses[seat] !== null) return null;
    const limit = level === 'easy' ? 3 : level === 'hard' ? 6 : LOW_HAND;
    return { type: 'respondDraw', fight: pts <= limit };
  }
  if (s.turn !== seat) return null;
  const opponents = [0, 1, 2].filter((x) => x !== seat);
  if (s.phase === 'draw') {
    if (level !== 'easy' && canCallDraw(s, seat)) {
      if (level === 'normal' && pts <= LOW_HAND) return { type: 'callDraw' };
      if (level === 'hard') {
        const lowestRival = Math.min(...opponents.map((x) => guessPoints(s.players[x].hand.length)));
        if (pts <= 4 || pts * 2 < lowestRival) return { type: 'callDraw' };
      }
    }
    const top = s.discard.at(-1);
    if (top && (level !== 'easy' || rng() < 0.5)) {
      let pick: CardId[] | null = null;
      for (let i = 0; i < hand.length; i++) {
        for (let j = i + 1; j < hand.length; j++) {
          const pair = [hand[i], hand[j]];
          if (classifyMeld([...pair, top], s.rules) && (!pick || points(pair) > points(pick))) pick = pair;
        }
      }
      if (pick) return { type: 'pickDiscard', cards: pick };
    }
    return s.stock.length > 0 ? { type: 'drawStock' } : null;
  }
  if (s.phase !== 'play') return null;

  // Hard keeps four-of-a-kinds in hand: they score nothing and stop it being burned.
  const secret = new Set(level === 'hard' && s.rules.secretSetCounts ? findSecretSets(hand).flat() : []);
  const meldable = hand.filter((c) => !secret.has(c));
  const meld = level === 'easy' && rng() < 0.3 ? null : bestMeld(meldable, s.rules);
  if (meld) return { type: 'meld', cards: meld };
  if (level !== 'easy') {
    for (const c of meldable) {
      const target = s.melds.find((m) => classifyMeld([...m.cards, c], s.rules) === m.kind);
      if (target) return { type: 'sapaw', cards: [c], meldId: target.id };
    }
  }
  if (hand.length === 0) return null;
  if (level === 'easy' && rng() < 0.5) return { type: 'discard', card: hand[Math.floor(rng() * hand.length)] };
  const choices = meldable.length ? meldable : hand;
  const unseen = level === 'hard' ? unseenCards(s, seat) : [];
  const keep = (c: CardId) => (level === 'hard' ? hasLivePartner(c, choices, unseen, s.rules) : hasPartner(c, choices));
  const loose = choices.filter((c) => !keep(c));
  const pool = loose.length ? loose : choices;
  const worst = pool.reduce((a, b) => (cardPoints(b) > cardPoints(a) ? b : a));
  return { type: 'discard', card: worst };
}
