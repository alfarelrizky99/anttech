# Migrasi AntTech ke Laptop Baru (Standby di Kantor)

Checklist lengkap untuk pindahkan chatbot WhatsApp AntTech (Hermes Agent + MCP server kustom)
dari laptop ini ke laptop baru yang akan standby di kantor.

## 0. Kenapa ini penting dibaca dulu

- Project `Ant Tech` **bukan git repo** — tidak ada remote untuk `git clone`. Pindahkan foldernya
  secara manual (AirDrop, external drive, cloud storage pribadi — **jangan** cloud publik/email,
  karena ada kredensial sensitif bank di dalamnya).
- Semua tool (OpenShift, Jira, Bitbucket, Bamboo, Redis) hanya bisa diakses dari **jaringan
  internal/VPN kantor**. Laptop baru harus terhubung ke jaringan itu agar bot berfungsi.
- `~/.hermes/` menyimpan session WhatsApp (biar tidak perlu scan QR ulang), API key, SOUL.md,
  dan skill kustom — ini juga harus dipindahkan, bukan di-setup dari nol.

## 1. Install software dasar di laptop baru

```bash
# Hermes Agent
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
source ~/.zshrc

# Node.js (versi yang dipakai saat ini: v23.9.0 — LTS terbaru juga aman)
brew install node

# OpenShift CLI + kubectl (dipakai tool redis-ops untuk `oc exec`)
brew install openshift-cli kubectl
```

Verifikasi:
```bash
hermes --version
node --version      # v23.9.0 di laptop sumber
oc version --client # Client Version: 4.14.1 di laptop sumber
kubectl version --client # Client Version: v1.34.1 di laptop sumber
```

Pastikan default shell adalah **zsh** (`echo $0` harus `-zsh` atau `/bin/zsh`), bukan bash — kalau
bukan, lihat Troubleshooting di bagian paling bawah.

## 2. Pindahkan folder project `Ant Tech`

Copy seluruh folder (termasuk `mcp-server/.env`, `mcp-server/certs/`, dan config JSON — semuanya
ikut karena bukan git repo, tidak ada `.gitignore` yang menyaring saat copy manual) ke laptop
baru, idealnya ke path yang **sama persis**:

```
~/Desktop/Data/Code/experimental/Ant Tech
```

File-file berisi kredensial/konfigurasi sensitif yang WAJIB ikut (jangan sampai ketinggalan,
tidak ada di git jadi tidak bisa di-generate ulang kecuali ketik manual lagi):
- `mcp-server/.env` — semua kredensial (OpenShift, Jira, Bitbucket, Bamboo)
- `mcp-server/certs/ocp-new-dev-ingress-ca.pem` — CA untuk OAuth ingress
- `mcp-server/certs/ocp-new-dev-apiserver-ca.pem` — CA untuk Kubernetes API server (beda issuer!)
- `mcp-server/redis-ops.config.json` — mapping Redis per environment (dev/uat/staging)
- `mcp-server/pr-monitoring.config.json` — mapping orang & repo untuk PR monitoring

Setelah folder dipindah, build ulang di laptop baru:
```bash
cd "~/Desktop/Data/Code/experimental/Ant Tech/mcp-server"
npm install
npm run build
```

**Kalau lokasi folder di laptop baru BERBEDA** dari path di atas, satu baris di
`~/.hermes/config.yaml` wajib diupdate manual (lihat langkah 4).

## 3. Pindahkan state Hermes (`~/.hermes/`)

Jangan copy seluruh `~/.hermes/` (ukurannya ~5.5GB, isinya banyak cache/log/db yang tidak perlu).
Install Hermes fresh di laptop baru (langkah 1), lalu **transplant** file/folder spesifik ini dari
laptop lama:

| Path | Isi | Kenapa penting |
|---|---|---|
| `~/.hermes/whatsapp/session/` | Session Baileys (~10MB) | Tanpa ini, harus scan QR ulang dan nomor WA jadi device baru |
| `~/.hermes/.env` | API key OpenRouter + semua `WHATSAPP_*` | Model LLM dan akses WhatsApp |
| `~/.hermes/config.yaml` | Semua setting (model, platform, mcp_servers, display, onboarding) | Konfigurasi inti |
| `~/.hermes/SOUL.md` | Persona AntTech | Identitas & gaya bicara bot |
| `~/.hermes/skills/get-token-oc/` | Skill generate token OpenShift | |
| `~/.hermes/skills/pr-monitoring/` | Skill monitoring PR Bitbucket+Bamboo | |
| `~/.hermes/skills/redis-ops/` | Skill operasi Redis (8 tools) | |

Cara paling aman: zip folder-folder itu di laptop lama, pindahkan filenya (AirDrop/external
drive), lalu extract ke `~/.hermes/` yang sudah di-generate oleh installer di laptop baru (akan
menimpa file dengan nama sama — itu yang diinginkan).

```bash
# Di laptop LAMA — buat satu archive isinya semua yang perlu dipindah
cd ~/.hermes
zip -r ~/Desktop/anttech-hermes-state.zip \
  whatsapp/session .env config.yaml SOUL.md \
  skills/get-token-oc skills/pr-monitoring skills/redis-ops
```

```bash
# Di laptop BARU — setelah install Hermes (langkah 1), extract menimpa state default
cd ~/.hermes
unzip -o ~/Desktop/anttech-hermes-state.zip
```

## 4. Sesuaikan path absolut di config.yaml

`~/.hermes/config.yaml` punya satu baris berisi absolute path ke MCP server:

```yaml
mcp_servers:
  anttech-azzeng:
    command: "node"
    args: ["/Users/farel/Desktop/Data/Code/experimental/Ant Tech/mcp-server/dist/index.js"]
```

- Kalau **username macOS** di laptop baru berbeda (bukan `farel`), atau
- Kalau **lokasi folder project** di laptop baru berbeda dari `~/Desktop/Data/Code/experimental/Ant Tech`,

maka baris `args` ini **wajib diedit manual** sesuai path yang benar di laptop baru. Tanpa ini
diperbaiki, Hermes tidak akan bisa menjalankan MCP server (semua 17 tool AntTech tidak akan
muncul).

## 5. Jalankan dan verifikasi

Pasang gateway langsung sebagai service launchd (lihat juga langkah 6):

```bash
hermes gateway install
hermes gateway status    # harus: "Gateway is supervised by launchd"
tail -f ~/.hermes/logs/gateway.log   # tunggu sampai muncul "✓ whatsapp connected"
```

Kalau kamu cuma mau tes sebentar tanpa service, `hermes gateway run` juga bisa, tapi gateway
mati begitu terminalnya ditutup. Jangan jalankan keduanya sekaligus: kalau service sudah aktif,
`hermes gateway run` akan menjawab "The host gateway already serves profile 'default' — nothing
to start". Itu normal, bukan error.

Checklist verifikasi:
- [ ] WhatsApp bridge **connected tanpa minta scan QR ulang** (kalau minta QR, berarti
      `whatsapp/session/` tidak ikut terpindah dengan benar)
- [ ] `hermes mcp test anttech-azzeng` → harus muncul **17 tools** (openshift, jira x3,
      bitbucket x2, bamboo x2, pr_monitoring, redis x8)
- [ ] Kirim pesan test ke WhatsApp personal → bot balas dengan persona AntTech (bukan default
      Hermes), tanpa breadcrumb "⚙️ tool_describe" (sudah di-set `tool_progress: off` khusus
      WhatsApp)
- [ ] Kirim `hidup` → harus balas `hidup jekiwi`
- [ ] Kirim pesan di grup WhatsApp yang sudah di-allowlist (tag/mention bot dulu, karena
      `require_mention: true`) → harus direspon
- [ ] Pastikan laptop baru terhubung ke jaringan internal/VPN kantor, baru test tool yang hit
      sistem internal (`/get-token-oc`, monitoring Jira/Bitbucket/Bamboo, Redis ops)

## 6. Jadikan service permanen (standby 24/7 di kantor)

`hermes gateway install` di langkah 5 memasang service launchd `ai.hermes.gateway`
(`~/Library/LaunchAgents/ai.hermes.gateway.plist`). launchd menyalakan gateway otomatis saat
login dan menghidupkannya lagi kalau crash.

| Keperluan | Perintah |
|---|---|
| Cek status | `hermes gateway status` |
| Restart (setelah ubah `config.yaml`, `SOUL.md`, atau rebuild `mcp-server`) | `hermes -p default gateway restart` |
| Lihat log | `tail -f ~/.hermes/logs/gateway.log` |
| Lepas service, kembali ke mode manual | `hermes gateway uninstall` |

Saat bersihkan laptop lama (langkah 7), jalankan juga `hermes gateway uninstall` di sana. Kalau
tidak, dua laptop akan login ke sesi WhatsApp yang sama dan saling rebutan koneksi.

Kalau laptop ini didedikasikan khusus
untuk bot (tidak dipakai login manual tiap hari), pertimbangkan juga:
- Nonaktifkan sleep otomatis (System Settings → Energy → jangan sleep saat charging)
- Set auto-login supaya service jalan lagi otomatis kalau laptop reboot (misal mati listrik)

## 7. Setelah migrasi sukses — bersihkan laptop lama

- [ ] Jalankan `hermes gateway uninstall` di laptop lama supaya service launchd-nya tidak ikut
      menyala dan berebut sesi WhatsApp dengan laptop baru.
- [ ] Hapus `mcp-server/.env` (berisi password akun `<username-kamu>` dan kredensial lain) dari laptop
      lama, **terutama** kalau laptop lama akan diserahkan ke orang lain/dijual/dipakai bersama.
- [ ] Hapus `~/.hermes/.env` (API key OpenRouter) dari laptop lama.
- [ ] Hapus archive `anttech-hermes-state.zip` dari Desktop setelah dipastikan extract di laptop
      baru berhasil — jangan biarkan tersisa di cloud sync folder (iCloud/Dropbox) kalau foldernya
      ikut ter-sync otomatis.
- [ ] Pertimbangkan ganti password OpenShift (`<username-kamu>`) kalau sempat ada risiko kredensial itu
      terekspos di luar laptop (misal pernah ditulis di chat/dokumen lain).

## 8. Skenario khusus: Windows dengan CLI di WSL, Hermes di luar WSL

Kalau laptop barunya **Windows**, dan kamu berencana kerja/ngetik command lewat **zsh di WSL**
tapi **Hermes-nya native Windows** (bukan di dalam WSL) — ini kombinasi yang valid, tapi butuh
penyesuaian signifikan dari semua langkah di atas. Baca ini SEBELUM mulai langkah 1-7.

### 8.1 Kenapa project harus di filesystem Windows, bukan di dalam WSL

Hermes native Windows berjalan sebagai proses Windows biasa. Proses Windows **tidak bisa**
mengakses filesystem internal WSL (`\\wsl$\...` atau path `/home/...` di dalam WSL) secara
reliable untuk spawn child process. Karena `mcp_servers.anttech-azzeng` di `config.yaml`
men-spawn `node dist/index.js` sebagai child process dari proses Hermes itu sendiri, maka:

- **Folder project `Ant Tech` harus ada di filesystem Windows** (`C:\Users\<user>\...`), BUKAN
  di `~` milik distro WSL.
- Kamu tetap bisa edit/baca folder itu dari zsh WSL lewat mount otomatis WSL, lokasinya jadi
  `/mnt/c/Users/<user>/...` — ini filesystem Windows yang sama, cuma diakses dari sisi Linux.
- **Node.js juga harus terinstall di sisi Windows** (bukan hanya di dalam WSL), karena proses
  Hermes Windows yang akan menjalankan `node`, bukan proses WSL.

### 8.2 Penyesuaian per langkah

**Langkah 1 (Install software)** — install dua kali kalau mau tetap pakai zsh WSL untuk kerja
sehari-hari, tapi runtime Hermes tetap di Windows:
```powershell
# Di PowerShell (Windows native) — Hermes native Windows
iex (irm https://hermes-agent.nousresearch.com/install.ps1)
```
Lalu install Node.js **versi Windows** (bukan cuma di WSL) — download dari nodejs.org atau
`winget install OpenJS.NodeJS`. Begitu juga `oc`/`kubectl` versi Windows kalau redis-ops dipanggil
dari sisi Hermes (yang memang Windows).

Kamu tetap bisa punya Node/oc/kubectl **juga** di dalam WSL untuk kerja/debug manual lewat zsh —
itu instalasi terpisah dan tidak saling menggantikan.

**Langkah 2 (Pindahkan folder project)** — taruh di filesystem Windows:
```
C:\Users\<username>\Desktop\Data\Code\experimental\Ant Tech
```
Dari zsh WSL, folder ini diakses sebagai:
```
/mnt/c/Users/<username>/Desktop/Data/Code/experimental/Ant Tech
```
Build (`npm install && npm run build`) bisa dijalankan dari WSL (lewat path `/mnt/c/...`) ATAU
dari PowerShell/CMD langsung di `C:\Users\...` — hasilnya sama karena ini filesystem yang sama,
cuma dilihat dari dua sisi. **Yang penting:** `node_modules` yang di-generate oleh `npm install`
sebaiknya dibuild dari sisi yang sama dengan yang akan menjalankannya nanti (Hermes Windows) —
jalankan `npm install && npm run build` dari **PowerShell/CMD**, bukan dari WSL, untuk menghindari
masalah dependency native yang di-compile beda platform.

**Langkah 3 (Pindahkan state Hermes)** — lokasi `~/.hermes/` di Windows (native, bukan WSL) ada
di:
```
C:\Users\<username>\.hermes\
```
Cara paling pasti untuk tahu lokasi exact-nya di laptop baru:
```powershell
hermes config path
hermes config env-path
```
Proses zip/unzip-nya sama seperti langkah 3 di atas, tapi dijalankan dari PowerShell/CMD
(terminal Windows native), bukan dari zsh WSL — supaya permission dan path separator-nya benar.

**Langkah 4 (Sesuaikan path absolut)** — baris `args` di `config.yaml` **wajib** pakai format
path Windows, bukan format Unix:
```yaml
mcp_servers:
  anttech-azzeng:
    command: "node"
    args: ["C:\\Users\\<username>\\Desktop\\Data\\Code\\experimental\\Ant Tech\\mcp-server\\dist\\index.js"]
```
Perhatikan backslash ganda (`\\`) karena ini string YAML — satu backslash biasa akan salah
di-parse sebagai escape character.

**Langkah 6 (Service permanen)** — `hermes gateway install` di Windows mendaftarkan sebagai
Windows Scheduled Task / service, bukan launchd (yang itu khusus macOS). Perilakunya serupa
(auto-start), tapi mekanisme di baliknya beda OS.

### 8.3 Hal yang TIDAK berubah

- Semua isi `mcp-server/.env`, `certs/*.pem`, `redis-ops.config.json`,
  `pr-monitoring.config.json` tetap sama persis — ini cuma data, tidak peduli OS.
- `oc exec` tetap jalan dengan cara yang sama (`--token`/`--server`/`--certificate-authority`
  eksplisit) — asal binary `oc` versi Windows ada di PATH Windows (karena ini dipanggil oleh
  proses Hermes Windows, bukan oleh zsh WSL).
- Laptop masih harus terhubung ke jaringan internal/VPN kantor — ini soal network, tidak
  terpengaruh WSL vs native.

### 8.4 Troubleshooting khusus kombinasi ini

**MCP server `anttech-azzeng` gagal connect, padahal file-nya ada** — cek dulu: apakah path di
`args` pakai format Windows (`C:\\...`) atau format WSL/Unix (`/mnt/c/...` atau `/home/...`)?
Harus format Windows, karena yang men-spawn proses adalah Hermes Windows.

**`npm install` sukses di WSL tapi `node dist/index.js` error "invalid ELF header" atau sejenis
saat dijalankan Hermes Windows** — ini tanda `node_modules` ter-compile untuk Linux (dari WSL)
tapi dijalankan di Windows. Hapus `node_modules`, lalu `npm install` ulang dari PowerShell/CMD.

**Lupa di mana `~/.hermes` Windows berada** — jangan tebak, jalankan `hermes config path` di
PowerShell/CMD (bukan di WSL — WSL punya `~/.hermes` sendiri yang terpisah kalau Hermes juga
ter-install di sana, yang justru harus dihindari untuk setup ini).

## Troubleshooting

**`hermes: command not found`** — biasanya karena terminal yang dipakai masih sesi `bash`, bukan
`zsh`. Jalankan `zsh` dulu untuk pindah shell, atau buka terminal baru (bukan reload yang lama).

**WhatsApp minta scan QR lagi padahal session sudah dipindah** — cek permission folder
`~/.hermes/whatsapp/session/` (`chmod -R 700`), dan pastikan proses extract tidak menimpa dengan
folder kosong (archive gagal/corrupt).

**MCP server `anttech-azzeng` tidak connect / 0 tools** — hampir selalu karena path di langkah 4
belum disesuaikan, atau `npm run build` di langkah 2 belum dijalankan (folder `dist/` belum ada).

**Tool OpenShift/Jira/Bitbucket/Bamboo/Redis error jaringan** — laptop baru belum terhubung ke
VPN/jaringan internal kantor. Ini bukan bug konfigurasi — cek koneksi dulu, baru lapor kalau masih
gagal setelah online di jaringan kantor.
