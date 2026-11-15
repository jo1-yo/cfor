// Onramp, on the page: pick a Cloudflare product or ask for what you want (typed or spoken), then a ring
// around the control to act on, a pointer that glides to it, and a short note beside it. Reads control
// labels only; never reads what you type (input steps only check "is it non-empty"). It never clicks for you.
(() => {
  if (window.__onrampLoaded) return;
  window.__onrampLoaded = true;

  const chrome = window.__ONRAMP_ENV?.chrome || globalThis.chrome; // the website demo supplies a stand-in
  const CATALOG = self.ONRAMP_CATALOG || [];
  const GUIDES = self.ONRAMP_GUIDES || {};
  const byId = Object.fromEntries(CATALOG.map((p) => [p.id, p]));
  // The website's demo swaps these to run the same code against a mock dashboard inside a frame.
  const ENV = Object.assign({
    root: () => document.body,
    frame: () => null,
    href: () => location.href,
    go: (url) => { location.href = url; },
  }, window.__ONRAMP_ENV || {});

  const START = ['workers', 'agent-setup', 'r2', 'd1', 'kv', 'workers-ai', 'ai-gateway', 'agents', 'turnstile', 'dns', 'cloudflare-os'];
  const CATEGORIES = ['Developer platform', 'Core platform', 'Application performance', 'Application security', 'Cloudflare One', 'Network security', 'Consumer services'];
  const ROUTES = {
    click: ['Click', 'In the dashboard'],
    code: ['Code', 'In the terminal'],
    agent: ['Agent', 'With Claude Code and MCP'],
    live: ['Live', 'AI reads the page with you'],
  };
  const WHERE = { terminal: 'Terminal', claude: 'Claude Code' };
  const SUPPORTED = /^https:\/\/([\w-]+\.)*(cloudflare\.com|cloudflare\.app)\/|^https:\/\/claude\.ai\//;

  const S = { ready: false, session: null, progress: {}, gen: {}, device: '', auto: { muted: false, seen: {} }, voice: { used: false, sound: false }, canVoice: false };
  const G = { key: '', el: null, lostAt: 0, assist: null, live: { busy: false, last: null, error: null }, inputTimer: null, scrolled: false, cardKey: '', lastHref: '' };
  const P = { open: false, q: '', sel: 0, product: null, drafting: false };
  // asking: idle | listening | thinking; note: the answer on show; talk: a spoken conversation is going (the mic reopens after each reply)
  const V = { state: 'idle', note: null, seq: 0, spokeKey: '', leadUntil: 0, talk: false, turns: [], turnsAt: 0, saying: Promise.resolve(), resting: false };

  // ---------- storage + api ----------
  const store = { get: (k) => chrome.storage.local.get(k), set: (o) => chrome.storage.local.set(o) };
  async function api(path, body) {
    const r = await chrome.runtime.sendMessage({ type: 'onramp:api', path, body });
    if (!r || !r.ok) throw new Error(r?.error || 'offline');
    return r.data;
  }
  // The microphone and the speaker live outside the page (the extension's own hidden page, or the website in the demo):
  // the Cloudflare dashboard does not let a script on the page use the microphone.
  const voice = (op, extra) => Promise.resolve().then(() => chrome.runtime.sendMessage({ type: 'onramp:voice', op, ...extra })).catch(() => null);
  function speak(text, queue) {
    text = squash(text).slice(0, 280);
    if (S.voice.sound && !V.resting && text) V.saying = V.saying.then(() => voice('say', { text, queue: !!queue }));
  }
  // With the voice on, each new step is read out once: the short instruction only. The reason stays on the card to read.
  // Those lines are fixed words, so each is made into speech once, ever, and costs nothing after that.
  function speakStep(key, text) {
    if (key === V.spokeKey) return;
    V.spokeKey = key;
    if (V.state !== 'idle' || V.note) return;
    speak(text, Date.now() < V.leadUntil);
    converse();
  }
  // A conversation, not one question: when it has finished speaking, the microphone opens again by itself.
  // It ends when you say stop, press End, or say nothing.
  async function converse() {
    if (!V.talk) return;
    const seq = V.seq;
    await V.saying;
    await voice('idle');
    await new Promise((r) => setTimeout(r, 250)); // let the last syllable die away, so it does not hear itself
    if (seq === V.seq && V.talk && V.state === 'idle') listen(true);
  }
  function setTalk(on) {
    V.talk = on;
    if (!on) V.turns = [];
    store.set({ talk: on ? { at: Date.now(), turns: V.turns, leadUntil: V.leadUntil } : null });
  }
  function remember(q, a) {
    if (!q || !a) return;
    if (Date.now() - V.turnsAt > 300000) V.turns = [];
    V.turns = [...V.turns, { q: q.slice(0, 200), a: a.slice(0, 260) }].slice(-4);
    V.turnsAt = Date.now();
    if (V.talk) setTalk(true);
  }

  // ---------- guides ----------
  const guideFor = (id) => GUIDES[id] || S.gen[id] || null;
  const stepsFor = (id, track) => (guideFor(id)?.tracks?.[track] || []).flatMap((s) => (s.use ? GUIDES._shared?.[s.use] || [] : [s]));
  const pkey = (id, track) => id + '/' + track;
  function routesFor(id) {
    const t = Object.keys(guideFor(id)?.tracks || {});
    const out = ['click', 'code', 'agent'].filter((k) => t.includes(k));
    if (!GUIDES[id]) out.unshift('live');
    return out;
  }

  function setSession(ses) {
    S.session = ses;
    if (ses && ses.track !== 'live') S.progress[pkey(ses.product, ses.track)] = ses.idx;
    store.set({ session: ses, progress: S.progress });
    resetStep();
    tick();
  }
  function resetStep() {
    G.key = ''; G.el = null; G.lostAt = 0; G.assist = null; G.scrolled = false; G.foundAt = 0;
    clearTimeout(G.inputTimer);
  }
  function setIdx(i) {
    const ses = S.session;
    if (!ses) return;
    const n = stepsFor(ses.product, ses.track).length;
    const idx = Math.max(0, Math.min(i, n));
    setSession({ ...ses, idx });
    api('/api/progress', { device: S.device, product: ses.product, track: ses.track, step: idx, total: n }).catch(() => {});
  }
  const advance = () => setIdx(S.session.idx + 1);
  function startGuide(product, track, fresh, asked) {
    G.live = { busy: false, last: null, error: null };
    const n = stepsFor(product, track).length;
    let idx = track === 'live' || fresh ? 0 : S.progress[pkey(product, track)] || 0;
    if (idx >= n) idx = 0;
    setSession({ product, track, idx, history: [], ...(asked ? { asked: true } : {}) });
  }
  function stopGuide() {
    if (V.state === 'listening') voice('cancel');
    if (S.voice.used) voice('hush');
    V.seq++; V.state = 'idle'; V.note = null;
    if (V.talk) setTalk(false);
    setSession(null);
  }

  // Which guide belongs to the page you are looking at.
  function pageProduct() {
    let u;
    try { u = new URL(ENV.href()); } catch { return null; }
    if (u.host === 'os.cloudflare.app') return u.pathname.startsWith('/deploy') ? 'cloudflare-os' : null;
    if (u.host !== 'dash.cloudflare.com') return null;
    const m = u.pathname.match(/^\/[0-9a-f]{32}(\/.*)?$/);
    if (!m) return null;
    const rest = m[1] || '/home';
    if (rest === '/' || rest.startsWith('/home')) return 'workers'; // account home: the core thing is shipping a first Worker
    let best = null, len = 0;
    for (const p of CATALOG) {
      if (!p.guided || !p.dash || !p.dash.startsWith('/:account')) continue;
      let d = p.dash.slice(9), at = rest;
      if (d.startsWith('/:zone')) { d = d.slice(6).split('/').slice(0, 2).join('/'); at = rest.replace(/^\/[^/]+/, ''); }
      d = d.replace(/\/(overview|namespaces)$/, '');
      if (at.startsWith(d) && d.length > len) { best = p.id; len = d.length; }
    }
    return best;
  }
  // First time on a page with a guide: start it without being asked. Closing a guide turns this off until you pick one yourself.
  function autoStart() {
    if (S.auto.muted) return false;
    const id = pageProduct();
    if (!id || S.auto.seen[id] || !GUIDES[id]?.tracks?.click) return false;
    S.auto.seen[id] = true;
    store.set({ auto: S.auto });
    startGuide(id, 'click');
    return true;
  }
  const onCloudflare = () => { try { return /(^|\.)cloudflare\.(com|app)$/.test(new URL(ENV.href()).host); } catch { return false; } };

  // ---------- finding controls ----------
  const SEL = {
    button: 'button,[role=button],a[href],input[type=submit],input[type=button],[role=menuitem],[role=tab],[role=option],summary',
    link: 'a[href],[role=link],button,[role=button],[role=menuitem],[role=tab]',
    input: 'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=checkbox]):not([type=radio]),textarea,select,[contenteditable=""],[contenteditable=true],[role=textbox],[role=combobox]',
    tab: '[role=tab],a[href],button,[role=button]',
  };
  const ANY = [SEL.button, SEL.input, '[role=link],[role=switch],[role=checkbox],label'].join(',');
  const squash = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const norm = (s) => squash(s).toLowerCase();
  const scrub = (s) => (s || '').replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[email]').replace(/\b[0-9a-f]{32}\b/gi, '[id]');
  const isField = (el) => el.matches(SEL.input);

  // Cheap check: has a box and is not hidden by CSS.
  function shown(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    return !el.checkVisibility || el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  }
  // Full check: also not clipped out of sight (a later slide of a wizard) and not covered by something else.
  function visible(el) {
    if (!shown(el)) return false;
    const r = el.getBoundingClientRect();
    for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      const o = getComputedStyle(a);
      if (/hidden|clip/.test(o.overflowX + o.overflowY)) {
        const q = a.getBoundingClientRect();
        if (r.right <= q.left + 1 || r.left >= q.right - 1 || r.bottom <= q.top + 1 || r.top >= q.bottom - 1) return false;
      }
    }
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    if (cx > 0 && cy > 0 && cx < innerWidth && cy < innerHeight) {
      const top = document.elementsFromPoint(cx, cy).find((e) => e !== host);
      if (top && top !== el && !el.contains(top) && !top.contains(el) && top.closest('label')?.control !== el && !el.parentElement?.contains(top)) return false;
    }
    return true;
  }
  function labelsOf(el, raw) {
    const out = [];
    const push = (s) => { s = raw ? squash(s) : norm(s); if (s && s.length < 120) out.push(s); };
    push(el.getAttribute('aria-label'));
    const lb = el.getAttribute('aria-labelledby');
    if (lb) push(lb.split(/\s+/).map((id) => document.getElementById(id)?.innerText || '').join(' '));
    if (isField(el)) {
      if (el.id) { try { push(document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.innerText); } catch {} }
      push(el.closest('label')?.innerText);
      push(el.getAttribute('placeholder'));
      push(el.getAttribute('name'));
    } else {
      push(el.innerText);
      push(el.value);
    }
    push(el.getAttribute('title'));
    return out;
  }
  function scoreLabel(label, wants) {
    let best = 0;
    wants.forEach((w, k) => {
      const t = norm(w);
      if (!t) return;
      const roomy = label.length <= t.length * 3 + 12;
      let s = 0;
      // Whole words only: "key" must not match "Search keys by prefix".
      const at = roomy ? label.indexOf(t) : -1;
      const whole = at >= 0 && !/[a-z0-9]/.test(label[at - 1] || '') && !/[a-z0-9]/.test(label[at + t.length] || '');
      if (label === t) s = 100;
      else if (whole && at === 0) s = 70;
      else if (whole) s = 45;
      if (s) best = Math.max(best, s - k * 4);
    });
    return best;
  }
  const openDialog = () => [...ENV.root().querySelectorAll('[role=dialog],[aria-modal=true],dialog[open]')].filter(visible).pop() || null;

  // Finds the best element for a target like { text: ['Create'], role: 'button' }.
  function find(target) {
    if (!target || !target.text) return null;
    const wants = [].concat(target.text);
    const dialog = openDialog();
    let best = null, bestScore = 0;
    for (const el of ENV.root().querySelectorAll(SEL[target.role] || ANY)) {
      if (!shown(el) || el.closest('#onramp-root')) continue;
      let s = Math.max(0, ...labelsOf(el).map((l) => scoreLabel(l, wants)));
      if (!s || !visible(el)) continue;
      if (dialog) s += dialog.contains(el) ? 15 : -30;
      if (el.closest('nav,aside,header,footer')) s -= 8;
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') s -= 20;
      if (el.matches('label')) s -= 2; // on a tie, the field beats its own label
      if (target.role === 'input' && (el.type === 'search' || /^(search|filter)\b/.test(labelsOf(el)[0] || ''))) s -= 25; // a search box is rarely the field a step means
      if (s > bestScore) { best = el; bestScore = s; }
    }
    if (best?.matches('label') && best.control && visible(best.control)) best = best.control;
    if (bestScore >= 45 || target.role) return bestScore >= 40 ? best : null;
    // No role and no control matched: fall back to visible text (a heading, a section title).
    const want = wants.map(norm);
    const walker = document.createTreeWalker(ENV.root(), NodeFilter.SHOW_TEXT);
    let node, hit = null, hitRank = 99;
    while ((node = walker.nextNode())) {
      const t = norm(node.nodeValue);
      if (!t || t.length > 80) continue;
      const k = want.findIndex((w) => t === w || t.startsWith(w));
      if (k === -1 || k >= hitRank) continue;
      const el = node.parentElement;
      if (el && visible(el) && !el.closest('#onramp-root')) { hit = el; hitRank = k; }
    }
    return hit || best;
  }

  let snapEls = [];
  function snapshot() {
    snapEls = [];
    const dialog = openDialog();
    const scope = dialog || ENV.root();
    const seen = new Set();
    const elements = [];
    for (const el of scope.querySelectorAll(ANY)) {
      if (elements.length >= 90) break;
      if (el.matches('label') || !visible(el) || el.closest('#onramp-root')) continue;
      const label = scrub(labelsOf(el, true)[0] || '').slice(0, 70);
      const role = isField(el) ? 'input' : el.matches('a[href],[role=link]') ? 'link' : el.matches('[role=tab]') ? 'tab' : 'button';
      if (!label || seen.has(role + ':' + label)) continue;
      seen.add(role + ':' + label);
      const empty = role === 'input' && !(el.value ?? el.textContent ?? '').trim(); // a yes/no flag; contents never leave the page
      elements.push({ i: snapEls.length, role, label, ...(el.closest('nav,aside') ? { nav: true } : {}), ...(empty ? { empty: true } : {}) });
      snapEls.push(el);
    }
    const u = new URL(ENV.href());
    return {
      host: u.host, path: scrub(u.pathname).replace(/\[id\]/g, ':id'), title: scrub(document.title).slice(0, 100),
      headings: [...scope.querySelectorAll('h1,h2,h3')].filter(visible).slice(0, 8).map((h) => scrub(squash(h.innerText)).slice(0, 80)),
      dialog: !!dialog, elements,
    };
  }

  // ---------- where a step lives ----------
  function resolveGo(go) {
    if (/^https?:/.test(go)) return go;
    const acct = /^https:\/\/dash\.cloudflare\.com\/([0-9a-f]{32})(\/|$)/.exec(ENV.href())?.[1];
    if (acct && !go.includes(':zone')) return 'https://dash.cloudflare.com' + go.replace(':account', acct);
    return 'https://dash.cloudflare.com/?to=' + go; // Cloudflare's own deep link; asks which account if needed
  }
  function urlDone(step) {
    const d = step.done;
    if (!d || !d.url) return false;
    try {
      const u = new URL(ENV.href());
      if (step.go && step.go.startsWith('/:account') && u.host !== 'dash.cloudflare.com') return false;
      return (u.host + u.pathname).includes(d.url);
    } catch { return false; }
  }
  function openUrl(url) {
    if (SUPPORTED.test(url) || window.__ONRAMP_ENV) ENV.go(url);
    else window.open(url, '_blank', 'noopener');
  }

  // ---------- overlay ----------
  let host, rootEl, ring, cur, card, fab, scrim, pal;
  const svg = (d) => `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const ICON = {
    mic: svg('<rect x="5.7" y="1.7" width="4.6" height="8" rx="2.3"/><path d="M3.3 7.6a4.7 4.7 0 0 0 9.4 0M8 12.4v2"/>'),
    on: svg('<path d="M2.4 6.3h2.2L7.9 3.6v8.8L4.6 9.7H2.4z"/><path d="M10.3 6a2.9 2.9 0 0 1 0 4M12.1 4.3a5.4 5.4 0 0 1 0 7.4"/>'),
    off: svg('<path d="M2.4 6.3h2.2L7.9 3.6v8.8L4.6 9.7H2.4z"/><path d="M10.7 6.3l3 3.4M13.7 6.3l-3 3.4"/>'),
  };
  const POINTER = '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M5 3v15.2l4-3.7 2.8 6.3 2.5-1.1-2.8-6.3 5.5-.3z" fill="#fff" stroke="rgba(0,0,0,.8)" stroke-width="1.2" stroke-linejoin="round"/></svg>';
  const micButton = () => `<button class="ic" data-act="mic" aria-label="Ask by voice" title="Ask by voice">${ICON.mic}</button>`;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const CSS_TEXT = `
    :host{all:initial}
    *{box-sizing:border-box}
    button{font:inherit;color:inherit;background:none;border:0;padding:0;margin:0;cursor:pointer;text-align:left}
    button:focus-visible{outline:2px solid rgba(0,0,0,.55);outline-offset:2px}
    .root{position:absolute;inset:0;overflow:hidden;font:13px/1.4 -apple-system,BlinkMacSystemFont,"SF Pro Text","Inter","Segoe UI",system-ui,sans-serif;color:var(--ink);-webkit-font-smoothing:antialiased;text-align:left;letter-spacing:0}
    .root{--ink:#1d1d1f;--paper:#fff;--muted:#6e6e73;--faint:#aeaeb2;--hair:rgba(0,0,0,.08);--fill:rgba(118,118,128,.1);--dim:rgba(20,20,26,.1);--scrim:rgba(20,20,26,.22)}
    .glass{background:linear-gradient(180deg,rgba(255,255,255,.97),rgba(244,244,247,.95));-webkit-backdrop-filter:blur(30px) saturate(180%);backdrop-filter:blur(30px) saturate(180%);
      box-shadow:inset 0 1px 0 #fff,0 0 0 .5px rgba(0,0,0,.14),0 28px 70px rgba(0,0,0,.2),0 4px 14px rgba(0,0,0,.08)}

    .ring{position:absolute;border-radius:12px;pointer-events:none;opacity:0;
      box-shadow:0 0 0 1.5px #fff,0 0 0 3px rgba(0,0,0,.3),0 0 0 8px rgba(255,255,255,.5),0 12px 34px rgba(0,0,0,.2),0 0 0 300vmax var(--dim);
      transition:left .2s ease,top .2s ease,width .2s ease,height .2s ease,opacity .2s ease}
    .ring.on{opacity:1;animation:halo 2.2s ease-in-out infinite}
    @keyframes halo{50%{box-shadow:0 0 0 1.5px #fff,0 0 0 3px rgba(0,0,0,.3),0 0 0 13px rgba(255,255,255,.22),0 12px 34px rgba(0,0,0,.2),0 0 0 300vmax var(--dim)}}

    .card{position:absolute;width:292px;max-width:calc(100% - 24px);border-radius:20px;padding:16px 18px 16px;pointer-events:none;opacity:0;transform:translateY(6px) scale(.985);
      transition:opacity .2s ease,transform .2s ease,left .2s ease,top .2s ease}
    .card.on{opacity:1;transform:none;pointer-events:auto}
    .card.dock{width:344px}
    .cur{position:absolute;left:0;top:0;width:24px;height:24px;margin:-3px 0 0 -5px;pointer-events:none;opacity:0;filter:drop-shadow(0 2px 5px rgba(0,0,0,.3));transition:left .2s ease,top .2s ease,opacity .25s ease}
    .cur.on{opacity:1}
    .cur.glide{transition:left .62s cubic-bezier(.3,.7,.2,1),top .62s cubic-bezier(.3,.7,.2,1),opacity .25s ease}
    .cur svg{display:block;transform-origin:5px 3px}
    .cur.tap svg{animation:tap .34s ease}
    @keyframes tap{45%{transform:scale(.78)}}
    .top{display:flex;align-items:center;gap:8px;height:22px}
    .ic{flex:none;width:24px;height:24px;margin:0 -3px;border-radius:12px;display:grid;place-items:center;color:var(--muted)}
    .ic:hover{background:var(--fill);color:var(--ink)}
    .ic svg{display:block}
    .heard{margin-top:12px;font-size:12px;line-height:1.4;color:var(--muted)}
    .ans{margin-top:5px;font-size:14.5px;line-height:1.44;letter-spacing:-.006em}
    .top+.ans{margin-top:12px}
    .live{display:inline-block;width:10px;height:10px;border-radius:50%;border:2px solid var(--ink);margin-right:8px;animation:pulse 1.3s ease-in-out infinite}
    .hear{display:flex;align-items:center;margin-top:14px;min-height:22px;font-size:13px;font-weight:500}
    .hl{display:inline-flex;align-items:center}
    .hl .busy{margin-right:8px;vertical-align:0}
    .hear+.foot{margin-top:8px}
    @keyframes pulse{50%{transform:scale(.6);opacity:.35}}
    .ctx{flex:1;min-width:0;font-size:12px;font-weight:500;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .count{font-size:12px;color:var(--faint);font-variant-numeric:tabular-nums;white-space:nowrap}
    .x{flex:none;position:relative;width:22px;height:22px;margin-right:-5px;border-radius:11px}
    .x::before,.x::after{content:"";position:absolute;left:6px;right:6px;top:10.4px;height:1.2px;border-radius:1px;background:var(--muted);transform:rotate(45deg)}
    .x::after{transform:rotate(-45deg)}
    .x:hover{background:var(--fill)}
    .say{margin-top:12px;font-size:17px;font-weight:600;line-height:1.24;letter-spacing:-.018em}
    .detail{margin-top:6px;font-size:13px;line-height:1.42;color:var(--muted)}
    .code{margin:14px 0 0;padding:11px 13px;border-radius:12px;background:rgba(118,118,128,.1);box-shadow:inset 0 0 0 .5px rgba(0,0,0,.05);color:var(--ink);font:12px/1.55 ui-monospace,"SF Mono",Menlo,monospace;white-space:pre-wrap;word-break:break-word;max-height:148px;overflow:auto;user-select:text;-webkit-user-select:text}
    .tip{margin-top:10px;font-size:12px;line-height:1.42;color:var(--muted)}
    .foot{display:flex;align-items:center;gap:14px;margin-top:18px;min-height:28px}
    .sp{flex:1}
    .q{color:var(--muted);font-size:13px}
    .q:hover{color:var(--ink)}
    .pill{height:28px;padding:0 14px;border-radius:14px;background:#fff;color:var(--ink);font-size:13px;font-weight:600;text-align:center;white-space:nowrap;box-shadow:0 0 0 .5px rgba(0,0,0,.16),0 1px 2px rgba(0,0,0,.1),0 4px 12px rgba(0,0,0,.07);transition:box-shadow .15s ease}
    .pill:hover{box-shadow:0 0 0 .5px rgba(0,0,0,.2),0 2px 4px rgba(0,0,0,.12),0 8px 18px rgba(0,0,0,.1)}
    .pill.soft,.pill.soft:hover{background:var(--fill);color:var(--ink);box-shadow:none}
    .mark{display:block;width:20px;height:20px;border-radius:50%;background:#fff;box-shadow:0 0 0 .5px rgba(0,0,0,.16),0 1px 2px rgba(0,0,0,.1),0 4px 12px rgba(0,0,0,.07);position:relative;margin-top:14px}
    .mark::after{content:"";position:absolute;left:6.5px;top:5px;width:5px;height:8px;border:solid var(--ink);border-width:0 1.6px 1.6px 0;transform:rotate(45deg)}
    .mark+.say{margin-top:10px}
    .busy{display:inline-block;width:12px;height:12px;border-radius:50%;border:1.5px solid var(--faint);border-top-color:var(--ink);animation:spin .8s linear infinite;vertical-align:-2px;margin-right:7px}
    @keyframes spin{to{transform:rotate(360deg)}}

    .fab{position:absolute;right:24px;bottom:24px;width:46px;height:46px;border-radius:23px;display:grid;place-items:center;pointer-events:none;opacity:0;transform:scale(.9);transition:opacity .2s ease,transform .2s ease}
    .fab.on{opacity:1;transform:none;pointer-events:auto}
    .fab:hover{transform:scale(1.05)}
    .fab i{width:17px;height:17px;border-radius:50%;border:2.4px solid var(--ink)}
    .scrim{position:absolute;inset:0;background:var(--scrim);pointer-events:none;opacity:0;transition:opacity .18s ease}
    .scrim.on{opacity:1;pointer-events:auto}
    .pal{position:absolute;left:50%;top:max(72px,17%);width:min(620px,calc(100% - 32px));max-height:min(560px,70%);transform:translate(-50%,8px) scale(.985);
      border-radius:22px;overflow:hidden;display:flex;flex-direction:column;pointer-events:none;visibility:hidden;opacity:0;transition:opacity .18s ease,transform .18s ease,visibility 0s .18s}
    .pal.on{opacity:1;transform:translate(-50%,0);pointer-events:auto;visibility:visible;transition:opacity .18s ease,transform .18s ease}
    .ask{flex:none;display:flex;align-items:center;padding-right:20px;border-bottom:.5px solid var(--hair)}
    .ask .ic{width:30px;height:30px;border-radius:15px;margin:0}
    .pal input{flex:1;min-width:0;height:62px;padding:0 24px;border:0;background:transparent;color:var(--ink);caret-color:var(--ink);font:inherit;font-size:18px;letter-spacing:-.01em;outline:none}
    .pal input::placeholder{color:var(--faint)}
    .phead{flex:none;display:flex;align-items:center;gap:8px;height:62px;padding:0 16px;border-bottom:.5px solid var(--hair)}
    .phead .t{font-size:18px;font-weight:600;letter-spacing:-.015em}
    .back{width:28px;height:28px;border-radius:14px;position:relative}
    .back::after{content:"";position:absolute;left:11px;top:9.5px;width:8px;height:8px;border-left:1.6px solid var(--muted);border-bottom:1.6px solid var(--muted);transform:rotate(45deg)}
    .back:hover{background:var(--fill)}
    .list{overflow:auto;padding:8px 8px 10px;overscroll-behavior:contain}
    .sec{padding:14px 16px 6px;font-size:12px;font-weight:500;color:var(--muted)}
    .row{display:flex;align-items:center;gap:14px;width:100%;padding:10px 16px;border-radius:12px}
    .row.sel{background:var(--fill)}
    .glyph{flex:none;width:10px;height:10px;border-radius:50%;border:1.5px solid var(--faint)}
    .glyph.g{border-color:var(--ink)}
    .txt{flex:1;min-width:0}
    .name{display:block;font-size:15px;font-weight:550;letter-spacing:-.01em}
    .blurb{display:block;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .meta{flex:none;color:var(--muted);font-size:12px;white-space:nowrap;font-variant-numeric:tabular-nums}
    .none{padding:26px 24px;color:var(--muted)}
    .links{flex:none;display:flex;gap:20px;padding:13px 24px 15px;border-top:.5px solid var(--hair)}
    @media (prefers-reduced-motion:reduce){.ring.on,.busy,.live,.cur.tap svg{animation:none}.ring,.card,.pal,.scrim,.cur,.cur.glide{transition:none}}
  `;

  function mount() {
    const frame = ENV.frame();
    if (host?.isConnected) return;
    host = document.createElement('div');
    host.id = 'onramp-root';
    host.style.cssText = `position:${frame ? 'absolute' : 'fixed'};inset:0;pointer-events:none;z-index:2147483647;`;
    const sh = host.attachShadow({ mode: 'closed' });
    sh.innerHTML = `<style>${CSS_TEXT}</style><div class="root"><div class="ring"></div><div class="cur">${POINTER}</div><div class="card glass"></div><button class="fab glass" aria-label="CF Onramp: pick a product" title="CF Onramp"><i></i></button><div class="scrim"></div><div class="pal glass"></div></div>`;
    rootEl = sh.querySelector('.root');
    ring = sh.querySelector('.ring');
    cur = sh.querySelector('.cur');
    card = sh.querySelector('.card');
    fab = sh.querySelector('.fab');
    fab.addEventListener('click', openPalette);
    scrim = sh.querySelector('.scrim');
    pal = sh.querySelector('.pal');
    (frame || document.documentElement).appendChild(host);
    card.addEventListener('click', onCardClick);
    scrim.addEventListener('click', closePalette);
    pal.addEventListener('click', onPalClick);
    pal.addEventListener('input', (e) => { if (e.target.tagName === 'INPUT') { P.q = e.target.value; P.sel = 0; renderList(); } });
    pal.addEventListener('mousemove', (e) => { const r = e.target.closest('.row'); if (r && +r.dataset.i !== P.sel) { P.sel = +r.dataset.i; markSel(); } });
    // Keep typing in the picker away from the dashboard's own keyboard shortcuts.
    for (const t of ['keydown', 'keyup', 'keypress']) pal.addEventListener(t, (e) => { e.stopPropagation(); if (t === 'keydown') onPalKey(e); });
  }

  const theme = () => {}; // one look on every page: a white, silver-edged card reads on light and dark dashboards alike
  function bounds() {
    const f = ENV.frame();
    if (!f) return { x: 0, y: 0, w: innerWidth, h: innerHeight };
    const r = f.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  }

  // ---------- the card ----------
  // m: { i, n, where, say, detail, code, tip, mark, busy, actions: [[act, label, kind]] }
  // While it listens, thinks or shows an answer, that takes the card over; the ring stays where it was.
  // The step (or the last answer) stays on the card, with one line under it that says it is listening or thinking.
  function voiceCard(m) {
    const busy = V.state !== 'idle';
    let out = m;
    if (V.note) out = { ctx: m.ctx, heard: V.note.heard, ans: V.note.say, actions: busy ? [] : [['unnote', S.session ? 'Back to step' : 'Close', 'pill']],
      ...(V.resting && S.voice.sound && !V.note.plain ? { tip: 'The voice is resting until tomorrow. Answers stay here to read.' } : {}) };
    else if (!S.session && busy) out = { ctx: m.ctx, say: 'What do you want to do?', actions: [] };
    return busy ? { ...out, hear: V.state } : out;
  }
  function renderCard(m, anchored) {
    m = voiceCard(m);
    const loud = S.voice.sound && !V.resting;
    const tools = !S.canVoice ? '' : (S.voice.used ? `<button class="ic" data-act="sound" aria-label="${S.voice.sound ? 'Turn the voice off' : 'Turn the voice on'}" title="${V.resting ? 'The voice is resting until tomorrow' : loud ? 'Voice on' : 'Voice off'}">${loud ? ICON.on : ICON.off}</button>` : '') + (m.hear ? '' : micButton());
    const key = JSON.stringify(m) + anchored + tools.length + loud;
    card.classList.toggle('dock', !anchored);
    if (key === G.cardKey) return;
    G.cardKey = key;
    let h = `<div class="top"><span class="ctx">${esc(m.ctx || '')}</span>${m.count ? `<span class="count">${esc(m.count)}</span>` : ''}${tools}<button class="x" data-act="stop" aria-label="Close"></button></div>`;
    if (m.mark) h += `<span class="mark"></span>`;
    if (m.heard) h += `<div class="heard">“${esc(m.heard)}”</div>`;
    if (m.ans) h += `<div class="ans">${esc(m.ans)}</div>`;
    if (m.say) h += `<div class="say">${m.busy ? '<span class="busy"></span>' : ''}${esc(m.say)}</div>`;
    if (m.detail) h += `<div class="detail">${esc(m.detail)}</div>`;
    if (m.code) h += `<pre class="code">${esc(m.code)}</pre>`;
    if (m.tip) h += `<div class="tip">${esc(m.tip)}</div>`;
    if (m.hear) {
      h += `<div class="hear">${m.hear === 'listening' ? '<button class="hl" data-act="vsend" title="Send now"><span class="live"></span>Listening</button>' : '<span class="hl"><span class="busy"></span>Thinking</span>'}`
        + `<span class="sp"></span><button class="q" data-act="vend">End</button></div>`;
    }
    const quiet = m.actions.filter((a) => a[2] === 'q'), pills = m.actions.filter((a) => a[2] !== 'q');
    if (m.actions.length) {
      h += `<div class="foot">${quiet.map((a) => `<button class="q" data-act="${a[0]}">${esc(a[1])}</button>`).join('')}<span class="sp"></span>`
        + `${pills.map((a) => `<button class="pill${a[2] === 'soft' ? ' soft' : ''}" data-act="${a[0]}">${esc(a[1])}</button>`).join('')}</div>`;
    }
    card.innerHTML = h;
  }
  // What reads as "the field" is often a framed wrapper around a narrower <input> (a prefix, a suffix, an icon).
  function boxOf(el) {
    if (!isField(el)) return el;
    const r0 = el.getBoundingClientRect();
    let box = el;
    for (let a = el.parentElement, i = 0; a && i < 4; a = a.parentElement, i++) {
      const r = a.getBoundingClientRect();
      if (r.height > r0.height + 30 || r.width > Math.max(r0.width * 8, 820) || a.querySelectorAll(SEL.input).length !== 1) break;
      const cs = getComputedStyle(a);
      if (parseFloat(cs.borderTopWidth) > 0 || cs.boxShadow !== 'none' || (parseFloat(cs.outlineWidth) > 0 && cs.outlineStyle !== 'none')) box = a;
    }
    return box;
  }
  function place(el) {
    const b = bounds();
    const cw = card.offsetWidth, ch = card.offsetHeight;
    if (!el) { // docked: bottom right
      ring.classList.remove('on'); cur.classList.remove('on');
      card.style.left = Math.max(12, b.w - cw - 28) + 'px';
      card.style.top = b.h - ch - 28 + 'px';
      return;
    }
    const r = boxOf(el).getBoundingClientRect();
    const x = r.left - b.x, y = r.top - b.y, pad = 5, gap = 16;
    const fresh = !ring.classList.contains('on'); // appear in place instead of sliding in from the last spot
    if (fresh) ring.style.transition = 'none';
    ring.style.left = x - pad + 'px'; ring.style.top = y - pad + 'px';
    ring.style.width = r.width + pad * 2 + 'px'; ring.style.height = r.height + pad * 2 + 'px';
    if (fresh) { void ring.offsetWidth; ring.style.transition = ''; }
    ring.classList.add('on');
    // The pointer glides to each new control, the way someone showing you would move the mouse. It only points.
    if (G.curEl !== el) {
      G.curEl = el;
      if (!cur.style.left) { // first time: come in from the corner
        cur.style.transition = 'none';
        cur.style.left = b.w - 80 + 'px'; cur.style.top = b.h - 80 + 'px';
        void cur.offsetWidth; cur.style.transition = '';
      }
      cur.classList.add('glide');
      clearTimeout(G.curTimer);
      G.curTimer = setTimeout(() => { cur.classList.remove('glide'); cur.classList.add('tap'); setTimeout(() => cur.classList.remove('tap'), 360); }, 660);
    }
    cur.style.left = x + r.width - Math.min(10, r.width * .3) + 'px'; cur.style.top = y + r.height - Math.min(7, r.height * .3) + 'px';
    cur.classList.add('on');
    // Sit next to the control on whichever side covers the fewest other controls.
    const clampX = (v) => Math.min(Math.max(10, v), b.w - cw - 10), clampY = (v) => Math.min(Math.max(10, v), b.h - ch - 10);
    const spots = [
      [x + r.width + gap, clampY(y + r.height / 2 - ch / 2), x + r.width + gap + cw < b.w - 10],
      [clampX(x - pad), y + r.height + gap, y + r.height + gap + ch < b.h - 10],
      [clampX(x - pad), y - gap - ch, y - gap - ch > 10],
      [x - gap - cw, clampY(y + r.height / 2 - ch / 2), x - gap - cw > 10],
    ].filter((s) => s[2]);
    const sig = [Math.round(x), Math.round(y), Math.round(r.width), cw, ch, b.w, b.h].join();
    if (sig !== G.spotSig || Date.now() - (G.spotAt || 0) > 700) {
      const others = [...ENV.root().querySelectorAll(ANY)].filter((o) => o !== el && !o.contains(el) && !el.contains(o) && shown(o)).slice(0, 200)
        .map((o) => { const q = o.getBoundingClientRect(); return [q.left - b.x, q.top - b.y, q.right - b.x, q.bottom - b.y]; });
      const cost = (l, t) => others.reduce((sum, o) => {
        const w = Math.min(l + cw, o[2]) - Math.max(l, o[0]), hh = Math.min(t + ch, o[3]) - Math.max(t, o[1]);
        return sum + (w > 0 && hh > 0 ? w * hh : 0);
      }, 0);
      let best = spots[0] || [clampX(x), clampY(y + r.height + gap)], bestCost = Infinity;
      for (const s of spots) { const c = cost(s[0], s[1]); if (c < bestCost - 40) { best = s; bestCost = c; } }
      G.spot = best; G.spotSig = sig; G.spotAt = Date.now();
    }
    card.style.left = G.spot[0] + 'px'; card.style.top = G.spot[1] + 'px';
  }
  function hideGuide() { ring?.classList.remove('on'); cur?.classList.remove('on'); card?.classList.remove('on'); G.cardKey = ''; }

  // ---------- the loop ----------
  function tick() {
    if (document.visibilityState !== 'visible' || !S.ready) return;
    if (!S.session && !P.open) {
      if (V.state !== 'idle' || V.note) { // asked with no guide running: the card sits in the corner while it listens and answers
        mount(); fab.classList.remove('on');
        renderCard({ ctx: 'CF Onramp', say: '', actions: [] }, false);
        card.classList.add('on');
        return place(null);
      }
      if (autoStart()) return;
      if (!onCloudflare()) { if (host) { hideGuide(); fab.classList.remove('on'); } return; }
      mount(); theme(); hideGuide();
      return void fab.classList.add('on'); // nothing running: a small button in the corner opens the picker
    }
    mount(); theme();
    fab.classList.remove('on');
    if (P.open || !S.session) return hideGuide();
    const ses = S.session, p = byId[ses.product];
    if (!p) return stopGuide();
    if (ses.track === 'live') return tickLive(p);
    const list = stepsFor(ses.product, ses.track), n = list.length;
    if (!n) return stopGuide();

    if (ses.idx >= n) {
      const others = routesFor(p.id).filter((t) => t !== ses.track && t !== 'live');
      renderCard({ ctx: p.name, mark: true, say: guideFor(p.id)?.goal || p.name, detail: 'Done.',
        actions: [...others.map((t) => ['route:' + t, 'Try ' + ROUTES[t][0], 'soft']), ['stop', 'Close', 'pill']] }, false);
      speakStep(p.id + '/' + ses.track + '/done', 'Done. ' + (guideFor(p.id)?.goal || ''));
      card.classList.add('on');
      return place(null);
    }

    const step = list[ses.idx];
    const key = p.id + '/' + ses.track + '/' + ses.idx;
    if (key !== G.key) { resetStep(); G.key = key; V.note = null; }
    if (urlDone(step)) return advance();

    const onPage = step.at === 'dash' || step.at === 'any';
    // Look again every so often: a dialog may have opened with a better match than the one we ringed.
    if (onPage && (step.target || G.assist) && (!visible(G.el) || Date.now() - (G.foundAt || 0) > 600)) {
      G.foundAt = Date.now();
      const next = G.assist && visible(G.assist) ? G.assist : find(step.target);
      if (next || !visible(G.el)) G.el = next;
      if (G.el && !G.scrolled) {
        G.scrolled = true;
        const r = G.el.getBoundingClientRect(), b = bounds();
        if (r.top < b.y + 60 || r.bottom > b.y + b.h - 60) G.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }
    const el = onPage ? G.el : null;
    const back = ses.idx > 0 && !urlDone(list[ses.idx - 1]) ? [['back', 'Back', 'q']] : []; // no Back onto a step the URL already satisfies
    const m = { ctx: WHERE[step.at] || p.name, count: `${ses.idx + 1} of ${n}`, say: step.say, detail: step.detail, actions: back };

    if (el) {
      G.lostAt = 0;
      if (step.go && step.done?.url) m.say = 'Click ' + (labelsOf(el, true)[0] || '').slice(0, 40);
      if (step.code) { m.code = step.code; m.actions.push(['copy', 'Copy', 'soft']); }
      if (!step.detail && step.tip) m.detail = step.tip;
      m.actions.push(step.done === 'manual' ? ['next', 'Done', 'pill'] : ['next', 'Skip', 'q']);
      speakStep(key, m.say);
      renderCard(m, true);
    } else if (!onPage) {
      speakStep(key, step.say);
      m.code = step.code; m.tip = step.tip;
      if (step.code) m.actions.push(['copy', 'Copy', 'soft']);
      m.actions.push(['next', 'Done', 'pill']);
      renderCard(m, false);
    } else {
      if (!G.lostAt) G.lostAt = Date.now();
      const lostFor = Date.now() - G.lostAt;
      const here = step.go && urlDone({ ...step, done: step.done?.url ? step.done : { url: '\u0000' } });
      const prevGo = step.go || [...list.slice(0, ses.idx)].reverse().find((s) => s.go)?.go;
      // A guide you asked for goes to the product's page by itself, once, instead of waiting for a click on Open.
      if (ses.asked && !ses.went && step.go && !here && lostFor > 700) {
        ses.went = true; store.set({ session: ses });
        return openUrl(resolveGo(step.go));
      }
      if (lostFor > 900) speakStep(key, step.say);
      // The page and our note of it can drift apart (a click that reloaded the page, a shortcut, going on without
      // pressing Done, going back). If a nearby step's control is on screen and this one's is not, move to that step.
      if (step.target && lostFor > 600 && !(step.go && !here)) {
        for (const k of [1, 2, -1, -2, -3]) {
          const nx = list[ses.idx + k];
          if (nx && nx.target && !(k < 0 && nx.go) && find(nx.target)) return setIdx(ses.idx + k);
        }
      }
      if (step.code) { m.code = step.code; m.actions.push(['copy', 'Copy', 'soft']); }
      if (step.go && !here) {
        if (!step.target && step.done === 'manual') m.actions.push(['go', 'Open', 'soft'], ['next', 'Done', 'pill']);
        else m.actions.push(['next', 'Skip', 'q'], ['go', 'Open', 'pill']);
      } else if (step.target && lostFor > 900) {
        m.detail = G.assist === 'busy' ? 'Reading the page.' : G.assist === 'none' ? 'Not on this page.' : 'Not on this page yet.';
        m.actions.push(['next', 'Skip', 'q']);
        if (prevGo && !here) m.actions.push(['go', 'Open', 'soft']);
        if (G.assist !== 'busy') m.actions.push(['assist', 'Find it', 'pill']);
      } else if (!step.target) {
        m.tip = step.tip;
        m.actions.push(step.done === 'manual' ? ['next', 'Done', 'pill'] : ['next', 'Skip', 'q']);
      } else {
        m.actions.push(['next', 'Skip', 'q']);
      }
      m.goUrl = prevGo;
      renderCard(m, false);
    }
    card.classList.add('on');
    place(el);
  }

  // ---------- live (AI) guidance ----------
  async function liveNext() {
    if (G.live.busy || !S.session) return;
    G.live = { busy: true, last: null, error: null }; G.assist = null; G.el = null;
    try {
      const p = byId[S.session.product];
      const r = await api('/api/next', { device: S.device, product: p.id, snapshot: snapshot(), history: (S.session.history || []).slice(-6) });
      G.live.last = r;
      if (Number.isInteger(r.element) && visible(snapEls[r.element])) G.el = snapEls[r.element];
    } catch (e) {
      G.live.error = e.message === 'offline' ? 'Live guidance is offline.' : e.message;
    }
    G.live.busy = false;
    tick();
  }
  function tickLive(p) {
    const L = G.live;
    if (!L.busy && !L.last && !L.error) liveNext();
    const m = { ctx: p.name, say: '', actions: [] };
    let el = null;
    if (L.busy || (!L.last && !L.error)) { m.busy = true; m.say = 'Reading the page'; }
    else if (L.error) { m.say = L.error; m.actions.push(['live', 'Retry', 'pill']); }
    else {
      m.say = L.last.say; m.detail = L.last.detail && L.last.detail !== L.last.say ? L.last.detail : '';
      speakStep('live/' + m.say, m.say);
      if (visible(G.el)) { el = G.el; m.actions.push(['live', 'Skip', 'q']); }
      else {
        if (L.last.done) m.mark = true;
        if (p.dash) m.actions.push(['dash', 'Open', 'soft']);
        m.actions.push(['live', 'Look again', 'pill']);
      }
    }
    renderCard(m, !!el);
    card.classList.add('on');
    place(el);
  }
  async function assist() {
    const ses = S.session, list = stepsFor(ses.product, ses.track), step = list[ses.idx];
    G.assist = 'busy'; tick();
    try {
      const r = await api('/api/next', {
        device: S.device, product: ses.product, snapshot: snapshot(), history: list.slice(0, ses.idx).map((s) => s.say).slice(-6),
        hint: step.say + (step.target?.text ? ' (look for: ' + [].concat(step.target.text).join(', ') + ')' : ''),
      });
      const el = Number.isInteger(r.element) ? snapEls[r.element] : null;
      G.assist = visible(el) ? el : 'none';
    } catch { G.assist = 'none'; }
    G.el = null; tick();
  }

  // ---------- asking, typed or spoken ----------
  const MIC = {
    permission: 'Allow the microphone for this site, then tap the mic again.',
    window: 'Allow the microphone in the small window that opened, then tap the mic again.',
    nomic: 'No microphone was found.',
  };
  // Closes the answer and ends any conversation.
  function quiet() {
    if (V.state === 'listening') voice('cancel');
    if (S.voice.used) voice('hush');
    V.seq++; V.state = 'idle'; V.note = null;
    if (V.talk) setTalk(false);
    tick();
  }
  // Ends the conversation but leaves what is on the card.
  function endTalk() {
    if (V.state === 'listening') voice('cancel');
    V.seq++; V.state = 'idle';
    if (V.talk) setTalk(false);
    tick();
  }
  // again: the microphone reopening by itself in a conversation, as opposed to a tap on the mic.
  async function listen(again) {
    if (V.state !== 'idle' || !S.canVoice) return;
    if (P.open) closePalette();
    mount();
    const seq = ++V.seq;
    if (!again) { voice('hush'); V.note = null; setTalk(true); }
    if (!S.voice.used) { S.voice = { used: true, sound: true }; store.set({ voice: S.voice }); } // once you talk to it, it talks back
    V.state = 'listening'; tick();
    const r = await voice('listen');
    if (seq !== V.seq) return;
    if (r?.ok && r.audio) return ask('', r.audio);
    V.state = 'idle';
    setTalk(false); // nobody spoke, or no microphone: the conversation rests until the mic is tapped again
    if (r?.ok) { if (!again) V.note = { heard: '', say: 'I did not hear anything. Tap the mic and try again.' }; }
    else if (r?.error !== 'cancelled') V.note = { heard: '', say: MIC[r?.where === 'window' ? 'window' : r?.error] || 'The microphone is not available here.' };
    tick();
  }
  // Sends the question (or the recording) and acts on the answer: start a guide, move within this one, or show a short answer.
  async function ask(q, audio) {
    q = squash(q).slice(0, 300);
    if (!q && !audio) return;
    if (P.open) closePalette();
    mount();
    const seq = ++V.seq;
    V.note = null; V.state = 'thinking'; tick();
    const was = S.session, step = was && was.track !== 'live' ? stepsFor(was.product, was.track)[was.idx] : null;
    let r;
    try {
      if (Date.now() - V.turnsAt > 300000) V.turns = [];
      r = await api('/api/ask', { ...(audio ? { audio } : { q }), history: V.turns,
        at: was ? { product: was.product, say: step?.say || G.live.last?.say || '', detail: step?.detail || step?.tip || '' } : null });
    } catch (e) {
      r = { kind: 'error', say: e.message === 'offline' ? 'Ask is offline right now.' : e.message };
    }
    if (seq !== V.seq) return;
    V.state = 'idle';
    if (r.voice) V.resting = r.voice === 'resting';
    if (r.kind === 'error') { // shown, never spoken or remembered; a conversation cannot go on without it
      V.note = { heard: audio ? '' : q, say: r.say, plain: true };
      if (V.talk) setTalk(false);
      return tick();
    }
    const ses = S.session;
    if (r.kind === 'control' && ses) {
      const live = ses.track === 'live';
      if (r.control === 'stop') return stopGuide();
      if (r.control === 'next') return live ? liveAgain() : advance();
      if (r.control === 'back' && !live) return setIdx(ses.idx - 1);
      if (r.control === 'open') goNow();
      V.spokeKey = ''; // "repeat", or anything else: say the step again
      return tick();
    }
    remember(r.heard || q, r.kind === 'none' ? '' : r.say);
    if (r.kind === 'guide' && byId[r.product] && r.product !== ses?.product) {
      S.auto.muted = false; S.auto.seen[r.product] = true; store.set({ auto: S.auto });
      speak(r.say); V.leadUntil = Date.now() + 9000; V.spokeKey = '';
      if (V.talk) setTalk(true); // keep the conversation across the page load a guide may cause
      const routes = routesFor(r.product);
      return startGuide(r.product, routes.includes(r.track) ? r.track : routes.includes('click') ? 'click' : routes[0] || 'live', true, true);
    }
    V.note = { heard: r.heard || q, say: r.say || 'I did not catch that.' };
    speak(V.note.say);
    tick();
    converse();
  }
  function liveAgain() {
    const ses = S.session;
    if (G.live.last?.say) ses.history = [...(ses.history || []), G.live.last.say].slice(-8);
    G.live = { busy: false, last: null, error: null }; G.el = null; tick();
  }
  function goNow() {
    const ses = S.session, list = stepsFor(ses.product, ses.track);
    const go = list[ses.idx]?.go || [...list.slice(0, ses.idx)].reverse().find((s) => s.go)?.go || byId[ses.product]?.dash;
    if (go) openUrl(resolveGo(go));
  }

  function onCardClick(e) {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act, ses = S.session;
    if (act === 'mic') return void listen();
    if (act === 'vsend') return void voice('stop');
    if (act === 'sound') {
      S.voice.sound = !S.voice.sound; store.set({ voice: S.voice });
      if (S.voice.sound) V.spokeKey = ''; else voice('hush'); // turning it on reads the current step
      return tick();
    }
    if (act === 'vend') return endTalk();
    if (act === 'unnote' || (act === 'stop' && !ses)) return quiet();
    if (!ses) return;
    const list = stepsFor(ses.product, ses.track), step = list[ses.idx];
    if (act === 'stop') { if (ses.track === 'live' || ses.idx < list.length) { S.auto.muted = true; store.set({ auto: S.auto }); } stopGuide(); }
    else if (act === 'next') advance();
    else if (act === 'back') setIdx(ses.idx - 1);
    else if (act === 'assist') assist();
    else if (act === 'live') liveAgain();
    else if (act === 'dash') openUrl(resolveGo(byId[ses.product].dash));
    else if (act === 'go') goNow();
    else if (act.startsWith('route:')) startGuide(ses.product, act.slice(6), true);
    else if (act === 'copy') {
      navigator.clipboard.writeText(step?.code || '').then(() => { b.textContent = 'Copied'; }, () => { b.textContent = 'Select it'; });
      setTimeout(() => { if (b.isConnected) b.textContent = 'Copy'; }, 1400);
    }
  }

  // Noticing that the user did the step.
  function completed() {
    if (!S.session) return;
    if (S.session.track === 'live') {
      const say = G.live.last?.say;
      S.session.history = [...(S.session.history || []), say].filter(Boolean).slice(-8);
      store.set({ session: S.session });
      G.el = null; G.live = { busy: true, last: null, error: null }; tick();
      setTimeout(() => { G.live.busy = false; liveNext(); }, 1300);
    } else advance();
  }
  const doneKind = () => {
    if (!S.session || !G.el) return null;
    if (S.session.track === 'live' || G.assist === G.el) return isField(G.el) ? 'input' : 'click';
    return stepsFor(S.session.product, S.session.track)[S.session.idx]?.done;
  };
  document.addEventListener('click', (e) => {
    if (doneKind() === 'click') { if (e.composedPath().includes(G.el)) completed(); return; }
    // On a "Done" or typing step people often just go on to the next control. That counts as both steps.
    const ses = S.session;
    if (!ses || ses.track === 'live') return;
    const list = stepsFor(ses.product, ses.track), cur = list[ses.idx], nx = list[ses.idx + 1];
    if (!cur || !nx || !nx.target || nx.done !== 'click' || (cur.done !== 'manual' && cur.done !== 'input')) return;
    const el = find(nx.target);
    if (el && e.composedPath().includes(el)) setIdx(ses.idx + 2);
  }, true);
  const onField = (e) => {
    if (doneKind() !== 'input') return;
    const t = e.target;
    if (t !== G.el && !G.el.contains(t)) return;
    const filled = !!(t.value ?? t.textContent ?? '').trim();
    clearTimeout(G.inputTimer);
    if (!filled) return;
    if (e.type === 'change' || e.type === 'blur') return completed();
    G.inputTimer = setTimeout(completed, 1400);
  };
  for (const t of ['input', 'change', 'blur']) document.addEventListener(t, onField, true);

  // ---------- the picker ----------
  function rowsNow() {
    const q = P.q.trim().toLowerCase();
    if (P.product) {
      const p = byId[P.product];
      return routesFor(p.id).map((t) => {
        const n = stepsFor(p.id, t).length, i = S.progress[pkey(p.id, t)] || 0;
        return { act: 'route', id: t, name: ROUTES[t][0], blurb: ROUTES[t][1], glyph: t !== 'live' && S.session?.product === p.id && S.session.track === t,
          meta: t === 'live' ? '' : i >= n ? 'Done' : i > 0 ? `${i} of ${n}` : `${n} steps` };
      });
    }
    const item = (p) => ({ act: 'product', id: p.id, name: p.name, blurb: p.blurb, glyph: !!p.guided });
    if (q) {
      const hits = CATALOG.filter((p) => (p.name + ' ' + p.blurb + ' ' + p.id).toLowerCase().includes(q)).sort((a, b) => (b.guided ? 1 : 0) - (a.guided ? 1 : 0)).map(item);
      if (q.length < 3) return hits;
      // Anything typed can also be asked: "how do I store files" finds the guide and takes you there.
      const askRow = { act: 'ask', id: P.q.trim(), name: `Ask “${P.q.trim().slice(0, 60)}”`, blurb: 'Finds the guide and takes you there' };
      return CATALOG.some((p) => p.name.toLowerCase().includes(q) || p.id === q) ? [...hits, askRow] : [askRow, ...hits];
    }
    const out = [{ sec: 'Start here' }, ...START.map((id) => byId[id]).filter(Boolean).map(item)];
    for (const c of CATEGORIES) {
      const items = CATALOG.filter((p) => p.category === c);
      if (items.length) out.push({ sec: c }, ...items.map(item));
    }
    return out;
  }
  let palRows = [];
  function renderList() {
    const list = pal.querySelector('.list');
    const rows = rowsNow();
    palRows = rows.filter((r) => !r.sec);
    P.sel = Math.max(0, Math.min(P.sel, palRows.length - 1));
    let i = 0;
    let h = rows.map((r) => (r.sec ? `<div class="sec">${esc(r.sec)}</div>`
      : `<button class="row" data-i="${i++}"><span class="glyph${r.glyph ? ' g' : ''}"></span><span class="txt"><span class="name">${esc(r.name)}</span><span class="blurb">${esc(r.blurb)}</span></span>${r.meta ? `<span class="meta">${esc(r.meta)}</span>` : ''}</button>`)).join('');
    if (!palRows.length) h = `<div class="none">${P.product ? (P.drafting ? '<span class="busy"></span>Writing a guide from the docs' : 'No guide for this one yet.') : `Nothing matches “${esc(P.q)}”.`}</div>`;
    else if (P.product && P.drafting) h += `<div class="none"><span class="busy"></span>Writing more routes from the docs</div>`;
    list.innerHTML = h;
    list.scrollTop = 0;
    markSel();
  }
  function markSel() {
    pal.querySelectorAll('.row').forEach((r) => r.classList.toggle('sel', +r.dataset.i === P.sel));
    pal.querySelector('.row.sel')?.scrollIntoView({ block: 'nearest' });
  }
  function renderPalette() {
    if (P.product) {
      const p = byId[P.product];
      pal.innerHTML = `<div class="phead"><button class="back" data-act="back" aria-label="All products"></button><span class="t">${esc(p.name)}</span></div><div class="list"></div>`
        + `<div class="links">${p.dash ? '<button class="q" data-act="dash">Dashboard</button>' : ''}<button class="q" data-act="docs">Docs</button></div>`;
    } else {
      pal.innerHTML = `<div class="ask"><input type="text" placeholder="Search, or ask how to do something" autocomplete="off" spellcheck="false" aria-label="Search Cloudflare products, or ask how to do something">${S.canVoice ? micButton() : ''}</div><div class="list"></div>`;
      const input = pal.querySelector('input');
      input.value = P.q;
      setTimeout(() => input.focus({ preventScroll: true }), 30);
    }
    renderList();
  }
  function openPalette() {
    mount(); theme();
    P.open = true; P.product = null; P.sel = 0;
    hideGuide(); fab.classList.remove('on');
    renderPalette();
    scrim.classList.add('on'); pal.classList.add('on');
  }
  function closePalette() {
    P.open = false; P.q = '';
    scrim?.classList.remove('on'); pal?.classList.remove('on');
    tick();
  }
  async function pickProduct(id) {
    P.product = id; P.sel = 0; P.drafting = false;
    if (!GUIDES[id] && !S.gen[id]) { // products without a written guide get routes drafted from their docs
      P.drafting = true;
      api('/api/guide/' + encodeURIComponent(id)).then((g) => { if (g?.tracks) { S.gen[id] = g; store.set({ gen: S.gen }); } }).catch(() => {})
        .finally(() => { P.drafting = false; if (P.open && P.product === id) renderList(); });
    }
    renderPalette();
    setTimeout(() => pal.querySelector('.row')?.focus({ preventScroll: true }), 30);
  }
  function choose(i) {
    const r = palRows[i];
    if (!r) return;
    if (r.act === 'product') return pickProduct(r.id);
    if (r.act === 'ask') return void ask(r.id);
    const id = P.product;
    closePalette();
    S.auto.muted = false; S.auto.seen[id] = true; store.set({ auto: S.auto });
    startGuide(id, r.id);
  }
  function onPalClick(e) {
    const row = e.target.closest('.row');
    if (row) return choose(+row.dataset.i);
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'mic') listen();
    else if (act === 'back') { P.product = null; P.sel = 0; renderPalette(); }
    else if (act === 'docs') window.open(byId[P.product].docs, '_blank', 'noopener');
    else if (act === 'dash') { const d = byId[P.product].dash; closePalette(); openUrl(resolveGo(d)); }
  }
  function onPalKey(e) {
    if (e.key === 'ArrowDown') { P.sel = Math.min(P.sel + 1, palRows.length - 1); markSel(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { P.sel = Math.max(P.sel - 1, 0); markSel(); e.preventDefault(); }
    else if (e.key === 'Enter') { choose(P.sel); e.preventDefault(); }
    else if (e.key === 'Escape') { P.product ? (P.product = null, renderPalette()) : closePalette(); e.preventDefault(); }
    else if (e.key === 'Backspace' && P.product) { P.product = null; renderPalette(); e.preventDefault(); }
  }
  document.addEventListener('keydown', (e) => { if (P.open && e.key === 'Escape') closePalette(); }, true);

  // ---------- wiring ----------
  chrome.runtime.onMessage.addListener((msg, _s, reply) => {
    if (msg?.type === 'onramp:toggle') { P.open ? closePalette() : openPalette(); reply?.({ ok: true }); }
  });
  chrome.storage.onChanged?.addListener((ch, area) => {
    if (area !== 'local') return;
    if (ch.progress) S.progress = ch.progress.newValue || {};
    if (ch.session) {
      const a = ch.session.newValue || null, b = S.session;
      if (JSON.stringify(a && [a.product, a.track, a.idx]) !== JSON.stringify(b && [b.product, b.track, b.idx])) { S.session = a; resetStep(); tick(); }
    }
  });
  setInterval(() => {
    const h = ENV.href();
    if (h !== G.lastHref) { // single-page apps change the URL without reloading
      const first = !G.lastHref; G.lastHref = h;
      if (!first && S.session?.track === 'live' && !G.live.busy && !visible(G.el)) { G.live = { busy: false, last: null, error: null }; }
    }
    tick();
  }, 150);

  (async () => {
    const d = await store.get(['session', 'progress', 'gen', 'device', 'wantPalette', 'auto', 'voice', 'talk']);
    // A guide you asked for can reload the page on its way; a conversation that was going a moment ago carries on.
    if (d.talk && Date.now() - d.talk.at < 90000) { V.talk = true; V.turns = d.talk.turns || []; V.turnsAt = d.talk.at; V.leadUntil = d.talk.leadUntil || 0; }
    S.voice = { used: !!d.voice?.used, sound: !!d.voice?.sound };
    voice('can').then((r) => { S.canVoice = !!r?.ok; if (P.open && !P.product) renderPalette(); });
    S.progress = d.progress || {}; S.gen = d.gen || {}; S.session = d.session || null;
    S.auto = { muted: !!d.auto?.muted, seen: d.auto?.seen || {} };
    S.ready = true;
    S.device = d.device || crypto.randomUUID();
    if (!d.device) store.set({ device: S.device });
    if (d.wantPalette && Date.now() - d.wantPalette < 60000) { store.set({ wantPalette: 0 }); openPalette(); }
    tick();
  })();

  window.__onramp = { auto: () => S.auto, open: openPalette, close: closePalette, start: startGuide, stop: stopGuide, ask, listen, quiet,
    voice: () => ({ state: V.state, note: V.note, talk: V.talk, resting: V.resting, turns: V.turns.length, can: S.canVoice, ...S.voice, pointer: !!cur?.classList.contains('on') }), state: () => ({ session: S.session, card: card?.innerText, ring: ring?.classList.contains('on'), docked: card?.classList.contains('dock'), palette: P.open, rows: palRows.length }), ui: () => ({ card, pal }) };
})();
