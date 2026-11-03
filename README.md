# AntTech WhatsApp DevOps Assistant

Chatbot WhatsApp berbasis [Hermes Agent](https://github.com/NousResearch/hermes-agent) yang
dilengkapi tool kustom (via MCP) untuk:

- Generate token OpenShift (OAuth challenge, in-house cluster)
- Monitoring progress Jira
- Monitoring pull request Bitbucket
- Monitoring build & deployment Bamboo

## Arsitektur

```
WhatsApp  <--Baileys bridge-->  Hermes Agent (gateway + LLM)  <--MCP stdio-->  mcp-server/ (tools kustom)
                                                                       |
                                                                       +--> OpenShift OAuth / API
                                                                       +--> Jira REST
                                                                       +--> Bitbucket REST
                                                                       +--> Bamboo REST
```

Hermes Agent menjadi "otak" (menerima pesan WhatsApp, memanggil LLM, memanggil tools) dan
`mcp-server/` adalah MCP tool server kustom yang kita bangun sendiri, menjembatani ke sistem
internal perusahaan (semuanya hanya bisa diakses dari jaringan internal/VPN).

## 1. Install Hermes Agent

```bash
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
source ~/.zshrc
hermes
```

Pilih provider LLM saat wizard pertama kali jalan (OpenRouter, OpenAI, Anthropic, dll).

## 2. Setup MCP tool server kustom

```bash
cd mcp-server
npm install
cp .env.example .env
# isi .env dengan kredensial internal (lihat bagian Konfigurasi di bawah)
npm run build
```

Opsional, test dulu pakai MCP Inspector sebelum disambungkan ke Hermes:

```bash
npm run inspect
```

## 3. Daftarkan MCP server ke Hermes

Edit `~/.hermes/config.yaml` (atau config profil yang dipakai) dan tambahkan:

```yaml
mcp_servers:
  anttech-azzeng:
    command: "node"
    args: ["/absolute/path/to/mcp-server/dist/index.js"]
    enabled: true
    timeout: 60
```

Pastikan `.env` di `mcp-server/` sudah terisi — proses `node dist/index.js` membaca env lewat
`dotenv` saat start.

Setelah ditambahkan, restart Hermes gateway (gateway berjalan sebagai service launchd, lihat
bagian 4):

```bash
hermes -p default gateway restart
```

Cek tool kebaca dengan `hermes mcp list` atau tanya langsung ke bot "tools apa yang kamu punya".

### Skill `/get-token-oc`

Supaya re-authentication OpenShift bisa dipanggil cukup dengan `/get-token-oc` di WhatsApp (tanpa
ketik ulang username/password tiap kali), install skill-nya ke folder skills personal Hermes:

```bash
mkdir -p ~/.hermes/skills/get-token-oc
cp hermes-skills/get-token-oc/SKILL.md ~/.hermes/skills/get-token-oc/SKILL.md
```

Skill ini memanggil tool `openshift_generate_token` tanpa argumen, yang otomatis fallback ke
`OPENSHIFT_USERNAME`/`OPENSHIFT_PASSWORD` yang dikonfigurasi di `mcp-server/.env`.

## 4. Setup WhatsApp bridge

```bash
hermes whatsapp
```

Scan QR code dari nomor yang didedikasikan untuk bot (jangan nomor pribadi — lihat catatan
keamanan di bawah). Lalu isi `~/.hermes/.env`:

```env
WHATSAPP_ENABLED=true
WHATSAPP_MODE=bot
WHATSAPP_ALLOWED_USERS=62812xxxxxxx   # nomor WA yang boleh akses bot, pisah koma
```

Pasang gateway sebagai service launchd (auto-start saat login, hidup lagi otomatis kalau crash):

```bash
hermes gateway install
hermes gateway status    # harus: "Gateway is supervised by launchd"
```

Setelah service terpasang, jangan jalankan `hermes gateway run` lagi. Hermes hanya mengizinkan
satu gateway per host, jadi perintah itu akan menjawab "The host gateway already serves profile
'default' — nothing to start". Itu normal.

| Keperluan | Perintah |
|---|---|
| Cek status | `hermes gateway status` |
| Restart (setelah ubah config, SOUL.md, atau rebuild mcp-server) | `hermes -p default gateway restart` |
| Lihat log | `tail -f ~/.hermes/logs/gateway.log` |
| Lepas service, kembali ke mode manual | `hermes gateway uninstall`, lalu `hermes gateway run` |

## Konfigurasi tools kustom (`mcp-server/.env`)

| Variable | Keterangan |
|---|---|
| `OPENSHIFT_OAUTH_URL` | Route OAuth server cluster, biasanya `https://oauth-openshift.apps.<cluster>` |
| `OPENSHIFT_API_URL` | Route API server cluster |
| `OPENSHIFT_CA_BUNDLE_PATH` | Path ke CA internal, kalau cluster pakai cert self-signed (lebih aman daripada mematikan verifikasi TLS) |
| `JIRA_BASE_URL`, `JIRA_TOKEN` | Base URL Jira + Personal Access Token |
| `BITBUCKET_BASE_URL`, `BITBUCKET_TOKEN` | Base URL Bitbucket Server/DC + PAT |
| `BAMBOO_BASE_URL`, `BAMBOO_TOKEN` | Base URL Bamboo + PAT |

Semua service bersifat opsional secara independen — kalau `*_BASE_URL` tidak diisi, tool-nya akan
otomatis menolak dengan pesan error yang jelas saat dipanggil, bukan membuat server kustom crash.

### Autentikasi Jira/Bitbucket/Bamboo

Default-nya pakai **Bearer token (Personal Access Token)** — ini cara paling aman karena token
bisa di-scope dan di-revoke tanpa mengganti password akun. Kalau instance Anda tidak mendukung
PAT, set `*_AUTH_MODE=basic` dan isi `*_USERNAME` / `*_PASSWORD`.

### OpenShift token generation — sudah terverifikasi

Tool `openshift_generate_token` meniru `oc login -u <user> -p <password>` lewat endpoint
`/oauth/authorize?response_type=token&client_id=openshift-challenging-client`. Sudah dites
end-to-end terhadap cluster `ocp-new-dev.bri.co.id`: token yang dihasilkan berhasil dipakai untuk
memanggil API server (`GET /apis/user.openshift.io/v1/users/~`) dan mengembalikan identitas user
yang benar. Cluster ini pakai HTPasswd/identity provider yang mendukung password challenge, jadi
flow ini cocok.

**Soal TLS**: cluster ini pakai sertifikat self-signed dari ingress operator-nya sendiri (bukan
CA publik). Daripada mematikan verifikasi TLS (`OPENSHIFT_TLS_VERIFY=false`, tidak aman — rentan
MITM), kita simpan rantai sertifikatnya di `mcp-server/certs/ocp-new-dev-ingress-ca.pem` dan
percayakan secara spesifik lewat `OPENSHIFT_CA_BUNDLE_PATH`. File ini **ikut masuk `.gitignore`**
(folder `certs/`) karena isinya spesifik ke environment internal perusahaan dan tidak perlu
disebar lewat git. Kalau sertifikat ingress di-rotate, regenerate dengan:

```bash
openssl s_client -connect oauth-openshift.apps.ocp-new-dev.bri.co.id:443 \
  -servername oauth-openshift.apps.ocp-new-dev.bri.co.id -showcerts </dev/null 2>/dev/null \
  | awk '/BEGIN CERTIFICATE/,/END CERTIFICATE/' > mcp-server/certs/ocp-new-dev-ingress-ca.pem
```

Default credentials (`OPENSHIFT_USERNAME`/`OPENSHIFT_PASSWORD`) di `.env` dipakai otomatis kalau
tool dipanggil tanpa argumen — ini yang membuat `/get-token-oc` bisa "re-authenticate" tanpa minta
password tiap kali.

**Risiko keamanan**: token OpenShift adalah bearer credential penuh — siapa pun yang memegangnya
bisa bertindak sebagai user tersebut di cluster sampai token expired. Tool ini saat ini
mengembalikan token mentah ke chat WhatsApp. Pertimbangkan:
- Membatasi `WHATSAPP_ALLOWED_USERS` seketat mungkin.
- Memperpendek `OPENSHIFT_TOKEN_TTL_SECONDS`.
- Mengaktifkan `send_read_receipts`/retensi log WhatsApp seminimal mungkin, dan menghapus riwayat
  chat yang berisi token setelah dipakai.

## Catatan operasional

- **Bot hanya jalan saat laptop kamu di kantor** (perlu akses jaringan internal/VPN perusahaan ke
  Jira/Bitbucket/Bamboo/OpenShift). Ini bukan service 24/7 — kalau laptop mati atau keluar
  jaringan kantor, gateway Hermes (dan WhatsApp bot-nya) ikut berhenti merespons.
- **Password OpenShift kamu sempat dikirim via chat** saat setup awal. Sudah disimpan di
  `mcp-server/.env` (permission `600`, tidak masuk git). Pertimbangkan ganti password itu setelah
  yakin tidak ada salinan tersebar di riwayat chat/log lain.
- Token yang di-generate `/get-token-oc` saat ini dikirim penuh ke chat WhatsApp kalau user minta
  dilihat. Siapa pun yang bisa baca chat itu (termasuk WhatsApp Web/backup) bisa bertindak sebagai
  akun `<username-kamu>` di cluster sampai token expired (default 24 jam dari respons cluster). Batasi
  `WHATSAPP_ALLOWED_USERS` di Hermes seketat mungkin.

## Status verifikasi (semua 8 tools sudah dites end-to-end dengan data nyata)

| Tool | Status | Catatan |
|---|---|---|
| `openshift_generate_token` | ✅ Terverifikasi | Token asli berhasil dipakai memanggil API server |
| `jira_search_issues` / `jira_get_issue` / `jira_progress_summary` | ✅ Terverifikasi | Basic auth, project NDSI |
| `bitbucket_list_pull_requests` / `bitbucket_get_pull_request` | ✅ Terverifikasi | Basic auth, project NDS |
| `bamboo_get_latest_build` | ✅ Terverifikasi | Basic auth |
| `bamboo_get_deployment_status` | ✅ Terverifikasi | Punya fast-path lewat `planKey` — scan penuh `/deploy/project/all` lambat di instance ini (3000+ plan) |

Jira/Bitbucket/Bamboo di `.env` memakai `*_AUTH_MODE=basic` (username/password), bukan PAT —
sesuaikan ke `bearer` + token kapan saja kalau nanti kredensial PAT tersedia; lebih aman karena
bisa di-scope dan di-revoke tanpa ganti password akun.

## PR Monitoring (Bitbucket + Bamboo, per-orang, on-demand)

Fitur ini melacak PR siapa punya siapa (lintas repo yang dikonfigurasi) dan status gabungan
Bitbucket+Bamboo-nya (`open` → `merged` → `building` → `deployed`). **Murni on-demand** — tidak
ada polling/cron/background job. Setiap kali user tanya "monitoring pull request [nama]" di
WhatsApp, baru saat itu sistem query live ke Bitbucket (dan Bamboo kalau PR-nya sudah merged).

### 1. Isi mapping orang & repo

Edit `mcp-server/pr-monitoring.config.json` (sudah ada template dengan placeholder `GANTI_...`):

```json
{
  "people": [
    { "nickname": "Fuad", "bitbucketName": "Nama Persis Di Bitbucket", "whatsapp": "+6281234567890" }
  ],
  "repos": [
    { "projectKey": "NDS", "repoSlug": "cron-scheduler-v1", "bambooPlanKey": "MAU-MA", "bambooDeploymentProjectName": "Deployment for Makna API UAT" }
  ]
}
```

- `bitbucketName` harus **persis sama** dengan `displayName` yang muncul di Bitbucket (pakai tool
  `bitbucket_list_pull_requests` dulu kalau ragu).
- `repos` didaftar manual satu-satu — Bitbucket tidak punya endpoint "semua PR lintas repo tanpa
  tahu nama repo-nya", jadi tiap repo yang mau dipantau harus eksplisit di sini.
- `bambooPlanKey` / `bambooDeploymentProjectName` opsional per repo — tanpa itu, status PR yang
  sudah merged cuma berhenti di `merged` (tidak coba cek build/deploy).
- File ini **gitignored** (isinya nomor telepon orang) — jangan commit.
- `whatsapp` di sini **tidak dipakai untuk mengirim apa pun** saat ini (tidak ada fitur notifikasi
  otomatis) — field ini disiapkan untuk kalau nanti fitur push notification dihidupkan lagi.

### 2. Install skill

```bash
mkdir -p ~/.hermes/skills/pr-monitoring
cp hermes-skills/pr-monitoring/SKILL.md ~/.hermes/skills/pr-monitoring/SKILL.md
```

Setelah ini, "monitoring pull request [nama]" di WhatsApp akan query Bitbucket+Bamboo secara
langsung dan balas list PR + status terkini orang itu — tidak ada delay/jadwal, langsung saat
diminta.

## Pengembangan lanjutan yang disarankan

- Tambahkan tool `bitbucket_list_pull_requests` filter by author/reviewer sesuai kebutuhan tim.
- Tambahkan cron job Hermes (`cronjob_manage`) untuk kirim ringkasan progress Jira/Bamboo setiap
  pagi otomatis ke grup WhatsApp tim.
- Pertimbangkan migrasi dari basic auth (password) ke Personal Access Token untuk
  Jira/Bitbucket/Bamboo begitu tersedia — mengurangi exposure password di `.env`.
