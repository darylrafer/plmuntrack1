/* =========================================================
   STATE
========================================================= */
let visitors = [];   // {id,name,email,phone,purpose,host,org,createdAt}
let logs = [];        // {id,visitorId,checkin,checkout,status:'in'|'out',flagged,flagReason,rawToken}
let currentFilter = 'all';
let hourlyChart = null;
let qrInstance = null;
let genTimer = null;
let genExpiry = 0;
let lastGeneratedToken = null;
let html5QrCode = null;

const SECRET = 'PLMUNTRACK-DEMO-SIGNING-KEY';
const TOKEN_LIFETIME_MS = 30000;

/* =========================================================
   GOOGLE SHEETS / AUTH CONFIGURATION
   1) Deploy google-apps-script/Code.gs as a Web App.
   2) Put its /exec URL below.
   3) Create a Google OAuth Web Client ID and put it below.
   4) Set INSTITUTIONAL_EMAIL_DOMAIN in Code.gs to PLMUN's real domain.
========================================================= */
const GOOGLE_SHEETS_WEB_APP_URL = 'PASTE_YOUR_APPS_SCRIPT_WEB_APP_URL_HERE';
const GOOGLE_CLIENT_ID = 'PASTE_YOUR_GOOGLE_OAUTH_CLIENT_ID_HERE';
let googleUser = null;
let googleCredential = null;
const APP_TIMEZONE = 'Asia/Manila';


/* =========================================================
   GOOGLE LOGIN + SHEETS API BRIDGE
========================================================= */
function isGoogleConfigured(){
  return GOOGLE_CLIENT_ID && !GOOGLE_CLIENT_ID.startsWith('PASTE_') && GOOGLE_SHEETS_WEB_APP_URL && !GOOGLE_SHEETS_WEB_APP_URL.startsWith('PASTE_');
}
function showAuthStatus(){
  const box=document.getElementById('google-auth');
  if(!box) return;
  box.innerHTML = googleUser
    ? `<div class="google-user" title="${escapeHtml(googleUser.email||'')}">✓ ${escapeHtml(googleUser.name||googleUser.email||'Google account')}</div><button class="btn ghost sm" id="btn-google-logout">Sign out</button>`
    : '<div class="google-login-hint">Google login required</div>';
  const out=document.getElementById('btn-google-logout');
  if(out) out.onclick=()=>{ googleUser=null; googleCredential=null; if(window.google?.accounts?.id) window.google.accounts.id.disableAutoSelect(); showAuthStatus(); };
}
function decodeJwtPayload(jwt){
  try{ return JSON.parse(atob(jwt.split('.')[1].replace(/-/g,'+').replace(/_/g,'/'))); }catch(e){ return null; }
}
function handleGoogleCredential(response){
  const payload=decodeJwtPayload(response.credential);
  if(!payload) return;
  googleCredential=response.credential;
  googleUser={name:payload.name||'',email:payload.email||'',picture:payload.picture||''};
  showAuthStatus();
}
function initGoogleLogin(){
  const box=document.getElementById('google-auth');
  if(!box) return;
  if(!isGoogleConfigured()){ showAuthStatus(); return; }
  const script=document.createElement('script');
  script.src='https://accounts.google.com/gsi/client';
  script.async=true; script.defer=true;
  script.onload=()=>{
    google.accounts.id.initialize({client_id:GOOGLE_CLIENT_ID,callback:handleGoogleCredential,auto_select:false});
    box.innerHTML='';
    google.accounts.id.renderButton(box,{theme:'outline',size:'small',text:'signin_with',shape:'rectangular'});
  };
  document.head.appendChild(script);
}
async function googleRequest(action,payload={}){
  if(!isGoogleConfigured()) throw new Error('Google integration is not configured yet.');
  if(!googleCredential) throw new Error('Please sign in with Google first.');
  const response=await fetch(GOOGLE_SHEETS_WEB_APP_URL,{method:'POST',headers:{'Content-Type':'text/plain;charset=utf-8'},body:JSON.stringify({action,...payload,idToken:googleCredential})});
  const data=await response.json();
  if(!data.ok) throw new Error(data.error||'Google Sheets request failed.');
  return data;
}

/* =========================================================
   STORAGE (simulated encryption at rest)
========================================================= */
function encode(obj){
  try{ return btoa(unescape(encodeURIComponent(JSON.stringify(obj)))); }
  catch(e){ return JSON.stringify(obj); }
}
function decode(str){
  try{ return JSON.parse(decodeURIComponent(escape(atob(str)))); }
  catch(e){ return null; }
}

async function loadAll(){
  try{
    const v = await window.storage.get('vms_visitors_enc');
    visitors = v ? (decode(v.value) || []) : [];
  }catch(e){ visitors = []; }
  try{
    const l = await window.storage.get('vms_logs_enc');
    logs = l ? (decode(l.value) || []) : [];
  }catch(e){ logs = []; }
}
async function saveVisitors(){
  try{ await window.storage.set('vms_visitors_enc', encode(visitors)); }catch(e){}
}
async function saveLogs(){
  try{ await window.storage.set('vms_logs_enc', encode(logs)); }catch(e){}
}

/* =========================================================
   UTIL
========================================================= */
function uid(){ return 'id-' + Math.random().toString(36).slice(2,10) + Date.now().toString(36); }
function fmtTime(ts){ return new Date(ts).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}); }
function fmtDateTime(ts){ return new Date(ts).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}); }
function isToday(ts){ const d=new Date(ts), n=new Date(); return d.toDateString()===n.toDateString(); }
function durationStr(startMs,endMs){
  const mins = Math.max(0, Math.round((endMs-startMs)/60000));
  if(mins < 60) return mins + ' min';
  return Math.floor(mins/60) + 'h ' + (mins%60) + 'm';
}
function visitorById(id){ return visitors.find(v=>v.id===id); }
function simpleSign(str){
  let hash = 0;
  const s = str + SECRET;
  for(let i=0;i<s.length;i++){ hash = ((hash<<5)-hash + s.charCodeAt(i))|0; }
  return (hash>>>0).toString(36);
}
function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

/* =========================================================
   NAVIGATION
========================================================= */
const titles = {
  dashboard:['Dashboard','Live visitor activity and attendance overview'],
  visitors:['Visitors','Add, edit and remove visitor records'],
  generator:['QR Generator','Create a time-limited QR code for a registered visitor'],
  scanner:['QR Scanner','Scan a visitor code to check them in or out'],
  logs:['Attendance Logs','Full history of check-ins and check-outs']
};

const currentPage = document.body.dataset.page || 'dashboard';
document.querySelectorAll('.nav-item[data-page]').forEach(item=>{
  item.classList.toggle('active', item.dataset.page === currentPage);
});

const pageTitle = document.getElementById('topbar-title');
const pageSub = document.getElementById('topbar-sub');
if(pageTitle && titles[currentPage]){
  pageTitle.textContent = titles[currentPage][0];
  pageSub.textContent = titles[currentPage][1];
}

/* =========================================================
   CLOCK
========================================================= */
setInterval(()=>{
  document.getElementById('clock').textContent = new Date().toLocaleTimeString();
}, 1000);

/* =========================================================
   MODAL (visitor add/edit + confirm delete)
========================================================= */
function openModal(html){
  const root = document.getElementById('modal-root');
  root.innerHTML = '<div class="modal-overlay" id="modal-overlay"><div class="modal">'+html+'</div></div>';
  document.getElementById('modal-overlay').addEventListener('click', e=>{
    if(e.target.id==='modal-overlay') closeModal();
  });
}
function closeModal(){ document.getElementById('modal-root').innerHTML=''; }

function openVisitorForm(existing){
  const v = existing || {};
  openModal(`
    <h3>${existing? 'Edit visitor' : 'Add visitor'}</h3>
    <div class="field"><label>Full name</label><input id="f-name" value="${v.name?escapeHtml(v.name):''}" placeholder="Juan Dela Cruz"></div>
    <div class="field-row">
      <div class="field"><label>Person type</label><select id="f-type"><option value="student" ${v.type==='student'?'selected':''}>Student</option><option value="visitor" ${v.type!=='student'?'selected':''}>Visitor</option></select></div>
      <div class="field"><label>Institution ID (students)</label><input id="f-institution-id" value="${v.institutionId?escapeHtml(v.institutionId):''}" placeholder="Student ID"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Email</label><input id="f-email" value="${v.email?escapeHtml(v.email):''}" placeholder="school email for students / personal email for visitors"></div>
      <div class="field"><label>Phone</label><input id="f-phone" value="${v.phone?escapeHtml(v.phone):''}" placeholder="09xx xxx xxxx"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Purpose of visit</label><input id="f-purpose" value="${v.purpose?escapeHtml(v.purpose):''}" placeholder="Meeting, delivery, interview…"></div>
      <div class="field"><label>Host / department</label><input id="f-host" value="${v.host?escapeHtml(v.host):''}" placeholder="Ms. Santos, HR"></div>
    </div>
    <div class="modal-actions">
      <button class="btn ghost" id="modal-cancel">Cancel</button>
      <button class="btn primary" id="modal-save">${existing?'Save changes':'Add visitor'}</button>
    </div>
  `);
  document.getElementById('modal-cancel').onclick = closeModal;
  document.getElementById('modal-save').onclick = async ()=>{
    const name = document.getElementById('f-name').value.trim();
    if(!name){ document.getElementById('f-name').style.borderColor='var(--warn)'; return; }
    const type=document.getElementById('f-type').value;
    const email=document.getElementById('f-email').value.trim();
    const institutionId=document.getElementById('f-institution-id').value.trim();
    if(!email){ document.getElementById('f-email').style.borderColor='var(--warn)'; return; }
    if(type==='student' && !institutionId){ document.getElementById('f-institution-id').style.borderColor='var(--warn)'; return; }
    const data = {name,email,phone:document.getElementById('f-phone').value.trim(),purpose:document.getElementById('f-purpose').value.trim(),host:document.getElementById('f-host').value.trim(),type,institutionId};
    if(existing){
      Object.assign(existing, data);
    } else {
      visitors.push({id:uid(), ...data, createdAt:Date.now()});
    }
    await saveVisitors();
    renderVisitors();
    renderDashboard();
    closeModal();
  };
}

function confirmDialog(message, onConfirm){
  openModal(`
    <h3>Are you sure?</h3>
    <p style="color:var(--muted);font-size:13.5px;">${message}</p>
    <div class="modal-actions">
      <button class="btn ghost" id="modal-cancel">Cancel</button>
      <button class="btn danger" id="modal-confirm">Delete</button>
    </div>
  `);
  document.getElementById('modal-cancel').onclick = closeModal;
  document.getElementById('modal-confirm').onclick = ()=>{ onConfirm(); closeModal(); };
}

/* =========================================================
   VISITORS — CRUD
========================================================= */
const addVisitorBtn = document.getElementById('btn-add-visitor');
if(addVisitorBtn) addVisitorBtn.addEventListener('click', ()=>openVisitorForm(null));

const visitorSearch = document.getElementById('visitor-search');
if(visitorSearch) visitorSearch.addEventListener('input', renderVisitors);

function renderVisitors(){
  const q = document.getElementById('visitor-search').value.trim().toLowerCase();
  const body = document.getElementById('visitors-body');
  const filtered = visitors.filter(v => !q || v.name.toLowerCase().includes(q) || (v.host||'').toLowerCase().includes(q));
  document.getElementById('visitors-empty').style.display = filtered.length? 'none':'block';
  body.innerHTML = filtered.map(v=>`
    <tr>
      <td><strong>${escapeHtml(v.name)}</strong></td>
      <td><span class="badge ${v.type==='student'?'in':'out'}">${escapeHtml(v.type||'visitor')}</span></td>
      <td class="muted">${escapeHtml(v.email||'—')}${v.phone? '<br><span class="mono" style="font-size:11.5px;">'+escapeHtml(v.phone)+'</span>':''}</td>
      <td class="muted">${escapeHtml(v.purpose||'—')}</td>
      <td class="muted">${escapeHtml(v.host||'—')}</td>
      <td class="muted mono" style="font-size:11.5px;">${fmtDateTime(v.createdAt)}</td>
      <td style="text-align:right;white-space:nowrap;">
        <button class="btn ghost sm" data-edit="${v.id}">Edit</button>
        <button class="btn danger sm" data-del="${v.id}">Delete</button>
      </td>
    </tr>
  `).join('');
  body.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>openVisitorForm(visitorById(b.dataset.edit)));
  body.querySelectorAll('[data-del]').forEach(b=>b.onclick=()=>{
    const v = visitorById(b.dataset.del);
    confirmDialog(`This will permanently delete <strong>${escapeHtml(v.name)}</strong> and cannot be undone.`, async ()=>{
      visitors = visitors.filter(x=>x.id!==v.id);
      await saveVisitors();
      renderVisitors();
      renderDashboard();
    });
  });
}

/* =========================================================
   QR GENERATOR
========================================================= */
function populateGenSelect(){
  const sel = document.getElementById('gen-visitor-select');
  if(!sel) return;
  const current = sel.value;
  sel.innerHTML = '<option value="">Select a registered visitor…</option>' +
    visitors.map(v=>`<option value="${v.id}">${escapeHtml(v.name)}</option>`).join('');
  if(current) sel.value = current;
}
const genVisitorSelect = document.getElementById('gen-visitor-select');
if(genVisitorSelect) genVisitorSelect.addEventListener('change', (e)=>{
  const id = e.target.value;
  clearInterval(genTimer);
  if(!id){
    document.getElementById('qr-frame').classList.add('dim');
    document.getElementById('qr-visitor-name').textContent = 'No visitor selected';
    document.getElementById('qr-visitor-sub').textContent = 'Choose a visitor above to generate their code';
    document.getElementById('refresh-label').textContent = '—';
    document.getElementById('refresh-fill').style.width='100%';
    document.getElementById('btn-download-qr').disabled = true;
    document.getElementById('token-preview').textContent = 'Select a visitor to see the encoded payload.';
    return;
  }
  const v = visitorById(id);
  document.getElementById('qr-frame').classList.remove('dim');
  document.getElementById('qr-visitor-name').textContent = v.name;
  document.getElementById('qr-visitor-sub').textContent = (v.purpose||'Visitor') + (v.host? ' • '+v.host : '');
  document.getElementById('btn-download-qr').disabled = false;
  startDynamicQr(v);
});

async function makeDailyQr(visitor){
  const data=await googleRequest('createQr',{
    person:{id:visitor.id,name:visitor.name,email:visitor.email,phone:visitor.phone||'',purpose:visitor.purpose||'',host:visitor.host||'',type:visitor.type||'visitor',institutionId:visitor.institutionId||''}
  });
  return data;
}

async function startDynamicQr(v){
  clearInterval(genTimer);
  async function cycle(){
    try{
      const data=await makeDailyQr(v);
      lastGeneratedToken=data.token;
      genExpiry=data.expiresAt;
      renderQr(data.token);
      document.getElementById('token-preview').textContent = 'Daily QR • expires ' + new Date(data.expiresAt).toLocaleString();
      document.getElementById('refresh-label').textContent = 'Valid until ' + new Date(data.expiresAt).toLocaleTimeString();
      document.getElementById('refresh-fill').style.width='100%';
    }catch(err){
      document.getElementById('token-preview').textContent=err.message;
      document.getElementById('refresh-label').textContent='Google login / Sheets setup required';
      document.getElementById('refresh-fill').style.width='0%';
    }
  }
  await cycle();
  genTimer=setInterval(()=>{
    const remain=Math.max(0,genExpiry-Date.now());
    const pct=genExpiry ? Math.max(0,(remain/(24*60*60*1000))*100) : 0;
    const fill=document.getElementById('refresh-fill'); if(fill) fill.style.width=pct+'%';
    const label=document.getElementById('refresh-label'); if(label) label.textContent='Resets daily • '+Math.ceil(remain/3600000)+'h remaining';
    if(remain<=0) cycle();
  },1000);
}

function renderQr(text){
  const box = document.getElementById('qrcode-box');
  if(!box) return;
  box.innerHTML = '';
  qrInstance = new QRCode(box, {text,width:200,height:200,colorDark:'#0A1120',colorLight:'#ffffff',correctLevel:QRCode.CorrectLevel.M});
}

const downloadQrBtn = document.getElementById('btn-download-qr');
if(downloadQrBtn) downloadQrBtn.addEventListener('click', ()=>{
  const canvas = document.querySelector('#qrcode-box canvas');
  if(!canvas) return;
  const link = document.createElement('a');
  link.download = 'visitor-qr-frame.png';
  link.href = canvas.toDataURL('image/png');
  link.click();
});

/* =========================================================
   QR SCANNER + CHECK-IN / CHECK-OUT LOGIC
========================================================= */
function decodeToken(text){
  try{
    const payload=JSON.parse(atob(text));
    if(!payload || !payload.t || !payload.d) return {valid:false,reason:'Not a recognized PLMunTrack daily QR code.'};
    return {valid:true,payload};
  }catch(e){
    return {valid:false,reason:'Could not read this QR code.'};
  }
}

async function processToken(rawText){
  const resultBox=document.getElementById('scan-result-box');
  if(!resultBox) return;
  try{
    const check=decodeToken(rawText);
    if(!check.valid){
      resultBox.innerHTML=`<div class="scan-result bad"><h4>⚠ Rejected</h4><p>${escapeHtml(check.reason)}</p></div>`;
      return;
    }
    const data=await googleRequest('recordScan',{token:rawText,scannerEmail:googleUser?.email||''});
    const p=data.person;
    if(!visitorById(p.id)){ visitors.push({id:p.id,name:p.name,email:p.email,phone:p.phone||'',purpose:p.purpose||'',host:p.host||'',type:p.type||'visitor',institutionId:p.institutionId||'',createdAt:Date.now()}); await saveVisitors(); if(document.getElementById('visitors-body')) renderVisitors(); if(document.getElementById('gen-visitor-select')) populateGenSelect(); }
    const action=data.action==='check-in'?'Checked in':'Checked out';
    resultBox.innerHTML=`<div class="scan-result ok"><h4>✓ ${action}</h4><p><strong>${escapeHtml(p.name)}</strong> • ${escapeHtml(p.type||'visitor')}<br>Email: ${escapeHtml(p.email||'—')}<br>${action==='Checked in'?'Time in':'Time out'}: ${fmtTime(data.timestamp)}${data.duration?' • Duration: '+escapeHtml(data.duration):''}</p></div>`;
    const localLog={id:uid(),visitorId:p.id,checkin:data.checkin||data.timestamp,checkout:data.checkout||null,status:data.status,flagged:false,flagReason:null,rawToken:rawText,personSnapshot:p};
    const existing=logs.find(l=>l.visitorId===p.id && l.status==='in');
    if(data.action==='check-in') logs.unshift(localLog);
    else if(existing){ existing.checkout=data.checkout; existing.status='out'; existing.personSnapshot=p; }
    else logs.unshift(localLog);
    await saveLogs();
    renderDashboard(); renderRecentScans(); renderLogs();
  }catch(err){
    resultBox.innerHTML=`<div class="scan-result bad"><h4>⚠ Scan failed</h4><p>${escapeHtml(err.message)}</p></div>`;
  }
}

const processManualBtn = document.getElementById('btn-process-manual');
if(processManualBtn) processManualBtn.addEventListener('click', ()=>{
  const val = document.getElementById('manual-token').value.trim();
  if(val) processToken(val);
});

const simulateScanBtn = document.getElementById('btn-simulate-scan');
if(simulateScanBtn) simulateScanBtn.addEventListener('click', ()=>{
  if(lastGeneratedToken) processToken(lastGeneratedToken);
  else document.getElementById('scan-result-box').innerHTML = `<div class="scan-result bad"><h4>No code available</h4><p>Go to QR Generator and select a visitor first.</p></div>`;
});

const startCamBtn = document.getElementById('btn-start-cam');
if(startCamBtn) startCamBtn.addEventListener('click', startCamera);

const stopCamBtn = document.getElementById('btn-stop-cam');
if(stopCamBtn) stopCamBtn.addEventListener('click', stopCamera);

function startCamera(){
  if(!document.getElementById('reader')) return;
  document.getElementById('scan-placeholder').style.display='none';
  html5QrCode = new Html5Qrcode("reader");
  html5QrCode.start(
    {facingMode:"environment"},
    {fps:10, qrbox:230},
    (decodedText)=>{ processToken(decodedText); },
    ()=>{}
  ).then(()=>{
    document.getElementById('btn-start-cam').disabled = true;
    document.getElementById('btn-stop-cam').disabled = false;
  }).catch(()=>{
    document.getElementById('scan-placeholder').style.display='flex';
    document.getElementById('scan-placeholder').innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/></svg>
      Camera unavailable in this environment. Use manual entry or "Use last generated code" below.`;
  });
}
function stopCamera(){
  if(html5QrCode){
    html5QrCode.stop().then(()=>{ html5QrCode.clear(); html5QrCode=null; }).catch(()=>{});
  }
  document.getElementById('btn-start-cam').disabled = false;
  document.getElementById('btn-stop-cam').disabled = true;
  document.getElementById('scan-placeholder').style.display='flex';
}

function renderRecentScans(){
  const box = document.getElementById('recent-scans');
  if(!box) return;
  const recent = logs.slice(0,10);
  if(!recent.length){ box.innerHTML = '<div class="empty">No scans yet.</div>'; return; }
  box.innerHTML = recent.map(l=>{
    const v = visitorById(l.visitorId);
    const name = v? v.name : 'Unknown';
    if(l.flagged){
      return `<div class="activity-item"><div class="activity-dot warn"></div><div><div class="activity-text">${escapeHtml(name)} — <span style="color:var(--warn);">${escapeHtml(l.flagReason)}</span></div><div class="activity-time">${fmtTime(l.checkin)}</div></div></div>`;
    }
    const action = l.status==='in' ? 'checked in' : 'checked out';
    return `<div class="activity-item"><div class="activity-dot"></div><div><div class="activity-text">${escapeHtml(name)} ${action}</div><div class="activity-time">${fmtTime(l.checkout||l.checkin)}</div></div></div>`;
  }).join('');
}

/* =========================================================
   DASHBOARD
========================================================= */
function renderDashboard(){
  if(!document.getElementById('stat-total-visitors')) return;
  document.getElementById('stat-total-visitors').textContent = visitors.length;

  const openLogs = logs.filter(l=>l.status==='in');
  document.getElementById('stat-checked-in').textContent = openLogs.length;

  const todays = logs.filter(l=>!l.flagged && isToday(l.checkin));
  document.getElementById('stat-today').textContent = todays.length;
  document.getElementById('stat-today-sub').textContent = todays.length? (todays.length+' visit(s) recorded so far today') : 'No visits logged yet today';

  const flaggedToday = logs.filter(l=>l.flagged && isToday(l.checkin));
  document.getElementById('stat-flagged').textContent = flaggedToday.length;

  // on-premises table
  const onBody = document.getElementById('onprem-body');
  document.getElementById('onprem-count').textContent = openLogs.length + ' visitor' + (openLogs.length===1?'':'s');
  document.getElementById('onprem-empty').style.display = openLogs.length? 'none':'block';
  onBody.innerHTML = openLogs.map(l=>{
    const v = visitorById(l.visitorId);
    return `<tr><td><strong>${v?escapeHtml(v.name):'Unknown'}</strong></td><td class="muted">${v?escapeHtml(v.host||'—'):'—'}</td><td class="mono muted">${fmtTime(l.checkin)}</td><td class="muted">${durationStr(l.checkin, Date.now())}</td></tr>`;
  }).join('');

  // activity feed
  const feed = document.getElementById('activity-feed');
  if(!logs.length){ feed.innerHTML = '<div class="empty">No activity yet. Scan a visitor code to get started.</div>'; }
  else{
    feed.innerHTML = logs.slice(0,8).map(l=>{
      const v = visitorById(l.visitorId);
      const name = v? v.name : 'Unknown';
      if(l.flagged) return `<div class="activity-item"><div class="activity-dot warn"></div><div><div class="activity-text">${escapeHtml(name)} — <span style="color:var(--warn);">flagged</span></div><div class="activity-time">${fmtDateTime(l.checkin)}</div></div></div>`;
      const action = l.status==='in' ? 'checked in' : 'checked out';
      return `<div class="activity-item"><div class="activity-dot"></div><div><div class="activity-text">${escapeHtml(name)} ${action}</div><div class="activity-time">${fmtDateTime(l.checkout||l.checkin)}</div></div></div>`;
    }).join('');
  }

  renderHourlyChart();
}

function renderHourlyChart(){
  const canvas = document.getElementById('hourlyChart');
  if(!canvas) return;
  const hours = Array.from({length:24}, (_,i)=>i);
  const counts = hours.map(h => logs.filter(l=>!l.flagged && isToday(l.checkin) && new Date(l.checkin).getHours()===h).length);
  const labels = hours.map(h => (h%12===0?12:h%12) + (h<12?'am':'pm'));
  const ctx = canvas.getContext('2d');
  if(hourlyChart){ hourlyChart.data.datasets[0].data = counts; hourlyChart.update(); return; }
  hourlyChart = new Chart(ctx, {
    type:'bar',
    data:{ labels, datasets:[{ data:counts, backgroundColor:'#2FE0C0', borderRadius:4, barThickness:10 }] },
    options:{
      responsive:true,
      plugins:{legend:{display:false}},
      scales:{
        x:{ grid:{display:false}, ticks:{color:'#5D6E90', font:{size:10}, maxRotation:0, autoSkip:true, maxTicksLimit:12} },
        y:{ beginAtZero:true, ticks:{color:'#5D6E90', font:{size:10}, precision:0}, grid:{color:'#1B2745'} }
      }
    }
  });
}

/* =========================================================
   LOGS PAGE
========================================================= */
document.querySelectorAll('.filter-chip').forEach(chip=>{
  chip.addEventListener('click', ()=>{
    document.querySelectorAll('.filter-chip').forEach(c=>c.classList.remove('active'));
    chip.classList.add('active');
    currentFilter = chip.dataset.filter;
    renderLogs();
  });
});

function renderLogs(){
  if(!document.getElementById('logs-body')) return;
  let rows = logs.slice();
  if(currentFilter==='today') rows = rows.filter(l=>isToday(l.checkin));
  if(currentFilter==='flagged') rows = rows.filter(l=>l.flagged);

  const body = document.getElementById('logs-body');
  document.getElementById('logs-empty').style.display = rows.length? 'none':'block';
  body.innerHTML = rows.map(l=>{
    const v = visitorById(l.visitorId);
    const name = v? v.name : 'Unknown';
    let statusBadge = '';
    if(l.flagged) statusBadge = `<span class="badge flag" title="${escapeHtml(l.flagReason||'')}">Flagged</span>`;
    else if(l.status==='in') statusBadge = `<span class="badge in">Checked in</span>`;
    else statusBadge = `<span class="badge out">Completed</span>`;
    return `<tr>
      <td><strong>${escapeHtml(name)}</strong></td>
      <td class="mono muted">${fmtDateTime(l.checkin)}</td>
      <td class="mono muted">${l.checkout? fmtDateTime(l.checkout) : '—'}</td>
      <td class="muted">${l.checkout? durationStr(l.checkin,l.checkout) : (l.flagged? '—' : durationStr(l.checkin, Date.now()))}</td>
      <td>${statusBadge}</td>
    </tr>`;
  }).join('');
}

const exportCsvBtn = document.getElementById('btn-export-csv');
if(exportCsvBtn) exportCsvBtn.addEventListener('click', ()=>{
  const rows = [['Visitor','Check-in','Check-out','Duration','Status','Flag reason']];
  logs.forEach(l=>{
    const v = visitorById(l.visitorId);
    rows.push([
      v? v.name:'Unknown',
      new Date(l.checkin).toISOString(),
      l.checkout? new Date(l.checkout).toISOString() : '',
      l.checkout? durationStr(l.checkin,l.checkout) : '',
      l.flagged? 'Flagged' : l.status,
      l.flagReason||''
    ]);
  });
  const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], {type:'text/csv'});
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'attendance-logs.csv';
  link.click();
});

/* =========================================================
   LIVE POLLING (simulates real-time refresh)
========================================================= */
setInterval(()=>{
  if(document.getElementById('stat-total-visitors')) renderDashboard();
}, 5000);

/* =========================================================
   INIT
========================================================= */
(async function init(){
  initGoogleLogin();
  await loadAll();

  if(document.getElementById('visitors-body')) renderVisitors();
  if(document.getElementById('view-dashboard')) renderDashboard();
  if(document.getElementById('logs-body')) renderLogs();
  if(document.getElementById('gen-visitor-select')) populateGenSelect();
  if(document.getElementById('recent-scans')) renderRecentScans();

  if(!visitors.length){
    visitors.push(
      {id:uid(), name:'Maria Santos', email:'maria.santos@email.com', type:'visitor', phone:'0917 123 4567', purpose:'Job interview', host:'HR Department', createdAt:Date.now()-86400000},
      {id:uid(), name:'Carlo Reyes', email:'carlo.reyes@email.com', type:'visitor', phone:'0928 555 1122', purpose:'Vendor delivery', host:'Procurement', createdAt:Date.now()-3600000}
    );
    await saveVisitors();
    if(document.getElementById('visitors-body')) renderVisitors();
    if(document.getElementById('gen-visitor-select')) populateGenSelect();
  }
})();
