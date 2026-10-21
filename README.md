# WA Channel Poster

Alat buat posting teks dan gambar ke Saluran WhatsApp (Channel) dari halaman web.
Awalnya ini kubuat karena kebutuhan sendiri: aku admin sebuah Saluran dan capek
posting manual dari HP, jadi kubuat web sederhana supaya bisa posting dari laptop,
termasuk kirim gambar dan screenshot tugas.

Kedengarannya sepele, ternyata tidak. Ceritanya ada di bawah.

## Kenapa tidak pakai bot biasa saja?

Sudah kucoba duluan lewat bot WhatsApp (Baileys, lewat bridge Hermes). Hasilnya:

- Kirim teks ke Saluran: bisa.
- Kirim gambar ke Saluran: API-nya bilang sukses, messageId keluar, log bersih,
  tapi postingannya tidak pernah muncul di Saluran. Dicek berkali-kali tetap sama.
  Rupanya server WhatsApp membuang konten selain teks dari jalur itu tanpa
  memberi tahu apa pun.

Library whatsapp-web.js juga tidak langsung menyelesaikan masalah. Jalur
Saluran bawaan versi 1.34.7 sudah tidak cocok dengan WhatsApp Web sekarang:
ada dua tempat yang error karena perubahan internal WA Web, dan satu fungsi
yang dipanggil library (`avParams()`) sudah tidak ada lagi di WA Web versi baru.

Akhirnya kubuat jalur sendiri di dalam halaman WhatsApp Web, meniru cara WA Web
resmi memposting ke Saluran. Inti-intinya begini:

1. Ambil data Saluran dari `WAWebNewsletterCollection` pakai objek Wid.
   Kalau pakai string biasa langsung error.
2. Media disiapkan pakai `processMediaData` dengan opsi `sendToChannel: true`,
   nanti dapat `mediaHandle` dari hasil upload-nya.
3. Model pesan dibangun dari `mediaData.toJSON()` saja. Jangan menyebar objek
   model mentahnya, itu yang bikin error getter tadi.
4. Catat dulu pesan ke `addNewsletterMsgsRecords`, baru kirim pakai
   `sendNewsletterMessageJob`. Untuk gambar, `mediaMetadata` tidak perlu diisi.

Kalau berhasil, server WhatsApp membalas `success: true` plus `serverId`, dan
postingannya benar-benar nongol di Saluran. Cara ini yang sekarang kupakai dan
sudah jalan di serverku sendiri.

## Isi proyek

Ada dua bagian:

**wa-poster** (folder `wa-poster/`)
Sidecar yang menjalankan WhatsApp Web asli di dalam Docker (Chromium +
whatsapp-web.js). Dia yang login ke WhatsApp sebagai perangkat tertaut dan
menyediakan API HTTP kecil untuk mengirim pesan. Pipeline Saluran kustom di
atas ada di file `index.js`, fungsi `sendToChannel()`.

**wa-web** (folder `wa-web/`)
Halaman web pengirimnya. Satu file Node.js tanpa dependensi tambahan. Ada login
password, form teks, upload gambar (bisa juga tempel screenshot pakai Ctrl+V),
lalu pengiriman diteruskan ke sidecar.

Alurnya kurang lebih:

```
Browser -> wa-web (port 8090) -> wa-poster (port 3001) -> WhatsApp Web -> Saluran
```

Khusus tujuan chat pribadi/grup, wa-web meneruskan ke bridge WhatsApp Hermes
di port 3000. Bagian itu opsional, tanpa bridge pun mode Saluran tetap jalan.

## Fitur

Sidecar wa-poster:

- Pairing pakai kode 8 karakter (cara ini yang berhasil di serverku; pairing QR
  sempat gagal terus karena QR-nya berputar terlalu cepat untuk dipindai).
- Sesi tersimpan di volume `./data`, jadi restart container tidak perlu pairing ulang.
- API dikunci token lewat header `X-Token`, hanya listen di 127.0.0.1 port 3001.
- Gambar tidak disimpan jadi file di server. Datanya diterima sebagai base64,
  diproses di memori, lalu diupload langsung ke WhatsApp.
- Ada pembersih lock Chromium otomatis. Waktu awal ngoprek, container sempat
  gagal start setelah di-recreate gara-gara file `SingletonLock` basi di volume.

Endpoint sidecar:

- `GET /health` untuk cek status dan nomor yang terhubung
- `GET /qr` untuk mengambil QR pairing
- `GET /code` untuk mengambil kode pairing 8 karakter
- `POST /send` untuk mengirim teks atau gambar
- `POST /probe` alat bantu diagnosis, ikut dikunci token

Web wa-web:

- Login satu password bersama, sesi pakai cookie httpOnly selama 30 hari.
- Tujuan bawaan terkunci ke satu Saluran saja.
- Form teks/caption, lampiran gambar dari file atau tempel dari clipboard,
  pratinjau gambar sebelum kirim, dan indikator status sidecar.
- Footer kontak bantuan di bawah form, ganti nomornya sesuai kebutuhan.

Routing kirimnya:

- Saluran: teks dan gambar dua-duanya lewat sidecar.
- Chat pribadi/grup: teks lewat bridge Hermes (`POST /send`), gambar lewat
  bridge juga (`POST /send-media`, file ditulis sementara lalu langsung dihapus).

## Yang dibutuhkan

- Server Linux dengan Docker dan Docker Compose.
- Node.js 20 ke atas di host untuk menjalankan wa-web.
- Nomor WhatsApp yang sudah jadi admin Saluran tujuan. Tidak harus pemilik
  Saluran, admin saja cukup karena admin bisa membuat postingan.
- RAM kosong sekitar 1,5 GB untuk container Chromium-nya.
- Opsional: Hermes Agent dengan bridge WhatsApp aktif, kalau mau pakai tujuan
  chat pribadi/grup.
- Opsional: Cloudflare Tunnel kalau webnya mau dibuka dari internet.

## Cara install

### 1. Sidecar

```bash
cd wa-poster
cp .env.example .env
```

Isi dulu `.env`-nya (penjelasan variabel ada di bagian Pengaturan), lalu:

```bash
docker compose up -d --build
```

Pairing nomor pengirim, ambil kodenya dari:

```bash
curl http://127.0.0.1:3001/code
```

Di HP nomor pengirim buka WhatsApp, masuk ke Perangkat tertaut, pilih
Tautkan perangkat, lalu pilih opsi tautkan dengan nomor telepon dan masukkan
kode tadi. Kalau mau coba QR bisa ambil dari `GET /qr`, tapi dari pengalamanku
kode 8 karakter jauh lebih bisa diandalkan.

Cek hasil pairing:

```bash
curl http://127.0.0.1:3001/health
```

Kalau `ready` sudah `true` dan field `me` berisi nomormu, sidecar siap dipakai.

### 2. Web pengirim

```bash
cd wa-web
cp .env.example .env
node server.js
```

Web jalan di port 8090 (bisa diganti di `.env`). Supaya tetap jalan terus,
pasang sebagai service systemd user. Contoh unitnya ada di
`wa-web.service.example`, sesuaikan path Node dan lokasi foldernya, lalu:

```bash
systemctl --user daemon-reload
systemctl --user enable --now wa-web
sudo loginctl enable-linger $USER
```

Perintah terakhir itu supaya service tetap hidup walaupun user logout.

### 3. Dibuka dari internet (opsional)

Aku sendiri memakai Cloudflare Tunnel. Tambahkan Public Hostname di tunnel,
arahkan ke `http://localhost:8090`. Saranku tambahkan juga Cloudflare Access
di depannya dan batasi hanya email tertentu yang boleh masuk, karena halaman
ini bisa mengirim pesan memakai nomormu. Password web saja menurutku kurang.

## Pengaturan

### wa-poster/.env

- `POSTER_TOKEN` : token rahasia untuk header `X-Token`. Buat yang acak,
  misalnya pakai `openssl rand -hex 24`.
- `PAIR_PHONE` : nomor pengirim format internasional tanpa tanda plus,
  contohnya `6281234567890`. Dipakai saat pairing kode.

Pengaturan lain sidecar ada di `docker-compose.yml`: port `127.0.0.1:3001`,
batas memori 1200 MB, volume sesi `./data`, restart `unless-stopped`.

### wa-web/.env

- `PORT` : port web, bawaannya 8090.
- `WEB_PASSWORD` : password untuk login halaman web.
- `POSTER_TOKEN` : harus sama persis dengan token di `.env` sidecar.
- `CHANNEL_JID` : JID Saluran tujuan, formatnya `120363xxxxxxxxxx@newsletter`.
- `SELF_JID` : JID nomor sendiri, formatnya `628xxxxxxxxxx@s.whatsapp.net`.
  Dipakai kalau pilihan tujuan diaktifkan lagi (lihat bagian bawah).

### Cara dapat JID Saluran

JID ini tidak kelihatan dari link undangan Saluran. Cara yang kutemukan:
JID muncul di log bridge Hermes (`~/.hermes/whatsapp/bridge.log`) pada event
promosi admin newsletter, atau bisa ditanyakan lewat endpoint `POST /probe`
sidecar dengan action `channels` setelah pairing berhasil.

### Ganti kontak bantuan di footer

Di `wa-web/server.js` cari tulisan `Mengalami kendala?`, lalu ganti tautan
`https://wa.me/628xxxxxxxxxx` dengan nomor admin yang diinginkan.

## Cara pakai

Lewat web:

1. Buka alamat webnya dan login.
2. Tulis pesan atau caption.
3. Kalau ada gambar, pilih file atau tempel screenshot dengan Ctrl+V.
4. Klik Kirim. Postingan langsung muncul di Saluran.

Lewat API sidecar langsung juga bisa.

Kirim teks:

```bash
curl -X POST http://127.0.0.1:3001/send \
  -H "Content-Type: application/json" \
  -H "X-Token: TOKEN_ANDA" \
  -d '{"chatId":"120363xxxxxxxxxx@newsletter","text":"Halo dari API"}'
```

Kirim gambar:

```bash
curl -X POST http://127.0.0.1:3001/send \
  -H "Content-Type: application/json" \
  -H "X-Token: TOKEN_ANDA" \
  -d '{"chatId":"120363xxxxxxxxxx@newsletter","mediaBase64":"BASE64_GAMBAR","mediaMimetype":"image/jpeg","mediaName":"foto.jpg","caption":"Caption gambar"}'
```

Balasan sukses berisi `serverId`, itu nomor urut postingan di Saluran dari
server WhatsApp.

## Mengaktifkan pilihan tujuan kirim

Di versi yang kupakai sekarang, tujuan di halaman web kukunci hanya ke Saluran.
Alasannya keamanan: password web ini kubagikan ke anggota Saluran, dan aku tidak
mau mereka bisa mengirim pesan sebagai nomorku ke orang lain.

Backend wa-web sebenarnya masih mendukung tujuan lain, yang diubah hanya
tampilan halamannya. Kalau mau pilihan tujuan seperti semula, ubah tiga hal
di `wa-web/server.js`:

1. Ganti blok tujuan yang terkunci dengan dropdown:

```html
<label>Tujuan</label>
<select id="target">
  <option value="channel">Saluran</option>
  <option value="self">Nomor sendiri (tes)</option>
  <option value="custom">JID lain (isi manual)</option>
</select>
<input type="text" id="customJid" placeholder="contoh: 62812xxxx@s.whatsapp.net atau 12345@g.us" style="display:none;margin-top:8px">
```

Blok yang diganti adalah bagian `<label>Tujuan</label>` dengan div
"Saluran, tujuan terkunci" di bawahnya.

2. Tambahkan logika menampilkan kolom JID saat opsi manual dipilih:

```js
$('target').onchange=()=>{$('customJid').style.display=$('target').value==='custom'?'block':'none';};
```

3. Ubah payload pada handler tombol Kirim. Semula target terkunci:

```js
const payload={target:'channel',text:$('text').value,...};
```

Ganti jadi mengambil dari pilihan pengguna:

```js
const target=$('target').value;
const jid=target==='custom'?$('customJid').value.trim():target;
const payload={target:jid,text:$('text').value,...};
```

Setelah itu restart servicenya: `systemctl --user restart wa-web`.

Format JID yang dipakai:

- Saluran: `120363xxxxxxxxxx@newsletter`
- Chat pribadi: `628xxxxxxxxxx@s.whatsapp.net`
- Grup: `12036xxxxxxxxxx@g.us`

Sekali lagi soal keamanan: kalau pilihan ini diaktifkan, siapa pun yang tahu
password web bisa mengirim pesan sebagai Anda ke siapa saja. Pikirkan lagi
sebelum membagikan passwordnya.

## Catatan keamanan

- File `.env` dan folder `wa-poster/data/` jangan sampai ikut ter-commit.
  Folder data itu isinya sesi WhatsApp Web, nilainya sama seperti kredensial
  login akun. File `.gitignore` di repo ini sudah mengecualikan keduanya.
- Sidecar hanya listen di loopback dan API-nya wajib token. Jangan buka port
  3001 langsung ke internet.
- Untuk pemakaian publik, tambahkan Cloudflare Access sebagai lapisan di
  depan password web.
- Sebisa mungkin pakai nomor khusus untuk pengirim, jangan nomor utama.
  Jalur ini tidak resmi dari WhatsApp, jadi selalu ada risiko pembatasan akun.
  Jangan dipakai untuk spam atau broadcast massal.

## Masalah yang pernah kutemui

- Pairing QR gagal terus dengan pesan tidak dapat menautkan perangkat.
  Solusinya pakai kode pairing 8 karakter.
- Container tidak mau start setelah di-recreate. Penyebabnya file lock
  Chromium dari sesi sebelumnya. Sudah ditangani di `index.js`, lock dibersihkan
  otomatis sebelum client start.
- Kirim gambar balas error soal getter id. Itu tanda pengiriman masuk ke jalur
  bawaan library. Pastikan targetnya berakhiran `@newsletter` supaya memakai
  fungsi `sendToChannel()`.
- Indikator status di web merah padahal kirim bisa. Pernah kejadian karena
  fungsi pemanggil API memaksa semua request menjadi POST, termasuk cek
  kesehatan yang harusnya GET. Sekarang sudah dibedakan di `callJson`.

## Struktur folder

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

## Penutup

Proyek ini kubuat untuk kebutuhan sendiri dan masih jauh dari sempurna, tapi
sudah kupakai harian untuk mengelola Saluran. Silakan dipakai atau dimodifikasi
kalau ada yang butuh hal serupa. Library whatsapp-web.js sendiri berlisensi
Apache-2.0 dan merupakan proyek terpisah dari Pedro Lopez dan para
kontributornya. Risiko pemakaian jalur tidak resmi ini tanggung sendiri ya.
