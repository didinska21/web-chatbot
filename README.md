# web-chatbot

Website chat AI untuk coding, dengan API custom. Dikunci dengan kode PIN dan dijalankan di Cloudflare Pages.

## Fitur

- Tampilan chat dengan sidebar riwayat (tersimpan di browser), mode terang dan gelap, responsif untuk HP
- Jawaban tampil bertahap (streaming)
- Blok kode dengan nama file, tombol **Salin** dan **Unduh**
- Tombol **Unduh semua (.zip)** untuk jawaban yang berisi banyak file
- Lampirkan file kode (`.js`, `.py`, `.mq5`, `.json`, dan lainnya, maks 300 KB per file)
- Login dengan PIN, dicek di server (bukan di browser)
- API key tersimpan aman di server, tidak terlihat pengunjung

## Struktur

```
web-chatbot/
├── index.html              Tampilan dan logika chat
├── lib/
│   └── auth.js             Fungsi pembuat dan pemeriksa sesi login
└── functions/
    └── api/
        ├── login.js        POST /api/login    cek PIN, beri cookie sesi
        ├── session.js      GET  /api/session  cek apakah sudah login
        └── chat.js         POST /api/chat     proxy ke API AI (wajib login)
```

## Deploy

1. Upload **isi** folder ini ke repo GitHub. `index.html`, `lib`, dan `functions` harus berada di root repo.
2. Buka Cloudflare Dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**, lalu pilih repo.
3. Framework preset: **None**. Build command kosong. Output directory: `/`.
4. Setelah project jadi, buka **Settings → Variables and Secrets** dan isi variabel di bawah (tipe **Secret**), lalu deploy ulang.
5. Buka tab **Custom domains** dan tambahkan domain (misalnya `didinska.my.id`).

## Variabel environment

| Nama | Isi |
|---|---|
| `PIN` | PIN untuk masuk. Sebaiknya 6 digit atau lebih |
| `SESSION_SECRET` | Teks acak panjang untuk menandatangani cookie. Buat dengan `openssl rand -hex 32` |
| `API_URL` | URL endpoint API AI, misalnya `https://api.domainmu.com/v1/chat/completions` |
| `API_KEY` | API key untuk API tersebut |
| `MODEL` | Nama model (opsional, menimpa pilihan dari browser) |

## Format API

Default-nya OpenAI-compatible:

- Request: `{ "model": "...", "stream": true, "messages": [{ "role": "...", "content": "..." }] }`
- Respons streaming (SSE): `choices[0].delta.content`
- Respons biasa: `choices[0].message.content`

Kalau API-mu berbeda, sesuaikan `functions/api/chat.js` (bentuk request) dan bagian pembacaan respons di `index.html`.

## Cara pakai

- Masukkan PIN. Sesi berlaku 7 hari.
- Tulis permintaan, atau klik 📎 untuk melampirkan file kode.
- Pada jawaban AI, klik **Unduh** untuk menyimpan satu file, atau **Unduh semua (.zip)** untuk semuanya.
- Tombol **Pengaturan** di sidebar hanya perlu dipakai kalau tidak memakai proxy `/api/chat`. Dengan proxy, biarkan default.

## Keamanan

- Jangan memasukkan API key ke `index.html` atau ke Pengaturan di browser. Simpan hanya di variabel environment Cloudflare.
- Aktifkan rate limiting untuk path `/api/login` (Cloudflare → Security → WAF → Rate limiting rules), misalnya 5 percobaan per menit per IP. PIN angka pendek bisa ditebak tanpa pembatas.
- Kalau PIN bocor, ganti `PIN` dan `SESSION_SECRET`. Mengganti `SESSION_SECRET` membuat semua sesi lama otomatis tidak berlaku.
- Riwayat chat tersimpan di browser masing-masing perangkat dan tidak disinkronkan.

## Masalah umum

| Gejala | Penyebab dan solusi |
|---|---|
| Layar PIN muncul terus | `PIN` atau `SESSION_SECRET` belum diisi, atau belum deploy ulang setelah mengisi |
| Error 401 saat chat | Sesi habis. Masukkan PIN lagi |
| Error 404 pada `/api/...` | Folder `functions` tidak berada di root repo |
| Jawaban kosong atau error 4xx/5xx | Periksa `API_URL`, `API_KEY`, `MODEL`, dan format API |
| Tombol zip tidak berfungsi | Library JSZip gagal dimuat. Periksa koneksi internet |
