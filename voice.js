// Records one spoken question and plays spoken lines. Shared by the extension's hidden page (offscreen.html)
// and the website demo. Audio is held in memory only until it is handed back; nothing is stored here.
(() => {
  let rec = null;

  const b64 = (blob) => new Promise((resolve) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
    fr.readAsDataURL(blob);
  });

  // Resolves once with { ok, audio (base64), mime } when the speaker pauses, after 12 s, or when stop() is called.
  async function listen({ maxMs = 12000 } = {}) {
    if (rec) return { ok: false, error: 'busy' };
    if (!navigator.mediaDevices?.getUserMedia || !self.MediaRecorder) return { ok: false, error: 'unsupported' };
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
    } catch (e) {
      return { ok: false, error: e.name === 'NotAllowedError' || e.name === 'SecurityError' ? 'permission' : e.name === 'NotFoundError' ? 'nomic' : 'unsupported' };
    }
    return new Promise((resolve) => {
      const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((t) => MediaRecorder.isTypeSupported(t));
      const mr = new MediaRecorder(stream, { ...(type ? { mimeType: type } : {}), audioBitsPerSecond: 32000 });
      const me = rec = { mr, spoke: false, signal: false, manual: false, cancelled: false, timer: 0, ctx: null };
      const chunks = [];
      mr.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      mr.onstop = async () => {
        clearInterval(me.timer);
        stream.getTracks().forEach((t) => t.stop());
        const heardLevels = me.ctx?.state === 'running' && me.signal;
        me.ctx?.close().catch(() => {});
        if (rec === me) rec = null;
        if (me.cancelled) return resolve({ ok: false, error: 'cancelled' });
        const blob = new Blob(chunks, { type: mr.mimeType || type || 'audio/webm' });
        // Nothing but room noise: do not send it. If levels could not be measured, send it and let the server decide.
        if (blob.size < 1200 || (heardLevels && !me.spoke && !me.manual)) return resolve({ ok: true, audio: '' });
        resolve({ ok: true, audio: await b64(blob), mime: blob.type });
      };
      // Stop by itself when the speaker has paused for about a second.
      try {
        const ctx = me.ctx = new AudioContext();
        ctx.resume().catch(() => {});
        const an = ctx.createAnalyser();
        an.fftSize = 1024;
        ctx.createMediaStreamSource(stream).connect(an);
        const buf = new Float32Array(an.fftSize);
        const t0 = performance.now();
        let quietSince = 0;
        me.timer = setInterval(() => {
          const now = performance.now();
          if (ctx.state === 'running') {
            an.getFloatTimeDomainData(buf);
            let sum = 0;
            for (const v of buf) sum += v * v;
            if (sum > 0) me.signal = true; // a real microphone is never perfectly silent; all zeros means levels cannot be read here
            if (Math.sqrt(sum / buf.length) > 0.018) { me.spoke = true; quietSince = 0; } else if (!quietSince) quietSince = now;
            if (me.spoke && quietSince && now - quietSince > 1100) return stop();
            if (me.signal && !me.spoke && now - t0 > 7000) return stop();
          }
          if (now - t0 > maxMs) stop();
        }, 80);
      } catch {
        me.timer = setInterval(stop, maxMs);
      }
      mr.start();
    });
  }
  function end(how) {
    const me = rec;
    if (!me || me.mr.state === 'inactive') return;
    me[how] = true;
    me.mr.stop();
  }
  const stop = () => end('auto'); // a pause, or the time limit
  const send = () => end('manual'); // the listener pressed Send: trust that they spoke
  const cancel = () => end('cancelled');

  // ---------- speaking: a small queue of lines ----------
  let queue = [], playing = null;
  function next() {
    const item = queue.shift();
    if (!item) { playing = null; return; }
    let over = false;
    const done = () => { if (!over) { over = true; if (playing === me) next(); } };
    const a = new Audio(item.url);
    const me = playing = { a, done };
    a.onended = done;
    a.onerror = () => fallback(item, done);
    a.play().catch(() => fallback(item, done));
  }
  // The server voice is unavailable (offline, quota): use the browser's own voice so the guide still talks.
  function fallback(item, done) {
    if (!item.text || !self.speechSynthesis || !self.SpeechSynthesisUtterance) return done();
    try {
      const u = new SpeechSynthesisUtterance(item.text);
      u.lang = 'en-US';
      u.onend = u.onerror = done;
      item.text = ''; // once only
      speechSynthesis.speak(u);
    } catch { done(); }
  }
  // say({ url, text }, keep): plays the line; unless keep is true, it replaces whatever was being said.
  function say(item, keep) {
    if (!keep) hush();
    queue.push(item);
    if (!playing) next();
  }
  function hush() {
    queue = [];
    if (playing) { playing.a.onended = playing.a.onerror = null; try { playing.a.pause(); } catch {} playing = null; }
    try { self.speechSynthesis?.cancel(); } catch {}
  }

  self.OnrampVoice = { listen, stop: send, cancel, say, hush, can: () => !!(navigator.mediaDevices?.getUserMedia && self.MediaRecorder) };
})();
