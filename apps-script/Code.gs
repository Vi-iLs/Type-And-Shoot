
/**
 * TYPE-AND-SHOOT DATABASE API
 * Spreadsheet: DATABASE TYPE AND SHOOT
 * Sheet: DATABASE
 *
 * Format input:
 * CAM 1234
 * CHN-1234
 * JPN:1234
 * TWN 1234
 * HKP 1234
 *
 * Automatic results use Indotogel first and the LIVE SGP widget as a
 * fallback only when the primary channel/date result is unavailable.
 * A different prior value is logged in SOURCE_AUDIT before being updated.
 */

const CONFIG = {
  SPREADSHEET_ID_PROPERTY: 'TYPE_SHOOT_SPREADSHEET_ID',
  SHEET_NAME: 'DATABASE',
  TIME_ZONE: 'Asia/Jakarta',
  HEADERS: ['TANGGAL', 'CAM', 'SDY', 'CHN', 'JPN', 'SGP', 'TWN', 'HKP'],
  API_SECRET_PROPERTY: 'TYPE_SHOOT_API_SECRET',
  DISPLAY_DAYS: 30,
  RETENTION_DAYS: 366,
  SOURCE_AUDIT_SHEET: 'SOURCE_AUDIT'
};

/**
 * Dipanggil ketika Cloudflare Worker mengirim permintaan.
 */
function doPost(e) {
  try {
    const raw = e && e.postData ? e.postData.contents : '';

    if (!raw) {
      throw new Error('Request kosong.');
    }

    const payload = JSON.parse(raw);
    verifyApiSecret_(payload.token);

    if (payload.action === 'save') {
      const result = saveRecord_(payload.input);
      return jsonResponse_(result);
    }

    if (payload.action === 'list') {
      const result = getRecentRecords_();
      return jsonResponse_(result);
    }

    // Dipakai khusus oleh Worker terjadwal setelah mengambil hasil dari web.
    if (payload.action === 'pollState') {
      const result = getAutoPollState_(payload);
      return jsonResponse_(result);
    }

    if (payload.action === 'ingest') {
      const result = ingestAutomaticResult_(payload);
      return jsonResponse_(result);
    }

    throw new Error('Action tidak dikenal.');
  } catch (error) {
    return jsonResponse_({
      ok: false,
      error: error.message || 'Terjadi kesalahan.'
    });
  }
}

/**
 * Menyiapkan format database tanpa menghapus data.
 * Jalankan satu kali dari Apps Script.
 */
function setupDatabase() {
  const spreadsheet = SpreadsheetApp.openById(getSpreadsheetId_());
  spreadsheet.setSpreadsheetTimeZone(CONFIG.TIME_ZONE);

  const sheet = spreadsheet.getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) throw new Error('Tab DATABASE tidak ditemukan.');

  const targetHeaders = CONFIG.HEADERS;
  const lastRow = Math.max(sheet.getLastRow(), 1);
  const lastColumn = Math.max(sheet.getLastColumn(), 1);
  const currentHeaders = sheet
    .getRange(1, 1, 1, lastColumn)
    .getDisplayValues()[0]
    .map(value => String(value).trim().toUpperCase());

  const alreadyMigrated = targetHeaders.every(
    (header, index) => currentHeaders[index] === header
  );

  if (!alreadyMigrated) {
    const nonEmptyHeaders = currentHeaders.filter(Boolean);
    const allowedHeaders = new Set(targetHeaders);
    const hasDateColumn = nonEmptyHeaders.includes('TANGGAL');
    const hasUnknownHeader = nonEmptyHeaders.some(header => !allowedHeaders.has(header));
    const hasDuplicateHeader = nonEmptyHeaders.some(
      (header, index) => nonEmptyHeaders.indexOf(header) !== index
    );

    if (!hasDateColumn || hasUnknownHeader || hasDuplicateHeader) {
      throw new Error(
        'Migrasi dibatalkan karena header DATABASE tidak dikenali. Tidak ada data yang diubah.'
      );
    }

    const oldRows = lastRow > 1
      ? sheet.getRange(2, 1, lastRow - 1, lastColumn).getValues()
      : [];

    // Buat salinan cadangan sebelum mengubah susunan kolom.
    const stamp = Utilities.formatDate(new Date(), CONFIG.TIME_ZONE, 'yyyyMMdd_HHmmss');
    let backupName = 'DATABASE_BACKUP_' + stamp;
    let suffix = 1;
    while (spreadsheet.getSheetByName(backupName)) {
      backupName = 'DATABASE_BACKUP_' + stamp + '_' + suffix++;
    }
    sheet.copyTo(spreadsheet).setName(backupName);

    const oldHeaderIndex = {};
    currentHeaders.forEach((header, index) => {
      if (header) oldHeaderIndex[header] = index;
    });
    const migratedRows = oldRows.map(row => targetHeaders.map(header => {
      const sourceIndex = oldHeaderIndex[header];
      return sourceIndex === undefined ? '' : row[sourceIndex];
    }));

    // Tulis ulang hanya tab DATABASE; salinan cadangan tetap menyimpan data asli.
    sheet.getRange(1, 1, lastRow, Math.max(lastColumn, targetHeaders.length)).clearContent();
    sheet.getRange(1, 1, 1, targetHeaders.length).setValues([targetHeaders]);
    if (migratedRows.length) {
      sheet.getRange(2, 1, migratedRows.length, targetHeaders.length).setValues(migratedRows);
    }

    Logger.log('Migrasi selesai. Data lama dipertahankan; salinan cadangan: ' + backupName);
  }

  sheet.setFrozenRows(1);
  sheet.setColumnWidth(1, 68);
  sheet.setColumnWidths(2, 7, 92);
  sheet.getRange('A:A').setNumberFormat('dd/MM/yyyy');
  sheet.getRange('B:H').setNumberFormat('@');
  sheet.getRange(1, 1, 1, targetHeaders.length).setFontWeight('bold');

  Logger.log('Database siap dengan kolom: ' + targetHeaders.join(', '));
}

/**
 * Membuat token rahasia untuk komunikasi Worker -> Apps Script.
 * Jalankan satu kali. Salin token dari Execution log.
 *
 * Jangan jalankan ulang setelah Worker dikonfigurasi,
 * kecuali Anda memang ingin mengganti token.
 */
function generateApiSecret() {
  const secret =
    Utilities.getUuid().replace(/-/g, '') +
    Utilities.getUuid().replace(/-/g, '');

  PropertiesService
    .getScriptProperties()
    .setProperty(CONFIG.API_SECRET_PROPERTY, secret);

  console.log('API_SECRET=' + secret);
  return 'Token berhasil dibuat. Salin token dari Execution log.';
}

/**
 * Memeriksa token yang dikirim oleh Cloudflare Worker.
 */
function verifyApiSecret_(providedToken) {
  const expectedToken = PropertiesService
    .getScriptProperties()
    .getProperty(CONFIG.API_SECRET_PROPERTY);

  if (!expectedToken) {
    throw new Error('API secret belum dibuat.');
  }

  if (
    typeof providedToken !== 'string' ||
    providedToken.length !== expectedToken.length ||
    providedToken !== expectedToken
  ) {
    throw new Error('Akses ditolak.');
  }
}

/**
 * Menyimpan satu input.
 * Bila tanggal dan kategori sudah ada, nilai lama ditimpa.
 */
function saveRecord_(input) {
  const parsed = parseInput_(input);

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const sheet = getDatabaseSheet_();
    const todayKey = getTodayKey_();
    const values = getDatabaseValues_(sheet);

    const categoryColumn = CONFIG.HEADERS.indexOf(parsed.category) + 1;

    let targetRow = 0;

    // Cari baris dengan tanggal yang sama.
    for (let i = 0; i < values.length; i++) {
      const rowDateKey = dateCellToKey_(values[i][0]);

      if (rowDateKey === todayKey) {
        targetRow = i + 2;
        break;
      }
    }

    let resultAction;

    if (targetRow) {
      // Hanya mengganti kategori yang dimasukkan.
      // Kategori lain pada tanggal yang sama tidak disentuh.
      resultAction = 'updated';
    } else {
      // Membuat baris baru jika tanggal belum tersedia.
      targetRow = sheet.getLastRow() + 1;

      sheet.getRange(targetRow, 1, 1, CONFIG.HEADERS.length).setValues([[
        dateKeyToSheetDate_(todayKey), '', '', '', '', '', '', ''
      ]]);

      resultAction = 'inserted';
    }

    const valueCell = sheet.getRange(targetRow, categoryColumn);
    valueCell.setNumberFormat('@');
    valueCell.setValue(parsed.value);

    // Data terbaru selalu berada di atas.
    sortDatabase_(sheet);

    SpreadsheetApp.flush();

    return {
      ok: true,
      action: resultAction,
      date: todayKey,
      displayDate: formatDisplayDate_(todayKey),
      category: parsed.category,
      value: parsed.value,
      message:
        parsed.category + ' berhasil ' +
        (resultAction === 'updated' ? 'diperbarui.' : 'disimpan.')
    };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Membaca maksimal 30 hari kalender terakhir,
 * termasuk tanggal hari ini.
 */
function getRecentRecords_() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const sheet = getDatabaseSheet_();
    const todayKey = getTodayKey_();
    const oldestKey = addDaysToKey_(todayKey, -(CONFIG.DISPLAY_DAYS - 1));
    const values = getDatabaseValues_(sheet);
    const auditMap = getLatestSourceAuditMap_(oldestKey, todayKey);
    const categories = ['CAM', 'SDY', 'CHN', 'JPN', 'SGP', 'TWN', 'HKP'];

    const records = [];

    values.forEach(row => {
      const dateKey = dateCellToKey_(row[0]);

      if (!dateKey || dateKey < oldestKey || dateKey > todayKey) return;

      const record = {
        date: dateKey,
        displayDate: formatDisplayDate_(dateKey),
        CAM: normalizeSheetValue_(row[1]),
        SDY: normalizeSheetValue_(row[2]),
        CHN: normalizeSheetValue_(row[3]),
        JPN: normalizeSheetValue_(row[4]),
        SGP: normalizeSheetValue_(row[5]),
        TWN: normalizeSheetValue_(row[6]),
        HKP: normalizeSheetValue_(row[7])
      };

      categories.forEach(category => {
        const audit = auditMap[dateKey + '|' + category];
        record[category + '_STATUS'] = audit ? audit.status : '';
        record[category + '_PREVIOUS'] = audit ? audit.previousValue : '';
        record[category + '_SOURCE'] = audit ? audit.sourceName : '';
      });

      records.push(record);
    });

    records.sort((a, b) => b.date.localeCompare(a.date));

    return {
      ok: true,
      timezone: CONFIG.TIME_ZONE,
      days: CONFIG.DISPLAY_DAYS,
      records: records
    };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Menghapus data yang lebih tua dari 366 hari kalender.
 * Hari ini dihitung sebagai hari pertama.
 */
function cleanupOldRecords() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const sheet = getDatabaseSheet_();
    const oldestAllowedKey = addDaysToKey_(
      getTodayKey_(),
      -(CONFIG.RETENTION_DAYS - 1)
    );

    let deletedCount = 0;

    // Hapus dari bawah agar nomor baris tidak bergeser.
    for (let row = sheet.getLastRow(); row >= 2; row--) {
      const dateValue = sheet.getRange(row, 1).getValue();
      const dateKey = dateCellToKey_(dateValue);

      // Baris dengan tanggal kosong/tidak dikenal tidak dihapus otomatis.
      if (dateKey && dateKey < oldestAllowedKey) {
        sheet.deleteRow(row);
        deletedCount++;
      }
    }

    Logger.log('Baris lama dihapus: ' + deletedCount);
    return deletedCount;
  } finally {
    lock.releaseLock();
  }
}

/**
 * Membuat pemicu pembersihan arsip setiap hari.
 * Jalankan satu kali dari Apps Script.
 */
function installDailyCleanupTrigger() {
  const functionName = 'cleanupOldRecords';

  ScriptApp.getProjectTriggers().forEach(trigger => {
    if (trigger.getHandlerFunction() === functionName) {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  ScriptApp.newTrigger(functionName)
    .timeBased()
    .everyDays(1)
    .atHour(3)
    .create();

  Logger.log('Pembersihan arsip harian berhasil dipasang.');
}

/* =========================
   FUNGSI INTERNAL
========================= */

function getSpreadsheetId_() {
  const id = PropertiesService.getScriptProperties().getProperty(CONFIG.SPREADSHEET_ID_PROPERTY);
  if (!id) throw new Error('Script Property TYPE_SHOOT_SPREADSHEET_ID belum diatur.');
  return id.trim();
}

function getDatabaseSheet_() {
  const spreadsheet = SpreadsheetApp.openById(getSpreadsheetId_());
  const sheet = spreadsheet.getSheetByName(CONFIG.SHEET_NAME);

  if (!sheet) {
    throw new Error('Tab DATABASE tidak ditemukan.');
  }

  return sheet;
}

function getDatabaseValues_(sheet) {
  const lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    return [];
  }

  return sheet.getRange(2, 1, lastRow - 1, CONFIG.HEADERS.length).getValues();
}

function parseInput_(input) {
  const text = String(input || '').trim().toUpperCase();

  const match = text.match(
    /^(CAM|SDY|CHN|JPN|SGP|TWN|HKP)\s*[-:=]?\s*(\d{4})$/
  );

  if (!match) {
    throw new Error(
      'Format tidak valid. Gunakan kode kategori diikuti tepat 4 digit.'
    );
  }

  return {
    category: match[1],
    value: match[2]
  };
}

function getTodayKey_() {
  return Utilities.formatDate(
    new Date(),
    CONFIG.TIME_ZONE,
    'yyyy-MM-dd'
  );
}

function dateKeyToSheetDate_(key) {
  const parts = key.split('-').map(Number);

  // 05:00 UTC = 12:00 siang Asia/Jakarta.
  return new Date(Date.UTC(
    parts[0],
    parts[1] - 1,
    parts[2],
    5, 0, 0
  ));
}

function dateCellToKey_(value) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return Utilities.formatDate(
      value,
      CONFIG.TIME_ZONE,
      'yyyy-MM-dd'
    );
  }

  const text = String(value || '').trim();

  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return text;
  }

  const match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);

  if (match) {
    return [
      match[3],
      match[2].padStart(2, '0'),
      match[1].padStart(2, '0')
    ].join('-');
  }

  return '';
}

function addDaysToKey_(key, days) {
  const parts = key.split('-').map(Number);
  const date = new Date(Date.UTC(
    parts[0],
    parts[1] - 1,
    parts[2]
  ));

  date.setUTCDate(date.getUTCDate() + days);

  return date.toISOString().slice(0, 10);
}

function formatDisplayDate_(key) {
  const parts = key.split('-');
  return parts[2] + '/' + parts[1] + '/' + parts[0];
}

function normalizeSheetValue_(value) {
  if (value === '' || value === null || value === undefined) {
    return '';
  }

  return String(value).trim();
}

function sortDatabase_(sheet) {
  const lastRow = sheet.getLastRow();

  if (lastRow > 2) {
    sheet.getRange(2, 1, lastRow - 1, CONFIG.HEADERS.length).sort({
      column: 1,
      ascending: false
    });
  }
}



/**
 * Polling selesai hanya setelah Indotogel mengonfirmasi hasil. Widget adalah
 * fallback sementara; Worker tetap mencoba sumber utama setelah fallback.
 */
function getAutoPollState_(payload) {
  const category = String(payload.category || '').trim().toUpperCase();
  const dateKey = String(payload.date || '').trim();
  const categories = ['CAM', 'SDY', 'CHN', 'JPN', 'SGP', 'TWN', 'HKP'];

  if (!categories.includes(category)) throw new Error('Kategori otomatis tidak valid.');
  if (!isValidDateKey_(dateKey)) throw new Error('Tanggal status otomatis tidak valid.');

  const latest = getLatestSourceAuditEntry_(dateKey, category);
  const done = !!latest && latest.sourceName === 'INDOTOGEL';
  const key = 'AUTO_POLL_DONE_' + category;
  const properties = PropertiesService.getScriptProperties();
  if (done) properties.setProperty(key, dateKey);
  else properties.deleteProperty(key);

  return { ok: true, category: category, date: dateKey, done, completedDate: done ? dateKey : '' };
}

function getLatestSourceAuditEntry_(dateKey, category) {
  const spreadsheet = SpreadsheetApp.openById(getSpreadsheetId_());
  const sheet = spreadsheet.getSheetByName(CONFIG.SOURCE_AUDIT_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return null;

  const lastRow = sheet.getLastRow();
  const startRow = Math.max(2, lastRow - 9999);
  const values = sheet.getRange(startRow, 1, lastRow - startRow + 1, Math.max(11, sheet.getLastColumn())).getValues();
  for (let i = values.length - 1; i >= 0; i--) {
    const row = values[i];
    if (dateCellToKey_(row[1]) !== dateKey) continue;
    if (String(row[2] || '').trim().toUpperCase() !== category) continue;
    return {
      sourceName: String(row[10] || 'INDOTOGEL').trim().toUpperCase(),
      sourceValue: normalizeSheetValue_(row[5]),
      status: String(row[6] || '')
    };
  }
  return null;
}

/**
 * Terima hasil otomatis dari salah satu sumber yang diizinkan.
 * Indotogel adalah sumber utama; widget hanya diterima sebagai fallback.
 * Jika sel kosong, isi. Jika sama, tandai MATCH. Jika berbeda, pakai hasil
 * terpilih dan catat nilai sebelumnya, hasil mentah, serta nama sumber.
 */
function ingestAutomaticResult_(payload) {
  const category = String(payload.category || '').trim().toUpperCase();
  const dateKey = String(payload.date || '').trim();
  const rawDigits = String(payload.resultDigits || payload.value || '').replace(/\D/g, '');
  const period = String(payload.period || '').trim().toUpperCase();
  const sourceUrl = String(payload.sourceUrl || '').trim();
  const sourceName = String(payload.sourceName || '').trim().toUpperCase();

  const marketConfig = {
    CAM: { slug: 'MC', periods: ['MC'] },
    SDY: { slug: 'SD', periods: ['SD'] },
    CHN: { slug: 'CN', periods: ['CN'] },
    JPN: { slug: 'JPN', periods: ['JPN', 'JP'] },
    SGP: { slug: 'sg', periods: ['SG'] },
    TWN: { slug: 'TW', periods: ['TW'] },
    HKP: { slug: 'HK', periods: ['HK'] }
  };
  const market = marketConfig[category];
  if (!market) throw new Error('Kategori otomatis tidak dikenal.');
  if (!isValidDateKey_(dateKey) || dateKey !== getTodayKey_()) {
    throw new Error('Tanggal hasil harus sama dengan tanggal hari ini di Asia/Jakarta.');
  }

  let sourceLabel;
  if (sourceName === 'INDOTOGEL') {
    if (!/^(?:\d{4}|\d{6})$/.test(rawDigits)) {
      throw new Error('Hasil Indotogel harus berisi 4 atau 6 digit.');
    }
    if (!market.periods.includes(period)) throw new Error('Kode periode Indotogel tidak sesuai kategori.');
    const expectedUrl = 'https://indotogel.jp.net/result/' + market.slug;
    if (sourceUrl.replace(/\/$/, '') !== expectedUrl) {
      throw new Error('URL sumber bukan halaman kategori Indotogel yang diizinkan.');
    }
    sourceLabel = 'INDOTOGEL';
  } else if (sourceName === 'WIDGET_BACKUP') {
    if (!/^\d{4}$/.test(rawDigits)) {
      throw new Error('Widget cadangan harus mengembalikan tepat 4 digit.');
    }
    if (period !== 'WIDGET') throw new Error('Kode sumber widget tidak sesuai.');
    if (sourceUrl.replace(/\/$/, '') !== 'https://widgets2.livesgp.day/result1.php') {
      throw new Error('URL sumber widget cadangan tidak diizinkan.');
    }
    sourceLabel = 'WIDGET_BACKUP';
  } else {
    throw new Error('Sumber otomatis tidak diizinkan.');
  }

  // Dashboard menyimpan empat digit terakhir sebagai teks agar nol awal aman.
  const sourceValue = rawDigits.slice(-4);
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const sheet = getDatabaseSheet_();
    const latestAudit = getLatestSourceAuditEntry_(dateKey, category);

    // Backup data never overwrites a value already confirmed by Indotogel.
    if (sourceLabel === 'WIDGET_BACKUP' && latestAudit && latestAudit.sourceName === 'INDOTOGEL') {
      const currentRow = findDatabaseRowByDate_(sheet, dateKey);
      const currentValue = currentRow
        ? normalizeSheetValue_(sheet.getRange(currentRow, CONFIG.HEADERS.indexOf(category) + 1).getDisplayValue())
        : latestAudit.sourceValue;
      return {
        ok: true, status: 'IGNORED_BACKUP', action: 'unchanged',
        category, date: dateKey, value: currentValue, previousValue: currentValue,
        sourceName: 'INDOTOGEL', done: true,
        message: 'Hasil widget diabaikan karena nilai Indotogel sudah tersimpan.'
      };
    }

    let targetRow = findDatabaseRowByDate_(sheet, dateKey);
    const categoryColumn = CONFIG.HEADERS.indexOf(category) + 1;

    if (!targetRow) {
      targetRow = sheet.getLastRow() + 1;
      sheet.getRange(targetRow, 1, 1, CONFIG.HEADERS.length).setValues([[
        dateKeyToSheetDate_(dateKey), '', '', '', '', '', '', ''
      ]]);
    }

    const valueCell = sheet.getRange(targetRow, categoryColumn);
    const previousValue = normalizeSheetValue_(valueCell.getDisplayValue());
    let status;
    let action;

    if (!previousValue) {
      status = 'SAVED';
      action = 'inserted';
    } else if (previousValue === sourceValue) {
      status = 'MATCH';
      action = 'unchanged';
    } else {
      status = 'MISMATCH';
      action = 'updated_from_' + sourceLabel.toLowerCase();
    }

    if (action !== 'unchanged') {
      valueCell.setNumberFormat('@');
      valueCell.setValue(sourceValue);
      sortDatabase_(sheet);
      SpreadsheetApp.flush();
    }

    const sourceSentence = sourceLabel === 'INDOTOGEL'
      ? 'Indotogel'
      : 'widget cadangan';
    const sourceChanged = !latestAudit || latestAudit.sourceName !== sourceLabel;
    const valueChanged = previousValue !== sourceValue;
    // Avoid writing duplicate audit rows for unchanged five-minute retries.
    if (sourceChanged || valueChanged || status === 'SAVED') {
      appendSourceAudit_(getSourceAuditSheet_(), {
        checkedAt: new Date(),
        date: dateKey,
        category: category,
        previousValue: previousValue,
        rawDigits: rawDigits,
        sourceValue: sourceValue,
        status: status,
        period: period,
        sourceUrl: sourceUrl,
        sourceName: sourceLabel,
        note: status === 'MISMATCH'
          ? 'Nilai berbeda. Nilai dari ' + sourceSentence + ' dipakai sebagai nilai aktif; nilai sebelumnya tetap disimpan di audit.'
          : (status === 'MATCH'
            ? 'Nilai sama; sumber terbaru yang mengonfirmasi: ' + sourceSentence + '.'
            : 'Sel kosong diisi dari ' + sourceSentence + '.')
      });
    }

    // Only an Indotogel result completes polling for this market/date.
    const properties = PropertiesService.getScriptProperties();
    if (sourceLabel === 'INDOTOGEL') properties.setProperty('AUTO_POLL_DONE_' + category, dateKey);
    else properties.deleteProperty('AUTO_POLL_DONE_' + category);

    return {
      ok: true,
      status: status,
      action: action,
      category: category,
      date: dateKey,
      value: sourceValue,
      previousValue: previousValue,
      rawDigits: rawDigits,
      sourceName: sourceLabel,
      sourceUrl: sourceUrl,
      done: sourceLabel === 'INDOTOGEL',
      message: status === 'MISMATCH'
        ? category + ': hasil dari ' + sourceSentence + ' ' + sourceValue + ' berbeda dari nilai sebelumnya ' + previousValue + '. Nilai sumber baru dipakai; perbedaan dicatat.'
        : (status === 'MATCH'
          ? category + ' ' + sourceValue + ' sama dengan nilai sebelumnya (' + sourceSentence + ').'
          : category + ' ' + sourceValue + ' berhasil dimasukkan dari ' + sourceSentence + '.')
    };
  } finally {
    lock.releaseLock();
  }
}

function isValidDateKey_(key) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return false;
  const parts = key.split('-').map(Number);
  const date = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  if (date.toISOString().slice(0, 10) !== key) return false;

  const today = getTodayKey_();
  const oldest = addDaysToKey_(today, -(CONFIG.RETENTION_DAYS - 1));
  return key <= today && key >= oldest;
}

function getSourceAuditSheet_() {
  const spreadsheet = SpreadsheetApp.openById(getSpreadsheetId_());
  let sheet = spreadsheet.getSheetByName(CONFIG.SOURCE_AUDIT_SHEET);

  if (!sheet) {
    sheet = spreadsheet.insertSheet(CONFIG.SOURCE_AUDIT_SHEET);
    sheet.getRange(1, 1, 1, 11).setValues([[
      'WAKTU CEK', 'TANGGAL HASIL', 'KATEGORI', 'NILAI SEBELUMNYA',
      'HASIL MENTAH SUMBER', 'NILAI DISIMPAN', 'STATUS', 'PERIODE',
      'URL SUMBER', 'CATATAN', 'NAMA SUMBER'
    ]]);
  } else {
    // Existing Indotogel-only audit rows remain intact; add the source column in place.
    if (sheet.getLastColumn() < 11 || !String(sheet.getRange(1, 11).getDisplayValue()).trim()) {
      sheet.getRange(1, 11).setValue('NAMA SUMBER');
    }
    if (String(sheet.getRange(1, 5).getDisplayValue()).trim() === 'HASIL ASLI INDOTOGEL') {
      sheet.getRange(1, 5).setValue('HASIL MENTAH SUMBER');
    }
  }

  sheet.setFrozenRows(1);
  sheet.getRange('A:A').setNumberFormat('dd/MM/yyyy HH:mm:ss');
  sheet.getRange(1, 1, 1, 11).setFontWeight('bold');
  sheet.setColumnWidth(9, 300);
  sheet.setColumnWidth(10, 420);
  sheet.setColumnWidth(11, 140);
  return sheet;
}

function appendSourceAudit_(sheet, item) {
  sheet.appendRow([
    item.checkedAt, item.date, item.category, item.previousValue,
    item.rawDigits, item.sourceValue, item.status, item.period,
    item.sourceUrl, item.note, item.sourceName || 'INDOTOGEL'
  ]);
}

function getLatestSourceAuditMap_(oldestKey, todayKey) {
  const spreadsheet = SpreadsheetApp.openById(getSpreadsheetId_());
  const sheet = spreadsheet.getSheetByName(CONFIG.SOURCE_AUDIT_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return {};

  // Audit logs are append-only. Read a bounded tail to keep list refresh fast.
  const lastRow = sheet.getLastRow();
  const startRow = Math.max(2, lastRow - 4999);
  const values = sheet.getRange(startRow, 1, lastRow - startRow + 1, Math.max(10, sheet.getLastColumn())).getValues();
  const result = {};

  values.forEach(row => {
    const dateKey = dateCellToKey_(row[1]);
    const category = String(row[2] || '').trim().toUpperCase();
    if (!dateKey || dateKey < oldestKey || dateKey > todayKey) return;
    if (!['CAM', 'SDY', 'CHN', 'JPN', 'SGP', 'TWN', 'HKP'].includes(category)) return;
    result[dateKey + '|' + category] = {
      status: String(row[6] || ''),
      previousValue: normalizeSheetValue_(row[3]),
      sourceValue: normalizeSheetValue_(row[5]),
      sourceName: normalizeSheetValue_(row[10]) || 'INDOTOGEL'
    };
  });
  return result;
}

function findDatabaseRowByDate_(sheet, dateKey) {
  const values = getDatabaseValues_(sheet);
  for (let i = 0; i < values.length; i++) {
    if (dateCellToKey_(values[i][0]) === dateKey) return i + 2;
  }
  return 0;
}

function jsonResponse_(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}