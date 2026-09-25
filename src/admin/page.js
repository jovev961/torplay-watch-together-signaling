export const ADMIN_PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>TWTS Operations</title>
  <style>
    :root{color-scheme:dark;--bg:#080b12;--panel:#111827;--line:#273449;--muted:#94a3b8;--text:#f8fafc;--blue:#4f8cff;--green:#34d399;--red:#fb7185;--amber:#fbbf24}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at top,#16213a 0,var(--bg) 46%);color:var(--text);font:15px/1.5 system-ui,-apple-system,sans-serif}.shell{width:min(1040px,calc(100% - 32px));margin:auto;padding:48px 0 72px}.brand{display:flex;align-items:center;gap:14px;margin-bottom:28px}.mark{display:grid;place-items:center;width:44px;height:44px;border-radius:13px;background:linear-gradient(135deg,#5b8cff,#8b5cf6);font-weight:800}.brand h1{font-size:24px;margin:0}.brand p{margin:2px 0 0;color:var(--muted)}.card{background:rgba(17,24,39,.88);border:1px solid var(--line);border-radius:18px;padding:22px;box-shadow:0 20px 60px rgba(0,0,0,.25)}#login{max-width:430px;margin:80px auto}.grid{display:grid;grid-template-columns:repeat(12,1fr);gap:16px}.span4{grid-column:span 4}.span6{grid-column:span 6}.span12{grid-column:span 12}.metric strong{display:block;font-size:30px}.metric span,.muted{color:var(--muted)}h2{font-size:17px;margin:0 0 16px}label{display:block;color:var(--muted);margin:12px 0 6px}input{width:100%;padding:11px 12px;border:1px solid var(--line);border-radius:9px;background:#0b1220;color:var(--text)}button{border:0;border-radius:9px;padding:10px 14px;background:var(--blue);color:#fff;font-weight:650;cursor:pointer}button.secondary{background:#263247}button.danger{background:#be3144}button:disabled{opacity:.45;cursor:not-allowed}.actions{display:flex;flex-wrap:wrap;gap:10px}.row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:9px 0;border-bottom:1px solid rgba(148,163,184,.12)}.row:last-child{border:0}.pill{padding:3px 8px;border-radius:999px;background:#243047;color:var(--muted);font-size:12px}.pill.ok{background:rgba(52,211,153,.13);color:var(--green)}.pill.bad{background:rgba(251,113,133,.13);color:var(--red)}#notice{position:fixed;right:20px;bottom:20px;max-width:420px;padding:12px 16px;border-radius:10px;background:#1f2937;border:1px solid var(--line);display:none}.topbar{display:flex;justify-content:space-between;align-items:start;gap:16px}.hidden{display:none!important}code{color:#bfdbfe}@media(max-width:760px){.span4,.span6{grid-column:span 12}.shell{padding-top:24px}.topbar{align-items:center}.brand p{display:none}}
  </style>
</head>
<body>
  <main class="shell">
    <section id="login" class="card hidden">
      <div class="brand"><div class="mark">TW</div><div><h1>TWTS Operations</h1><p>Protected signaling administration</p></div></div>
      <form id="login-form"><label for="username">Username</label><input id="username" autocomplete="username" required><label for="password">Password</label><input id="password" type="password" autocomplete="current-password" required><div style="height:18px"></div><button type="submit">Sign in</button></form>
    </section>
    <section id="dashboard" class="hidden">
      <div class="topbar"><div class="brand"><div class="mark">TW</div><div><h1>TWTS Operations</h1><p>TorPlay Watch Together signaling</p></div></div><button class="secondary" id="logout">Sign out</button></div>
      <div class="grid">
        <article class="card metric span4"><span>Active rooms</span><strong id="rooms">—</strong></article>
        <article class="card metric span4"><span>Participants</span><strong id="participants">—</strong></article>
        <article class="card metric span4"><span>Connected now</span><strong id="connected">—</strong></article>
        <article class="card span6"><h2>Service configuration</h2><div id="configuration"></div></article>
        <article class="card span6"><h2>Runtime</h2><div id="runtime"></div></article>
        <article class="card span12"><h2>Actions</h2><p class="muted">Restart closes every room before requesting a fresh Vercel deployment. Active viewers will need to reconnect.</p><div class="actions"><button id="refresh">Refresh</button><button class="secondary" id="test-storage">Test storage</button><button class="secondary" id="cleanup">Clean expired rooms</button><button class="danger" id="reset">Reset room state</button><button class="danger" id="restart">Restart service</button></div></article>
      </div>
    </section>
  </main>
  <div id="notice"></div>
  <script>
    const login=document.querySelector('#login'),dashboard=document.querySelector('#dashboard'),notice=document.querySelector('#notice'),username=document.querySelector('#username'),password=document.querySelector('#password'),rooms=document.querySelector('#rooms'),participants=document.querySelector('#participants'),connected=document.querySelector('#connected'),configuration=document.querySelector('#configuration'),runtime=document.querySelector('#runtime'),restart=document.querySelector('#restart'),refresh=document.querySelector('#refresh'),cleanup=document.querySelector('#cleanup'),reset=document.querySelector('#reset');
    function toast(message,bad=false){notice.textContent=message;notice.style.display='block';notice.style.borderColor=bad?'var(--red)':'var(--line)';clearTimeout(toast.timer);toast.timer=setTimeout(()=>notice.style.display='none',5000)}
    async function api(path,options={}){const response=await fetch(path,{credentials:'same-origin',headers:{'Content-Type':'application/json',...(options.headers||{})},...options});const data=await response.json().catch(()=>({}));if(!response.ok){const error=new Error(data.error||'Request failed.');error.status=response.status;throw error}return data}
    function row(label,value,ok){return '<div class="row"><span>'+label+'</span><span class="pill '+(ok?'ok':'bad')+'">'+value+'</span></div>'}
    async function load(){try{const data=await api('/admin/api/status');login.classList.add('hidden');dashboard.classList.remove('hidden');rooms.textContent=data.stats.rooms;participants.textContent=data.stats.participants;connected.textContent=data.stats.connected;configuration.innerHTML=row('Room storage',data.storage.type,data.storage.ready)+row('Allowed origins',data.configuration.allowedOrigins?'Configured':'Open',data.configuration.allowedOrigins)+row('Admin credentials','Configured',data.configuration.adminConfigured)+row('Deploy hook',data.configuration.deployHook?'Configured':'Missing',data.configuration.deployHook);runtime.innerHTML=row('Service','Healthy',true)+row('Protocol','v'+data.protocol,true)+row('Instance uptime',Math.floor(data.uptimeSeconds)+'s',true)+row('Last restart',data.lastRestartAt?new Date(data.lastRestartAt).toLocaleString():'Not recorded',true);restart.disabled=!data.configuration.deployHook}catch(error){if(error.status===401){dashboard.classList.add('hidden');login.classList.remove('hidden')}else toast(error.message,true)}}
    document.querySelector('#login-form').addEventListener('submit',async event=>{event.preventDefault();try{await api('/admin/api/login',{method:'POST',body:JSON.stringify({username:username.value,password:password.value})});password.value='';await load()}catch(error){toast(error.message,true)}});
    document.querySelector('#logout').onclick=async()=>{await api('/admin/api/logout',{method:'POST',body:'{}'});await load()};
    refresh.onclick=load;
    async function action(name,body={}){try{const result=await api('/admin/api/actions/'+name,{method:'POST',body:JSON.stringify(body)});toast(result.message||'Action completed.');await load()}catch(error){toast(error.message,true)}}
    document.querySelector('#test-storage').onclick=()=>action('test-storage');
    cleanup.onclick=()=>action('cleanup');
    reset.onclick=()=>{if(confirm('Close every active Watch Together room?'))action('reset',{confirm:'RESET'})};
    restart.onclick=()=>{if(confirm('Close every room and trigger a new Vercel deployment?'))action('restart',{confirm:'RESTART'})};
    load();
  </script>
</body>
</html>`;
