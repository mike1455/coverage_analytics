// «Папка с выгрузками»: загрузка ваших файлов прямо с диска через локальный serve.py.
// Путь к папке и имена файлов вводятся в интерфейсе и сохраняются в config/sources.local.json.
// Браузер сам не может читать C:\..., поэтому файлы отдаёт serve.py - только по путям из настроек и только на localhost.

import { h, clear, fmt, NA, icon, modal, toast } from './ui.js';

const ROLE_ORDER = ['mji', 'houses', 'entrances', 'requests', 'geo'];
const ROLE_SHORT = { mji: 'Реестр МЖИ', houses: 'SQL № 2 (дома)', entrances: 'SQL № 3 (подъезды)', requests: 'SQL № 4 (заявки 2026)', geo: 'Геоданные' };
const SNAP_SOURCE = { mji: 'mji', houses: 'edc', entrances: 'edc', requests: 'edc' };

/** Состояние источников или null, если приложение запущено не через serve.py. */
export async function getSourcesState() {
  try {
    const r = await fetch('api/sources', { cache: 'no-store' });
    if (!r.ok) return null;
    const st = await r.json();
    return st && st.files ? st : null;
  } catch (_) {
    return null;
  }
}

export async function saveSources(cfg) {
  const r = await fetch('api/sources', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) });
  const st = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(st.error || `Ошибка сохранения (${r.status})`);
  return st;
}

/** Открыть текущую папку с выгрузками в проводнике (Windows) - делает serve.py. */
export async function openFolder() {
  const r = await fetch('api/open-folder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `Не удалось открыть папку (${r.status})`);
  return d.opened;
}

/** Прочитать файлы выбранных ролей с диска → File[] (имя и дата изменения - как у исходных файлов). */
export async function fetchSourceFiles(state, roles, onProgress = () => {}) {
  const out = [];
  let i = 0;
  for (const role of roles) {
    const f = state.files[role];
    i++;
    if (!f || !f.exists) continue;
    onProgress({ role, i, n: roles.length, stage: `Чтение с диска: ${f.name} (${fmt.bytes(f.size)})` });
    const r = await fetch(`api/source/${role}`, { cache: 'no-store' });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.error || `Не удалось прочитать ${f.name} (${r.status})`);
    }
    const blob = await r.blob();
    const name = decodeURIComponent(r.headers.get('X-File-Name') || encodeURIComponent(f.name));
    out.push(new File([blob], name, { lastModified: f.mtime || Date.now() }));
  }
  return out;
}

/** Файл уже загружен в активный снимок (то же имя, размер и дата изменения)? */
export function alreadyLoaded(app, role, f) {
  const src = SNAP_SOURCE[role];
  if (!src || !f || !f.exists) return false;
  const snap = src === 'mji' ? app.state.snapMji : app.state.snapEdc;
  if (!snap || !snap.files) return false;
  const base = (n) => String(n || '').split(/[\\/]/).pop();
  return snap.files.some((x) => (x.role === role || (role === 'mji' && x.role === 'mji')) && !x.reused &&
    base(x.name) === base(f.path) && x.size === f.size && (!x.lastModified || x.lastModified === f.mtime));
}

function statusChip(f) {
  if (!f.name) return h('span', { class: 'chip' }, 'не задан');
  if (f.exists) {
    return h('div', null, h('span', { class: 'badge st-full' }, icon('check', 13), 'найден'),
      h('div', { class: 'sub', style: { marginTop: '3px' } }, `${fmt.bytes(f.size)}, ${fmt.dateTime(f.mtime)}`));
  }
  return h('span', { class: 'badge st-none', style: { whiteSpace: 'normal' } }, icon('xCircle', 13), f.reason || 'не найден');
}

/**
 * Окно настройки и загрузки. app: {state, worker, reload}, onLoad(files) - что делать с прочитанными файлами
 * (по умолчанию открыть мастер импорта).
 */
export async function openSourcesDialog(app, { onLoad } = {}) {
  let st = await getSourcesState();
  const dlg = modal({ title: 'Папка с выгрузками', body: h('div'), wide: true, actions: [] });
  if (!st) {
    dlg.setBody(h('div', { class: 'note warn' }, icon('warn'), h('div', null,
      h('b', null, 'Загрузка из папки работает при запуске через serve.py. '),
      'Закройте окно сервера и запустите приложение командой ', h('span', { class: 'mono' }, 'py -3 serve.py'),
      ' (или двойным щелчком по start.bat). Пока можно перетащить файлы в «Обновить данные».')));
    dlg.setActions([{ label: 'Закрыть' }]);
    return;
  }
  const picked = {};
  for (const r of ROLE_ORDER) picked[r] = !!(st.files[r] && st.files[r].exists && !alreadyLoaded(app, r, st.files[r]));
  const folderIn = h('input', { type: 'text', value: st.folder, style: { width: '100%' }, 'aria-label': 'Папка с выгрузками', spellcheck: 'false' });
  const nameIn = {};
  const listId = 'mca-folder-files';

  const collect = () => ({ folder: folderIn.value, files: Object.fromEntries(ROLE_ORDER.map((r) => [r, nameIn[r] ? nameIn[r].value : (st.files[r] && st.files[r].name) || ''])) });

  const render = () => {
    const box = h('div', { class: 'stack' });
    box.append(h('p', { class: 'ink2' }, 'Проще всего положить выгрузки в папку ', h('b', { class: 'mono' }, 'data/input'),
      ' внутри приложения под именами из таблицы ниже. Имена и папку можно поменять: впишите свои или выберите из подсказки (имя может быть и полным путём). ',
      'Настройки сохраняются на этом компьютере (', h('span', { class: 'mono small' }, 'config/sources.local.json'), ') и при следующем запуске подставятся сами.'));
    box.append(h('div', { class: 'field-inline' }, h('label', null, 'Папка'),
      h('div', { style: { display: 'flex', gap: '8px' } }, folderIn,
        h('button', {
          class: 'btn', title: 'Открыть папку в проводнике', onclick: async () => {
            try { await openFolder(); } catch (e) { toast(e.message, 'error'); }
          },
        }, icon('database', 15), 'Открыть папку'))));
    box.append(h('div', { class: 'small' }, st.folderExists
      ? h('span', null, h('span', { class: 'badge st-full' }, icon('check', 13), 'папка найдена'), ' ', h('span', { class: 'mono' }, st.folderResolved), `, файлов: ${st.folderFiles.length}`)
      : h('span', null, h('span', { class: 'badge st-none' }, icon('xCircle', 13), 'папка не найдена'), ' ', h('span', { class: 'mono' }, st.folderResolved || NA))));
    const dl = h('datalist', { id: listId }, st.folderFiles.map((n) => h('option', { value: n })));
    box.append(dl);
    const rows = ROLE_ORDER.map((r) => {
      const f = st.files[r] || { name: '' };
      const inp = h('input', { type: 'text', value: f.name, list: listId, style: { width: '100%' }, spellcheck: 'false', 'aria-label': ROLE_SHORT[r], title: f.path || f.name });
      nameIn[r] = inp;
      const loaded = alreadyLoaded(app, r, f);
      return h('tr', null,
        h('td', null, h('label', { class: 'check-row' }, h('input', { type: 'checkbox', checked: picked[r], disabled: !f.exists, onchange: (e) => { picked[r] = e.target.checked; } }),
          h('div', null, h('b', null, ROLE_SHORT[r]), h('div', { class: 'sub' }, st.roles[r] || '')))),
        h('td', null, inp),
        h('td', null, statusChip(f), loaded ? h('div', { class: 'sub' }, 'уже загружен в приложение') : null));
    });
    box.append(h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
      h('thead', null, h('tr', null, h('th', { style: { width: '27%' } }, 'Загрузить'), h('th', { style: { width: '45%' } }, 'Имя файла (или полный путь)'), h('th', null, 'Статус'))),
      h('tbody', null, rows))));
    box.append(h('div', { class: 'note' }, icon('info'), h('div', { class: 'small' },
      h('b', null, 'Используются только нужные файлы: '), 'реестр МЖИ и выгрузки SQL № 2, № 3, № 4. ',
      'Запросы № 1 и № 5 (контрольные), № 6 (платные дефекты) и документ .md для расчётов не нужны, их указывать не надо. ',
      'Отмеченные файлы откроются в мастере импорта: сначала проверка и предпросмотр, затем подтверждение.')));
    dlg.setBody(box);
    dlg.setActions([
      { label: 'Закрыть' },
      { label: 'Сохранить и проверить', close: false, icon: 'refresh', onClick: () => doSave() },
      { label: 'Загрузить отмеченные', kind: 'primary', icon: 'upload', close: false, onClick: () => doLoad() },
    ]);
  };

  const doSave = async () => {
    try {
      st = await saveSources(collect());
      for (const r of ROLE_ORDER) picked[r] = !!(st.files[r] && st.files[r].exists && !alreadyLoaded(app, r, st.files[r]));
      render();
      const found = ROLE_ORDER.filter((r) => st.files[r].exists).length;
      toast(`Сохранено. Найдено файлов: ${found}`, found ? 'ok' : 'error');
    } catch (e) { toast(e.message, 'error'); }
  };

  const doLoad = async () => {
    // Сначала сохраняем то, что введено, - загружается ровно то, что видно в окне
    try { st = await saveSources(collect()); } catch (e) { toast(e.message, 'error'); return; }
    const roles = ROLE_ORDER.filter((r) => picked[r] && st.files[r].exists);
    if (!roles.length) { render(); toast('Отметьте хотя бы один найденный файл', 'error'); return; }
    const stage = h('div', { class: 'small ink2' }, 'Чтение файлов с диска...');
    const bar = h('i', { style: { width: '5%' } });
    dlg.setBody(h('div', { class: 'stack' }, h('div', { class: 'progress' }, bar), stage,
      h('div', { class: 'small muted' }, 'Большие CSV читаются несколько секунд; данные не покидают компьютер.')));
    dlg.setActions([]);
    try {
      const files = await fetchSourceFiles(st, roles, (p) => { stage.textContent = p.stage; bar.style.width = `${Math.round((p.i / p.n) * 100)}%`; });
      dlg.close();
      if (onLoad) onLoad(files);
      else {
        const { openImportWizard } = await import('./import.js');
        openImportWizard(app, files);
      }
    } catch (e) {
      toast(e.message, 'error', 8000);
      render();
    }
  };

  render();
}

/** Краткая карточка статуса для раздела «Импорт» и стартового экрана. */
export function sourcesSummary(app, st, { onOpen } = {}) {
  const card = h('div', { class: 'card stack', style: { gap: '8px' } });
  if (!st) {
    card.append(h('div', { class: 'card-head' }, h('h3', null, 'Папка с выгрузками')),
      h('div', { class: 'small ink2' }, 'Загрузка прямо из папки на диске доступна при запуске через ', h('span', { class: 'mono' }, 'py -3 serve.py'), ' или start.bat.'));
    return card;
  }
  const found = ROLE_ORDER.filter((r) => st.files[r] && st.files[r].exists);
  const fresh = found.filter((r) => !alreadyLoaded(app, r, st.files[r]));
  card.append(...[h('div', { class: 'card-head' }, h('h3', null, 'Папка с выгрузками'),
    st.folderExists ? h('span', { class: 'badge st-full' }, icon('check', 13), `найдено файлов: ${found.length}`) : h('span', { class: 'badge st-none' }, icon('xCircle', 13), 'папка не найдена')),
  h('div', { class: 'small mono', style: { overflowWrap: 'anywhere' } }, st.folderResolved || st.folder || NA),
  h('div', { class: 'small ink2' }, ROLE_ORDER.filter((r) => r !== 'geo' || st.files.geo.name).map((r) => {
    const f = st.files[r];
    const mark = f.exists ? (alreadyLoaded(app, r, f) ? 'загружен' : 'новый') : 'нет файла';
    return `${ROLE_SHORT[r]}: ${mark}`;
  }).join('; ')),
  !found.length ? h('div', { class: 'small ink2' }, 'Положите выгрузки в папку ', h('b', { class: 'mono' }, 'data/input'), ' приложения. Нужные имена есть в окне «Папка и имена файлов» и в data/input/README.md.') : null,
  h('div', { class: 'actions-row' },
    h('button', { class: `btn ${fresh.length ? 'btn-primary' : ''}`, onclick: () => (onOpen ? onOpen() : openSourcesDialog(app)) }, icon('database', 16),
      fresh.length ? `Загрузить из папки (${fresh.length})` : 'Папка и имена файлов'),
    h('button', { class: 'btn btn-ghost', onclick: async () => { try { await openFolder(); } catch (e) { toast(e.message, 'error'); } } }, 'Открыть папку'))].filter(Boolean));
  return card;
}

export { clear };
