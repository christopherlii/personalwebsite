export function listeningItem(value, type) {
  if (!value || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 300 ||
      typeof value.url !== 'string' || !new RegExp(`^https://open\\.spotify\\.com/${type}/[A-Za-z0-9]{22}$`).test(value.url)) return null;
  const artists = type === 'track' && Array.isArray(value.artists)
    ? value.artists.filter(name => typeof name === 'string' && name.length <= 200).slice(0, 12) : [];
  return { name: value.name, url: value.url, text: value.name + (artists.length ? ` by ${artists.join(', ')}` : '') };
}

if (typeof document !== 'undefined') {
  const rows = ['track', 'artist'].map(type => {
    const row = document.getElementById(`listening-${type}`);
    return { type, row, label: row?.querySelector('[data-listening-label]'), value: row?.querySelector('[data-listening-value]') };
  }).map(entry => ({ ...entry, fallbackLabel: entry.label?.textContent, fallbackValue: entry.value?.textContent }));
  let pending, checkedAt = 0;
  async function update() {
    if (!['#stats', '#youre-already-here'].includes(location.hash) || pending || Date.now() - checkedAt < 1200000) return;
    pending = (async () => {
      try {
        const source = await fetch('/writing-source.json', { cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(8000) }).then(r => r.ok ? r.json() : null);
        if (!source?.listening) return;
        const response = await fetch(source.listening, { cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(8000) });
        if (!response.ok) return;
        const data = await response.json();
        if (data.time_range !== 'short_term') return;
        for (const { type, row, label, value, fallbackLabel, fallbackValue } of rows) {
          if (!row || !label || !value) continue;
          const item = listeningItem(data[type], type);
          if (!item) { label.textContent = fallbackLabel; value.textContent = fallbackValue; row.removeAttribute('title'); continue; }
          label.textContent = type === 'track' ? 'top song this week' : 'top artist this week';
          const link = document.createElement('a');
          link.href = item.url; link.textContent = item.text; link.target = '_blank'; link.rel = 'noopener noreferrer';
          value.replaceChildren(link);
          const date = new Date(data.updated_at);
          row.title = 'Spotify · approximately the past four weeks' + (Number.isNaN(date.getTime()) ? '' : ` · updated ${date.toLocaleDateString()}`);
        }
        checkedAt = Date.now();
      } catch { /* Keep the existing favorites if the connection is unavailable. */ }
    })();
    await pending; pending = null;
  }
  addEventListener('hashchange', update);
  addEventListener('popstate', update);
  update();
}
