// Таблица с сортировкой по клику на заголовок и строкой фильтров под заголовками.
// Ввод в фильтр перерисовывает только строки таблицы, поэтому курсор остаётся в поле.
import { h, clear, debounce } from './ui.js';
import { applyTableFilters } from './core/filter.js';

const NUM_HINT = 'Число или условие: >90, <50, >=10, 10-20. Для процентов вводите проценты.';

/**
 * @param {object} o
 * @param {object[]} o.rows
 * @param {{key, label, type?: 'text'|'num', scale?, value: (r) => any, search?: (r) => string,
 *   cell?: (r) => any, r?: boolean, disabled?: boolean, placeholder?: string}[]} o.columns
 * @param {{sort?: string, dir?: number, f?: object}} o.state сортировка и фильтры, переживают перерисовку вида
 * @param {(r) => object} [o.rowAttrs] атрибуты строки (класс, обработчик клика)
 * @param {string} [o.maxHeight]
 * @returns {{table: HTMLElement, tools: HTMLElement}}
 */
export function dataTable({ rows, columns, state, rowAttrs, maxHeight }) {
  state.f = state.f || {};
  const tbody = h('tbody');
  const arrows = new Map();
  const inputs = new Map();
  const count = h('span', { class: 'small muted' });
  const reset = h('button', {
    class: 'btn btn-ghost btn-sm', type: 'button',
    onclick: () => { state.f = {}; for (const inp of inputs.values()) inp.value = ''; draw(); },
  }, 'Сбросить фильтры');

  function draw() {
    const { rows: out, errors } = applyTableFilters(rows, columns, state);
    clear(tbody);
    for (const r of out) {
      tbody.append(h('tr', rowAttrs ? rowAttrs(r) : null, columns.map((c) => h('td', { class: c.r ? 'r' : '' }, c.cell ? c.cell(r) : c.value(r)))));
    }
    if (!out.length) tbody.append(h('tr', null, h('td', { colspan: columns.length, class: 'dt-empty' }, 'Нет строк под эти фильтры')));
    for (const [key, inp] of inputs) {
      inp.classList.toggle('bad', errors.has(key));
      inp.title = errors.has(key) ? `Не понял условие. ${NUM_HINT}` : inp.dataset.hint;
    }
    for (const [key, a] of arrows) a.textContent = state.sort === key ? (state.dir > 0 ? '↑' : '↓') : '';
    const active = Object.values(state.f).some((v) => String(v || '').trim());
    count.textContent = active ? `Показано ${out.length} из ${rows.length}` : '';
    reset.hidden = !active;
  }

  const head = h('tr', null, columns.map((c) => {
    const a = h('span', { class: 'arrow' });
    arrows.set(c.key, a);
    return h('th', {
      class: `sortable ${c.r ? 'r' : ''}`, title: 'Сортировать',
      onclick: () => {
        if (state.sort === c.key) state.dir = -(state.dir || 1);
        else { state.sort = c.key; state.dir = c.type === 'text' ? 1 : -1; }
        draw();
      },
    }, c.label, a);
  }));
  const filters = h('tr', { class: 'dt-filters' }, columns.map((c) => {
    if (c.type === 'none') return h('th');
    const hint = c.type === 'text' ? 'Слова из названия' : NUM_HINT;
    const inp = h('input', {
      type: 'text', class: 'dt-filter', value: state.f[c.key] || '', disabled: c.disabled,
      placeholder: c.placeholder || (c.type === 'text' ? 'поиск' : ''),
      'aria-label': `Фильтр: ${c.label}`, dataset: { hint }, title: hint,
    });
    inp.addEventListener('input', debounce(() => { state.f[c.key] = inp.value; draw(); }, 150));
    inputs.set(c.key, inp);
    return h('th', { class: c.r ? 'r' : '' }, inp);
  }));
  draw();
  return {
    table: h('div', { class: 'table-wrap', style: maxHeight ? { maxHeight } : null }, h('table', { class: 'tbl dt' }, h('thead', null, head, filters), tbody)),
    tools: h('div', { class: 'dt-tools' }, h('span', { class: 'small muted dt-hint' }, 'Фильтры под заголовками: >90, <50, 10-20, проценты вводятся в процентах. Клик по заголовку сортирует.'), count, reset),
  };
}
