// Self-contained dashboard served at GET /. Vanilla JS calls /v1/* with the
// session cookie (same-origin). baseDomain is injected for building site URLs.
export function dashboardHtml(baseDomain: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>drop · control</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&family=Hanken+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{
  --bg:#0b0c0e; --surface:#131517; --surface2:#181b1e;
  --line:rgba(255,255,255,.09); --line2:rgba(255,255,255,.14);
  --txt:#e9ecef; --mut:#8b929b; --dim:#5c636c;
  --acc:#caff4d; --acc-dim:rgba(202,255,77,.14);
  --danger:#ff6b6b; --amber:#ffc14d;
  --mono:"JetBrains Mono",ui-monospace,"SF Mono",Menlo,monospace;
  --sans:"Hanken Grotesk",-apple-system,system-ui,"Segoe UI",sans-serif;
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{
  background:var(--bg); color:var(--txt); font-family:var(--sans);
  -webkit-font-smoothing:antialiased; line-height:1.5;
  background-image:
    radial-gradient(900px 500px at 78% -10%, rgba(202,255,77,.08), transparent 60%),
    linear-gradient(var(--line) 1px, transparent 1px),
    linear-gradient(90deg, var(--line) 1px, transparent 1px);
  background-size:auto, 46px 46px, 46px 46px;
  background-position:0 0, -1px -1px, -1px -1px;
}
a{color:inherit}
.wrap{max-width:1080px;margin:0 auto;padding:0 28px}
header{
  display:flex;align-items:center;justify-content:space-between;
  padding:26px 0 22px;border-bottom:1px solid var(--line);
}
.brand{font-family:var(--mono);font-weight:700;font-size:20px;letter-spacing:-.5px;display:flex;align-items:center;gap:9px}
.brand .tri{color:var(--acc)}
.brand .v{font-size:10px;color:var(--dim);font-weight:500;border:1px solid var(--line);border-radius:999px;padding:2px 7px;margin-left:4px}
.who{display:flex;align-items:center;gap:14px;font-family:var(--mono);font-size:12.5px;color:var(--mut)}
.who a{color:var(--mut);text-decoration:none;border-bottom:1px dashed transparent}
.who a:hover{color:var(--acc);border-bottom-color:var(--acc)}
.head{display:flex;align-items:baseline;justify-content:space-between;margin:38px 0 20px}
.head h1{font-family:var(--mono);font-size:13px;font-weight:500;letter-spacing:3px;text-transform:uppercase;color:var(--mut)}
.head .count{font-family:var(--mono);font-size:13px;color:var(--dim)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px;padding-bottom:60px}
.card{
  background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:20px 20px 18px;
  cursor:pointer;position:relative;overflow:hidden;transition:border-color .18s,transform .18s,background .18s;
  opacity:0;transform:translateY(8px);animation:rise .5s cubic-bezier(.2,.7,.2,1) forwards;
}
@keyframes rise{to{opacity:1;transform:none}}
.card:hover{border-color:var(--line2);background:var(--surface2);transform:translateY(-2px)}
.card::after{content:"";position:absolute;inset:0;border-radius:14px;pointer-events:none;
  background:radial-gradient(420px 120px at 100% 0,var(--acc-dim),transparent 70%);opacity:0;transition:opacity .2s}
.card:hover::after{opacity:1}
.card .name{font-family:var(--mono);font-size:18px;font-weight:500;letter-spacing:-.3px;display:flex;align-items:center;gap:9px}
.dot{width:7px;height:7px;border-radius:50%;flex:none}
.dot.live{background:var(--acc);box-shadow:0 0 0 4px var(--acc-dim)}
.dot.empty{background:var(--dim)}
.card .host{color:var(--mut);font-size:13px;margin-top:7px;font-family:var(--mono)}
.card .row{display:flex;align-items:center;justify-content:space-between;margin-top:18px}
.badge{font-family:var(--mono);font-size:10.5px;letter-spacing:.5px;text-transform:uppercase;color:var(--mut);border:1px solid var(--line);border-radius:999px;padding:3px 9px}
.badge.own{color:var(--acc);border-color:rgba(202,255,77,.3)}
.ver{font-family:var(--mono);font-size:11px;color:var(--dim)}
.empty,.gate{min-height:60vh;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:18px}
.empty p,.gate p{color:var(--mut);max-width:420px}
.empty code{font-family:var(--mono);background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:3px 9px;color:var(--acc);font-size:13px}
.btn{font-family:var(--mono);font-size:13px;font-weight:500;border:1px solid var(--line2);background:var(--surface);color:var(--txt);
  border-radius:10px;padding:11px 20px;cursor:pointer;transition:.15s;text-decoration:none;display:inline-flex;align-items:center;gap:9px}
.btn:hover{border-color:var(--acc);color:var(--acc)}
.btn.primary{background:var(--acc);color:#0b0c0e;border-color:var(--acc);font-weight:700}
.btn.primary:hover{filter:brightness(1.08);color:#0b0c0e}
.btn.danger{color:var(--danger);border-color:rgba(255,107,107,.3)}
.btn.danger:hover{background:rgba(255,107,107,.1);border-color:var(--danger);color:var(--danger)}
.btn.sm{padding:6px 12px;font-size:11.5px;border-radius:8px}
/* drawer */
#scrim{position:fixed;inset:0;background:rgba(5,6,7,.6);backdrop-filter:blur(3px);opacity:0;pointer-events:none;transition:.2s;z-index:5}
#scrim.on{opacity:1;pointer-events:auto}
#drawer{position:fixed;top:0;right:0;height:100%;width:min(520px,100%);background:var(--bg);border-left:1px solid var(--line2);
  transform:translateX(100%);transition:transform .26s cubic-bezier(.2,.7,.2,1);z-index:6;overflow-y:auto;
  box-shadow:-30px 0 60px rgba(0,0,0,.5)}
#drawer.on{transform:none}
.dpad{padding:26px 28px 60px}
.dhead{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:6px}
.dhead .name{font-family:var(--mono);font-size:26px;font-weight:500;letter-spacing:-.6px}
.x{font-family:var(--mono);font-size:20px;color:var(--mut);background:none;border:none;cursor:pointer;line-height:1}
.x:hover{color:var(--acc)}
.dhost{font-family:var(--mono);font-size:13px;color:var(--acc);text-decoration:none;border-bottom:1px solid transparent}
.dhost:hover{border-bottom-color:var(--acc)}
.sec{margin-top:30px}
.sec h3{font-family:var(--mono);font-size:11px;letter-spacing:2px;text-transform:uppercase;color:var(--mut);margin-bottom:13px}
.item{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 0;border-bottom:1px solid var(--line)}
.item:last-child{border-bottom:none}
.item .meta{font-family:var(--mono);font-size:12px;color:var(--mut);min-width:0}
.item .meta b{color:var(--txt);font-weight:500}
.item .meta .sub{color:var(--dim);font-size:11px}
.cur{color:var(--acc) !important}
.field{display:flex;gap:9px;margin-top:12px}
.field input{flex:1;font-family:var(--mono);font-size:13px;background:var(--surface);border:1px solid var(--line);
  border-radius:9px;padding:10px 12px;color:var(--txt)}
.field input:focus{outline:none;border-color:var(--acc)}
.danger-zone{margin-top:34px;border:1px solid rgba(255,107,107,.25);border-radius:12px;padding:16px 18px;display:flex;align-items:center;justify-content:space-between;gap:14px}
.danger-zone p{font-size:13px;color:var(--mut)}
#toast{position:fixed;bottom:22px;left:50%;transform:translateX(-50%) translateY(20px);background:var(--surface2);
  border:1px solid var(--line2);border-radius:10px;padding:11px 18px;font-family:var(--mono);font-size:13px;
  opacity:0;transition:.2s;z-index:9;pointer-events:none}
#toast.on{opacity:1;transform:translateX(-50%)}
#toast.err{border-color:var(--danger);color:var(--danger)}
.spin{color:var(--mut);font-family:var(--mono);padding:40px 0;text-align:center}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="brand"><span class="tri">▸</span>drop<span class="v">control</span></div>
    <div class="who" id="who"></div>
  </header>
  <main id="main"><div class="spin">loading…</div></main>
</div>

<div id="scrim"></div>
<aside id="drawer"><div class="dpad" id="dpad"></div></aside>
<div id="toast"></div>

<script>
const BASE_DOMAIN = ${JSON.stringify(baseDomain)};
const $ = (s,r=document)=>r.querySelector(s);
const el=(t,c,txt)=>{const e=document.createElement(t);if(c)e.className=c;if(txt!=null)e.textContent=txt;return e};
const esc=s=>String(s);
let toastT;
function toast(msg,err){const t=$('#toast');t.textContent=msg;t.className='on'+(err?' err':'');clearTimeout(toastT);toastT=setTimeout(()=>t.className='',2600)}

// Build the public URL for a site. Local (*.localhost) → http + edge port; prod → as returned.
function siteUrl(name){
  if(BASE_DOMAIN.endsWith('.localhost')) return 'http://'+name+'.'+BASE_DOMAIN+':8474/';
  return 'https://'+name+'.'+BASE_DOMAIN+'/';
}
async function api(method,path,body){
  const r=await fetch(path,{method,headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
  if(r.status===401){gate();throw new Error('unauthenticated')}
  const j=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error(j.error||(method+' '+path+' → '+r.status));
  return j;
}
function gate(){
  $('#who').innerHTML='';
  $('#main').innerHTML='';
  const g=el('div','gate');
  g.appendChild(el('div','brand')).innerHTML='<span class="tri" style="color:var(--acc)">▸</span> drop';
  g.appendChild(el('p',null,'Sign in to publish and manage static sites on your company infrastructure.'));
  const a=el('a','btn primary','Sign in with Google →');a.href='/login';
  g.appendChild(a);
  $('#main').appendChild(g);
}
function shortVer(v){return v?v.replace(/^v_\\d+_/,'#'):'—'}
function fmtBytes(n){if(n==null)return'';if(n<1024)return n+' B';if(n<1048576)return (n/1024).toFixed(1)+' KB';return (n/1048576).toFixed(1)+' MB'}
function fmtDate(s){try{return new Date(s).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}catch{return s||''}}

let me_email='';
async function boot(){
  let me;
  try{ me=await api('GET','/v1/me') }catch{ return }     // gate() already shown on 401
  me_email=me.email;
  const who=$('#who');
  who.innerHTML='';
  who.appendChild(el('span',null,me.email));
  const lo=el('a',null,'logout');lo.href='/logout';who.appendChild(lo);
  await render();
}
async function render(){
  const {sites}=await api('GET','/v1/sites');
  const main=$('#main');main.innerHTML='';
  const head=el('div','head');
  head.appendChild(el('h1',null,'your sites'));
  head.appendChild(el('span','count',sites.length+(sites.length===1?' site':' sites')));
  main.appendChild(head);
  if(!sites.length){
    const e=el('div','empty');
    e.appendChild(el('p',null,'No sites yet.'));
    const p=el('p');p.innerHTML='Publish one from your terminal: <code>drop publish ./dist myapp</code>';
    e.appendChild(p);
    main.appendChild(e);return;
  }
  const grid=el('div','grid');
  sites.forEach((s,i)=>{
    const c=el('div','card');c.style.animationDelay=(i*45)+'ms';
    const n=el('div','name');
    n.appendChild(el('span','dot '+(s.current?'live':'empty')));
    n.appendChild(el('span',null,s.name));
    c.appendChild(n);
    c.appendChild(el('div','host',(s.current?siteUrl(s.name):'nothing published').replace(/^https?:\\/\\//,'')));
    const row=el('div','row');
    row.appendChild(el('span','badge'+(s.owner===me_email?' own':''),s.owner===me_email?'owner':'shared'));
    row.appendChild(el('span','ver',shortVer(s.current)));
    c.appendChild(row);
    c.onclick=()=>openSite(s.name);
    grid.appendChild(c);
  });
  main.appendChild(grid);
}
function closeDrawer(){$('#drawer').classList.remove('on');$('#scrim').classList.remove('on')}
$('#scrim').onclick=closeDrawer;
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeDrawer()});

async function openSite(name){
  const d=$('#dpad');d.innerHTML='<div class="spin">loading…</div>';
  $('#drawer').classList.add('on');$('#scrim').classList.add('on');
  let s;try{s=await api('GET','/v1/sites/'+name)}catch(e){toast(e.message,true);return}
  const isOwner=s.owner===me_email;
  d.innerHTML='';
  const dh=el('div','dhead');
  const left=el('div');
  left.appendChild(el('div','name',s.name));
  const link=el('a','dhost',siteUrl(name).replace(/^https?:\\/\\//,'')+' ↗');link.href=siteUrl(name);link.target='_blank';
  left.appendChild(link);
  dh.appendChild(left);
  const x=el('button','x','✕');x.onclick=closeDrawer;dh.appendChild(x);
  d.appendChild(dh);

  // versions
  const vs=el('div','sec');vs.appendChild(el('h3',null,'versions ('+s.versions.length+')'));
  if(!s.versions.length)vs.appendChild(el('p',null,'—'));
  s.versions.forEach(v=>{
    const it=el('div','item');
    const m=el('div','meta');
    m.innerHTML='<b class="'+(v.id===s.current?'cur':'')+'">'+shortVer(v.id)+(v.id===s.current?' · live':'')+'</b>'
      +'<div class="sub">'+fmtDate(v.createdAt)+' · '+v.fileCount+' files · '+fmtBytes(v.bytes)+' · '+esc(v.publishedBy)+'</div>';
    it.appendChild(m);
    if(v.id!==s.current){
      const b=el('button','btn sm','rollback');b.onclick=()=>act('rollback to '+shortVer(v.id),()=>api('POST','/v1/sites/'+name+'/rollback',{to:v.id}),name);
      it.appendChild(b);
    }
    vs.appendChild(it);
  });
  d.appendChild(vs);

  // collaborators
  const cs=el('div','sec');cs.appendChild(el('h3',null,'collaborators'));
  const owner=el('div','item');owner.innerHTML='<div class="meta"><b>'+esc(s.owner)+'</b><div class="sub">owner</div></div>';cs.appendChild(owner);
  s.collaborators.forEach(em=>{
    const it=el('div','item');
    it.appendChild(el('div','meta')).innerHTML='<b>'+esc(em)+'</b><div class="sub">collaborator</div>';
    if(isOwner){const b=el('button','btn sm danger','remove');b.onclick=()=>act('remove '+em,()=>api('DELETE','/v1/sites/'+name+'/collaborators/'+encodeURIComponent(em)),name);it.appendChild(b)}
    cs.appendChild(it);
  });
  if(isOwner){
    const f=el('div','field');const inp=el('input');inp.placeholder='teammate@paytm.com';inp.type='email';
    const b=el('button','btn sm','share');
    b.onclick=()=>{if(!inp.value)return;act('shared with '+inp.value,()=>api('POST','/v1/sites/'+name+'/collaborators',{email:inp.value.trim()}),name)};
    f.appendChild(inp);f.appendChild(b);cs.appendChild(f);
  }
  d.appendChild(cs);

  // owner-only: transfer + delete
  if(isOwner){
    const ts=el('div','sec');ts.appendChild(el('h3',null,'transfer ownership'));
    const f=el('div','field');const inp=el('input');inp.placeholder='new-owner@paytm.com';inp.type='email';
    const b=el('button','btn sm','transfer');
    b.onclick=()=>{if(!inp.value)return;if(!confirm('Transfer '+name+' to '+inp.value+'? You become a collaborator.'))return;act('transferred',()=>api('POST','/v1/sites/'+name+'/transfer',{email:inp.value.trim()}),name)};
    f.appendChild(inp);f.appendChild(b);ts.appendChild(f);d.appendChild(ts);

    const dz=el('div','danger-zone');
    dz.appendChild(el('p',null,'Unpublish this site. It stops resolving immediately.'));
    const del=el('button','btn sm danger','delete');
    del.onclick=()=>{if(!confirm('Delete '+name+'? This unpublishes it.'))return;act('deleted '+name,()=>api('DELETE','/v1/sites/'+name),null)};
    dz.appendChild(del);d.appendChild(dz);
  }
}
async function act(msg,fn,reopen){
  try{await fn();toast('✓ '+msg);await render();if(reopen)openSite(reopen);else closeDrawer()}
  catch(e){toast(e.message,true)}
}
boot();
</script>
</body>
</html>`;
}
