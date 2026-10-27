// Импорт: клиент Web Worker и мастер «Обновить данные» (выбор файлов → проверка → предпросмотр → применение).
// Снимок применяется только после подтверждения; накопительные заявки 2026 заменяются, а не складываются.

import { h, clear, fmt, NA, na, icon, modal, toast, plural } from './ui.js';
import { KIND_LABEL, SKIP_KINDS } from './core/edc.js';
import { getSourcesState, fetchSourceFiles, openSourcesDialog } from './sources.js';
import { NA_REASON } from './analytics.js';

export class WorkerClient {
  constructor() {
    this.w = new Worker(new URL('./workers/import.worker.js', import.meta.url), { type: 'module' });
    this.seq = 0;
    this.pending = new Map();
    this.w.onmessage = (ev) => {
      const { id, type, ...rest } = ev.data;
      const p = this.pending.get(id);
      if (!p) return;
      if (type === 'progress') { p.onProgress && p.onProgress(rest); return; }
      this.pending.delete(id);
      if (type === 'error') {
        const err = new Error(rest.message);
        err.details = rest.details;
        p.reject(err);
      } else p.resolve({ type, ...rest, id });
    };
    this.w.onerror = (e) => {
      const msg = e.message || 'Ошибка Web Worker (браузер не поддерживает module worker?)';
      for (const p of this.pending.values()) p.reject(new Error(msg));
      this.pending.clear();
    };
  }

  call(cmd, payload = {}, { onProgress } = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      this.w.postMessage({ id, cmd, ...payload });
    });
  }
}

// ---------------------------------------------------------------- мастер импорта

function classify(detected) {
  const by = (k) => detected.filter((d) => d.kind === k);
  const plan = { mji: by('mji')[0] || null, edc: null, geo: by('geo'), control: by('control'), unknown: by('unknown'), notes: [],
    skipped: detected.filter((d) => SKIP_KINDS.has(d.kind)) };
  const H = by('houses')[0]; const E = by('entrances')[0]; const R = by('requests')[0];
  const HM = by('houses_merged')[0]; const EM = by('entrances_merged')[0];
  if (H || E) {
    plan.edc = { mode: 'raw', files: { houses: H, entrances: E, requests: R } };
    const miss = [!H && '01_дома.csv (SQL № 2)', !E && '02_подъезды.csv (SQL № 3)', !R && '03_заявки_2026.csv (SQL № 4)'].filter(Boolean);
    if (miss.length) plan.notes.push(`Для импорта сырых выгрузок не хватает: ${miss.join(', ')}.`);
    if (HM || EM) plan.notes.push('Выбраны и исходные, и объединённые CSV. Будут использованы исходные.');
  } else if (HM || EM) {
    plan.edc = { mode: 'merged', files: { houses: HM, entrances: EM } };
    const miss = [!HM && 'Дома_ЕДЦ_2026_с_заявками.csv', !EM && 'Подъезды_ЕДЦ_2026_с_заявками.csv'].filter(Boolean);
    if (miss.length) plan.notes.push(`Для режима объединённых CSV не хватает: ${miss.join(', ')}.`);
    if (R) plan.notes.push('Файл заявок SQL № 4 не нужен в режиме объединённых CSV и будет пропущен.');
  } else if (R) {
    plan.edc = { mode: 'requests', files: { requests: R } };
    plan.notes.push('Будут обновлены только заявки 2026: адреса и подъезды берутся из текущего снимка ЕДЦ (разные даты среза!).');
  }
  if (by('mji').length > 1) plan.notes.push('Выбрано несколько файлов МЖИ, будет использован первый.');
  return plan;
}

function edcReady(plan) {
  if (!plan.edc) return false;
  const f = plan.edc.files;
  if (plan.edc.mode === 'raw') return !!(f.houses && f.entrances && f.requests);
  if (plan.edc.mode === 'merged') return !!(f.houses && f.entrances);
  return !!f.requests;
}

const MODE_LABEL = {
  raw: 'Три исходных CSV (SQL № 2, № 3, № 4), объединение по правилам S2',
  merged: 'Два объединённых CSV (результат merge_edc_houses.py / merge_edc_entrances.py)',
  requests: 'Только заявки 2026 (SQL № 4) поверх текущего снимка адресов',
};

/**
 * Открыть мастер. app: {worker, state, reload(), importGeoFiles(files)}.
 * initialFiles - File[] (например, найденные в data/local).
 */
export function openImportWizard(app, initialFiles = []) {
  let files = [...initialFiles];
  let detected = [];
  let sourcesState = null;
  getSourcesState().then((st) => { sourcesState = st; if (st && !files.length) renderSelect(); });
  let matchByNumber = false;
  // Закрытие окна крестиком/Esc во время предпросмотра = отмена импорта (staging-снимок удаляется).
  let onDismiss = null;
  const dlg = modal({ title: 'Обновить данные', body: h('div'), wide: true, actions: [], onClose: () => { if (onDismiss) onDismiss(); } });

  const input = h('input', { type: 'file', multiple: true, accept: '.csv,.xlsx,.txt,.json,.geojson', class: 'hidden', onchange: (e) => addFiles([...e.target.files]) });
  async function addFiles(list) {
    const names = new Set(files.map((f) => f.name + f.size));
    for (const f of list) if (!names.has(f.name + f.size)) files.push(f);
    await redetect();
  }
  async function redetect() {
    detected = files.length ? (await app.worker.call('detect', { files })).result : [];
    renderSelect();
  }

  function renderSelect() {
    const plan = classify(detected.map((d, i) => ({ ...d, file: files[i] })));
    const zone = h('div', {
      class: 'dropzone', tabindex: 0, role: 'button',
      onclick: () => input.click(),
      onkeydown: (e) => { if (e.key === 'Enter') input.click(); },
      ondragover: (e) => { e.preventDefault(); zone.classList.add('over'); },
      ondragleave: () => zone.classList.remove('over'),
      ondrop: (e) => { e.preventDefault(); zone.classList.remove('over'); addFiles([...e.dataTransfer.files]); },
    }, icon('upload', 28), h('div', { style: { marginTop: '6px' } }, h('b', null, 'Перетащите файлы сюда'), ' или нажмите, чтобы выбрать'),
    h('div', { class: 'small muted', style: { marginTop: '4px' } }, 'МЖИ (.xlsx/.csv), ЕДЦ: три CSV SQL № 2/3/4 или два объединённых CSV, заявки отдельно, геоданные (.csv/.geojson), контрольные .txt'));
    const list = h('div', { class: 'file-list' }, detected.map((d, i) => h('div', { class: 'file-item' },
      h('div', null, h('div', { class: 'fn' }, d.name), h('div', { class: 'small muted' }, fmt.bytes(d.size), d.error ? `, ошибка: ${d.error}` : '')),
      h('span', { class: `chip ${d.kind === 'unknown' ? 'warn' : SKIP_KINDS.has(d.kind) ? '' : 'accent'}` }, d.kind === 'control' ? 'Контрольный отчёт S2' : KIND_LABEL[d.kind] || d.kind),
      h('button', { class: 'icon-btn', 'aria-label': 'Убрать файл', onclick: () => { files.splice(i, 1); redetect(); } }, icon('close', 16)))));
    const fromFolder = sourcesState ? h('div', { class: 'actions-row' },
      h('button', {
        class: 'btn btn-sm', onclick: async (ev) => {
          ev.target.disabled = true;
          try {
            const st = await getSourcesState();
            const roles = Object.keys(st.files).filter((r) => st.files[r].exists);
            if (!roles.length) { toast('В папке выгрузок не найдено ни одного файла. Проверьте путь и имена.', 'error'); return; }
            await addFiles(await fetchSourceFiles(st, roles, () => {}));
          } catch (e) { toast(e.message, 'error'); } finally { ev.target.disabled = false; }
        },
      }, icon('database', 14), 'Взять из папки выгрузок'),
      h('button', { class: 'btn btn-sm btn-ghost', onclick: () => openSourcesDialog(app) }, 'Настроить путь и имена файлов')) : null;
    const body = h('div', { class: 'stack' }, zone, input, fromFolder, detected.length ? list : null);
    const steps = [];
    if (plan.mji) steps.push(h('li', null, 'Реестр МЖИ: ', h('b', null, plan.mji.name)));
    if (plan.edc) steps.push(h('li', null, 'ЕДЦ: ', MODE_LABEL[plan.edc.mode]));
    if (plan.geo.length) steps.push(h('li', null, `Геоданные: ${plan.geo.map((g) => g.name).join(', ')}`));
    if (steps.length) body.append(h('div', { class: 'note' }, icon('list'), h('div', null, h('b', null, 'План импорта'), h('ol', { style: { margin: '4px 0 0', paddingLeft: '18px' } }, steps))));
    for (const n of plan.notes) body.append(h('div', { class: 'note warn' }, icon('warn'), h('div', null, n)));
    if (plan.skipped.length) {
      body.append(h('div', { class: 'note' }, icon('info'), h('div', null, h('b', null, 'Для импорта не нужны и будут пропущены: '),
        plan.skipped.map((x) => x.name).join('; '), '.')));
    }
    for (const u of plan.unknown) {
      body.append(h('div', { class: 'note error' }, icon('warn'), h('div', null, h('b', null, `${u.name}: формат не распознан.`),
        h('div', { class: 'small' }, u.error ? u.error : `Заголовки: ${(u.header || []).slice(0, 12).join(' | ')}`))));
    }
    if (plan.edc && plan.edc.mode !== 'merged') {
      body.append(h('label', { class: 'check-row' }, h('input', { type: 'checkbox', checked: matchByNumber, onchange: (e) => { matchByNumber = e.target.checked; } }),
        h('div', null, h('b', null, 'Дополнительно сопоставлять заявки по номеру подъезда (условно)'),
          h('div', { class: 'small muted' }, 'Аналог --match-by-number из S2: только если номер встречается в доме ровно один раз. Для официальных счётчиков рекомендуется оставить выключенным.'))));
    }
    body.append(h('div', { class: 'note' }, icon('info'), h('div', { class: 'small' },
      'Файлы обрабатываются локально в браузере (Web Worker) и никуда не отправляются. Новый снимок заменяет предыдущий целиком, заявки 2026 не суммируются с прошлым месяцем. Геоточки, контуры, зоны подъездов и ручные соответствия сохраняются.')));
    dlg.setBody(body);
    const canRun = !!plan.mji || edcReady(plan) || plan.geo.length > 0;
    dlg.setActions([
      { label: 'Закрыть' },
      { label: 'Проверить и показать изменения', kind: 'primary', disabled: !canRun, close: false, onClick: () => run(plan) },
    ]);
  }

  async function run(plan) {
    const queue = [];
    if (plan.mji) queue.push({ kind: 'mji', file: plan.mji.file });
    if (edcReady(plan)) queue.push({ kind: 'edc', mode: plan.edc.mode, files: Object.fromEntries(Object.entries(plan.edc.files).filter(([, v]) => v).map(([k, v]) => [k, v.file])) });
    const controlTexts = [];
    for (const c of plan.control) controlTexts.push({ name: c.name, text: await c.file.text() });
    let applied = 0;
    for (const job of queue) {
      const ok = await runJob(job, controlTexts);
      if (ok === 'cancelled-all') break;
      if (ok === 'error') {
        // Сообщение об ошибке остаётся на экране; уже применённые шаги отражаем в интерфейсе.
        if (applied) await app.reload();
        return;
      }
      if (ok) applied++;
    }
    if (plan.geo.length) {
      await app.importGeoFiles(plan.geo.map((g) => g.file));
      applied++;
    }
    onDismiss = null;
    dlg.close();
    if (applied) await app.reload();
  }

  function progressView(title) {
    const bar = h('i');
    const stage = h('div', { class: 'small ink2' }, 'Подготовка...');
    const box = h('div', { class: 'stack' }, h('h3', null, title), h('div', { class: 'progress' }, bar), stage,
      h('div', { class: 'small muted' }, 'Большие файлы (сотни мегабайт) обрабатываются порциями; вкладку не закрывайте.'));
    return { box, set: (p) => { bar.style.width = `${p.pct || 0}%`; stage.textContent = `${p.stage || ''}${p.rows ? `, строк: ${fmt.int(p.rows)}` : ''}`; } };
  }

  function runJob(job, controlTexts) {
    return new Promise((resolve) => {
      onDismiss = () => { onDismiss = null; resolve('cancelled-all'); };
      const pv = progressView(job.kind === 'mji' ? 'Импорт реестра МЖИ' : `Импорт ЕДЦ: ${MODE_LABEL[job.mode]}`);
      dlg.setBody(pv.box);
      dlg.setActions([]);
      const cmd = job.kind === 'mji' ? app.worker.call('importMji', { file: job.file }, { onProgress: pv.set })
        : app.worker.call('importEdc', { mode: job.mode, files: job.files, opts: { matchByNumber }, controlTexts }, { onProgress: pv.set });
      cmd.then((res) => {
        const p = res.preview;
        window.__lastPreview = p; // для e2e-тестов
        onDismiss = () => { onDismiss = null; app.worker.call('cancel', { target: res.id }).catch(() => {}); toast('Импорт отменён, данные не изменены'); resolve('cancelled-all'); };
        const dateInput = h('input', { type: 'date', value: p.suggestedDate || '' });
        dlg.setTitle(job.kind === 'mji' ? 'Предпросмотр: реестр МЖИ' : 'Предпросмотр: выгрузка ЕДЦ');
        dlg.setBody(renderPreview(p, dateInput));
        dlg.setActions([
          { label: 'Отменить импорт', close: false, onClick: async () => { onDismiss = null; await app.worker.call('cancel', { target: res.id }); toast('Импорт отменён, данные не изменены'); resolve(false); } },
          {
            label: 'Применить снимок', kind: 'primary', disabled: p.blocking, close: false, icon: 'check',
            onClick: async () => {
              onDismiss = null;
              const pv2 = progressView('Применение снимка');
              dlg.setBody(pv2.box); dlg.setActions([]);
              try {
                await app.worker.call('commit', { target: res.id, dataDate: dateInput.value }, { onProgress: pv2.set });
                toast(job.kind === 'mji' ? 'Реестр МЖИ обновлён' : 'Снимок ЕДЦ обновлён', 'ok');
                resolve(true);
              } catch (e) {
                showError(e); resolve('error');
              }
            },
          },
        ]);
      }).catch((e) => { showError(e); resolve('error'); });
    });
  }

  function showError(e) {
    dlg.setTitle('Импорт остановлен');
    dlg.setBody(h('div', { class: 'note error' }, icon('warn'), h('div', null, h('b', null, 'Ошибка: '), e.message,
      h('div', { class: 'small', style: { marginTop: '6px' } }, 'Данные приложения не изменены. Проверьте экспорт (полный результат, CSV, заголовки включены) и повторите.'))));
    dlg.setActions([{ label: 'Закрыть' }]);
  }

  input.addEventListener('click', (e) => e.stopPropagation());
  if (files.length) redetect(); else renderSelect();
  return dlg;
}

// ---------------------------------------------------------------- предпросмотр

function kpiCmp(before, after) {
  const rows = [
    ['МКД МЖИ', (k) => fmt.int(k.mkd)],
    ['Сопоставлено с ЕДЦ', (k) => `${fmt.int(k.matched)} (${fmt.pct(k.matchRate)})`],
    ['Обслуживаются в ЕДЦ', (k) => (k.served !== undefined ? `${fmt.int(k.served)} (${fmt.pct(k.servedShare)})` : NA)],
    ['Обслуживается часть подъездов', (k) => (k.hs && k.hs.partial !== undefined ? fmt.int(k.hs.partial) : NA)],
    ['Не обслуживаются', (k) => (k.hs && k.hs.none !== undefined ? fmt.int(k.hs.none) : NA)],
    ['% подъездов обслуживается', (k) => fmt.pct(k.entrShare)],
    ['Заявок 2026 (дом)', (k) => fmt.int(k.req.total)],
  ];
  return h('div', { class: 'cmp' }, h('div', { class: 'h' }, 'Показатель'), h('div', { class: 'h num' }, 'Сейчас'), h('div', { class: 'h num' }, 'После'),
    rows.map(([l, f]) => [h('div', null, l), h('div', { class: 'num muted' }, before ? f(before) : na()), h('div', { class: 'num' }, h('b', null, after ? f(after) : na()))]));
}

function diffTiles(d, hasPrev, unit) {
  if (!hasPrev) return h('div', { class: 'note' }, icon('info'), h('div', null, `Первый импорт: предыдущего снимка нет, все ${unit} новые.`));
  const t = (label, n, ex) => h('div', { class: 'mini' }, h('div', { class: 'v' }, fmt.int(n)), h('div', { class: 'l' }, label),
    ex && ex.length ? h('details', null, h('summary', { class: 'small' }, 'примеры'), h('div', { class: 'small mono' }, ex.map((x) => h('div', null, x)))) : null);
  return h('div', { class: 'diff-grid' }, t('новых', d.added, d.examples.added), t('изменилось', d.changed, d.examples.changed),
    t('исчезло (помечаются, не удаляются)', d.gone, d.examples.gone), t('без изменений', d.same));
}

function issues(report) {
  const out = [];
  for (const e of report.errors || []) out.push(h('div', { class: 'note error' }, icon('warn'), h('div', null, h('b', null, 'Критическая ошибка: '), e)));
  for (const w of report.warnings || []) out.push(h('div', { class: 'note warn' }, icon('warn'), h('div', null, w)));
  if (!out.length) out.push(h('div', { class: 'note ok' }, icon('checkCircle'), h('div', null, 'Проверки пройдены: обязательные колонки найдены, ключи уникальны.')));
  return out;
}

function renderPreview(p, dateInput) {
  const box = h('div', { class: 'stack' });
  box.append(...issues(p.report));
  if (p.source === 'mji') {
    const r = p.report;
    box.append(h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', null, p.file.name), h('span', { class: 'sub' }, `${fmt.int(r.rowsTotal)} записей, ${p.file.format?.toUpperCase() || ''}`)),
      h('div', { class: 'mini-kpis' },
        mini(r.rowsTotal, 'записей МЖИ'), mini(Object.keys(r.byOkrug || {}).filter((k) => k !== 'Без округа').length, 'округов'),
        mini(r.areas, 'районов'), mini(r.noFias + r.invalidFias, 'без корректного ФИАС'))));
  } else {
    box.append(edcControl(p));
  }
  box.append(h('div', { class: 'card' }, h('h3', { style: { marginBottom: '8px' } }, 'Изменения относительно текущего снимка'), diffTiles(p.diff, p.hasPrev, p.source === 'mji' ? 'дома' : 'адреса')));
  if (p.kpiAfter) box.append(h('div', { class: 'card' }, h('h3', { style: { marginBottom: '8px' } }, 'Как изменятся показатели'), kpiCmp(p.kpiBefore, p.kpiAfter),
    p.kpiAfter && p.kpiAfter.na ? h('div', { class: 'small muted', style: { marginTop: '8px' } }, 'Не оценено: ',
      Object.entries(p.kpiAfter.na).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${NA_REASON[k] || k}: ${fmt.int(n)}`).join('; ')) : null));
  else if (p.source === 'edc' && !p.hasMji) box.append(h('div', { class: 'note' }, icon('info'), h('div', null, 'Реестр МЖИ ещё не загружен: рейтинги по округам появятся после его импорта.')));
  box.append(h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', null, 'Дата среза данных'),
    h('span', { class: 'sub' }, p.source === 'mji' ? 'по имени файла' : 'по последней дате заявки / дате файла')), dateInput,
  h('div', { class: 'small muted', style: { marginTop: '6px' } }, 'Отображается рядом с показателями. 2026 год не завершён, IV квартал неполный.')));
  return box;
}

function mini(v, l) {
  return h('div', { class: 'mini' }, h('div', { class: 'v' }, typeof v === 'number' ? fmt.int(v) : v), h('div', { class: 'l' }, l));
}

function edcControl(p) {
  const c = p.report.control || {};
  const card = h('div', { class: 'card stack' });
  card.append(h('div', { class: 'card-head' }, h('h3', null, MODE_LABEL[p.mode]), h('span', { class: 'sub' }, p.report.files.map((f) => `${f.name}${f.reused ? ' (из текущего снимка)' : ''}: ${fmt.int(f.rows)} строк${f.encoding ? `, ${f.encoding}` : ''}`).join(', '))));
  const hc = c.houses || {};
  const ec = c.entrances || {};
  card.append(h('div', { class: 'mini-kpis' },
    mini(hc.rows, 'адресов (строк SQL № 2)'), mini(ec.real, 'реальных подъездов'), mini(ec.stubs, 'строк-заглушек без подъездов'), mini(hc.matched, 'адресов с заявками 2026')));
  if (c.requests) {
    card.append(h('div', { class: 'small ink2' }, `Агрегатов заявок: уровень «Дом» ${fmt.int(c.requests.houseLevel)}, «Подъезд» ${fmt.int(c.requests.entranceLevel)}. `,
      `Заявок 2026 в домовых агрегатах: ${fmt.int(c.requests.houseLevelRequests)}. Уровни «Дом» и «Подъезд» не складываются.`));
  }
  const um = (rep, title) => {
    if (!rep) return null;
    return h('details', null, h('summary', null, `${title}: не сопоставлено ${fmt.int(rep.unmatched)} из ${fmt.int(rep.loaded)} агрегатов (${fmt.int(rep.unmatchedRequests)} заявок)`),
      h('table', { class: 'tbl', style: { marginTop: '6px' } }, h('thead', null, h('tr', null, h('th', null, 'Тип ключа адреса / подъезда'), h('th', { class: 'r' }, 'Агрегатов'), h('th', { class: 'r' }, 'Заявок'))),
        h('tbody', null, rep.groups.map((g) => h('tr', null, h('td', { class: 'mono' }, g.key), h('td', { class: 'r' }, fmt.int(g.count)), h('td', { class: 'r' }, fmt.int(g.requests)))))),
      rep.examples.length ? h('pre', { class: 'raw' }, rep.examples.join('\n')) : null);
  };
  card.append(um(c.unmatchedHouse, 'Домовой уровень'), um(c.unmatchedEntrance, 'Подъездный уровень (UNKNOWN, entrances.id, NUMBER не распределяются)'));
  if (hc.mismatch) card.append(h('div', { class: 'small muted' }, `Расхождение УНОМ между адресом и заявками (сопоставление по UUID сохранено): ${fmt.int(hc.mismatch)} ${plural(hc.mismatch, 'дом', 'дома', 'домов')}.`));
  if (ec.matchByNumber) card.append(h('div', { class: 'note warn' }, icon('warn'), h('div', null, `Включено условное сопоставление по номеру подъезда: добавлено ${fmt.int(ec.numberMatched)} совпадений, неоднозначных номеров ${fmt.int(ec.ambiguousNumbers)}.`)));
  return card;
}

// ---------------------------------------------------------------- файлы из data/local

/** Список файлов в data/local (через листинг каталога локального сервера). */
export async function discoverLocal() {
  try {
    const res = await fetch('data/local/', { cache: 'no-store' });
    if (!res.ok) return [];
    const html = await res.text();
    const names = [...html.matchAll(/href="([^"?#]+)"/g)].map((m) => decodeURIComponent(m[1]))
      .filter((n) => !n.endsWith('/') && /\.(xlsx|csv|txt|geojson|json)$/i.test(n) && !n.startsWith('.') && !/\.pmtiles\.json$/i.test(n));
    return [...new Set(names)].map((n) => ({ name: n.split('/').pop(), url: `data/local/${encodeURIComponent(n.split('/').pop())}` }));
  } catch (_) {
    return [];
  }
}

export async function fetchLocalFiles(list) {
  const out = [];
  for (const it of list) {
    const res = await fetch(it.url, { cache: 'no-store' });
    if (!res.ok) continue;
    const blob = await res.blob();
    const lm = Date.parse(res.headers.get('last-modified') || '') || Date.now();
    out.push(new File([blob], it.name, { lastModified: lm }));
  }
  return out;
}

export { clear };
