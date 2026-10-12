export type Suit = 'S' | 'H' | 'D' | 'C';

/** A card id is rank (1 = Ace ... 13 = King) followed by suit, e.g. "1S", "10H", "13C". */
export type CardId = string;

export const SUITS: readonly Suit[] = ['S', 'H', 'D', 'C'];

export function cardRank(id: CardId): number {
  return Number(id.slice(0, -1));
}

export function cardSuit(id: CardId): Suit {
  return id.slice(-1) as Suit;
}

export function isCardId(value: unknown): value is CardId {
  if (typeof value !== 'string') return false;
  const m = /^(\d{1,2})([SHDC])$/.exec(value);
  if (!m) return false;
  const r = Number(m[1]);
  return r >= 1 && r <= 13;
}

/** Card points: Ace 1, 2-10 face value, J/Q/K 10. */
export function cardPoints(id: CardId): number {
  const r = cardRank(id);
  return r >= 10 ? 10 : r;
}

export function fullDeck(): CardId[] {
  const deck: CardId[] = [];
  for (const s of SUITS) for (let r = 1; r <= 13; r++) deck.push(`${r}${s}`);
  return deck;
}

export function rankLabel(rank: number): string {
  return rank === 1 ? 'A' : rank === 11 ? 'J' : rank === 12 ? 'Q' : rank === 13 ? 'K' : String(rank);
}

export const SUIT_SYMBOL: Record<Suit, string> = { S: '♠', H: '♥', D: '♦', C: '♣' };

export function cardLabel(id: CardId): string {
  return `${rankLabel(cardRank(id))}${SUIT_SYMBOL[cardSuit(id)]}`;
}

/** Deterministic PRNG so tests and replays can reproduce a deal. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(items: T[], rng: () => number): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const SUIT_ORDER: Record<Suit, number> = { S: 0, H: 1, C: 2, D: 3 };

export function sortByRank(cards: CardId[]): CardId[] {
  return cards.slice().sort((a, b) => cardRank(a) - cardRank(b) || SUIT_ORDER[cardSuit(a)] - SUIT_ORDER[cardSuit(b)]);
}

export function sortBySuit(cards: CardId[]): CardId[] {
  return cards.slice().sort((a, b) => SUIT_ORDER[cardSuit(a)] - SUIT_ORDER[cardSuit(b)] || cardRank(a) - cardRank(b));
}
