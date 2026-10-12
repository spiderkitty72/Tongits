import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RULES,
  GameError,
  GameState,
  RuleSet,
  applyAction,
  autoAction,
  classifyMeld,
  handPoints,
  mulberry32,
  newRound,
  normalizeRules,
  playerView,
} from '../src/index.js';

const rules = (over: Partial<RuleSet> = {}): RuleSet => ({ ...DEFAULT_RULES, ...over });

/** Builds a mid-round state by hand so each rule can be tested in isolation. */
function table(hands: string[][], opts: Partial<GameState> = {}, r: RuleSet = rules()): GameState {
  return {
    rules: r,
    players: hands.map((hand) => ({ hand, hasExposed: false, drawBlocked: false })),
    stock: ['2C', '3C', '4C'],
    discard: [],
    melds: [],
    dealer: 0,
    turn: 0,
    phase: 'draw',
    drawCall: null,
    lastDrawer: null,
    meldSeq: 0,
    result: null,
    log: [],
    ...opts,
  };
}

describe('melds', () => {
  it('recognises sets and runs', () => {
    expect(classifyMeld(['5S', '5H', '5D'], DEFAULT_RULES)).toBe('set');
    expect(classifyMeld(['5S', '5H', '5D', '5C'], DEFAULT_RULES)).toBe('set');
    expect(classifyMeld(['1S', '2S', '3S'], DEFAULT_RULES)).toBe('run');
    expect(classifyMeld(['9H', '10H', '11H', '12H'], DEFAULT_RULES)).toBe('run');
  });
  it('rejects non-melds', () => {
    expect(classifyMeld(['5S', '5H'], DEFAULT_RULES)).toBeNull();
    expect(classifyMeld(['1S', '2S', '4S'], DEFAULT_RULES)).toBeNull();
    expect(classifyMeld(['1S', '2H', '3S'], DEFAULT_RULES)).toBeNull();
  });
  it('allows Q-K-A only when the rule is on, and never K-A-2', () => {
    expect(classifyMeld(['12S', '13S', '1S'], rules())).toBeNull();
    expect(classifyMeld(['12S', '13S', '1S'], rules({ aceHighRun: true }))).toBe('run');
    expect(classifyMeld(['13S', '1S', '2S'], rules({ aceHighRun: true }))).toBeNull();
  });
});

describe('deal', () => {
  it('gives the dealer 13, others 12, and leaves 15 in the stock', () => {
    const s = newRound(DEFAULT_RULES, 1, mulberry32(7));
    expect(s.players.map((p) => p.hand.length)).toEqual([12, 13, 12]);
    expect(s.stock).toHaveLength(15);
    expect(s.turn).toBe(1);
    expect(s.phase).toBe('play');
    const all = [...s.stock, ...s.players.flatMap((p) => p.hand)];
    expect(new Set(all).size).toBe(52);
  });
});

describe('turns', () => {
  it('draws, then discards, then passes the turn', () => {
    let s = table([['13S', '12H'], ['2D'], ['3D']]);
    s = applyAction(s, 0, { type: 'drawStock' });
    expect(s.players[0].hand).toContain('4C');
    expect(() => applyAction(s, 0, { type: 'drawStock' })).toThrow(GameError);
    s = applyAction(s, 0, { type: 'discard', card: '13S' });
    expect(s.turn).toBe(1);
    expect(s.phase).toBe('draw');
    expect(s.discard).toEqual(['13S']);
  });
  it('rejects moves out of turn', () => {
    const s = table([['13S'], ['2D'], ['3D']]);
    expect(() => applyAction(s, 1, { type: 'drawStock' })).toThrow('not your turn');
  });
  it('only lets you take the discard if you meld it at once', () => {
    const s = table([['7S', '8S', '2H'], ['2D'], ['3D']], { discard: ['9S'] });
    expect(() => applyAction(s, 0, { type: 'pickDiscard', cards: ['7S', '2H'] })).toThrow(GameError);
    const t = applyAction(s, 0, { type: 'pickDiscard', cards: ['7S', '8S'] });
    expect(t.melds[0].cards).toEqual(['7S', '8S', '9S']);
    expect(t.players[0].hand).toEqual(['2H']);
    expect(t.phase).toBe('play');
  });
});

describe('sapaw', () => {
  it('extends a meld and blocks the owner from calling Draw next turn', () => {
    let s = table([['2D', '13C'], ['8H', '9H'], ['5D']], {
      phase: 'play',
      melds: [{ id: 'm1', owner: 1, kind: 'run', cards: ['5H', '6H', '7H'] }],
    });
    s.players[1].hasExposed = true;
    expect(() => applyAction(s, 0, { type: 'sapaw', cards: ['2D'], meldId: 'm1' })).toThrow('do not fit');
    s.players[0].hand.push('4H');
    s = applyAction(s, 0, { type: 'sapaw', cards: ['4H'], meldId: 'm1' });
    expect(s.melds[0].cards).toEqual(['4H', '5H', '6H', '7H']);
    expect(s.players[1].drawBlocked).toBe(true);
    s = applyAction(s, 0, { type: 'discard', card: '13C' });
    expect(playerView(s, 1).canCallDraw).toBe(false);
    expect(() => applyAction(s, 1, { type: 'callDraw' })).toThrow('sapawed');
    s = applyAction(s, 1, { type: 'drawStock' });
    s = applyAction(s, 1, { type: 'discard', card: '8H' });
    expect(s.players[1].drawBlocked).toBe(false);
  });
  it('does not block when the rule is off', () => {
    const s = table([['4H', '13C'], ['8H'], ['5D']], {
      phase: 'play',
      melds: [{ id: 'm1', owner: 1, kind: 'run', cards: ['5H', '6H', '7H'] }],
    }, rules({ sapawBlocksDraw: false }));
    const t = applyAction(s, 0, { type: 'sapaw', cards: ['4H'], meldId: 'm1' });
    expect(t.players[1].drawBlocked).toBe(false);
  });
});

describe('Tong-its', () => {
  it('wins when the hand is emptied by melding', () => {
    const s = table([['5S', '5H', '5D'], ['13D', '1D'], ['12C']], { phase: 'play' });
    const t = applyAction(s, 0, { type: 'meld', cards: ['5S', '5H', '5D'] });
    expect(t.phase).toBe('ended');
    expect(t.result?.endedBy).toBe('tongits');
    expect(t.result?.winner).toBe(0);
    // Both losers are burned: base 1 + tongits 3 + burned 1 = 5 each.
    expect(t.result?.payouts).toEqual([10, -5, -5]);
  });
  it('wins when the last card is discarded', () => {
    const s = table([['9C'], ['13D'], ['12C']], { phase: 'play' });
    s.players[0].hasExposed = true;
    const t = applyAction(s, 0, { type: 'discard', card: '9C' });
    expect(t.result?.endedBy).toBe('tongits');
  });
});

describe('Draw call', () => {
  const base = () => {
    const s = table([['2S', '3D'], ['10S', '12D'], ['1C', '2C']]);
    s.players.forEach((p) => (p.hasExposed = true));
    return s;
  };
  it('needs a meld on the table', () => {
    const s = table([['2S'], ['3S'], ['4S']]);
    expect(() => applyAction(s, 0, { type: 'callDraw' })).toThrow('need a meld');
  });
  it('lowest hand wins after fights and folds', () => {
    let s = applyAction(base(), 0, { type: 'callDraw' });
    expect(s.phase).toBe('drawCall');
    s = applyAction(s, 1, { type: 'respondDraw', fight: false });
    s = applyAction(s, 2, { type: 'respondDraw', fight: true });
    expect(s.result?.winner).toBe(2); // 1+2=3 beats caller's 2+3=5
    expect(s.result?.folded).toEqual([false, true, false]);
    // Caller fought and lost: base 1 + fightLoss 1 + one Ace held by winner = 3. Folder pays base + ace = 2.
    expect(s.result?.payouts).toEqual([-3, -2, 5]);
  });
  it('caller wins a tie by default, challenger wins under the other rule', () => {
    const tie = () => {
      const s = table([['2S', '3D'], ['4S', '1D'], ['13C', '13D']]);
      s.players.forEach((p) => (p.hasExposed = true));
      return s;
    };
    let s = applyAction(tie(), 0, { type: 'callDraw' });
    s = applyAction(s, 1, { type: 'respondDraw', fight: true });
    s = applyAction(s, 2, { type: 'respondDraw', fight: false });
    expect(s.result?.winner).toBe(0);
    const t = tie();
    t.rules = rules({ drawTie: 'challenger' });
    let u = applyAction(t, 0, { type: 'callDraw' });
    u = applyAction(u, 1, { type: 'respondDraw', fight: true });
    u = applyAction(u, 2, { type: 'respondDraw', fight: false });
    expect(u.result?.winner).toBe(1);
  });
  it('burned players cannot fight and the caller wins at once if nobody can', () => {
    const s = table([['2S'], ['1S'], ['1H']]);
    s.players[0].hasExposed = true;
    const t = applyAction(s, 0, { type: 'callDraw' });
    expect(t.result?.winner).toBe(0);
    expect(t.result?.burned).toEqual([false, true, true]);
  });
});

describe('stock runs out', () => {
  it('lowest melded hand wins; burned players are out', () => {
    const s = table([['13S', '9D'], ['1S'], ['2H']], { phase: 'play', stock: [], lastDrawer: 0 });
    s.players[0].hasExposed = true;
    s.players[2].hasExposed = true;
    const t = applyAction(s, 0, { type: 'discard', card: '13S' });
    expect(t.result?.endedBy).toBe('stockOut');
    expect(t.result?.winner).toBe(2);
    expect(t.result?.burned).toEqual([false, true, false]);
  });
  it('the last drawer loses a tie, or nobody wins under the other rule', () => {
    const make = (r: RuleSet) => {
      const s = table([['13S', '5D'], ['5S'], ['4H', '1H']], { phase: 'play', stock: [], lastDrawer: 0 }, r);
      s.players.forEach((p) => (p.hasExposed = true));
      return s;
    };
    expect(applyAction(make(rules()), 0, { type: 'discard', card: '13S' }).result?.winner).toBe(1);
    expect(applyAction(make(rules({ stockOutTie: 'noWinner' })), 0, { type: 'discard', card: '13S' }).result?.winner).toBeNull();
  });
});

describe('secret sets', () => {
  it('a hidden four-of-a-kind scores nothing and saves you from being burned', () => {
    const hand = ['7S', '7H', '7D', '7C', '2S'];
    expect(handPoints(hand, rules())).toBe(2);
    expect(handPoints(hand, rules({ secretSetCounts: false }))).toBe(30);
  });
});

describe('views and timers', () => {
  it('hides opponents hands and the stock', () => {
    const s = newRound(DEFAULT_RULES, 0, mulberry32(1));
    const v = playerView(s, 1);
    expect(v.hand).toHaveLength(12);
    expect(v.players[0].handCount).toBe(13);
    expect(JSON.stringify(v)).not.toContain(s.players[0].hand[0] + '"');
    expect(v.stockCount).toBe(15);
  });
  it('auto-plays a full round without errors', () => {
    let s = newRound(DEFAULT_RULES, 0, mulberry32(42));
    for (let i = 0; i < 200 && s.phase !== 'ended'; i++) {
      const seat = s.turn;
      s = applyAction(s, seat, autoAction(s, seat)!);
    }
    expect(s.phase).toBe('ended');
    expect(s.result?.payouts.reduce((a, b) => a + b, 0)).toBe(0);
  });
});

describe('rules input', () => {
  it('fills gaps and clamps bad values', () => {
    const r = normalizeRules({ drawTie: 'challenger', turnSeconds: 99, payouts: { base: -5 }, rounds: 1000 });
    expect(r.drawTie).toBe('challenger');
    expect(r.turnSeconds).toBe(45);
    expect(r.payouts.base).toBe(0);
    expect(r.rounds).toBe(50);
  });
});
