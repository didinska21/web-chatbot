# web-chatbot

Website chat AI untuk coding, dengan API custom.

- **Tampilan** di GitHub Pages (`didinska.my.id`), dari folder `docs/`
- **Backend** di Cloudflare Worker (`web-chatbot.mr-didinska21.workers.dev`), menyimpan PIN dan API key di server
- Login memakai token (header `Authorization: Bearer`), bukan cookie, karena tampilan dan backend beda domain

## Struktur

```
web-chatbot/
├── wrangler.jsonc      Konfigurasi Worker
├── src/
│   └── worker.js       /api/login, /api/session, /api/chat (CORS + token)
└── docs/
    ├── index.html      Tampilan chat (dilayani GitHub Pages)
    └── CNAME           didinska.my.id
```

## Deploy

### 1. Worker (Cloudflare)
1. Upload semua isi folder ini ke repo GitHub (root repo berisi `wrangler.jsonc`, `src`, `docs`).
2. Cloudflare: Workers & Pages → Worker `web-chatbot` → Settings → Builds: build command kosong, deploy command `npx wrangler deploy`. Setiap commit ke `main` men-deploy otomatis.
3. Settings → Variables and Secrets, semuanya bertipe **Secret**:

| Nama | Isi |
|---|---|
| `PIN` | PIN untuk masuk (6 digit atau lebih) |
| `SESSION_SECRET` | Teks acak panjang (`openssl rand -hex 32`) |
| `API_URL` | Endpoint API AI, misalnya `https://api.groq.com/openai/v1/chat/completions` |
| `API_KEY` | API key |
| `MODEL` | Nama model, misalnya `openai/gpt-oss-120b` |
| `ALLOWED_ORIGINS` | Opsional. Daftar domain frontend, pisahkan koma. Default: `https://didinska.my.id,https://www.didinska.my.id` |

### 2. Tampilan (GitHub Pages)
1. Repo → Settings → Pages: Source **Deploy from a branch**, branch `main`, folder `/docs`.
2. Custom domain: `didinska.my.id`, lalu centang Enforce HTTPS.

### 3. DNS (di IDwebhost)
- 4 record **A** untuk `@`: `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`
- **CNAME** `www` ke `<username-github>.github.io`

## Mengganti alamat Worker
Kalau alamat Worker berubah, ubah konstanta `API` di `docs/index.html`.

## Log dan diagnosa

- **Log Worker:** Cloudflare → Workers & Pages → `web-chatbot` → Logs (atau `npx wrangler tail`). Satu baris JSON per kejadian. Cari `"lvl":"error"` atau `"lvl":"warn"`. Key, PIN, dan isi obrolan tidak pernah dicatat.
- **Di web:** tombol **Diagnosa koneksi** di sidebar memeriksa Secret, KV, ALLOWED_ORIGINS, dan koneksi ke provider satu per satu.
- **Error di chat** menampilkan sumber, kode, dan `ref`. `ref` sama dengan `rid` di log Worker.

| Sumber | Kode | Artinya dan solusi |
|---|---|---|
| Sesi / PIN | `pin_wrong` | PIN salah |
| Sesi / PIN | `session_invalid` | Sesi habis, masukkan PIN lagi |
| Konfigurasi Worker | `config_missing`, `config_invalid` | Secret belum diisi atau API_URL bukan URL valid (nama Secret disebut di pesan) |
| Konfigurasi Worker | `kv_missing` | KV `CHATS` belum terpasang, deploy ulang |
| Provider API | `upstream_error` | Provider menolak (lihat angka `provider:` 401/403/404/429/5xx dan sarannya) |
| Provider API | `upstream_unreachable`, `upstream_timeout` | API_URL salah ketik, atau provider down/lambat |
| Provider API | `upstream_stream_error`, `upstream_body_error` | Provider mengirim error di dalam balasan |
| Jaringan / CORS | `network` | Internet putus, alamat Worker di index.html salah, atau domain belum ada di ALLOWED_ORIGINS |
| Worker | `internal`, `kv_error`, `not_found` | Bug atau gangguan di Worker, cari `ref` di log |

## Keamanan
- Jangan menaruh API key di `index.html`.
- Pasang rate limiting untuk path `/api/login` (Security → WAF → Rate limiting rules), misalnya 5 percobaan per menit per IP.
- Kalau PIN bocor, ganti `PIN` dan `SESSION_SECRET` (semua token lama jadi tidak berlaku).

## Masalah umum

| Gejala | Penyebab dan solusi |
|---|---|
| Layar PIN muncul terus | `PIN` atau `SESSION_SECRET` belum diisi sebagai Secret |
| "Tidak bisa terhubung ke server" | Alamat `API` di `docs/index.html` salah, atau domain frontend belum ada di `ALLOWED_ORIGINS` |
| Error 401 saat chat | Sesi habis. Masukkan PIN lagi |
| Jawaban kosong atau error 4xx/5xx | Periksa `API_URL`, `API_KEY`, `MODEL` |
