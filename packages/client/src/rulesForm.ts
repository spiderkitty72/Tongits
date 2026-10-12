import { RuleSet, normalizeRules } from '@tongits/engine';
import { esc } from './util';

type Choice = { key: keyof RuleSet; label: string; help?: string; options: [string | number, string][] };
type Toggle = { key: keyof RuleSet; label: string; help?: string; toggle: true };

const FIELDS: (Choice | Toggle)[] = [
  { key: 'drawTie', label: 'Draw tie', help: 'When the caller and a challenger have the same points.', options: [['caller', 'Caller wins'], ['challenger', 'Challenger wins']] },
  { key: 'stockOutTie', label: 'Tie when the stock runs out', options: [['lastDrawerLoses', 'Last player to draw loses'], ['noWinner', 'Nobody wins the round']] },
  { key: 'sapawBlocksDraw', label: 'Sapaw blocks Draw', help: "A sapaw onto your meld stops you calling Draw on your next turn.", toggle: true },
  { key: 'secretSetCounts', label: 'Secret four-of-a-kind counts as melded', help: 'Scores 0 and keeps you from being burned.', toggle: true },
  { key: 'aceHighRun', label: 'Q-K-A is a run', toggle: true },
  { key: 'nextDealer', label: 'Next dealer', options: [['winner', 'Round winner'], ['rotate', 'Rotate to the next player']] },
  { key: 'turnSeconds', label: 'Turn timer', options: [[0, 'Off'], [30, '30 seconds'], [45, '45 seconds'], [60, '60 seconds']] },
  { key: 'gameLength', label: 'Game length', options: [['single', 'Single round'], ['rounds', 'Fixed number of rounds'], ['chipTarget', 'Until someone wins a chip target']] },
];

const PAYOUTS: [keyof RuleSet['payouts'], string][] = [
  ['base', 'Base stake from each loser'],
  ['tongits', 'Tong-its bonus'],
  ['burned', 'Burned penalty'],
  ['fightLoss', 'Lost a Draw fight'],
  ['fourOfAKind', 'Per four-of-a-kind'],
  ['ace', 'Per Ace held by winner'],
];

export function rulesSummary(r: RuleSet): string {
  const len = r.gameLength === 'single' ? '1 round' : r.gameLength === 'rounds' ? `${r.rounds} rounds` : `first to ${r.chipTarget} chips`;
  return `${len} · timer ${r.turnSeconds ? r.turnSeconds + 's' : 'off'} · Draw tie: ${r.drawTie}`;
}

/** The rules page shown in the lobby. Read-only for everyone except the host. */
export function rulesForm(r: RuleSet, editable: boolean): string {
  const dis = editable ? '' : 'disabled';
  const rows = FIELDS.map((f) => {
    const value = r[f.key] as unknown;
    const help = f.help ? `<small>${esc(f.help)}</small>` : '';
    if ('toggle' in f) {
      return `<label class="rule toggle"><span>${esc(f.label)}${help}</span>
        <input type="checkbox" data-rule="${f.key}" ${value ? 'checked' : ''} ${dis}></label>`;
    }
    const opts = f.options
      .map(([v, l]) => `<option value="${v}" ${String(v) === String(value) ? 'selected' : ''}>${esc(l)}</option>`)
      .join('');
    let extra = '';
    if (f.key === 'gameLength' && r.gameLength === 'rounds')
      extra = `<input type="number" min="1" max="50" data-rule="rounds" value="${r.rounds}" ${dis} aria-label="Rounds">`;
    if (f.key === 'gameLength' && r.gameLength === 'chipTarget')
      extra = `<input type="number" min="1" max="1000" data-rule="chipTarget" value="${r.chipTarget}" ${dis} aria-label="Chip target">`;
    return `<label class="rule"><span>${esc(f.label)}${help}</span>
      <span class="rule-input"><select data-rule="${f.key}" ${dis}>${opts}</select>${extra}</span></label>`;
  }).join('');
  const pay = PAYOUTS.map(
    ([k, l]) => `<label class="rule pay"><span>${esc(l)}</span>
      <input type="number" min="0" max="100" data-payout="${k}" value="${r.payouts[k]}" ${dis}></label>`,
  ).join('');
  return `<form class="rules-form" id="rules-form">${rows}<h4>Payouts (chips)</h4>${pay}</form>`;
}

/** Reads the rules page back into a rule set. */
export function readRulesForm(form: HTMLFormElement, current: RuleSet): RuleSet {
  const next: any = structuredClone(current);
  form.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-rule]').forEach((el) => {
    const key = el.dataset.rule!;
    if (el instanceof HTMLInputElement && el.type === 'checkbox') next[key] = el.checked;
    else if (el instanceof HTMLInputElement && el.type === 'number') next[key] = Number(el.value);
    else next[key] = key === 'turnSeconds' ? Number(el.value) : el.value;
  });
  form.querySelectorAll<HTMLInputElement>('[data-payout]').forEach((el) => {
    next.payouts[el.dataset.payout!] = Number(el.value);
  });
  return normalizeRules(next);
}
