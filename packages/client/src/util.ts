import { CardId, SUIT_SYMBOL, cardRank, cardSuit, rankLabel } from '@tongits/engine';

export function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

let toastTimer: number | undefined;
export function toast(message: string, kind: 'info' | 'error' = 'info'): void {
  const el = document.getElementById('toast')!;
  el.textContent = message;
  el.className = `show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.className = ''), 3500);
}

/** A card face. `attrs` adds data attributes or classes for interactive cards. */
export function cardHtml(id: CardId, opts: { selected?: boolean; hint?: boolean; small?: boolean; action?: string; disabled?: boolean } = {}): string {
  const suit = cardSuit(id);
  const red = suit === 'H' || suit === 'D';
  const cls = ['card', red ? 'red' : 'black', opts.selected ? 'selected' : '', opts.hint ? 'hint' : '', opts.small ? 'small' : '']
    .filter(Boolean)
    .join(' ');
  const label = `${rankLabel(cardRank(id))}${SUIT_SYMBOL[suit]}`;
  // Rank and suit sit in the corner so they stay readable when cards overlap.
  const inner = `<span class="corner"><span class="rank">${rankLabel(cardRank(id))}</span><span class="suit">${SUIT_SYMBOL[suit]}</span></span><span class="pip" aria-hidden="true">${SUIT_SYMBOL[suit]}</span>`;
  if (opts.action) {
    return `<button type="button" class="${cls}" data-action="${opts.action}" data-card="${id}" aria-pressed="${!!opts.selected}" aria-label="${label}" ${opts.disabled ? 'disabled' : ''}>${inner}</button>`;
  }
  return `<span class="${cls}" aria-label="${label}">${inner}</span>`;
}

export function cardBack(extra = ''): string {
  return `<span class="card back ${extra}" aria-hidden="true"></span>`;
}

export function timeAgo(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
