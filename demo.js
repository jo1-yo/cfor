// Runs the real extension code (content.js) against a mock dashboard inside the frame on this page.
// Control labels mirror the real Cloudflare dashboard as read on 2026-11-14.
(() => {
  const ACCT = '0123456789abcdef0123456789abcdef';
  const DASH = 'https://dash.cloudflare.com/';
  const frame = document.getElementById('frame');
  const page = document.getElementById('page');
  const addr = document.getElementById('addr');
  // The page can be served from anywhere (imjane.top/cfor on GitHub Pages); the API and MCP server live on the Worker.
  const API = /(^|\.)workers\.dev$|^localhost$|^127\./.test(location.hostname) ? '' : 'https://onramp.janezhang555l.workers.dev';
  const mem = {};
  let url = DASH + ACCT + '/home';
  let osStage = 0;

  const dlg = (inner) => `<div class="veil"></div><div role="dialog">${inner}</div>`;
  const HELLO = `<h2>Deploy Hello World</h2><p>A simple Worker that returns Hello World.</p><label>Worker name</label>
    <div class="fieldbox"><input aria-label="worker" name="worker" value="shy-moon-1234" size="13"><span>.demo.workers.dev</span></div>
    <div class="row"><button id="helloback">Back</button><button class="pri" data-nav="/workers/services/view/hello-onramp/production">Deploy</button></div>`;
  const PAGES = {
    // Layout and wording follow the account home of a new Cloudflare account (seen 2026-11-14).
    '/home': () => `<div class="home"><span class="onb">Onboard your agent to Cloudflare</span><h1>Shipping today?</h1>
      <div class="hs"><span>Search</span><kbd>⌘K</kbd></div>
      <div class="cards">
        <div class="c"><div class="art"></div><h2>Ship something new</h2><p>Deploy simple sites or full-stack apps with integrated compute, AI, storage, and media services.</p><button data-nav="/workers-and-pages/create">Create app</button></div>
        <div class="c"><div class="art"></div><h2>Add a domain</h2><p>Register a new domain or bring your own. Free DNS, automatic HTTPS, and DDoS protection included.</p><input aria-label="Type in your domain" placeholder="Type in your domain..."></div>
        <div class="c"><div class="art"></div><h2>Protect apps and users</h2><p>Modern access control, private networking and security for your users, devices, and servers.</p><button>Protect your app</button></div>
      </div></div>`,
    '/workers-and-pages': () => `<h1>Workers &amp; Pages</h1><p>Build and deploy serverless applications.</p>
      <div class="row"><a class="btn2 pri" href="#" data-nav="/workers-and-pages/create">Create application</a><input aria-label="Search applications" placeholder="Search applications" style="width:190px"><button>Refresh</button></div>
      <div class="empty">No projects found</div>`,
    '/workers-and-pages/create': () => `<h1>Workers &amp; Pages</h1>${dlg(`<div id="app-step"><h2>Create an app</h2>
      <button class="opt">Connect GitHub</button><button class="opt">Connect with GitLab</button><button class="opt" id="hello">Start with Hello World!</button>
      <button class="opt">Select a template</button><button class="opt">Upload your static files</button></div>`)}`,
    '/workers/services/view/hello-onramp/production': () => `<h1>hello-onramp</h1><p>Deployed a moment ago.</p>
      <div class="row"><a href="#" id="visit">Visit</a><a class="btn2" href="#">Edit code</a></div><h2>Metrics</h2><div class="empty">No requests yet</div>`,
    '/workers/kv/namespaces': () => `<h1>Workers KV</h1><p>Global, low-latency key-value storage.</p>
      <div class="row"><button class="pri" id="newkv">Create a KV namespace</button><input aria-label="Search" placeholder="Search" style="width:160px"><button>Refresh</button></div><div class="empty">No namespaces yet</div>`,
    '/workers/kv/namespaces/abc': () => `<h1>onramp-kv</h1><p>Namespace</p>
      <div class="row"><input aria-label="Search keys by prefix" placeholder="Search keys by prefix" style="width:200px"><button>Refresh</button><button class="pri" id="addentry">Add entry</button></div><div class="empty" id="entries">No entries yet</div>`,
    '/workers/d1': () => `<h1>D1 Database</h1><p>Serverless SQL databases.</p><div class="row"><a class="btn2 pri" href="#" data-nav="/workers/d1/create">Create Database</a><input aria-label="Search databases" placeholder="Search databases" style="width:180px"></div><div class="empty">You have no D1 databases.</div>`,
    '/workers/d1/create': () => `<h1>Create a D1 database</h1><label for="d1n">Name</label><input id="d1n" name="name"><div class="row"><button>Cancel</button><button class="pri" data-nav="/workers/d1/databases/abc">Create</button></div>`,
    '/workers/d1/databases/abc': () => `<h1>onramp-db</h1><div class="row"><button role="tab">Overview</button><button role="tab" id="console">Console</button><button role="tab">Settings</button></div><div id="sql" class="empty">Open the Console to run SQL.</div>`,
    '/ai/ai-gateway': () => `<h1>AI Gateway</h1><p>Observe and control your AI applications. <a href="#">Learn more</a></p>
      <div class="row"><select aria-label="API type" style="width:150px"><option>Universal</option></select><select aria-label="AI provider" style="width:150px"><option>OpenAI</option></select><select aria-label="SDK or client" style="width:150px"><option>curl</option></select></div>
      <div class="row"><button>Copy</button><button>Create authentication token</button></div>
      <div class="row"><a href="#">View all models</a><a href="#" data-nav="/ai/ai-gateway/create-gateway">Create a custom gateway</a><a href="#">Manage credits</a></div>`,
    '/ai/ai-gateway/create-gateway': () => `<h1>Create new gateway</h1><label for="gid">Gateway ID</label><input id="gid" placeholder="my-gateway">
      <div class="row"><button>Cancel</button><button class="pri" data-nav="/ai/ai-gateway/gateways/onramp/overview">Create</button></div>`,
    '/ai/ai-gateway/gateways/onramp/overview': () => `<h1>onramp</h1><p>Gateway created.</p><div class="empty">No requests logged yet</div>`,
    '/ai/workers-ai': () => `<h1>Workers AI</h1><p>Run models on Cloudflare's GPUs.</p><div class="row"><a href="#">REST API</a><a href="#">Documentation</a></div><h2>Browse Model Catalog</h2><a href="#" id="models">Browse All Models</a>`,
    '/turnstile': () => `<h1>Turnstile widgets</h1><p>A smart CAPTCHA alternative.</p><div class="row"><button class="pri" data-nav="/turnstile/add">Add widget manually</button><button>Set up with Spin</button></div>`,
    '/turnstile/add': () => `<h1>Add Widget</h1><label for="wn">Widget name</label><input id="wn" name="name"><label for="hn">Hostnames</label><input id="hn" role="combobox">
      <div class="row"><button>Cancel</button><button class="pri" data-nav="/turnstile/widget">Create</button></div>`,
    '/turnstile/widget': () => `<h1>Widget created</h1><h2>Site Key</h2><p>0x4AAAAAAA-demo</p><h2>Secret Key</h2><p>Hidden in this demo</p>`,
    '/r2/overview': () => `<h1>R2 Object Storage</h1><p>Store files without egress fees.</p><div class="row"><button class="pri" id="newr2">Create bucket</button></div>`,
    '/r2/default/buckets/onramp-files': () => `<h1>onramp-files</h1><p>Bucket created.</p><div class="row"><button class="pri" id="upload">Upload</button><button>Create directory</button></div><div class="empty" id="objects">No objects yet</div>`,
    '/workers/queues': () => `<h1>Queues</h1><p>Send and receive messages reliably.</p><div class="row"><button class="pri" id="newq">Create queue</button></div><div class="empty">No queues yet</div>`,
  };
  const SITES = {
    // The real page is a wizard: sign-in first, and the form lives on a later slide that is clipped out of sight until then.
    'https://os.cloudflare.app/deploy': () => `<h1>Deploy Cloudflare OS</h1><p>Your own Cloudflare OS instance, in your Cloudflare account</p>
      <div class="wiz"><div class="slides" style="transform:translateX(${osStage ? '-100%' : '0'})">
        <section><h2>Deploy Cloudflare OS to your Cloudflare account</h2><p>Here's what will happen</p>
          <div class="li"><strong>Sign in with Cloudflare</strong><br>You'll approve access on the Cloudflare dashboard.</div>
          <div class="li"><strong>We set up Cloudflare OS for you</strong><br>A few Workers, KV namespaces, and an R2 bucket. It takes about a minute.</div>
          <div class="row end"><button class="pri" data-site="https://dash.cloudflare.com/oauth2/auth">Sign in with Cloudflare</button></div></section>
        <section><h2>Name your instance</h2>
          <label for="instance-name">Instance name</label><input id="instance-name" placeholder="cloudflareos">
          <label for="admin-username">Admin email</label><input id="admin-username" placeholder="you@example.com">
          <h2>AI models</h2><p>Built-in models work out of the box.</p>
          <div class="row end"><button class="pri" id="osdeploy">Deploy</button></div></section>
      </div></div>`,
    'https://dash.cloudflare.com/oauth2/auth': () => `<h1>Authorize Cloudflare OS</h1><p>Deploy into Demo account.</p><div class="row"><button>Cancel</button><button class="pri" id="authz">Authorize</button></div>`,
  };

  function navigate(next) {
    url = next.replace(DASH + '?to=/:account', DASH + ACCT);
    const path = url.startsWith(DASH + ACCT) ? url.slice((DASH + ACCT).length) || '/home' : null;
    addr.textContent = url.replace(/^https:\/\//, '').replace(ACCT, 'your-account');
    const make = SITES[url] || (path && PAGES[path]);
    page.innerHTML = make ? make() : `<h1>Outside the demo</h1><p>This page is not part of the demo. On the real dashboard, the ring picks up from here.</p>`;
    page.scrollTop = 0;
  }
  page.addEventListener('click', (e) => {
    const t = e.target;
    if (t.closest('a')) e.preventDefault();
    const nav = t.closest('[data-nav]'), site = t.closest('[data-site]');
    if (site) return void setTimeout(() => navigate(site.dataset.site), 80);
    if (nav) return void setTimeout(() => navigate(DASH + ACCT + nav.dataset.nav), 80);
    const add = (html) => page.insertAdjacentHTML('beforeend', dlg(html));
    const closeDlg = () => page.querySelectorAll('.veil,[role=dialog]').forEach((n) => n.remove());
    if (t.id === 'authz') { osStage = 1; return void setTimeout(() => navigate('https://os.cloudflare.app/deploy'), 80); }
    if (t.id === 'osdeploy') return void (page.innerHTML = '<h1>Deploying</h1><p>Creating Workers, KV namespaces and an R2 bucket. Your URL will be demo-os.you.workers.dev.</p>');
    if (t.id === 'helloback') return void navigate(DASH + ACCT + '/workers-and-pages/create');
    if (t.id === 'hello') document.getElementById('app-step').innerHTML = HELLO;
    else if (t.id === 'newkv') add(`<h2>Create a KV namespace</h2><label for="kn">Namespace name</label><input id="kn" name="name" placeholder="your_kv_namespace"><div class="row"><button data-x>Cancel</button><button class="pri" data-nav="/workers/kv/namespaces/abc">Create</button></div>`);
    else if (t.id === 'addentry') add(`<h2>Add entry</h2><label for="kk">Key</label><input id="kk" name="key"><label for="kv">Value</label><input id="kv" name="value"><div class="row"><button data-x>Cancel</button><button class="pri" id="saveentry">Add entry</button></div>`);
    else if (t.id === 'saveentry') { const k = document.getElementById('kk').value || 'greeting'; closeDlg(); document.getElementById('entries').textContent = k + ' saved'; }
    else if (t.id === 'newq') add(`<h2>Create queue</h2><label for="qn">Queue name</label><input id="qn"><div class="row"><button data-x>Cancel</button><button class="pri" data-x>Create</button></div>`);
    else if (t.id === 'newr2') add(`<h2>Create a bucket</h2><label for="bn">Bucket name</label><input id="bn"><div class="row"><button data-x>Cancel</button><button class="pri" data-nav="/r2/default/buckets/onramp-files">Create bucket</button></div>`);
    else if (t.id === 'upload') document.getElementById('objects').textContent = 'hello.txt uploaded';
    else if (t.id === 'console') document.getElementById('sql').innerHTML = '<input aria-label="SQL" style="width:100%" placeholder="SELECT 1"><div class="row"><button class="pri">Execute</button></div>';
    else if (t.matches('[data-x]')) closeDlg();
  });

  const chromeShim = {
    runtime: {
      id: 'demo',
      onMessage: { addListener() {} },
      async sendMessage(msg) {
        if (msg?.type === 'onramp:voice') { // on the website the page itself holds the mic and the speaker
          const v = window.OnrampVoice;
          if (!v) return { ok: false, error: 'unsupported' };
          if (msg.op === 'can') return { ok: v.can() };
          if (msg.op === 'listen') return v.listen();
          if (msg.op === 'idle') { await v.idle(); return { ok: true }; }
          if (msg.op === 'say') v.say({ url: API + '/api/say?t=' + encodeURIComponent(msg.text), text: msg.text }, msg.queue);
          else if (typeof v[msg.op] === 'function') v[msg.op]();
          return { ok: true };
        }
        if (msg?.type !== 'onramp:api') return;
        try {
          const res = await fetch(API + msg.path, msg.body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(msg.body) } : undefined);
          const data = await res.json().catch(() => ({}));
          return res.ok ? { ok: true, data } : { ok: false, error: data.error || 'Request failed' };
        } catch { return { ok: false, error: 'offline' }; }
      },
    },
    storage: {
      local: { get: async (keys) => Object.fromEntries([].concat(keys).map((k) => [k, mem[k]])), set: async (o) => void Object.assign(mem, o) },
      onChanged: { addListener() {} },
    },
  };
  window.__ONRAMP_ENV = { chrome: chromeShim, root: () => page, frame: () => frame, href: () => url, go: navigate };
  window.__demo = { navigate, url: () => url };

  const FIRST = { kv: '/workers/kv/namespaces', 'ai-gateway': '/ai/ai-gateway' };
  function play(id) {
    if (id === '*') return window.__onramp.open();
    window.__onramp.close();
    osStage = 0;
    navigate(FIRST[id] ? DASH + ACCT + FIRST[id] : DASH + ACCT + '/home');
    window.__onramp.start(id, 'click', true);
  }
  document.querySelector('.try').addEventListener('click', (e) => { const b = e.target.closest('[data-demo]'); if (b) play(b.dataset.demo); });
  // Ask bar: the question goes to the same engine as the extension's picker and mic; the answer plays out in the frame.
  const askq = document.getElementById('askq'), askmic = document.getElementById('askmic');
  const showFrame = () => frame.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  function askDemo(q) { window.__onramp.close(); window.__onramp.ask(q); askq.value = ''; showFrame(); }
  document.getElementById('askbar').addEventListener('submit', (e) => { e.preventDefault(); if (askq.value.trim()) askDemo(askq.value); });
  document.querySelector('.asks').addEventListener('click', (e) => { const b = e.target.closest('[data-ask]'); if (b) askDemo(b.dataset.ask); });
  askmic.addEventListener('click', () => { window.__onramp.close(); window.__onramp.listen(); showFrame(); });
  if (!window.OnrampVoice?.can()) askmic.hidden = true;
  if (matchMedia('(max-width: 480px)').matches) askq.placeholder = 'Ask how to do something';
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-copy-from]');
    if (!b) return;
    const text = document.getElementById(b.dataset.copyFrom).textContent;
    try { await navigator.clipboard.writeText(text); } catch {
      const t = document.createElement('textarea');
      t.value = text; t.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(t); t.select();
      try { document.execCommand('copy'); } catch {}
      t.remove();
    }
    b.classList.add('ok');
    setTimeout(() => b.classList.remove('ok'), 1600);
  });
  // A web page cannot open chrome:// addresses (Chrome blocks it), so clicking copies the address instead.
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-copy]');
    if (!b) return;
    const said = b.nextElementSibling;
    let ok = false;
    try { await navigator.clipboard.writeText(b.dataset.copy); ok = true; } catch {
      const t = document.createElement('textarea'); // older path; also works when the tab is not focused
      t.value = b.dataset.copy; t.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(t); t.select();
      try { ok = document.execCommand('copy'); } catch {}
      t.remove();
    }
    said.textContent = ok ? 'Copied. Paste it in the address bar' : 'Select it and copy';
    setTimeout(() => { said.textContent = ''; }, 4000);
  });
  const mcpBtn = document.getElementById('mcpbtn'), mcpPop = document.getElementById('mcppop');
  const setPop = (open) => { mcpPop.hidden = !open; mcpBtn.setAttribute('aria-expanded', String(open)); };
  mcpBtn.addEventListener('click', (e) => { e.stopPropagation(); setPop(mcpPop.hidden); });
  document.addEventListener('click', (e) => { if (!mcpPop.hidden && !mcpPop.contains(e.target)) setPop(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setPop(false); });
  document.getElementById('mcp').textContent = `claude mcp add --transport http onramp ${API || location.origin}/mcp`;
  // Like the real thing: land on the account home and the first guide starts by itself.
  navigate(DASH + ACCT + '/home');
})();
