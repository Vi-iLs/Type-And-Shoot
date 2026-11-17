# TYPE-AND-SHOOT — Dashboard + Google Sheets + Cloudflare Worker

Repository ini memuat satu paket sinkronisasi untuk **tepat tujuh pasaran**:

- CAM
- SDY
- CHN
- JPN
- SGP
- TWN
- HKP

Tidak ada penambahan pasaran lain. Dashboard tetap menggunakan kolom tujuh kategori tersebut.

## Alur data

1. Cloudflare Worker berjalan melalui Cron Trigger setiap 5 menit.
2. Worker memeriksa halaman hasil Indotogel untuk pasaran yang sudah memasuki waktu pengecekan hari itu.
3. Indotogel adalah sumber utama. Widget LIVE SGP hanya dicoba untuk kategori/tanggal yang belum memiliki hasil valid di Indotogel.
4. Hasil yang lolos pemeriksaan tanggal, periode, kategori, URL sumber, dan format digit dikirim ke Google Apps Script.
5. Apps Script menulis hasil ke tab `DATABASE` dan mencatat perubahan sumber/nilai di `SOURCE_AUDIT`.
6. Bila widget dipakai lebih dulu, Worker tetap mengecek Indotogel pada siklus berikutnya. Hasil Indotogel dapat menggantikan hasil cadangan. Sebaliknya, widget tidak boleh menimpa nilai yang sudah dikonfirmasi Indotogel.
7. Dashboard membaca tab `DATABASE` dan memuat ulang data setiap 60 detik selama tab dashboard terbuka.

**Catatan:** pengambilan otomatis berarti Worker mencoba ulang setiap lima menit setelah waktu pengecekan awal tiap pasaran. Waktu publikasi tetap bergantung pada situs sumber; sistem tidak membuat angka ketika sumber belum menerbitkannya.

## Struktur paket

- `worker.js` — Cloudflare Worker: API dashboard, pembacaan sumber, fallback, dan penulisan ke Apps Script.
- `apps-script/Code.gs` — Google Apps Script untuk membaca/menulis Google Sheets.
- `dashboard.html` — dashboard data dan kalkulator.
- `wrangler.toml` — konfigurasi Worker dan Cron Trigger.
- `index.html`, `assets/`, `dashboard2.html` — file aplikasi lain yang sudah ada di repository; tidak dihapus.

## 1. Konfigurasi Google Apps Script

1. Buka project Apps Script yang terhubung ke spreadsheet **DATABASE TYPE AND SHOOT**.
2. Ganti isi file script dengan `apps-script/Code.gs` dari repository.
3. Buka **Project Settings → Script Properties**, lalu isi:
   - `TYPE_SHOOT_SPREADSHEET_ID` = ID spreadsheet DATABASE TYPE AND SHOOT.
4. Jalankan fungsi `generateApiSecret()` satu kali. Salin nilai `API_SECRET` dari Execution log. Jangan jalankan ulang setelah Worker dikonfigurasi kecuali memang ingin mengganti token.
5. Jalankan `setupDatabase()` satu kali. Fungsi ini menyiapkan header tujuh pasaran dan membuat backup sebelum migrasi header yang dikenali; data lama tidak dihapus.
6. Jalankan `installDailyCleanupTrigger()` satu kali bila ingin pembersihan arsip lebih dari 366 hari.
7. **Deploy → Manage deployments → Edit → New version** untuk deployment Web App yang digunakan Worker. Jalankan sebagai akun pemilik spreadsheet dan izinkan akses sesuai kebijakan project (endpoint tetap dilindungi token rahasia).

`TYPE_SHOOT_API_SECRET` disimpan oleh fungsi `generateApiSecret()` di Script Properties. Jangan menaruh token ini di file publik.

## 2. Konfigurasi Cloudflare Worker

1. Buka Worker bernama `type-shoot-sheet-test` atau sesuaikan nama pada `wrangler.toml`.
2. Ganti isi Worker dengan `worker.js` dari repository.
3. Pasang dua **Secrets**:
   - `APPS_SCRIPT_TOKEN` = nilai `API_SECRET` dari Apps Script.
   - `DASHBOARD_PIN` = PIN yang digunakan untuk membuka pengaturan data di dashboard.
4. Pastikan `APPS_SCRIPT_URL` di bagian atas `worker.js` sama dengan URL deployment Web App Apps Script.
5. Tambahkan Cron Trigger `*/5 * * * *`. Bila menggunakan Wrangler, konfigurasi ini sudah ada di `wrangler.toml`. Bila menyalin kode langsung dari dashboard Cloudflare, tambahkan trigger yang sama melalui **Settings → Triggers → Cron Triggers**.
6. Bila dashboard dihosting pada origin selain `https://vi-ils.github.io`, tambahkan origin dashboard tersebut ke `ALLOWED_ORIGINS` di `worker.js` (hanya origin, tanpa path), lalu deploy ulang.

## 3. Dashboard

- File dashboard adalah `dashboard.html` di root repository.
- Endpoint Worker dashboard sudah diarahkan ke `https://type-shoot-sheet-test.vails.workers.dev`.
- Dashboard menampilkan tujuh pasaran dari data di Google Sheets.
- Data riwayat dimuat saat halaman dibuka dan diperbarui otomatis setiap 60 detik.
- Tombol **UJI 7 CHANNEL** hanya membaca sumber.
- Tombol **AMBIL & SIMPAN 7 CHANNEL** membaca lalu menyimpan hasil valid ke Google Sheets saat diperlukan untuk sinkronisasi manual.
- Input manual tetap tersedia di panel pengaturan.

## 4. Verifikasi setelah deploy

1. Buka dashboard dan masuk ke Pengaturan Data dengan PIN.
2. Gunakan **UJI 7 CHANNEL** untuk melihat status pembacaan tujuh pasaran tanpa menulis.
3. Gunakan **AMBIL & SIMPAN 7 CHANNEL** untuk menguji alur baca → simpan secara manual.
4. Periksa tab `DATABASE`: satu tanggal memiliki kolom CAM, SDY, CHN, JPN, SGP, TWN, HKP.
5. Periksa tab `SOURCE_AUDIT` untuk sumber, nilai sebelumnya, nilai baru, dan status perubahan.
6. Buka **Cloudflare → Worker → Logs** untuk memeriksa eksekusi terjadwal. Pastikan Cron Trigger aktif.

## Kebijakan sumber dan penyimpanan

- Indotogel selalu diprioritaskan.
- Widget hanya menjadi cadangan saat kategori/tanggal yang sama belum tersedia di Indotogel.
- Data hasil disimpan sebagai teks empat digit agar angka nol di depan tetap aman.
- Nilai lama tidak dihapus dari audit ketika nilai berubah.
- Sumber cadangan tidak boleh menimpa hasil utama yang telah dikonfirmasi.
- Worker tidak mengarang atau menebak nilai jika format sumber tidak lolos validasi.
