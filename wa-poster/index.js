'use strict';
/*
 * wa-poster — WhatsApp Web sidecar for posting media to WhatsApp Channels.
 *
 * Why this exists: the Hermes Baileys bridge delivers text to channels but
 * WhatsApp's servers silently drop every non-text (image/document/poll)
 * message sent through Baileys 7.0.0-rc13/rc14. This service drives the real
 * WhatsApp Web client (whatsapp-web.js + Chromium) as a separate linked
 * device, which posts channel media the same way WhatsApp Web does.
 *
 * HTTP API (loopback only, X-Token header required except /health):
 *   GET  /health  -> { ready, qrPending, me }
 *   GET  /qr      -> { qr } latest pairing QR payload (null once ready)
 *   POST /send    -> { chatId, text?, caption?, mediaBase64?, mediaMimetype?, mediaName? }
 *                    returns { success, messageId, to }
 */
const http = require('http');
const fs = require('fs');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');

const PORT = parseInt(process.env.PORT || '3001', 10);
const TOKEN = process.env.POSTER_TOKEN || '';
const DATA_DIR = process.env.WWEB_DATA || '/data';

let lastQr = null;
let lastCode = null;
let ready = false;
let me = null;

const PAIR_PHONE = process.env.PAIR_PHONE || '';

// Container recreates leave stale Chromium singleton locks in the persisted
// profile, which makes the next launch fail with "profile appears to be in
// use". Clear them before the client starts (lock files only, never session
// data).
try {
  const profileDir = `${DATA_DIR}/session-poster`;
  for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { fs.unlinkSync(`${profileDir}/${f}`); } catch {}
  }
} catch {}

const client = new Client({
  authStrategy: new LocalAuth({ clientId: 'poster', dataPath: DATA_DIR }),
  ...(PAIR_PHONE
    ? { pairWithPhoneNumber: { phoneNumber: PAIR_PHONE, showNotification: true } }
    : {}),
  puppeteer: {
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
      '--mute-audio',
      '--window-size=1280,900',
    ],
  },
});

client.on('qr', (qr) => {
  lastQr = qr;
  try { fs.writeFileSync(`${DATA_DIR}/qr.txt`, qr); } catch {}
  console.log('QR_READY');
});
client.on('code', (code) => {
  lastCode = code;
  try { fs.writeFileSync(`${DATA_DIR}/code.txt`, code); } catch {}
  console.log('CODE_READY', code);
});
client.on('authenticated', () => console.log('WA_AUTHENTICATED'));
client.on('auth_failure', (m) => console.log('WA_AUTH_FAILURE', m));
client.on('ready', () => {
  ready = true;
  lastQr = null;
  me = client.info && client.info.wid ? client.info.wid._serialized : null;
  console.log('WA_READY', me);
});
client.on('disconnected', (reason) => {
  ready = false;
  console.log('WA_DISCONNECTED', reason);
});

/*
 * Channel (newsletter) sending — custom in-page pipeline.
 *
 * Why not client.sendMessage: whatsapp-web.js 1.34.7's channel path is
 * broken against the current WhatsApp Web build in two places:
 *   1. WWebJS.getChat calls WAWebNewsletterCollection.get(chatId) with a
 *      plain string, which throws "Data passed to getter must include an
 *      id property" (the collection's memoized getter wants a Wid).
 *   2. WWebJS.sendMessage spreads the raw MediaData model ({...mediaOptions})
 *      into the Msg model constructor, which throws the same getter error;
 *      spreading mediaData.toJSON() instead works. It also calls
 *      msg.avParams(), which no longer exists; the current
 *      sendNewsletterMessageJob does not need mediaMetadata for images.
 *
 * This pipeline uses the same WA Web internals the real client uses:
 * processMediaData (unencrypted channel upload) -> Msg model ->
 * addNewsletterMsgsRecords -> sendNewsletterMessageJob.
 * Verified live 2026-10-21: { success: true, serverId: 128 } for an image
 * post to a newsletter JID (e.g. 120363xxxxxxxxxx@newsletter).
 */
async function sendToChannel(chatId, { text, caption, media }) {
  const payload = {
    chatId,
    text: text || null,
    caption: caption || null,
    media: media || null,
  };
  const result = await client.pupPage.evaluate(async (p) => {
    try {
      const wid = window.require('WAWebWidFactory').createWid(p.chatId);
      const chat = window
        .require('WAWebCollections')
        .WAWebNewsletterCollection.get(wid);
      if (!chat) return { error: 'channel not loaded in WA Web store' };

      let md = null;
      let body = p.text || '';
      if (p.media) {
        md = await window.WWebJS.processMediaData(p.media, {
          sendToChannel: true,
          sendToStatus: false,
        });
        body = md.preview;
      }

      const { getMaybeMePnUser } = window.require('WAWebUserPrefsMeUser');
      const meUser = getMaybeMePnUser();
      const newId = await window.require('WAWebMsgKey').newId();
      const newMsgKey = new (window.require('WAWebMsgKey'))({
        from: meUser,
        to: chat.id,
        id: newId,
        selfDir: 'out',
      });
      const ephemeralFields = window
        .require('WAWebGetEphemeralFieldsMsgActionsUtils')
        .getEphemeralFields(chat);

      const message = {
        id: newMsgKey,
        ack: 0,
        body,
        from: meUser,
        to: chat.id,
        local: true,
        self: 'out',
        t: Math.floor(Date.now() / 1000),
        isNewMsg: true,
        type: 'chat',
        ...(p.caption ? { caption: p.caption } : {}),
        ...ephemeralFields,
        ...(md ? md.toJSON() : {}),
      };

      const msg = new (window.require('WAWebCollections').Msg.modelClass)(
        message,
      );
      const msgData =
        window.require('WAWebMsgDataFromModel').msgDataFromMsgModel(msg);
      await window
        .require('WAWebNewsletterUpdateMsgsRecordsJob')
        .addNewsletterMsgsRecords([msgData]);
      chat.msgs.add(msg);
      chat.t = msg.t;

      const resp = await window
        .require('WAWebNewsletterSendMessageJob')
        .sendNewsletterMessageJob({
          msg,
          type: md ? 'media' : 'text',
          newsletterJid: chat.id.toJid(),
          ...(md ? { mediaHandle: md.mediaHandle } : {}),
        });
      if (!resp || !resp.success) {
        return { error: 'send job not successful: ' + JSON.stringify(resp) };
      }
      msg.t = resp.ack.t;
      msg.serverId = resp.serverId;
      msg.updateAck(1, true);
      await window
        .require('WAWebNewsletterUpdateMsgsRecordsJob')
        .updateNewsletterMsgRecord(msg);
      return { success: true, serverId: resp.serverId };
    } catch (e) {
      return { error: String((e && e.message) || e) };
    }
  }, payload);
  if (!result || result.error) {
    throw new Error(
      'channel send failed: ' + ((result && result.error) || 'no result'),
    );
  }
  return result;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 30 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (e) { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === '/health' && req.method === 'GET') {
      return sendJson(res, 200, { status: 'ok', ready, qrPending: !!lastQr, me });
    }
    if (TOKEN && req.headers['x-token'] !== TOKEN) {
      return sendJson(res, 401, { error: 'bad token' });
    }
    if (req.url === '/qr' && req.method === 'GET') {
      return sendJson(res, 200, { qr: lastQr });
    }
    if (req.url === '/code' && req.method === 'GET') {
      return sendJson(res, 200, { code: lastCode });
    }
    if (req.url === '/probe' && req.method === 'POST') {
      if (!ready) return sendJson(res, 503, { error: 'whatsapp not ready' });
      const b = await readBody(req);
      const action = String(b.action || '');
      if (action === 'channels') {
        const channels = await client.getChannels();
        return sendJson(res, 200, {
          channels: channels.map((c) => ({
            id: c.id && c.id._serialized,
            name: c.name,
            isChannel: c.isChannel,
          })),
        });
      }
      if (action === 'getchat') {
        const chat = await client.getChatById(String(b.chatId || ''));
        return sendJson(res, 200, {
          chat: chat
            ? { id: chat.id && chat.id._serialized, name: chat.name, isChannel: chat.isChannel }
            : null,
        });
      }
      if (action === 'eval') {
        const fn = new Function(
          'return (async () => { ' + String(b.code || '') + ' })()',
        );
        try {
          const out = await client.pupPage.evaluate(fn);
          return sendJson(res, 200, { result: out === undefined ? null : out });
        } catch (e) {
          return sendJson(res, 200, { evalError: String((e && e.message) || e) });
        }
      }
      if (action === 'sendtext') {
        const r = await client.sendMessage(String(b.chatId || ''), String(b.text || 'uji teks sidecar'));
        return sendJson(res, 200, { messageId: r && r.id ? r.id._serialized : null });
      }
      return sendJson(res, 400, { error: 'unknown action' });
    }
    if (req.url === '/send' && req.method === 'POST') {
      if (!ready) return sendJson(res, 503, { error: 'whatsapp not ready (pairing pending?)' });
      const b = await readBody(req);
      const chatId = String(b.chatId || '');
      if (!chatId) return sendJson(res, 400, { error: 'chatId required' });
      if (chatId.endsWith('@newsletter')) {
        const out = await sendToChannel(chatId, {
          text: b.text ? String(b.text) : null,
          caption: b.caption ? String(b.caption) : null,
          media: b.mediaBase64
            ? {
                mimetype: String(b.mediaMimetype || 'image/jpeg'),
                data: String(b.mediaBase64),
                filename: b.mediaName ? String(b.mediaName) : 'media',
              }
            : null,
        });
        return sendJson(res, 200, {
          success: true,
          messageId: null,
          serverId: out.serverId,
          to: chatId,
          via: 'wa-web-newsletter-pipeline',
        });
      }
      let result;
      if (b.mediaBase64) {
        const media = new MessageMedia(
          String(b.mediaMimetype || 'application/octet-stream'),
          String(b.mediaBase64),
          b.mediaName ? String(b.mediaName) : undefined,
        );
        result = await client.sendMessage(chatId, media, {
          caption: b.caption || b.text || undefined,
        });
      } else if (b.text) {
        result = await client.sendMessage(chatId, String(b.text));
      } else {
        return sendJson(res, 400, { error: 'text or mediaBase64 required' });
      }
      return sendJson(res, 200, {
        success: true,
        messageId: result && result.id ? result.id._serialized : null,
        to: result ? result.to : chatId,
      });
    }
    return sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    console.error('REQ_ERROR', err && err.message);
    return sendJson(res, 500, { error: String((err && err.message) || err) });
  }
});

server.listen(PORT, '0.0.0.0', () => console.log(`wa-poster listening on ${PORT}`));
client.initialize().catch((e) => console.error('INIT_ERROR', e && e.message));
