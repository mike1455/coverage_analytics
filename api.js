// Запросы к локальному серверу serve.py: JSON и ожидание фоновых задач (загрузки карт, адресов, границ).

export async function getJson(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export async function postJson(url, body = {}) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok && r.status !== 409) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

/** Ждать окончания фоновой задачи serve.py, сообщая её ход. */
export async function waitJob(url, onTick = () => {}) {
  for (;;) {
    const st = await getJson(url);
    onTick(st);
    if (!st.job || st.job.state !== 'running') return st;
    await new Promise((r) => setTimeout(r, 1000));
  }
}
