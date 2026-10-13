import { CardId, cardPoints, cardRank, cardSuit } from './cards.js';
import { classifyMeld } from './melds.js';
import { Action, GameState, canCallDraw, handPoints } from './game.js';

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
 * A simple computer player: melds and sapaws whenever it can, takes the discard
 * when it makes a meld, calls or fights a Draw on a low hand, and throws away
 * its highest loose card.
 */
export function botAction(s: GameState, seat: number): Action | null {
  const me = s.players[seat];
  const hand = me.hand;
  if (s.phase === 'drawCall') {
    if (!s.drawCall || s.drawCall.responses[seat] !== null) return null;
    return { type: 'respondDraw', fight: handPoints(hand, s.rules) <= LOW_HAND };
  }
  if (s.turn !== seat) return null;
  if (s.phase === 'draw') {
    if (canCallDraw(s, seat) && handPoints(hand, s.rules) <= LOW_HAND) return { type: 'callDraw' };
    const top = s.discard.at(-1);
    if (top) {
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
  const meld = bestMeld(hand, s.rules);
  if (meld) return { type: 'meld', cards: meld };
  for (const c of hand) {
    const target = s.melds.find((m) => classifyMeld([...m.cards, c], s.rules) === m.kind);
    if (target) return { type: 'sapaw', cards: [c], meldId: target.id };
  }
  if (hand.length === 0) return null;
  const loose = hand.filter((c) => !hasPartner(c, hand));
  const pool = loose.length ? loose : hand;
  const worst = pool.reduce((a, b) => (cardPoints(b) > cardPoints(a) ? b : a));
  return { type: 'discard', card: worst };
}
