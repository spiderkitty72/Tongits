/** Every house-rule choice the host can make on the rules page before a game starts. */
export interface RuleSet {
  /** Who wins when the Draw caller ties with a challenger. */
  drawTie: 'caller' | 'challenger';
  /** What happens when lowest hands tie after the stock runs out. */
  stockOutTie: 'lastDrawerLoses' | 'noWinner';
  /** A sapaw onto your meld stops you calling Draw on your next turn. */
  sapawBlocksDraw: boolean;
  /** A four-of-a-kind kept in hand counts as melded (no points, not burned). */
  secretSetCounts: boolean;
  /** Q-K-A counts as a run (Ace high). K-A-2 never does. */
  aceHighRun: boolean;
  /** Who deals the next round. */
  nextDealer: 'winner' | 'rotate';
  /** Seconds per turn before the server plays for you. 0 = no timer. */
  turnSeconds: 0 | 30 | 45 | 60;
  payouts: {
    /** Each loser pays the winner this. */
    base: number;
    /** Extra from each loser when the winner calls Tong-its. */
    tongits: number;
    /** Extra from a loser who was burned (no meld). */
    burned: number;
    /** Extra from a loser who fought a Draw call and lost. */
    fightLoss: number;
    /** Extra per four-of-a-kind the winner holds (exposed or secret). */
    fourOfAKind: number;
    /** Extra per Ace the winner holds. */
    ace: number;
  };
  gameLength: 'single' | 'rounds' | 'chipTarget';
  /** Number of rounds when gameLength is 'rounds'. */
  rounds: number;
  /** Chips a player must win to end the match when gameLength is 'chipTarget'. */
  chipTarget: number;
}

export const DEFAULT_RULES: RuleSet = {
  drawTie: 'caller',
  stockOutTie: 'lastDrawerLoses',
  sapawBlocksDraw: true,
  secretSetCounts: true,
  aceHighRun: false,
  nextDealer: 'winner',
  turnSeconds: 45,
  payouts: { base: 1, tongits: 3, burned: 1, fightLoss: 1, fourOfAKind: 1, ace: 1 },
  gameLength: 'rounds',
  rounds: 10,
  chipTarget: 20,
};

function pick<T>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function int(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? Math.round(value) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** Turns untrusted input (from a client or the database) into a complete, valid rule set. */
export function normalizeRules(input: unknown): RuleSet {
  const r = (input && typeof input === 'object' ? input : {}) as Record<string, any>;
  const d = DEFAULT_RULES;
  const p = (r.payouts && typeof r.payouts === 'object' ? r.payouts : {}) as Record<string, unknown>;
  return {
    drawTie: pick(r.drawTie, ['caller', 'challenger'] as const, d.drawTie),
    stockOutTie: pick(r.stockOutTie, ['lastDrawerLoses', 'noWinner'] as const, d.stockOutTie),
    sapawBlocksDraw: bool(r.sapawBlocksDraw, d.sapawBlocksDraw),
    secretSetCounts: bool(r.secretSetCounts, d.secretSetCounts),
    aceHighRun: bool(r.aceHighRun, d.aceHighRun),
    nextDealer: pick(r.nextDealer, ['winner', 'rotate'] as const, d.nextDealer),
    turnSeconds: pick(r.turnSeconds, [0, 30, 45, 60] as const, d.turnSeconds),
    payouts: {
      base: int(p.base, 0, 100, d.payouts.base),
      tongits: int(p.tongits, 0, 100, d.payouts.tongits),
      burned: int(p.burned, 0, 100, d.payouts.burned),
      fightLoss: int(p.fightLoss, 0, 100, d.payouts.fightLoss),
      fourOfAKind: int(p.fourOfAKind, 0, 100, d.payouts.fourOfAKind),
      ace: int(p.ace, 0, 100, d.payouts.ace),
    },
    gameLength: pick(r.gameLength, ['single', 'rounds', 'chipTarget'] as const, d.gameLength),
    rounds: int(r.rounds, 1, 50, d.rounds),
    chipTarget: int(r.chipTarget, 1, 1000, d.chipTarget),
  };
}
