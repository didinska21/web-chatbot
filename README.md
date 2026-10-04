# web-chatbot

Website chat AI untuk coding, dengan API custom. Dikunci dengan kode PIN dan dijalankan sebagai **Cloudflare Worker** (dengan static assets), dideploy lewat `wrangler`.

## Fitur

- Tampilan chat dengan sidebar riwayat (tersimpan di browser), mode terang dan gelap, responsif untuk HP
- Jawaban tampil bertahap (streaming)
- Blok kode dengan nama file, tombol **Salin** dan **Unduh**, serta **Unduh semua (.zip)**
- Lampirkan file kode (maks 300 KB per file)
- Login PIN yang dicek di server; API key tersimpan di server

## Struktur

```
web-chatbot/
├── wrangler.jsonc      Konfigurasi Worker
├── src/
│   └── worker.js       /api/login, /api/session, /api/chat (wajib login)
└── public/
    └── index.html      Tampilan chat (satu-satunya file yang dipublikasikan)
```

Hanya isi folder `public` yang menjadi file publik. Folder lain (termasuk `.git`) tidak ikut terunggah.

## Deploy (Git ke Cloudflare Worker)

1. Upload isi folder ini ke repo GitHub (root repo harus berisi `wrangler.jsonc`, `src`, `public`).
2. Di Cloudflare: **Workers & Pages** → Worker `web-chatbot` → **Settings → Builds**: build command kosong, deploy command `npx wrangler deploy`. Setiap commit ke `main` akan men-deploy otomatis.
3. **Settings → Variables and Secrets**: tambahkan semuanya bertipe **Secret**:

| Nama | Isi |
|---|---|
| `PIN` | PIN untuk masuk (6 digit atau lebih) |
| `SESSION_SECRET` | Teks acak panjang (`openssl rand -hex 32`) |
| `API_URL` | Endpoint API AI, misalnya `https://api.groq.com/openai/v1/chat/completions` |
| `API_KEY` | API key |
| `MODEL` | Nama model, misalnya `openai/gpt-oss-120b` |

   Gunakan tipe Secret untuk semuanya. Variabel bertipe Text bisa terhapus saat deploy berikutnya.
4. **Settings → Domains & Routes → Add → Custom domain**: isi `didinska.my.id` (dan `www.didinska.my.id`). Domain harus aktif di akun Cloudflare yang sama dengan Worker. Record DNS lama dengan nama yang sama (misalnya record A ke GitHub Pages) harus dihapus dulu. Record DNS untuk Worker dibuat otomatis, tidak perlu CNAME manual.

## Keamanan

- Jangan menaruh API key di `index.html` atau di Pengaturan browser.
- Pasang rate limiting untuk path `/api/login` (Security → WAF → Rate limiting rules), misalnya 5 percobaan per menit per IP.
- Kalau PIN bocor, ganti `PIN` dan `SESSION_SECRET`.

## Masalah umum

| Gejala | Penyebab dan solusi |
|---|---|
| Layar PIN muncul terus | `PIN` atau `SESSION_SECRET` belum diisi sebagai Secret |
| Error 401 saat chat | Sesi habis. Masukkan PIN lagi |
| `/api/...` menampilkan halaman biasa | `run_worker_first` belum terbaca; pastikan `wrangler.jsonc` ada di root repo |
| Jawaban kosong atau error 4xx/5xx | Periksa `API_URL`, `API_KEY`, `MODEL` |
