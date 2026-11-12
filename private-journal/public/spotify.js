(() => {
  // Spotify permits explicit loopback IPs, not localhost, as redirect addresses.
  if (location.hostname === 'localhost') {
    const url = new URL(location.href); url.hostname = '127.0.0.1'; location.replace(url); return;
  }
  const $ = id => document.getElementById(id);
  const status = message => { $('status').textContent = message; };
  async function api(path, method = 'GET', body) {
    const response = await fetch(new URL(`api/${path}`, location.href), {
      method, headers: { 'Content-Type': 'application/json', 'X-Journal': '1' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not connect. Try again.');
    return data;
  }
  async function load() {
    const session = await api('session');
    $('login').hidden = session.authenticated;
    $('setup').hidden = !session.authenticated;
    if (!session.ready) { status('The journal backend needs its local password configuration before setup.'); return; }
    if (!session.authenticated) { status('Unlock your journal to manage this connection.'); return; }
    const data = await api('spotify');
    $('redirect').textContent = data.redirect_uri;
    $('client-id').value = data.client_id;
    $('connected').hidden = !data.connected;
    $('connect-button').textContent = data.connected ? 'reconnect Spotify' : 'connect Spotify';
    const track = data.listening?.track, artist = data.listening?.artist;
    $('listening').textContent = data.connected ? `connected${track ? ` · ${track.name}` : ''}${artist ? ` · ${artist.name}` : ''}` : '';
    const outcome = new URL(location.href).searchParams.get('spotify');
    status(outcome === 'cancelled' ? 'Connection cancelled. Your existing settings are unchanged.' : data.connected ? 'Your site updates automatically each day.' : 'Connect your account to start showing your listening stats.');
    if (outcome) history.replaceState(null, '', location.pathname);
  }
  $('login').addEventListener('submit', async event => {
    event.preventDefault();
    try { await api('login', 'POST', { password: $('password').value }); $('password').value = ''; await load(); }
    catch (error) { status(error.message); }
  });
  $('connect').addEventListener('submit', async event => {
    event.preventDefault(); $('connect-button').disabled = true;
    try {
      const data = await api('spotify/connect', 'POST', { client_id: $('client-id').value.trim() });
      const url = new URL(data.url);
      if (url.origin !== 'https://accounts.spotify.com' || url.pathname !== '/authorize') throw new Error('Invalid Spotify authorization address.');
      location.assign(url.href);
    } catch (error) { status(error.message); $('connect-button').disabled = false; }
  });
  $('disconnect').addEventListener('click', async () => {
    $('disconnect').disabled = true;
    try { await api('spotify', 'DELETE'); await load(); }
    catch (error) { status(error.message); }
    finally { $('disconnect').disabled = false; }
  });
  load().catch(error => status(error.message));
})();
