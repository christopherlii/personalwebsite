// Explicit clicks start the browser's speech service. Only its transcript
// enters the journal; audio may be processed by the browser vendor remotely.
export function createDictation({ onState, onMessage, Recognition = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition, language = globalThis.navigator?.language || 'en-US' }) {
  let session = null;
  function finish(current) {
    if (session !== current) return;
    clearTimeout(current.timer); session = null;
    current.recognition.onstart = current.recognition.onresult = current.recognition.onerror = current.recognition.onend = null;
    onState(current.owner, 'idle'); current.resolve?.();
  }
  function cancel() {
    const current = session; if (!current) return;
    finish(current);
    try { current.recognition.abort(); } catch { /* Already ended. */ }
  }
  function stop() {
    const current = session; if (!current) return Promise.resolve();
    if (current.done) return current.done;
    current.done = new Promise(resolve => { current.resolve = resolve; });
    onState(current.owner, 'stopping');
    clearTimeout(current.timer);
    current.timer = setTimeout(() => {
      if (session !== current) return;
      onMessage(current.owner, 'Dictation stopped before the last phrase was returned.'); cancel();
    }, 5000);
    try { current.recognition.stop(); } catch { cancel(); }
    return current.done;
  }
  function start(owner, editor) {
    cancel(); onMessage(owner, '');
    if (!Recognition) { onMessage(owner, 'Dictation isn’t supported by this browser.'); return; }
    if (!editor) return;
    let recognition;
    try { recognition = new Recognition(); }
    catch { onMessage(owner, 'The speech service is unavailable in this browser.'); return; }
    const current = { owner, recognition, seen: new Set() }; session = current;
    recognition.lang = language; recognition.continuous = true; recognition.interimResults = false; recognition.maxAlternatives = 1;
    recognition.onstart = () => {
      if (session !== current || current.done) return;
      clearTimeout(current.timer); onState(owner, 'listening');
    };
    recognition.onresult = event => {
      if (session !== current) return;
      for (let index = event.resultIndex; index < event.results.length; index++) {
        const result = event.results[index];
        if (!result.isFinal || current.seen.has(index)) continue;
        current.seen.add(index);
        const text = result[0]?.transcript?.trim();
        if (text && !editor.insertText(text)) { cancel(); return; }
      }
    };
    recognition.onerror = event => {
      if (session !== current) return;
      const messages = {
        'not-allowed': 'Microphone access was denied. Allow it in your browser, then try again.',
        'service-not-allowed': 'Your browser has blocked its speech service.',
        'audio-capture': 'No microphone is available.',
        'no-speech': 'No speech detected. Try again.',
        'network': 'The speech service is unavailable. Try again.',
        'language-not-supported': 'Your browser’s speech service doesn’t support this language.'
      };
      if (event.error !== 'aborted') onMessage(owner, messages[event.error] || 'Dictation stopped. Try again.');
      cancel();
    };
    recognition.onend = () => finish(current);
    onState(owner, 'starting');
    current.timer = setTimeout(() => { if (session === current) { onMessage(owner, 'Dictation could not start. Check your microphone permission.'); cancel(); } }, 30000);
    try { recognition.start(); editor.focus(); }
    catch { onMessage(owner, 'Dictation could not start. Check your microphone permission.'); cancel(); }
  }
  return { get owner() { return session?.owner || null; }, stop, cancel,
    toggle(owner, editor) { return session?.owner === owner ? stop() : start(owner, editor); }
  };
}
