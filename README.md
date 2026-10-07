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
│   └── worker.js       /api/login, /api/session, /api/chat, /api/forex (CORS + token)
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
| `TWELVEDATA_KEY` | API key Twelve Data untuk menu Grafik XAU/USD (opsional, hanya dipakai Worker) |
| `GUEST_TRIAL_MIN` | Opsional. Lama trial kode tamu dalam menit (bawaan 60) |
| `GUEST_CODE_HOURS` | Opsional. Masa berlaku kode tamu yang belum dipakai dalam jam (bawaan 24) |
| `REASONING_HIGH` / `REASONING_MAX` | Opsional. JSON yang digabung ke permintaan analisa AI saat kedalaman berpikir Tinggi / Maksimal, contoh `{"reasoning":{"effort":"high"},"max_tokens":64000}` atau `{"thinking":{"type":"enabled","budget_tokens":30000},"max_tokens":48000}`. Kalau kosong, dipilih otomatis dari alamat `API_URL` |
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

## Kode tamu

Login pemilik memakai PIN. Dari menu **Kode tamu** (hanya tampil untuk pemilik) kamu bisa membuat kode 8 digit untuk orang lain. Kode dimasukkan di kolom PIN. Trial berjalan sejak kode pertama kali dipakai, lalu sesi tamu otomatis berakhir. Tamu tidak bisa membuka riwayat obrolan pemilik, menu Diagnosa, atau menu Kode tamu. Kode disimpan di KV `CHATS`, jadi binding KV wajib ada. Mengganti `PIN` langsung mengeluarkan semua sesi pemilik.

## Penalaran panjang (Analisa AI)

Analisa AI memakai jalur khusus tanpa batas 60 detik: Worker langsung membuka stream, menjaga koneksi tetap hidup dengan komentar `: ping`, dan menunggu provider sampai 20 menit. Parameter penalaran dicoba bertahap. Jika provider menolak (HTTP 400/422), Worker mengulang dengan parameter lebih sederhana lalu tanpa parameter, dan kartu analisa menandainya. Akun tamu selalu memakai penalaran standar. Batas dari sisi provider atau model (maksimum token, anggaran berpikir) tidak bisa dilewati oleh skrip.
