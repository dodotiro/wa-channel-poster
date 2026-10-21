# WA Channel Poster

A small system for posting text and images to a WhatsApp Channel from a web
page. It runs on a home server and sends through a real WhatsApp Web session,
because image posts to Channels do not go through when they are sent with
regular bot libraries such as Baileys. WhatsApp accepts the request and even
returns a message id, but the post never appears in the Channel. Text works,
media does not.

The project has two parts.

**wa-poster** is a sidecar service. It runs WhatsApp Web in Chromium through
the whatsapp-web.js library, packaged as a Docker container. It signs in as a
linked device and exposes a small HTTP API for sending.

**wa-web** is the sender page. It is a single Node.js file with no extra
dependencies. It has a password login, a message form, and image attachments.
It forwards every send request to the sidecar.

```
Browser -> wa-web on port 8090 -> wa-poster on port 3001 -> WhatsApp Web -> Channel
```

Personal and group chats can also be served when a Hermes WhatsApp bridge is
running on the same machine on port 3000. That part is optional. Channel mode
works without it.

## How channel sending works

The channel path in whatsapp-web.js 1.34.7 no longer matches the current
WhatsApp Web build, so the sidecar uses a custom function named
`sendToChannel()` in `wa-poster/index.js`. It runs inside the WhatsApp Web
page and follows the same steps the official web client uses.

1. The channel object is loaded from `WAWebNewsletterCollection` with a Wid
   object. Passing a plain string throws an error.
2. Media is prepared with `WWebJS.processMediaData` and the
   `sendToChannel` option turned on. The result carries a `mediaHandle` from
   the unencrypted channel upload.
3. The message model is built from `mediaData.toJSON()` only. Spreading the
   raw media model into the message breaks an internal WhatsApp getter.
4. The message record is stored with `addNewsletterMsgsRecords`, then sent
   with `sendNewsletterMessageJob`. Image sends do not need the
   `mediaMetadata` field on the current WhatsApp Web build.

A successful send returns `success` and a `serverId`, and the post shows up
in the Channel like a post made from the phone app.

## Features

The sidecar signs in with an 8 digit pairing code. QR pairing is also
available, but the code method proved more reliable because the QR rotates
too fast to scan from a headless session. The session is stored in the
`./data` volume, so restarts do not need a new pairing. The API listens on
127.0.0.1 port 3001 only and requires a token in the `X-Token` header.
Images are handled in memory as base64 and uploaded straight to WhatsApp, so
no image files are kept on the server. Stale Chromium lock files in the
persisted profile are removed automatically before the client starts.

Sidecar endpoints are listed below.

- `GET /health` reports readiness and the connected number.
- `GET /qr` returns the current pairing QR payload.
- `GET /code` returns the 8 digit pairing code.
- `POST /send` sends text or media. Targets ending in `@newsletter` use the
  custom channel pipeline. Other targets use the standard library send.
- `POST /probe` is a token protected diagnostics endpoint used during
  development.

The web app uses one shared password and an httpOnly session cookie that
lasts 30 days. The destination is locked to one Channel by default. The form
accepts a message or caption, an image picked from a file, or an image
pasted from the clipboard with Ctrl+V. Pasted screenshots get an automatic
file name based on the time they were pasted. A small status line shows
whether the sidecar and the bridge are up, and a help contact link sits at
the bottom of the page.

Routing is simple. Text and media for a Channel both go through the sidecar.
Text for personal and group chats goes through the Hermes bridge. Media for
personal and group chats also goes through the bridge, which needs a file
path, so the web app writes a temporary file and deletes it right after the
send.

## Requirements

- A Linux machine with Docker and Docker Compose for the sidecar.
- Node.js 20 or newer on the host for the web app.
- A WhatsApp number that is an admin of the target Channel. The sender does
  not need to own the Channel, since admins can create posts.
- About 1.5 GB of free RAM for the Chromium container.
- Optional, a Hermes Agent with its WhatsApp bridge active, for personal
  and group destinations.
- Optional, a Cloudflare Tunnel or another reverse proxy, if the web page
  should be reachable from the internet.

## Installation

### Sidecar

```bash
cd wa-poster
cp .env.example .env
```

Fill in the `.env` file first. The variables are explained in the
Configuration section. Then build and start the container.

```bash
docker compose up -d --build
```

Get a pairing code from the running service.

```bash
curl http://127.0.0.1:3001/code
```

On the sender phone, open WhatsApp and go to Linked devices. Choose the
option to link with a phone number instead of a QR code and enter the code.
Then check the service state.

```bash
curl http://127.0.0.1:3001/health
```

The sidecar is ready when `ready` is true and `me` shows the sender number.

### Web app

```bash
cd wa-web
cp .env.example .env
node server.js
```

The page listens on port 8090 by default. To keep it running, install it as
a systemd user service. An example unit is included as
`wa-web.service.example`. Adjust the Node path and the folder path in the
unit, then run the commands below.

```bash
systemctl --user daemon-reload
systemctl --user enable --now wa-web
sudo loginctl enable-linger $USER
```

The last command keeps the service alive after the user logs out.

### Public access

Add a public hostname to a Cloudflare Tunnel and point it at
`http://localhost:8090`. Put Cloudflare Access in front of it and allow only
selected email addresses. The web password alone is a thin barrier for a
page that can send messages as your number.

## Configuration

The sidecar reads `wa-poster/.env`.

`POSTER_TOKEN` is the secret token for the `X-Token` header. Make it long
and random, for example with `openssl rand -hex 24`.

`PAIR_PHONE` is the sender number in international format without a plus
sign, such as `6281234567890`. It is used for code pairing.

Other sidecar settings live in `docker-compose.yml`. The port is bound to
127.0.0.1 port 3001, the memory limit is 1200 MB, the session volume is
`./data`, and the restart policy is `unless-stopped`.

The web app reads `wa-web/.env`.

`PORT` sets the web port. The default is 8090.

`WEB_PASSWORD` is the password for the login page.

`POSTER_TOKEN` must match the sidecar token exactly.

`CHANNEL_JID` is the target Channel id, in the form
`120363xxxxxxxxxx@newsletter`.

`SELF_JID` is the sender's own id, in the form
`628xxxxxxxxxx@s.whatsapp.net`. It is used by the optional self destination
described further down.

A Channel JID is not visible on the public channel page or in the invite
link. It appears in the Hermes bridge log at `~/.hermes/whatsapp/bridge.log`
in the newsletter admin promotion event, and it can also be listed through
the sidecar `POST /probe` endpoint with the `channels` action after pairing.

The help link in the page footer points to a wa.me address. To change it,
search for the help text in `wa-web/server.js` and replace the number in the
`https://wa.me/628xxxxxxxxxx` link.

## Usage

Open the web page and sign in. Write a message or a caption. Attach an image
by picking a file or by pasting a screenshot with Ctrl+V. Press Send and the
post appears in the Channel.

The sidecar API can also be called directly. This example sends text to a
Channel.

```bash
curl -X POST http://127.0.0.1:3001/send \
  -H "Content-Type: application/json" \
  -H "X-Token: YOUR_TOKEN" \
  -d '{"chatId":"120363xxxxxxxxxx@newsletter","text":"Hello from the API"}'
```

This example sends an image with a caption.

```bash
curl -X POST http://127.0.0.1:3001/send \
  -H "Content-Type: application/json" \
  -H "X-Token: YOUR_TOKEN" \
  -d '{"chatId":"120363xxxxxxxxxx@newsletter","mediaBase64":"IMAGE_BASE64","mediaMimetype":"image/jpeg","mediaName":"photo.jpg","caption":"Image caption"}'
```

A successful reply contains a `serverId`. That is the post number assigned
by WhatsApp for the Channel.

## Enabling destination choices

The shipped page is locked to one Channel on purpose. The shared password is
meant to be given to Channel members, and a locked destination stops them
from sending messages as the owner to anyone else. The backend still accepts
other destinations, so only the page needs three small changes in
`wa-web/server.js`.

First, replace the locked destination block with a dropdown. The block to
replace is the `Destination` label followed by the div that shows the locked
Channel name.

```html
<label>Destination</label>
<select id="target">
  <option value="channel">Channel</option>
  <option value="self">Own number (testing)</option>
  <option value="custom">Other JID (type it manually)</option>
</select>
<input type="text" id="customJid" placeholder="example: 62812xxxx@s.whatsapp.net or 12345@g.us" style="display:none;margin-top:8px">
```

Second, show the manual JID field only when the manual option is selected.

```js
$('target').onchange=()=>{$('customJid').style.display=$('target').value==='custom'?'block':'none';};
```

Third, take the destination from the dropdown in the Send button handler.
The locked version builds the payload with a fixed channel target.

```js
const payload={target:'channel',text:$('text').value,...};
```

Change it to use the selected value.

```js
const target=$('target').value;
const jid=target==='custom'?$('customJid').value.trim():target;
const payload={target:jid,text:$('text').value,...};
```

Restart the service afterwards with `systemctl --user restart wa-web`.

Destination ids use three forms. A Channel id looks like
`120363xxxxxxxxxx@newsletter`. A personal chat id looks like
`628xxxxxxxxxx@s.whatsapp.net`. A group id looks like
`12036xxxxxxxxxx@g.us`.

Keep the security trade off in mind. With choices enabled, anyone who knows
the web password can send messages as you to any destination.

## Security notes

Never commit the `.env` files or the `wa-poster/data/` folder. The data
folder holds the WhatsApp Web session, which works like the account
credentials. The `.gitignore` in this repo already excludes both.

Keep the sidecar on loopback and behind its token. Do not expose port 3001
to the internet.

Add Cloudflare Access in front of the web password when the page is public.

Use a dedicated number as the sender when possible. This system drives
WhatsApp Web in an unofficial way, so account restrictions are a real risk.
Do not use it for spam or mass broadcasts.

## Troubleshooting

QR pairing fails with a message that the device cannot be linked. The QR
rotates too fast in a headless session. Use the 8 digit pairing code from
`GET /code` instead.

The container will not start after being recreated. A stale Chromium lock in
the persisted profile is the usual cause. The sidecar removes the lock files
on start, so a plain rebuild should recover. If it still fails, check the
container log first before touching the session data.

Sending an image returns a 500 error that mentions a getter and an id
property. The request went through the library default path instead of the
custom pipeline. Check that the target ends in `@newsletter`.

The status line on the web page shows red while sends still work. The
status calls must use GET requests with no body. An early version of the
web app forced every call to POST, and both health endpoints rejected that.

An image sent through a Baileys bot never appears in the Channel even
though the API reports success. That is the known silent drop described at
the top of this file. Use the sidecar for Channel media.

## Project structure

```
.
├── README.md
├── wa-poster/
│   ├── index.js
│   ├── Dockerfile
│   ├── docker-compose.yml
│   ├── package.json
│   └── .env.example
└── wa-web/
    ├── server.js
    ├── wa-web.service.example
    └── .env.example
```

## Notes

The scope of this project is limited to the flows described above.
The whatsapp-web.js library is a separate project by Pedro Lopez and
contributors, licensed under Apache-2.0. Using an unofficial WhatsApp
client path is at your own risk.
