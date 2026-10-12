import { CardId, Meld, PlayerView, classifyMeld, meldableCards, sortByRank, sortBySuit } from '@tongits/engine';
import type { RoomView, SeatView } from './api';
import { cardBack, cardHtml, esc } from './util';

export interface TableUi {
  selected: Set<CardId>;
  sort: 'rank' | 'suit';
  showLog: boolean;
}

const END_LABEL: Record<string, string> = { tongits: 'Tong-its!', draw: 'Draw', stockOut: 'Stock ran out' };

function seatName(room: RoomView, seat: number): string {
  return room.seats[seat]?.displayName ?? `Seat ${seat + 1}`;
}

/** What the selected cards could do right now. */
export function moves(g: PlayerView, ui: TableUi) {
  const sel = [...ui.selected];
  const myTurn = g.turn === g.seat && g.seat >= 0;
  const top = g.discard.at(-1);
  return {
    myTurn,
    canDrawStock: myTurn && g.phase === 'draw' && g.stockCount > 0,
    canPickDiscard: myTurn && g.phase === 'draw' && !!top && sel.length >= 2 && !!classifyMeld([...sel, top], g.rules),
    canMeld: myTurn && g.phase === 'play' && !!classifyMeld(sel, g.rules),
    canDiscard: myTurn && g.phase === 'play' && sel.length === 1,
    canCallDraw: g.canCallDraw,
    mustRespond: g.phase === 'drawCall' && !!g.drawCall?.waitingOn.includes(g.seat),
    sapawTargets: new Set(
      myTurn && g.phase === 'play' && sel.length > 0
        ? g.melds.filter((m) => classifyMeld([...m.cards, ...sel], g.rules) === m.kind).map((m) => m.id)
        : [],
    ),
  };
}

function meldsHtml(melds: Meld[], targets: Set<string>): string {
  if (melds.length === 0) return '<div class="melds empty">No melds yet</div>';
  return `<div class="melds">${melds
    .map((m) => {
      const target = targets.has(m.id);
      const cards = m.cards.map((c) => cardHtml(c, { small: true })).join('');
      return target
        ? `<button type="button" class="meld target" data-action="sapaw" data-meld="${m.id}" aria-label="Sapaw onto this meld">${cards}<span class="sapaw-tag">Sapaw</span></button>`
        : `<div class="meld">${cards}</div>`;
    })
    .join('')}</div>`;
}

function opponentHtml(room: RoomView, g: PlayerView, seat: number, targets: Set<string>, side: string): string {
  const s = room.seats[seat] as SeatView | null;
  const p = g.players[seat];
  const turn = g.turn === seat && g.phase !== 'ended';
  const waiting = g.drawCall?.waitingOn.includes(seat);
  const badges = [
    g.dealer === seat ? '<span class="badge">Dealer</span>' : '',
    p.drawBlocked ? '<span class="badge warn" title="Sapawed: cannot call Draw next turn">Blocked</span>' : '',
    !p.hasExposed ? '<span class="badge quiet" title="No meld yet">No meld</span>' : '',
    s && !s.connected ? '<span class="badge warn">Offline</span>' : '',
    waiting ? '<span class="badge">Deciding…</span>' : '',
  ].join('');
  const backs = Array.from({ length: Math.min(p.handCount, 13) }, () => cardBack('mini')).join('');
  return `<section class="opponent ${side} ${turn ? 'turn' : ''}">
    <header><span class="avatar">${esc(s?.avatar ?? '🂠')}</span>
      <span class="who"><strong>${esc(seatName(room, seat))}</strong><small>${p.handCount} cards · ${s?.total ?? 0} chips</small></span></header>
    <div class="badges">${badges}</div>
    <div class="backs" aria-label="${p.handCount} cards">${backs}</div>
    ${meldsHtml(g.melds.filter((m) => m.owner === seat), targets)}
  </section>`;
}

function resultHtml(room: RoomView, g: PlayerView): string {
  const r = g.result!;
  const rows = [0, 1, 2]
    .map((seat) => {
      const s = room.seats[seat];
      const flags = [r.winner === seat ? '<span class="badge win">Winner</span>' : '', r.burned[seat] ? '<span class="badge warn">Burned</span>' : '', r.folded[seat] ? '<span class="badge quiet">Folded</span>' : ''].join('');
      const delta = r.payouts[seat];
      return `<div class="result-row ${r.winner === seat ? 'won' : ''}">
        <div class="result-who"><span class="avatar">${esc(s?.avatar ?? '')}</span><strong>${esc(seatName(room, seat))}</strong>${flags}</div>
        <div class="result-hand">${r.hands[seat].map((c) => cardHtml(c, { small: true })).join('') || '<em>empty hand</em>'}</div>
        <div class="result-nums"><span>${r.points[seat]} pts</span><span class="${delta >= 0 ? 'plus' : 'minus'}">${delta > 0 ? '+' : ''}${delta} chips</span><span class="total">Match: ${s?.total ?? 0}</span></div>
      </div>`;
    })
    .join('');
  const title = r.winner === null ? 'Nobody wins this round' : `${esc(seatName(room, r.winner))} wins · ${END_LABEL[r.endedBy]}`;
  const isPlayer = room.mySeat >= 0;
  let buttons = '';
  if (room.status === 'roundOver' && isPlayer) buttons = '<button class="primary" data-action="next-round">Deal next round</button>';
  if (room.status === 'finished') {
    const best = Math.max(...room.seats.map((s) => s?.total ?? 0));
    const champs = room.seats.filter((s) => s && s.total === best).map((s) => esc(s!.displayName)).join(' and ');
    buttons = `<p class="match-over">Match over. ${champs} finished on top with ${best} chips.</p>`;
    buttons += room.hostId === room.seats[room.mySeat]?.userId ? '<button class="primary" data-action="play-again">Back to lobby</button>' : '';
    buttons += '<button data-action="leave">Leave room</button>';
  }
  return `<div class="overlay"><div class="sheet result">
    <h2>${title}</h2><p class="muted">Round ${room.roundNo}${room.rules.gameLength === 'rounds' ? ` of ${room.rules.rounds}` : ''}</p>
    ${rows}<div class="sheet-actions">${buttons}</div></div></div>`;
}

export function renderTable(room: RoomView, ui: TableUi): string {
  const g = room.game!;
  const me = g.seat;
  const base = me >= 0 ? me : 0;
  const right = (base + 1) % 3;
  const left = (base + 2) % 3;
  const m = moves(g, ui);
  const top = g.discard.at(-1);
  const hand = ui.sort === 'rank' ? sortByRank(g.hand) : sortBySuit(g.hand);
  const hints = meldableCards(g.hand, g.rules);

  let status = '';
  if (g.phase === 'ended') status = 'Round over';
  else if (g.phase === 'drawCall') {
    status = `${esc(seatName(room, g.drawCall!.caller))} called Draw!`;
    if (m.mustRespond) status += ' Fight or fold?';
  } else if (m.myTurn) status = g.phase === 'draw' ? 'Your turn: draw a card' : 'Your turn: meld, sapaw, then discard';
  else status = `${esc(seatName(room, g.turn))}'s turn`;

  const deadline = room.turnDeadline ? `<span class="timer" data-deadline="${room.turnDeadline}"></span>` : '';

  let actions = '';
  if (me >= 0 && g.phase !== 'ended') {
    if (m.mustRespond) {
      actions = `<span class="pts">Your hand: ${g.myPoints} pts</span>
        <button class="primary" data-action="fight">Fight</button><button data-action="fold">Fold</button>`;
    } else if (m.myTurn && g.phase === 'draw') {
      actions = `<button class="primary" data-action="draw-stock" ${m.canDrawStock ? '' : 'disabled'}>Draw from stock</button>
        <button data-action="pick-discard" ${m.canPickDiscard ? '' : 'disabled'} title="Select two cards that meld with the top discard">Take discard</button>
        ${g.canCallDraw ? '<button class="call" data-action="call-draw">Call Draw</button>' : ''}`;
    } else if (m.myTurn && g.phase === 'play') {
      actions = `<button data-action="meld" ${m.canMeld ? '' : 'disabled'}>Meld</button>
        <button class="primary" data-action="discard" ${m.canDiscard ? '' : 'disabled'}>Discard</button>
        <span class="tip">${m.sapawTargets.size ? 'Tap a glowing meld to sapaw' : 'Select cards to meld or sapaw'}</span>`;
    }
  }

  const myInfo = room.seats[base];
  const myBadges = me >= 0
    ? [g.dealer === me ? '<span class="badge">Dealer</span>' : '', g.players[me].drawBlocked ? '<span class="badge warn">Blocked from Draw</span>' : '', !g.players[me].hasExposed ? '<span class="badge quiet">No meld yet</span>' : ''].join('')
    : '<span class="badge quiet">Watching</span>';

  return `<div class="table ${m.myTurn ? 'my-turn' : ''}">
    <div class="topbar">
      <button class="icon" data-action="menu" aria-label="Menu">☰</button>
      <span class="room-code">Room ${esc(room.code)} · Round ${room.roundNo}</span>
      <button class="icon" data-action="toggle-log" aria-label="Game log">📜</button>
    </div>
    <div class="opponents">
      ${opponentHtml(room, g, left, m.sapawTargets, 'left')}
      ${opponentHtml(room, g, right, m.sapawTargets, 'right')}
    </div>
    <div class="center">
      <button type="button" class="pile stock" data-action="draw-stock" ${m.canDrawStock ? '' : 'disabled'} aria-label="Stock, ${g.stockCount} cards">
        ${g.stockCount ? cardBack() : '<span class="card empty"></span>'}<span class="count">${g.stockCount}</span></button>
      <button type="button" class="pile discard" data-action="pick-discard" ${m.canPickDiscard ? '' : 'disabled'} aria-label="Discard pile">
        ${top ? cardHtml(top) : '<span class="card empty"></span>'}<span class="count">${g.discard.length}</span></button>
      <div class="status"><strong>${status}</strong>${deadline}</div>
    </div>
    ${ui.showLog ? `<div class="log">${g.log.map((l) => `<div>${esc(l)}</div>`).join('')}</div>` : ''}
    <section class="me ${m.myTurn ? 'turn' : ''}">
      <header><span class="avatar">${esc(myInfo?.avatar ?? '')}</span>
        <span class="who"><strong>${me >= 0 ? 'You' : 'Spectating'}</strong><small>${me >= 0 ? `${g.myPoints} pts in hand · ${myInfo?.total ?? 0} chips` : ''}</small></span>
        <span class="badges">${myBadges}</span>
        ${me >= 0 ? `<button class="small-btn" data-action="sort">Sort: ${ui.sort === 'rank' ? 'rank' : 'suit'}</button>` : ''}</header>
      ${me >= 0 ? meldsHtml(g.melds.filter((x) => x.owner === me), m.sapawTargets) : ''}
      <div class="hand">${hand.map((c) => cardHtml(c, { action: 'select', selected: ui.selected.has(c), hint: hints.has(c) })).join('')}</div>
      <div class="actions">${actions}</div>
    </section>
    ${g.phase === 'ended' && g.result ? resultHtml(room, g) : ''}
  </div>`;
}
