import { CardId, cardRank, cardSuit } from './cards.js';
import { RuleSet } from './rules.js';

export type MeldKind = 'set' | 'run';

function consecutive(ranks: number[]): boolean {
  const s = ranks.slice().sort((a, b) => a - b);
  for (let i = 1; i < s.length; i++) if (s[i] !== s[i - 1] + 1) return false;
  return true;
}

/** Returns what kind of meld these cards form, or null if they are not a legal meld. */
export function classifyMeld(cards: CardId[], rules: Pick<RuleSet, 'aceHighRun'>): MeldKind | null {
  if (cards.length < 3) return null;
  if (new Set(cards).size !== cards.length) return null;
  const ranks = cards.map(cardRank);
  if (ranks.every((r) => r === ranks[0])) return cards.length <= 4 ? 'set' : null;
  const suit = cardSuit(cards[0]);
  if (!cards.every((c) => cardSuit(c) === suit)) return null;
  if (consecutive(ranks)) return 'run';
  if (rules.aceHighRun && ranks.includes(1) && ranks.includes(13)) {
    if (consecutive(ranks.map((r) => (r === 1 ? 14 : r)))) return 'run';
  }
  return null;
}

/** Orders a meld's cards for display: runs low to high (Ace high when it follows a King). */
export function orderMeld(cards: CardId[]): CardId[] {
  const hasKing = cards.some((c) => cardRank(c) === 13);
  const key = (c: CardId) => {
    const r = cardRank(c);
    return r === 1 && hasKing ? 14 : r;
  };
  return cards.slice().sort((a, b) => key(a) - key(b) || cardSuit(a).localeCompare(cardSuit(b)));
}

/** Four-of-a-kind groups sitting in a hand. */
export function findSecretSets(hand: CardId[]): CardId[][] {
  const byRank = new Map<number, CardId[]>();
  for (const c of hand) {
    const r = cardRank(c);
    byRank.set(r, [...(byRank.get(r) ?? []), c]);
  }
  return [...byRank.values()].filter((g) => g.length === 4);
}

/** Every card in the hand that belongs to at least one possible 3-card meld (for UI hints). */
export function meldableCards(hand: CardId[], rules: Pick<RuleSet, 'aceHighRun'>): Set<CardId> {
  const out = new Set<CardId>();
  for (let i = 0; i < hand.length; i++)
    for (let j = i + 1; j < hand.length; j++)
      for (let k = j + 1; k < hand.length; k++) {
        if (classifyMeld([hand[i], hand[j], hand[k]], rules)) {
          out.add(hand[i]);
          out.add(hand[j]);
          out.add(hand[k]);
        }
      }
  return out;
}
