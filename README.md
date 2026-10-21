# WA Channel Poster — Kirim Pesan & Gambar ke Saluran WhatsApp via Web

Sistem untuk memposting **teks dan gambar ke Saluran WhatsApp (Channel/Newsletter)**
dari halaman web sederhana — termasuk **gambar**, yang tidak bisa dikirim ke Saluran
lewat jalur bot biasa (Baileys) karena dibuang diam-diam oleh server WhatsApp.

Proyek ini terdiri dari dua komponen:

| Komponen | Fungsi |
|---|---|
| **`wa-poster/`** | Sidecar WhatsApp Web: menjalankan WhatsApp Web asli (Chromium + [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js)) di dalam Docker, menyediakan API HTTP untuk mengirim pesan. Berisi perbaikan kustom jalur kirim ke Saluran (`sendToChannel()`). |
| **`wa-web/`** | Halaman web pengirim satu halaman (Node.js murni, tanpa dependensi): login password, form teks, upload/paste gambar, lalu meneruskan pengiriman ke sidecar (untuk Saluran) atau ke bridge Hermes (untuk chat pribadi/grup, bila diaktifkan). |

```
Browser ──► wa-web (:8090) ──┬─► wa-poster sidecar (:3001) ──► WhatsApp Web asli ──► Saluran
                             └─► (opsional) Hermes bridge (:3000, Baileys) ──► chat pribadi/grup
```

---

## Latar belakang: kenapa perlu sidecar?

Pengujian langsung membuktikan:

- Kirim **teks** ke Saluran lewat Baileys (mis. bridge WhatsApp Hermes): **berhasil**.
- Kirim **gambar/dokumen/polling** ke Saluran lewat Baileys: **gagal diam-diam** —
  API menjawab `success` + messageId, tidak ada error di log, tetapi postingan
  tidak pernah muncul di Saluran. Server WhatsApp membuang semua konten non-teks
  dari jalur tersebut.
- Library whatsapp-web.js versi 1.34.7 pun jalur Salurannya rusak terhadap build
  WhatsApp Web saat ini (dua bug getter internal + metode `avParams()` yang sudah
  dihapus dari WA Web).

Karena itu sidecar ini memakai **pipeline kustom** di dalam halaman WhatsApp Web
(fungsi `sendToChannel()` di `wa-poster/index.js`) yang meniru persis cara klien
WA Web resmi memposting ke Saluran:

1. Ambil objek chat Saluran dari `WAWebNewsletterCollection` memakai objek **Wid**
   (bukan string mentah).
2. Siapkan media dengan `WWebJS.processMediaData(..., { sendToChannel: true })`
   (upload tanpa enkripsi khusus Saluran, menghasilkan `mediaHandle`).
3. Bangun model pesan `Msg` dari `mediaData.toJSON()` saja
   (**jangan** menyebar objek model mentah — memicu error getter WA Web).
4. Daftarkan record lewat `addNewsletterMsgsRecords`, lalu kirim dengan
   `sendNewsletterMessageJob` **tanpa** `mediaMetadata` (untuk gambar tidak
   diperlukan pada build WA Web sekarang).

Hasil terverifikasi: server WhatsApp menjawab `{ success: true, serverId: <id> }`
dan postingan benar-benar muncul di Saluran.

---

## Fungsi / fitur

### wa-poster (sidecar)

- Pairing nomor WhatsApp sebagai **perangkat tertaut** WhatsApp Web:
  - lewat **kode pairing 8 karakter** (`pairWithPhoneNumber`) — direkomendasikan,
  - atau QR (tersedia di `GET /qr`, tetapi QR dapat berputar terlalu cepat untuk dipindai).
- Sesi **persisten** di volume Docker (`./data`) — restart container tidak perlu pairing ulang.
- API terkunci token (header `X-Token`), hanya listen di `127.0.0.1:3001`.
- Endpoint:
  | Method & path | Fungsi |
  |---|---|
  | `GET /health` | Status: `{ status, ready, qrPending, me }` |
  | `GET /qr` | QR pairing saat ini (bila ada) |
  | `GET /code` | Kode pairing 8 karakter untuk `PAIR_PHONE` |
  | `POST /send` | Kirim teks/gambar. Target `@newsletter` otomatis memakai pipeline Saluran kustom; target lain memakai `client.sendMessage` standar. |
  | `POST /probe` | Alat diagnosis (eval JS di halaman WA Web dsb). Token-gated; untuk pengembangan. |
- Gambar **tidak disimpan sebagai file** di server: base64 diterima di memori,
  diproses di halaman WA Web, lalu diunggah langsung ke server WhatsApp.
- Pembersihan otomatis lock Chromium basi (`SingletonLock` dsb.) sebelum start,
  agar container bisa di-recreate tanpa gagal start.

### wa-web (web pengirim)

- Login satu password bersama → cookie sesi `httpOnly` (30 hari).
- Tujuan **terkunci ke satu Saluran** secara bawaan (aman untuk dibagikan ke anggota).
- Form: teks/caption, **upload gambar** (pilih file) **atau tempel langsung dari
  clipboard** (`Ctrl+V`, mis. screenshot — nama file otomatis `screenshot-<timestamp>`),
  pratinjau gambar, indikator status bridge + sidecar, footer kontak bantuan.
- Routing pengiriman:
  | Tujuan | Teks | Gambar/media |
  |---|---|---|
  | Saluran (`@newsletter`) | sidecar wa-poster | sidecar wa-poster |
  | Chat pribadi / grup | bridge Hermes `:3000/send` | bridge Hermes `:3000/send-media` (file temp, dihapus otomatis setelah kirim) |

> Catatan: jalur chat pribadi/grup membutuhkan **Hermes WhatsApp bridge** yang
> berjalan di mesin yang sama (bagian dari Hermes Agent, di luar repo ini).
> Tanpa bridge itu, mode Saluran tetap berfungsi penuh.

---

## Prasyarat

- Linux dengan **Docker** + Docker Compose (untuk sidecar).
- **Node.js 20+** di host (untuk wa-web) — atau Node dari instalasi lain.
- Satu nomor WhatsApp yang menjadi **admin Saluran** target
  (admin dapat membuat postingan; tidak harus pemilik Saluran).
- RAM kosong ±1,5 GB untuk container Chromium sidecar.
- (Opsional) Hermes Agent dengan WhatsApp bridge aktif di `:3000` — hanya bila
  ingin mengaktifkan tujuan chat pribadi/grup.
- (Opsional) Cloudflare Tunnel / reverse proxy bila web ingin diakses dari internet.

---

## Instalasi

### 1. Sidecar `wa-poster`

```bash
cd wa-poster
cp .env.example .env
nano .env            # isi POSTER_TOKEN (acak) dan PAIR_PHONE (nomor pengirim)
docker compose up -d --build
```

Pairing (pilih salah satu):

**Kode 8 karakter (disarankan):**

```bash
curl http://127.0.0.1:3001/code
```

Di HP nomor pengirim: WhatsApp → **Perangkat tertaut** → **Tautkan perangkat** →
**Tautkan dengan nomor telepon saja** → masukkan kode dari endpoint di atas.

**Atau QR:** buka `http://127.0.0.1:3001/qr` dan pindai dari menu Perangkat tertaut.

Verifikasi:

```bash
curl http://127.0.0.1:3001/health
# {"status":"ok","ready":true,"qrPending":false,"me":"628xxxxxxxxxx@c.us"}
```

### 2. Web pengirim `wa-web`

```bash
cd wa-web
cp .env.example .env
nano .env            # isi WEB_PASSWORD, POSTER_TOKEN (sama dgn sidecar), CHANNEL_JID, SELF_JID
node server.js       # dengarkan di PORT (bawaan 8090)
```

Menjalankan sebagai service systemd (user):

```bash
mkdir -p ~/.config/systemd/user
cp wa-web.service.example ~/.config/systemd/user/wa-web.service
nano ~/.config/systemd/user/wa-web.service   # sesuaikan path & lokasi node
systemctl --user daemon-reload
systemctl --user enable --now wa-web
# agar tetap jalan setelah logout/reboot:
sudo loginctl enable-linger $USER
```

### 3. (Opsional) Akses dari internet via Cloudflare Tunnel

Buat tunnel (dashboard Cloudflare Zero Trust → Networks → Tunnels), lalu tambahkan
**Public Hostname**, contoh `tugas.contoh-domain.id` → service **HTTP** →
`localhost:8090`. Sangat disarankan menambahkan **Cloudflare Access**
(application self-hosted, policy allow email tertentu) di depannya, karena web
ini dapat mengirim pesan sebagai nomor Anda.

---

## Konfigurasi

### `wa-poster/.env`

| Variabel | Wajib | Keterangan |
|---|---|---|
| `POSTER_TOKEN` | ya | Token rahasia header `X-Token`. Buat acak: `openssl rand -hex 24`. |
| `PAIR_PHONE` | ya | Nomor pengirim format internasional tanpa `+` (mis. `6281234567890`). Dipakai untuk pairing kode. |

Pengaturan lain sidecar (di `docker-compose.yml`): port `127.0.0.1:3001`,
`mem_limit: 1200m`, volume sesi `./data:/data`, `restart: unless-stopped`.

### `wa-web/.env`

| Variabel | Bawaan | Keterangan |
|---|---|---|
| `PORT` | `8090` | Port web. |
| `WEB_PASSWORD` | — | Password login halaman web. |
| `POSTER_TOKEN` | — | Harus sama persis dengan token sidecar. |
| `CHANNEL_JID` | — | JID Saluran tujuan, format `120363xxxxxxxxxx@newsletter`. |
| `SELF_JID` | — | JID nomor sendiri `628xxxxxxxxxx@s.whatsapp.net` (dipakai opsi tujuan "Nomor sendiri"). |

### Menemukan JID Saluran

JID tidak tampil di halaman publik Saluran. Cara yang terbukti: JID muncul di log
bridge Hermes (`~/.hermes/whatsapp/bridge.log`, event
`xwa2_notify_newsletter_admin_promote`), atau tanyakan lewat endpoint diagnosis
sidecar `POST /probe` dengan action `channels` setelah pairing.

### Mengganti footer kontak bantuan

Di `wa-web/server.js` cari teks `Mengalami kendala?` lalu ganti tautan
`https://wa.me/628xxxxxxxxxx` dengan nomor admin Anda (format `wa.me/<kode negara><nomor>`).

---

## Penggunaan

### Lewat web

1. Buka web (mis. `http://localhost:8090` atau domain tunnel Anda), login.
2. Tulis pesan/caption.
3. Lampirkan gambar: **pilih file** atau **tempel screenshot** dengan `Ctrl+V`.
4. Klik **Kirim**. Postingan langsung muncul di Saluran.

### Lewat API sidecar langsung

Teks ke Saluran:

```bash
curl -X POST http://127.0.0.1:3001/send \
  -H "Content-Type: application/json" \
  -H "X-Token: <POSTER_TOKEN>" \
  -d '{"chatId":"120363xxxxxxxxxx@newsletter","text":"Halo dari API"}'
# {"success":true,"serverId":123,...}
```

Gambar ke Saluran (base64):

```bash
curl -X POST http://127.0.0.1:3001/send \
  -H "Content-Type: application/json" \
  -H "X-Token: <POSTER_TOKEN>" \
  -d '{"chatId":"120363xxxxxxxxxx@newsletter",
       "mediaBase64":"<BASE64>","mediaMimetype":"image/jpeg",
       "mediaName":"foto.jpg","caption":"Caption gambar"}'
```

---

## Mengaktifkan pilihan tujuan kirim (Saluran / nomor sendiri / JID lain)

Secara bawaan UI wa-web **terkunci hanya ke Saluran** (keputusan keamanan: siapa
pun yang memegang password web tidak bisa mengirim ke sembarang orang).
Backend-nya sendiri sudah mendukung semua tujuan — yang perlu diubah hanya
halaman depannya di `wa-web/server.js`:

1. **Ganti blok tujuan tetap menjadi dropdown.** Cari:

   ```html
   <label>Tujuan</label>
   <div style="...">Saluran — tujuan terkunci</div>
   ```

   Ganti dengan:

   ```html
   <label>Tujuan</label>
   <select id="target">
     <option value="channel">Saluran</option>
     <option value="self">Nomor sendiri (tes)</option>
     <option value="custom">JID lain (isi manual)</option>
   </select>
   <input type="text" id="customJid" placeholder="contoh: 62812xxxx@s.whatsapp.net atau 12345@g.us" style="display:none;margin-top:8px">
   ```

2. **Tambahkan logika tampil/sembunyi kolom JID** di bagian `<script>`:

   ```js
   $('target').onchange=()=>{$('customJid').style.display=$('target').value==='custom'?'block':'none';};
   ```

3. **Ubah payload tombol Kirim** dari yang terkunci:

   ```js
   const payload={target:'channel',text:$('text').value,...};
   ```

   menjadi:

   ```js
   const target=$('target').value;
   const jid=target==='custom'?$('customJid').value.trim():target;
   const payload={target:jid,text:$('text').value,...};
   ```

4. Restart service: `systemctl --user restart wa-web`.

Format JID tujuan:

| Jenis | Format | Contoh |
|---|---|---|
| Saluran | `<id>@newsletter` | `120363xxxxxxxxxx@newsletter` |
| Chat pribadi | `<nomor intl>@s.whatsapp.net` | `62812xxxxxxxx@s.whatsapp.net` |
| Grup | `<id>@g.us` | `12036xxxxxxxxxx@g.us` |

Routing otomatis mengikuti tabel di bagian Fungsi: Saluran selalu lewat sidecar;
pribadi/grup lewat bridge Hermes (teks bersih, gambar via file temp yang langsung
dihapus). **Perhatian:** dengan opsi ini aktif, pemegang password web dapat
mengirim pesan sebagai nomor Anda ke siapa pun — pertimbangkan Cloudflare Access
dan password yang kuat.

---

## Keamanan

- **Jangan pernah commit** `.env` dan folder `wa-poster/data/` — folder data berisi
  sesi WhatsApp Web, setara kredensial login akun. `.gitignore` repo ini sudah
  mengecualikannya; jangan diubah.
- API sidecar hanya listen di loopback dan wajib header `X-Token`; jangan
  mempublikasikannya langsung ke internet.
- Web pengirim cukup dilindungi satu password bersama — untuk pemakaian publik
  tambahkan Cloudflare Access (OTP email) sebagai lapis kedua.
- Gunakan **nomor khusus** untuk pengirim bila memungkinkan, dan jangan memakai
  sistem ini untuk spam/broadcast massal (risiko pembatasan akun oleh WhatsApp —
  jalur ini tidak resmi, sama seperti semua klien pihak ketiga).

## Troubleshooting

| Gejala | Penyebab & solusi |
|---|---|
| QR selalu gagal dipindai / "tidak dapat menautkan perangkat" | QR berputar terlalu cepat di sesi headless. Pakai **pairing kode 8 karakter** (`GET /code`). |
| Container gagal start setelah di-recreate | Lock Chromium basi di volume — sudah ditangani otomatis di `index.js` (menghapus `SingletonLock`/`SingletonCookie`/`SingletonSocket` sebelum start). |
| `POST /send` gambar ke Saluran balas 500 "getter must include an id" | Anda memakai jalur bawaan library (`client.sendMessage`) — pastikan target berakhiran `@newsletter` agar masuk pipeline `sendToChannel()`. |
| Indikator status web merah padahal kirim bisa | Endpoint status memakai GET; pastikan `callJson` mengirim GET untuk body kosong (bug lama: semua request dipaksa POST → bridge 400 / sidecar 404). |
| Gambar ke Saluran lewat bot Baileys tidak muncul tapi API bilang sukses | Memang dibuang server WhatsApp — itulah alasan proyek ini ada. Gunakan sidecar. |

## Struktur proyek

```
.
├── README.md
├── wa-poster/                 # sidecar WhatsApp Web (Docker)
│   ├── index.js               # API + pipeline Saluran kustom (sendToChannel)
│   ├── Dockerfile             # node:22 + Chromium
│   ├── docker-compose.yml
│   ├── package.json           # whatsapp-web.js 1.34.7
│   └── .env.example
└── wa-web/                    # web pengirim (Node murni)
    ├── server.js              # satu file: halaman + API + routing
    ├── wa-web.service.example # contoh unit systemd user
    └── .env.example
```

## Lisensi & catatan

Kode proyek ini bebas dipakai dan dimodifikasi untuk kebutuhan sendiri.
whatsapp-web.js berlisensi Apache-2.0 (proyek terpisah, oleh Pedro Lopez dkk.).
Sistem ini memakai jalur **tidak resmi** (WhatsApp Web diotomasi) — gunakan dengan
bijak dan tanggung sendiri risikonya.
