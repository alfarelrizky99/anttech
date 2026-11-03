# Arsitektur AntTech — WhatsApp DevOps Assistant

## 1. Gambaran Umum

AntTech adalah chatbot WhatsApp yang membantu tim DevOps/engineering untuk memonitor dan
mengoperasikan sistem internal perusahaan (OpenShift, Jira, Bitbucket, Bamboo, Redis) langsung
dari chat, tanpa perlu buka banyak dashboard atau login manual berkali-kali.

Secara fisik, ini dua program terpisah yang jalan di laptop/server yang sama:

```
┌──────────────┐     ┌─────────────────────────────┐     ┌───────────────────────────┐
│   WhatsApp    │────▶│   Hermes Agent (gateway)     │────▶│  mcp-server/ (tool kustom) │
│  (HP user)    │◀────│  - Baileys bridge (Node.js)   │◀────│  (Node.js, MCP stdio)      │
└──────────────┘     │  - LLM orchestration (Python)│     └──────────┬────────────────┘
                      │  - SOUL.md, skills, config    │                │
                      └───────────────────────────────┘                │
                                                                        ▼
                                                       ┌────────────────────────────────┐
                                                       │  Sistem internal perusahaan     │
                                                       │  (hanya lewat jaringan kantor)  │
                                                       │  - OpenShift API & OAuth        │
                                                       │  - Jira / Bitbucket / Bamboo    │
                                                       │  - Redis (lewat oc exec)        │
                                                       └────────────────────────────────┘
```

- **Hermes Agent** — framework agent AI open-source yang kita pakai sebagai "otak" dan "pintu
  masuk" WhatsApp. Kita tidak menulis kode untuk bagian ini, hanya mengonfigurasinya.
- **mcp-server/** — kode kustom yang kita tulis sendiri (TypeScript). Ini satu-satunya bagian
  yang menjembatani Hermes ke sistem internal perusahaan.
- Keduanya berjalan sebagai proses lokal di laptop yang **harus terhubung ke jaringan
  internal/VPN kantor**, karena semua sistem yang diakses (OpenShift, Jira, dst) hanya bisa
  dijangkau dari jaringan itu.

## 2. Alur satu pesan masuk, langkah demi langkah

Contoh: user kirim "monitoring pull request Fuad" di WhatsApp.

1. **Baileys bridge** (proses Node.js, bagian dari Hermes) menerima pesan dari WhatsApp Web
   protocol, lalu meneruskannya ke proses gateway Python Hermes lewat HTTP lokal (port 3000).
2. **Gateway Hermes** mengecek izin: apakah nomor pengirim ada di `WHATSAPP_ALLOWED_USERS`? Kalau
   di grup, apakah grup itu ada di `WHATSAPP_GROUP_ALLOWED_USERS` dan pesan ini mention/reply bot
   (karena `require_mention: true`)? Kalau lolos, pesan diteruskan ke agent loop.
3. **Agent loop** menyusun system prompt: identitas dari `SOUL.md` (persona AntTech, aturan
   sapaan, daftar kemampuan resmi) + daftar skill yang relevan + daftar tool yang tersedia dari
   MCP server kita.
4. **LLM** (model gratis `nvidia/nemotron-3.5-super-vl:free` via OpenRouter, dengan fallback
   otomatis, lihat bagian 7) membaca pesan, mencocokkan ke skill `pr-monitoring`, dan memutuskan
   memanggil tool `pr_monitoring_status` dengan `nickname: "Fuad"`.
5. Hermes mengirim tool call itu lewat **stdio (JSON-RPC/MCP protocol)** ke proses
   `mcp-server/dist/index.js` yang sudah berjalan sebagai child process sejak gateway start.
6. **mcp-server** menjalankan logic-nya sendiri: baca `pr-monitoring.config.json`, panggil REST
   API Bitbucket (dan Bamboo kalau PR-nya sudah merged), gabungkan hasilnya, kembalikan sebagai
   teks/JSON lewat MCP.
7. LLM menerima hasil tool itu, menyusun jawaban dalam Bahasa Indonesia santai (sesuai SOUL.md),
   dan Hermes mengirimkannya balik ke WhatsApp lewat Baileys bridge.

Tool progress ("⚙️ tool_describe...") disembunyikan khusus di WhatsApp
(`display.platforms.whatsapp.tool_progress: false`) supaya user cuma lihat hasil akhirnya.

## 3. Komponen: Hermes Agent (tidak kita tulis, kita konfigurasi)

| Bagian | Fungsi | Lokasi |
|---|---|---|
| Baileys bridge | Emulasi WhatsApp Web, kirim/terima pesan mentah | `~/.hermes/hermes-agent/scripts/whatsapp-bridge/` |
| Gateway core | Routing pesan, auth/allowlist, session management | Python, bagian dari install Hermes |
| Cron scheduler | Jadwal tugas berkala (saat ini tidak dipakai AntTech — lihat §6) | `~/.hermes/cron/` |
| `config.yaml` | Semua setting: model LLM, platform WhatsApp, MCP servers, display | `~/.hermes/config.yaml` |
| `.env` | Secrets: API key OpenRouter, nomor WA yang di-allowlist | `~/.hermes/.env` |
| `SOUL.md` | Identitas AntTech: bahasa, gaya bicara, aturan sapaan, daftar kemampuan resmi | `~/.hermes/SOUL.md` |
| `skills/` | Instruksi per-kemampuan yang dibaca LLM sebelum memanggil tool | `~/.hermes/skills/{get-token-oc,pr-monitoring,redis-ops}/` |

Kenapa pakai Hermes dan tidak tulis bot WhatsApp dari nol: Hermes sudah menyediakan bridge
WhatsApp (Baileys), orkestrasi LLM, sistem allowlist/keamanan dasar, dan protokol MCP untuk
nyambung ke tool kustom — jadi yang perlu kita tulis sendiri hanya logic yang spesifik ke
kebutuhan perusahaan (bagian §4).

## 4. Komponen: `mcp-server/` (kode kustom yang kita tulis)

Satu program Node.js/TypeScript yang bicara ke Hermes lewat **protokol MCP (Model Context
Protocol)** melalui stdio — bukan HTTP. Hermes men-spawn ini sebagai child process dan
berkomunikasi lewat JSON-RPC di stdin/stdout.

```
mcp-server/
├── src/
│   ├── index.ts           # Registrasi semua tool (17 total) + entrypoint MCP server
│   ├── config.ts          # Baca .env, validasi dengan Zod, resolve path absolut
│   ├── httpClient.ts      # Wrapper fetch dengan TLS/CA custom + Basic/Bearer auth
│   └── services/
│       ├── openshift.ts   # OAuth challenge flow (oc login equivalent)
│       ├── jira.ts        # REST API Jira Server/DC (JQL search, get issue)
│       ├── bitbucket.ts   # REST API Bitbucket Server/DC (list/get PR)
│       ├── bamboo.ts      # REST API Bamboo (build result, deployment status)
│       ├── prMonitoring.ts # Gabungkan Bitbucket+Bamboo per-orang (pakai config JSON)
│       └── redisOps.ts    # oc exec ke pod Redis per environment
├── .env                   # Kredensial semua service (gitignored)
├── certs/*.pem            # CA bundle TLS untuk cluster self-signed (gitignored)
├── pr-monitoring.config.json  # Mapping nama↔Bitbucket, daftar repo (gitignored)
└── redis-ops.config.json  # Mapping environment↔namespace/pod/host Redis (gitignored)
```

### 4.1 Daftar 17 tool, dikelompokkan per domain

**OpenShift (1 tool)**
- `openshift_generate_token` — meniru `oc login -u -p`, hit endpoint OAuth challenge
  (`/oauth/authorize?response_type=token&client_id=openshift-challenging-client`), parse token
  dari redirect fragment. Fallback ke kredensial default (`OPENSHIFT_USERNAME/PASSWORD`) kalau
  tidak diisi — ini yang membuat skill `/get-token-oc` bisa "re-auth" tanpa tanya password lagi.

**Jira (3 tool)** — semua lewat REST API `/rest/api/2/*`, auth Basic (username/password):
- `jira_search_issues` — JQL search, balikin ringkasan (key, status, assignee, priority)
- `jira_get_issue` — detail satu issue
- `jira_progress_summary` — hitung jumlah issue per status dari hasil JQL

**Bitbucket (2 tool)** — REST API 1.0 Server/DC, auth Basic:
- `bitbucket_list_pull_requests` — list PR satu repo, filter state
- `bitbucket_get_pull_request` — detail satu PR by ID

**Bamboo (2 tool)** — REST API, auth Basic:
- `bamboo_get_latest_build` — status build terakhir satu plan key
- `bamboo_get_deployment_status` — status deployment tiap environment; punya fast-path lewat
  `planKey` (endpoint `forPlan`) karena instance ini punya 3000+ plan — scan penuh terlalu lambat

**PR Monitoring (1 tool)** — gabungan Bitbucket + Bamboo:
- `pr_monitoring_status` — input nickname (misal "Fuad"), balikin semua PR orang itu lintas repo
  yang dikonfigurasi, dengan stage gabungan: `open → merged → building → deployed`. Murni
  on-demand (tidak ada polling/cron) — setiap dipanggil, query live ke kedua sistem.

**Redis Ops (8 tool)** — lewat `oc exec` ke pod di cluster OpenShift:
- `redis_scan_keys`, `redis_dbsize`, `redis_key_exists`, `redis_get_key`, `redis_key_info` (semua
  read-only, aman)
- `redis_set_key` (tulis/overwrite, opsional TTL)
- `redis_clear_key` (hapus 1 key)
- `redis_clear_all` (FLUSHALL — destruktif, punya safeguard `confirm: false/true` dua langkah)

### 4.2 Pola teknis yang berulang di semua tool

- **Tiap tool call generate token OpenShift baru** (lewat `getOpenShiftToken()` di `index.ts`),
  lalu `oc exec`/`oc get pods` dipanggil sebagai subprocess dengan `--token`/`--server`/
  `--certificate-authority` eksplisit — **tidak pernah menyentuh kubeconfig lokal**. Ini
  membuat tiap panggilan stateless dan tidak saling bentrok kalau dipakai beberapa environment.
- **Resolusi nama pod dinamis**: pod Redis punya suffix random yang berubah tiap restart
  (`redis-nds-13-b86vl`), jadi tool cari pod lewat prefix (`redis-nds-`) tiap kali dipanggil,
  bukan hardcode nama lengkap.
- **Dua CA bundle terpisah** untuk cluster yang sama: OAuth ingress route dan Kubernetes API
  server disign oleh issuer yang berbeda (`ingress-operator` vs `kube-apiserver-lb-signer`),
  butuh dua file `.pem` berbeda di `certs/`.
- **Error handling seragam**: fungsi `safe()` di `index.ts` membungkus semua tool handler supaya
  error jadi tool result biasa (`isError: true`) alih-alih crash koneksi MCP.

## 5. Konfigurasi: siapa boleh ngomong apa

| Layer | File | Fungsi |
|---|---|---|
| Siapa boleh chat 1-on-1 | `WHATSAPP_ALLOWED_USERS` (`.env`) | Daftar nomor WA yang didengar bot |
| Grup mana boleh dipakai | `platforms.whatsapp.group_policy: allowlist` + `WHATSAPP_GROUP_ALLOWED_USERS` | Default semua grup diabaikan, kecuali JID-nya didaftarkan |
| Di grup, kapan bot merespon | `platforms.whatsapp.require_mention: true` | Harus di-tag/reply/command, bukan baca semua chat grup |
| Orang asing DM bot | `platforms.whatsapp.unauthorized_dm_behavior: ignore` | Diam, bukan kirim kode pairing |

Keamanan berlapis ini sengaja dibuat ketat karena bot bisa generate token OpenShift dan FLUSHALL
Redis — kalau allowlist-nya longgar, siapa pun yang chat bot bisa bertindak sebagai akun kerja di
sistem produksi/dev perusahaan.

## 6. Yang TIDAK ada (dan kenapa)

- **Tidak ada database sendiri** — mcp-server tidak punya storage. Semua data (PR, status build,
  isi Redis) selalu di-query live ke sumbernya tiap kali diminta. Sempat dibangun versi dengan
  state file + cron polling 5 menit untuk notifikasi otomatis, tapi **dibongkar kembali** atas
  permintaan eksplisit, karena dianggap terlalu berat (perlu scan ribuan repo) dan user memilih
  model on-demand murni.
- **Tidak ada auto-discovery repo lintas project** — Bitbucket Server tidak punya API "semua PR
  siapa pun lintas semua repo". `pr-monitoring.config.json` karena itu mendaftar repo secara
  manual, bukan otomatis dari project key.
- **Tidak jalan di cloud** — semua sistem backend hanya reachable dari jaringan internal
  perusahaan; menaruh ini di cloud publik juga berarti memindahkan kredensial sensitif bank
  keluar dari jaringan terkontrol, yang butuh approval tim security, bukan keputusan teknis semata.
- **Tidak pakai WhatsApp Business API resmi** — dipakai Baileys (emulasi WhatsApp Web) karena
  gratis dan tidak perlu approval Meta Business, dengan konsekuensi risiko kecil nomor
  di-restrict kalau dipakai sembarangan (spam/broadcast ke orang yang belum pernah chat).

## 7. Lifecycle proses (operasional)

- Gateway berjalan sebagai **service launchd** (`ai.hermes.gateway`, file
  `~/Library/LaunchAgents/ai.hermes.gateway.plist`), dipasang dengan `hermes gateway install`.
  launchd menyalakan gateway otomatis saat login dan menghidupkannya lagi kalau crash. Rantai
  prosesnya: launchd → `ai.hermes.gateway` → gateway Python → WhatsApp bridge (Node) + mcp-server
  (Node).
- Hermes hanya mengizinkan **satu gateway per host**. Kalau service sudah jalan, perintah
  `hermes gateway run` akan menolak dengan pesan "The host gateway already serves profile
  'default' — nothing to start". Itu normal, bukan error.
- Perintah operasional:

  | Keperluan | Perintah |
  |---|---|
  | Cek status | `hermes gateway status` |
  | Restart (setelah ubah `config.yaml`, `SOUL.md`, atau rebuild `mcp-server`) | `hermes -p default gateway restart` |
  | Lihat log | `tail -f ~/.hermes/logs/gateway.log` |
  | Kembali ke mode manual | `hermes gateway uninstall`, lalu `hermes gateway run` |

- Jangan pakai `hermes gateway run` atau `hermes gateway restart` dari terminal yang nanti
  ditutup tanpa service terpasang: gateway ikut mati bersama terminalnya, dan WhatsApp berhenti
  merespons.
- **Model LLM** (`model:` dan `fallback_providers:` di `config.yaml`), semua gratis via
  OpenRouter:

  | Urutan | Model | Latency (benchmark 2 Nov 2026, payload asli ~15.600 token) |
  |---|---|---|
  | Utama | `nvidia/nemotron-3.5-super-vl:free` | 2,0-2,6 detik |
  | Fallback 1 | `cohere/north-mini-code:free` | 3,0-7,3 detik |
  | Fallback 2 | `nvidia/nemotron-3.5-lightning:free` | 111-120 detik (overload saat diuji) |

  Fallback dipakai otomatis kalau model utama kena rate-limit, error 5xx, atau gagal koneksi.
  Model gratis bisa di-deprecate atau overload sewaktu-waktu. Kalau bot mulai lambat, cek
  `latency=` di `~/.hermes/logs/agent.log` dan ganti model dengan `hermes fallback` atau edit
  `config.yaml`.
- **Groq tidak dipakai.** Free tier Groq membatasi `openai/gpt-oss-120b` di 8.000 token per
  menit, padahal satu request AntTech (21 tool schema + SOUL.md) sudah ~14.700-16.000 token.
  Groq baru masuk akal di paid tier.
- `mcp-server` di-build dulu (`npm run build`) menghasilkan `dist/index.js`, lalu didaftarkan
  sebagai child process di `mcp_servers.anttech-azzeng` dalam `config.yaml` dengan path absolut.
- Kalau kode `mcp-server` diubah, perlu `npm run build` ulang + restart gateway Hermes — tool baru
  tidak otomatis ter-reload di sesi yang sedang berjalan.
- Session WhatsApp (hasil pairing QR) disimpan di `~/.hermes/whatsapp/session/` — bertahan lintas
  restart gateway, tapi perlu ikut dipindah manual kalau migrasi ke laptop lain (lihat
  `migrate.md`).
