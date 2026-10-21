'use strict';
/*
 * wa-web — one-page WhatsApp sender web.
 *
 * Routing (all proven paths only):
 *   text/media -> Channel        : wa-poster sidecar POST 127.0.0.1:3001/send (X-Token)
 *   text/media -> personal/group : Hermes bridge /send, /send-media (127.0.0.1:3000)
 *
 * Why channel traffic goes to the sidecar: WhatsApp servers silently drop
 * non-text channel posts sent through Baileys, and bridge text carries a
 * Hermes prefix in self-chat mode; the sidecar drives the real WhatsApp Web
 * client instead and posts clean text and media.
 *
 * Auth: single shared password (WEB_PASSWORD env) -> httpOnly session cookie.
 * Uploads for the bridge path are written to ./uploads tmp dir for the
 * bridge's filePath API, then deleted after send. Channel uploads are never
 * written to disk (base64 in memory, straight to WhatsApp).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '8090', 10);
const PASSWORD = process.env.WEB_PASSWORD || '';
const POSTER_TOKEN = process.env.POSTER_TOKEN || '';
const CHANNEL_JID = process.env.CHANNEL_JID || ''; // e.g. 120363xxxxxxxxxx@newsletter
const SELF_JID = process.env.SELF_JID || '';       // e.g. 628xxxxxxxxxx@s.whatsapp.net
const BRIDGE = 'http://127.0.0.1:3000';
const POSTER = 'http://127.0.0.1:3001';
const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const sessions = new Set();
const newSession = () => {
  const s = crypto.randomBytes(24).toString('hex');
  sessions.add(s);
  return s;
};
const authed = (req) => {
  if (!PASSWORD) return true;
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/waweb=([a-f0-9]+)/);
  return m && sessions.has(m[1]);
};

async function callJson(url, body, headers = {}, timeoutMs = 120000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const isGet = body === null || body === undefined;
  try {
    const r = await fetch(url, {
      method: isGet ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: isGet ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await r.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    if (!r.ok) throw new Error(json.error || `HTTP ${r.status}`);
    return json;
  } finally { clearTimeout(t); }
}

function readBody(req, limit = 30 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}

const PAGE = `<!doctype html>
<html lang="id"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kirim WhatsApp</title>
<style>
 body{font-family:system-ui,sans-serif;max-width:560px;margin:24px auto;padding:0 16px;background:#0b141a;color:#e9edef}
 h1{font-size:20px} label{display:block;margin:14px 0 6px;font-size:14px;color:#8696a0}
 select,textarea,input[type=text],input[type=password]{width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid #2a3942;background:#1f2c34;color:#e9edef;font-size:15px}
 textarea{min-height:110px} input[type=file]{margin-top:6px}
 button{margin-top:18px;width:100%;padding:12px;border:0;border-radius:8px;background:#00a884;color:#06281f;font-size:16px;font-weight:700;cursor:pointer}
 button:disabled{opacity:.5} #status{margin-top:14px;font-size:14px;white-space:pre-wrap}
 img#prev{max-width:100%;margin-top:10px;border-radius:8px;display:none}
 .card{background:#111b21;padding:18px;border-radius:12px}
</style></head><body>
<div class="card">
<h1>Kirim WhatsApp</h1>
<div id="loginBox" style="display:none">
 <label>Password</label>
 <input type="password" id="pw" autocomplete="current-password">
 <button id="loginBtn">Masuk</button>
</div>
<div id="appBox" style="display:none">
 <label>Tujuan</label>
 <div style="padding:10px;border-radius:8px;border:1px solid #2a3942;background:#1f2c34;font-size:15px">Saluran — tujuan terkunci</div>
 <label>Pesan teks / caption</label>
 <textarea id="text" placeholder="Tulis pesan..."></textarea>
 <label>Gambar (opsional) — pilih file atau tempel screenshot langsung (Ctrl+V)</label>
 <input type="file" id="file" accept="image/*,video/mp4,application/pdf">
 <img id="prev" alt="">
 <div id="fileInfo" style="font-size:13px;color:#8696a0;margin-top:6px"></div>
 <button id="sendBtn">Kirim</button>
 <div id="status"></div>
</div>
</div>
<div style="text-align:center;margin-top:16px;font-size:14px;color:#8696a0">
 Mengalami kendala? <a href="https://wa.me/628xxxxxxxxxx" target="_blank" rel="noopener" style="color:#00a884;text-decoration:none;font-weight:600">Hubungi via WhatsApp</a>
</div>
<script>
const $=id=>document.getElementById(id);
let fileData=null;
async function me(){const r=await fetch('/api/me');const j=await r.json();
 $('loginBox').style.display=j.authed?'none':'block';
 $('appBox').style.display=j.authed?'block':'none';}
$('loginBtn').onclick=async()=>{const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:$('pw').value})});
 if(r.ok){me();}else{$('pw').value='';alert('Password salah');}};
function clearFile(){$('file').value='';fileData=null;$('prev').style.display='none';$('fileInfo').textContent='';}
function loadFile(f,src){if(!f){clearFile();return;}
 let name=f.name;
 if(src==='tempel'){const ext=(f.type.split('/')[1]||'png').replace('svg+xml','svg').replace(/[^a-z0-9]/gi,'')||'png';
  const d=new Date(),p=n=>String(n).padStart(2,'0');
  name='screenshot-'+d.getFullYear()+p(d.getMonth()+1)+p(d.getDate())+'-'+p(d.getHours())+p(d.getMinutes())+p(d.getSeconds())+'.'+ext;}
 const rd=new FileReader();rd.onload=()=>{fileData={base64:rd.result.split(',')[1],mimetype:f.type||'image/png',name};
 if(f.type.startsWith('image/')){$('prev').src=rd.result;$('prev').style.display='block';}else{$('prev').style.display='none';}
 $('fileInfo').textContent='Siap dikirim: '+name+' ('+(src==='tempel'?'dari tempel/clipboard':'dari file')+')';};rd.readAsDataURL(f);}
$('file').onchange=()=>{loadFile($('file').files[0],'file');};
document.addEventListener('paste',e=>{
 if($('appBox').style.display==='none')return;
 const cd=e.clipboardData||window.clipboardData;if(!cd||!cd.items)return;
 for(const it of cd.items){if(it.kind==='file'&&it.type.startsWith('image/')){const f=it.getAsFile();
  if(f){e.preventDefault();loadFile(f,'tempel');$('status').textContent='Gambar dari clipboard siap — tinggal klik Kirim.';}
  break;}}});
$('sendBtn').onclick=async()=>{const st=$('status');
 const payload={target:'channel',text:$('text').value,...(fileData?{file:fileData}:{})};
 if(!payload.text&&!fileData){st.textContent='Isi teks atau pilih gambar dulu.';return;}
 $('sendBtn').disabled=true;st.textContent='Mengirim...';
 try{const r=await fetch('/api/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
 const j=await r.json();if(!r.ok)throw new Error(j.error||'gagal');
 st.textContent='Terkirim ✓ ('+(j.via||'')+', id: '+(j.messageId||'-')+')';
 $('text').value='';clearFile();
 }catch(e){st.textContent='Gagal: '+e.message;}finally{$('sendBtn').disabled=false;}};
me();
</script></body></html>`;

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === '/' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(PAGE);
    }
    if (req.url === '/api/me') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ authed: authed(req) }));
    }
    if (req.url === '/api/status' && req.method === 'GET') {
      let bridgeReady = false, posterReady = false, me = null;
      try {
        const h = await callJson(`${BRIDGE}/health`, null, {}, 5000);
        bridgeReady = !!(h && (h.status === 'ok' || h.status === 'connected' || h.connected !== false));
      } catch {}
      try {
        const h = await callJson(`${POSTER}/health`, null, { 'X-Token': POSTER_TOKEN }, 5000);
        posterReady = !!(h && h.ready);
        me = h && h.me ? h.me : null;
      } catch {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ bridgeReady, posterReady, me }));
    }
    if (req.url === '/api/login' && req.method === 'POST') {
      const b = await readBody(req, 4096);
      if (PASSWORD && b.password === PASSWORD) {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': `waweb=${newSession()}; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000`,
        });
        return res.end('{"ok":true}');
      }
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end('{"error":"password salah"}');
    }
    if (req.url === '/api/send' && req.method === 'POST') {
      if (!authed(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end('{"error":"belum login"}');
      }
      const b = await readBody(req);
      const target = String(b.target || 'channel');
      const jid = target === 'channel' ? CHANNEL_JID : target === 'self' ? SELF_JID : target;
      const isChannel = jid === CHANNEL_JID;
      const text = String(b.text || '');
      let via; let out;
      if (b.file && b.file.base64) {
        const buf = Buffer.from(b.file.base64, 'base64');
        if (isChannel) {
          out = await callJson(`${POSTER}/send`, {
            chatId: jid,
            mediaBase64: b.file.base64,
            mediaMimetype: b.file.mimetype || 'image/jpeg',
            mediaName: b.file.name || 'gambar.jpg',
            caption: text || undefined,
          }, { 'X-Token': POSTER_TOKEN });
          via = 'sidecar WA Web';
        } else {
          const ext = (b.file.name || 'file').split('.').pop().replace(/[^a-zA-Z0-9]/g, '') || 'bin';
          const tmp = path.join(UPLOAD_DIR, `up_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${ext}`);
          fs.writeFileSync(tmp, buf);
          try {
            out = await callJson(`${BRIDGE}/send-media`, {
              chatId: jid, filePath: tmp, caption: text || undefined,
              fileName: b.file.name || undefined,
            });
          } finally { fs.unlink(tmp, () => {}); }
          via = 'bridge Hermes';
        }
      } else if (text) {
        if (isChannel) {
          // Channel text goes through the sidecar too: the bridge would add
          // the Hermes reply prefix in self-chat mode, the sidecar posts
          // clean text (verified, serverId 130).
          out = await callJson(`${POSTER}/send`, { chatId: jid, text }, { 'X-Token': POSTER_TOKEN }, 60000);
          via = 'sidecar WA Web';
        } else {
          out = await callJson(`${BRIDGE}/send`, { chatId: jid, message: text }, {}, 60000);
          via = 'bridge Hermes';
        }
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end('{"error":"teks atau file wajib ada"}');
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        success: true,
        via,
        messageId: out.messageId || null,
        serverId: out.serverId || null,
      }));
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"error":"not found"}');
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: String((err && err.message) || err) }));
  }
});

server.listen(PORT, '0.0.0.0', () => console.log(`wa-web listening on ${PORT}`));
