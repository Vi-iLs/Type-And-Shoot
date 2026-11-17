/**
 * TYPE-AND-SHOOT — GOOGLE SHEETS API + SINGLE-SOURCE INDOTOGEL POLLER
 * Worker: type-shoot-sheet-test
 *
 * Public API (dashboard):
 *   POST { action: "save", pin, input }
 *   POST { action: "list" }
 *
 * Automatic polling:
 *   - Primary: https://indotogel.jp.net (per-channel result page)
 *   - Backup: https://widgets2.livesgp.day/result1.php, fetched only when
 *     the same channel/date cannot be read from Indotogel
 *   - Exactly seven configured markets: CAM, SDY, CHN, JPN, SGP, TWN, HKP
 *   - Exact draw date required from either source; primary also requires
 *     the expected period code. Backup market names are exact-matched.
 *   - 4-digit values are preserved; 6-digit Indotogel values use the last 4.
 *   - If a saved value differs, the new source value becomes current and the
 *     previous value plus source identity are logged in SOURCE_AUDIT.
 *
 * Required Cloudflare secrets:
 *   APPS_SCRIPT_TOKEN
 *   DASHBOARD_PIN
 */

const APPS_SCRIPT_URL =
  'https://script.google.com/macros/s/AKfycbxGqXjuaowVZcFIklcMP8in1Gh3rTjUMW8FusRH1Y_XMCHLF-8j4gqiw7q9nwPzmDTnIg/exec';

const ALLOWED_ORIGINS = new Set([
  'https://vi-ils.github.io',
  'https://type-shooter.vails.workers.dev'
]);

const INDOTOGEL_BASE = 'https://indotogel.jp.net';
const WIDGET_BACKUP_URL = 'https://widgets2.livesgp.day/result1.php';
const WIDGET_MARKET_NAMES = {
  CAM: ['CAMBODIA'],
  SDY: ['SYDNEY'],
  CHN: ['CHINA'],
  JPN: ['JAPAN'],
  SGP: ['SINGAPORE'],
  TWN: ['TAIWAN'],
  HKP: ['HONGKONG', 'HONG KONG']
};
const MAX_SOURCE_HTML_BYTES = 2_000_000;
const FETCH_TIMEOUT_MS = 12_000;

// Poll the seven configured markets from their expected publication time until
// the end of the Jakarta day. The trigger runs every five minutes. This broad
// retry window catches delayed source publication without guessing a result.
const MARKETS = {
  CAM: { slug: 'MC', periods: ['MC'], resultMinute: 11 * 60 + 50 },
  SDY: { slug: 'SD', periods: ['SD'], resultMinute: 13 * 60 + 50 },
  CHN: { slug: 'CN', periods: ['CN'], resultMinute: 15 * 60 + 30 },
  JPN: { slug: 'JPN', periods: ['JPN', 'JP'], resultMinute: 17 * 60 + 20 },
  SGP: { slug: 'sg', periods: ['SG'], resultMinute: 17 * 60 + 40, drawDays: [0, 1, 3, 4, 6] },
  TWN: { slug: 'TW', periods: ['TW'], resultMinute: 20 * 60 + 45 },
  HKP: { slug: 'HK', periods: ['HK'], resultMinute: 23 * 60 }
};

function corsHeaders(origin) {
  const headers = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'no-store',
    'Vary': 'Origin'
  };
  if (ALLOWED_ORIGINS.has(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

function jsonResponse(data, status = 200, origin = '') {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(origin)
    }
  });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';

    if (origin && !ALLOWED_ORIGINS.has(origin)) {
      return jsonResponse({ ok: false, error: 'Origin tidak diizinkan.' }, 403, origin);
    }
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== 'POST') {
      return jsonResponse({ ok: false, error: 'Gunakan metode POST.' }, 405, origin);
    }
    if (!env.APPS_SCRIPT_TOKEN) {
      return jsonResponse({ ok: false, error: 'Secret APPS_SCRIPT_TOKEN belum dipasang.' }, 500, origin);
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return jsonResponse({ ok: false, error: 'Format JSON tidak valid.' }, 400, origin);
    }

    const action = String(payload.action || '').trim();
    if (!['save', 'list', 'sourceTest', 'sourceSync', 'verifyPin'].includes(action)) {
      return jsonResponse({ ok: false, error: 'Action tidak dikenal.' }, 400, origin);
    }

    if (['sourceTest', 'sourceSync', 'verifyPin', 'save'].includes(action)) {
      if (!env.DASHBOARD_PIN || String(payload.pin || '') !== env.DASHBOARD_PIN) {
        return jsonResponse({ ok: false, error: 'PIN tidak sesuai.' }, 403, origin);
      }
    }

    if (action === 'verifyPin') {
      return jsonResponse({ ok: true, authenticated: true }, 200, origin);
    }

    if (action === 'sourceTest' || action === 'sourceSync') {
      try {
        const date = String(payload.date || getJakartaDateKey(new Date())).trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          return jsonResponse({ ok: false, error: 'Tanggal tes tidak valid.' }, 400, origin);
        }
        const result = await testIndotogelSources_(date);
        if (action === 'sourceSync') {
          const stored = await persistSourceTestResults_(env, result.results);
          result.results = stored.results;
          result.saved = stored.saved;
          result.matched = stored.matched;
          result.mismatched = stored.mismatched;
          result.alreadySaved = stored.ignoredBackup;
          result.failed = stored.failed;
          result.message = 'Hasil valid telah dikirim ke Google Sheets.';
        }
        return jsonResponse(result, 200, origin);
      } catch (error) {
        return jsonResponse({ ok: false, error: error.message || 'Tes/sinkronisasi sumber gagal.' }, 502, origin);
      }
    }

    if (action === 'save') {
      if (typeof payload.input !== 'string' || !payload.input.trim()) {
        return jsonResponse({ ok: false, error: 'Input data kosong.' }, 400, origin);
      }
    }

    try {
      const result = await callAppsScript_(env, {
        action,
        input: action === 'save' ? payload.input : undefined
      });
      return jsonResponse(result, 200, origin);
    } catch (error) {
      return jsonResponse({ ok: false, error: error.message || 'Tidak dapat menghubungi Google Sheets.' }, 502, origin);
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runScheduledPoll_(controller, env).catch(error => {
      console.error('Polling Indotogel gagal:', error && error.stack ? error.stack : String(error));
    }));
  }
};

async function callAppsScript_(env, payload) {
  if (!env.APPS_SCRIPT_TOKEN) throw new Error('Secret APPS_SCRIPT_TOKEN belum dipasang.');

  const response = await fetch(APPS_SCRIPT_URL, {
    method: 'POST',
    redirect: 'follow',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: env.APPS_SCRIPT_TOKEN, ...payload })
  });

  const responseText = await response.text();
  let result;
  try {
    result = JSON.parse(responseText);
  } catch {
    throw new Error('Google Apps Script mengembalikan respons yang bukan JSON.');
  }
  if (!response.ok || !result.ok) {
    throw new Error(result.error || 'Permintaan ke Google Sheets gagal.');
  }
  return result;
}

function getJakartaClock(date) {
  // Add +7 hours, then use UTC getters to avoid runtime timezone assumptions.
  const shifted = new Date(date.getTime() + 7 * 60 * 60 * 1000);
  return {
    year: shifted.getUTCFullYear(),
    month: String(shifted.getUTCMonth() + 1).padStart(2, '0'),
    day: String(shifted.getUTCDate()).padStart(2, '0'),
    weekday: shifted.getUTCDay(),
    minuteOfDay: shifted.getUTCHours() * 60 + shifted.getUTCMinutes()
  };
}

function getDueCategories(minuteOfDay, weekday) {
  return Object.entries(MARKETS)
    .filter(([, market]) => {
      if (minuteOfDay < market.resultMinute) return false;
      if (market.drawDays && !market.drawDays.includes(weekday)) return false;
      return true;
    })
    .map(([category]) => category);
}

async function runScheduledPoll_(controller, env) {
  const scheduledAt = new Date(controller.scheduledTime || Date.now());
  const jakarta = getJakartaClock(scheduledAt);
  const date = `${jakarta.year}-${jakarta.month}-${jakarta.day}`;
  const categories = getDueCategories(jakarta.minuteOfDay, jakarta.weekday);

  // Before a market's expected time, do not poll it. Once its time passes,
  // continue checking until a primary Indotogel result is confirmed or day ends.
  if (!categories.length) return;

  let widgetRowsPromise = null;
  const getWidgetRows = () => {
    if (!widgetRowsPromise) widgetRowsPromise = fetchWidgetResultRows_();
    return widgetRowsPromise;
  };
  await Promise.all(categories.map(category =>
    pollOneMarket_(category, date, scheduledAt, env, getWidgetRows)
  ));
}

function getJakartaDateKey(date) {
  const clock = getJakartaClock(date);
  return `${clock.year}-${clock.month}-${clock.day}`;
}

async function fetchIndotogelMarket_(category, date) {
  const market = MARKETS[category];
  if (!market) throw new Error('Kategori tidak dikenal: ' + category);

  const sourceUrl = `${INDOTOGEL_BASE}/result/${market.slug}`;
  const response = await fetch(sourceUrl, {
    method: 'GET',
    redirect: 'follow',
    cache: 'no-store',
    headers: {
      'Accept': 'text/html,application/xhtml+xml',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
      'User-Agent': 'Mozilla/5.0 (compatible; TypeAndShootIndotogelReader/1.1)'
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  });

  if (!response.ok) throw new Error('HTTP ' + response.status);
  const finalUrl = new URL(response.url || sourceUrl);
  if (finalUrl.protocol !== 'https:' || finalUrl.hostname !== 'indotogel.jp.net') {
    throw new Error('Redirect di luar domain Indotogel ditolak.');
  }
  const html = await response.text();
  if (html.length > MAX_SOURCE_HTML_BYTES) throw new Error('Halaman melebihi batas ukuran 2 MB.');

  return {
    sourceUrl,
    parsed: parseIndotogelResultPage_(html, category, date)
  };
}

// Diagnostic only: Indotogel first; use the widget backup only when its row is unavailable.
// This endpoint never writes to Google Sheets.
async function testIndotogelSources_(date) {
  const categories = Object.keys(MARKETS);
  const primaryResults = await Promise.all(categories.map(async category => {
    const market = MARKETS[category];
    const sourceUrl = `${INDOTOGEL_BASE}/result/${market.slug}`;
    try {
      const fetched = await fetchIndotogelMarket_(category, date);
      if (!fetched.parsed) {
        return { category, date, primaryUrl: sourceUrl, primary: null,
          primaryMessage: 'Baris hasil untuk tanggal/periode ini belum tersedia.' };
      }
      return { category, date, primaryUrl: sourceUrl, primary: fetched.parsed,
        primaryMessage: '' };
    } catch (error) {
      return { category, date, primaryUrl: sourceUrl, primary: null,
        primaryMessage: String(error && error.message ? error.message : error) };
    }
  }));

  const missing = primaryResults.filter(item => !item.primary);
  let widgetRows = null;
  let widgetError = '';
  if (missing.length) {
    try {
      widgetRows = await fetchWidgetResultRows_();
    } catch (error) {
      widgetError = String(error && error.message ? error.message : error);
    }
  }

  const results = primaryResults.map(item => {
    if (item.primary) {
      return {
        category: item.category, date, status: 'FOUND_PRIMARY',
        sourceName: 'INDOTOGEL', url: item.primaryUrl,
        value: item.primary.displayValue, rawDigits: item.primary.resultDigits,
        period: item.primary.period, message: 'Dibaca dari sumber utama Indotogel.'
      };
    }

    const backup = widgetRows ? findWidgetMarketResult_(widgetRows, item.category, date) : null;
    if (backup) {
      return {
        category: item.category, date, status: 'FOUND_BACKUP',
        sourceName: 'WIDGET_BACKUP', url: WIDGET_BACKUP_URL,
        value: backup.value, rawDigits: backup.rawDigits,
        period: 'WIDGET', message: 'Indotogel tidak menyediakan hasil yang cocok; hasil diambil dari widget cadangan.'
      };
    }

    return {
      category: item.category, date, status: widgetError ? 'ERROR' : 'NOT_READY',
      sourceName: '', url: item.primaryUrl,
      value: '', rawDigits: '', period: '',
      message: [item.primaryMessage, widgetError ? 'Widget cadangan: ' + widgetError : 'Widget cadangan belum memiliki baris untuk tanggal ini.'].filter(Boolean).join(' | ')
    };
  });

  return {
    ok: true,
    source: 'INDOTOGEL_WITH_WIDGET_BACKUP',
    date,
    results,
    found: results.filter(item => item.status === 'FOUND_PRIMARY' || item.status === 'FOUND_BACKUP').length,
    primary: results.filter(item => item.status === 'FOUND_PRIMARY').length,
    backup: results.filter(item => item.status === 'FOUND_BACKUP').length,
    notReady: results.filter(item => item.status === 'NOT_READY').length,
    errors: results.filter(item => item.status === 'ERROR').length,
    saved: false
  };
}


async function persistSourceTestResults_(env, results) {
  const output = [];
  let saved = 0, matched = 0, mismatched = 0, ignoredBackup = 0, failed = 0;
  for (const item of (Array.isArray(results) ? results : [])) {
    if (!['FOUND_PRIMARY', 'FOUND_BACKUP'].includes(item.status)) {
      output.push(item);
      continue;
    }
    try {
      const stored = await callAppsScript_(env, {
        action: 'ingest',
        category: item.category,
        date: item.date,
        period: item.period,
        resultDigits: item.rawDigits,
        sourceUrl: item.url,
        sourceName: item.sourceName,
        fetchedAt: new Date().toISOString()
      });
      if (stored.status === 'SAVED') saved++;
      else if (stored.status === 'MATCH') matched++;
      else if (stored.status === 'MISMATCH') mismatched++;
      else if (stored.status === 'IGNORED_BACKUP') ignoredBackup++;
      output.push({ ...item, saveStatus: stored.status, saveMessage: stored.message, savedValue: stored.value });
    } catch (error) {
      failed++;
      output.push({ ...item, saveStatus: 'SAVE_ERROR', saveMessage: String(error && error.message ? error.message : error) });
    }
  }
  return { results: output, saved, matched, mismatched, ignoredBackup, failed };
}

async function fetchWidgetResultRows_() {
  const response = await fetch(WIDGET_BACKUP_URL, {
    method: 'GET',
    redirect: 'follow',
    cache: 'no-store',
    headers: {
      'Accept': 'text/html,application/xhtml+xml',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
      'User-Agent': 'Mozilla/5.0 (compatible; TypeAndShootWidgetBackup/1.0)'
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error('Widget backup HTTP ' + response.status);
  const finalUrl = new URL(response.url || WIDGET_BACKUP_URL);
  if (finalUrl.protocol !== 'https:' || finalUrl.hostname !== 'widgets2.livesgp.day') {
    throw new Error('Redirect widget ke domain yang tidak diizinkan.');
  }
  const html = await response.text();
  if (html.length > MAX_SOURCE_HTML_BYTES) throw new Error('Halaman widget melebihi batas ukuran 2 MB.');
  return parseWidgetResultPage_(html);
}

function parseWidgetResultPage_(html) {
  const rows = String(html).match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) || [];
  const parsedRows = [];
  for (const row of rows) {
    const cells = row.match(/<(?:td|th)\b[^>]*>[\s\S]*?<\/(?:td|th)>/gi) || [];
    if (cells.length < 3) continue;

    const marketName = normalizeWidgetMarketName_(htmlToText_(cells[0]));
    const date = findDateKey_(htmlToText_(cells[1]));
    const rawDigits = (htmlToText_(cells[2]).match(/\d+/g) || []).join('');
    if (!marketName || !date || !/^\d{4}$/.test(rawDigits)) continue;
    parsedRows.push({ marketName, date, value: rawDigits, rawDigits });
  }
  return parsedRows;
}

function normalizeWidgetMarketName_(value) {
  return String(value || '').trim().toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function findWidgetMarketResult_(rows, category, targetDate) {
  const acceptedNames = WIDGET_MARKET_NAMES[category] || [];
  return (Array.isArray(rows) ? rows : []).find(row =>
    acceptedNames.includes(row.marketName) && row.date === targetDate
  ) || null;
}

async function pollOneMarket_(category, date, scheduledAt, env, getWidgetRows) {
  const state = await callAppsScript_(env, { action: 'pollState', category, date });
  if (state.done) return;


  let result = null;
  let sourceName = 'INDOTOGEL';
  let sourceUrl = `${INDOTOGEL_BASE}/result/${MARKETS[category].slug}`;
  let period = '';
  let primaryError = '';

  try {
    const fetched = await fetchIndotogelMarket_(category, date);
    if (fetched.parsed) {
      result = fetched.parsed;
      period = result.period;
    }
  } catch (error) {
    primaryError = String(error && error.message ? error.message : error);
  }

  // Fallback only when Indotogel has no matching result row or cannot be fetched.
  if (!result) {
    try {
      const widgetRows = await getWidgetRows();
      const backup = findWidgetMarketResult_(widgetRows, category, date);
      if (backup) {
        result = {
          date,
          period: 'WIDGET',
          resultDigits: backup.rawDigits,
          displayValue: backup.value
        };
        sourceName = 'WIDGET_BACKUP';
        sourceUrl = WIDGET_BACKUP_URL;
        period = 'WIDGET';
      }
    } catch (error) {
      const backupError = String(error && error.message ? error.message : error);
      console.error(category + ' ' + date + ' — widget cadangan gagal: ' + backupError);
    }
  }

  if (!result) {
    console.log(category + ' ' + date + ': hasil tidak tersedia pada Indotogel maupun widget cadangan.' +
      (primaryError ? ' Indotogel: ' + primaryError : ''));
    return;
  }

  const stored = await callAppsScript_(env, {
    action: 'ingest',
    category,
    date,
    period,
    resultDigits: result.resultDigits,
    sourceUrl,
    sourceName,
    fetchedAt: scheduledAt.toISOString()
  });

  console.log(JSON.stringify({
    source: sourceName, category, date,
    raw: result.resultDigits,
    value: stored.value,
    status: stored.status,
    previousValue: stored.previousValue || '',
    action: stored.action
  }));
}

function parseIndotogelResultPage_(html, category, targetDate) {
  const market = MARKETS[category];
  if (!market) return null;

  const rows = String(html).match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) || [];
  for (const row of rows) {
    const cells = row.match(/<(?:td|th)\b[^>]*>[\s\S]*?<\/(?:td|th)>/gi) || [];
    if (cells.length < 3) continue;

    const rowDate = findDateKey_(htmlToText_(cells[0]));
    if (rowDate !== targetDate) continue;

    const periodText = htmlToText_(cells[1]).toUpperCase();
    const periodTokens = periodText.match(/[A-Z]{2,5}/g) || [];
    const matchingPeriod = market.periods.find(code => periodTokens.includes(code));
    if (!matchingPeriod) continue;

    const resultText = htmlToText_(cells[2]);
    const digitGroups = resultText.match(/\d+/g) || [];
    const resultDigits = digitGroups.join('');

    // The source uses 4-digit results for some markets and 6-digit results
    // for others. A 5-digit value is rejected as ambiguous, never guessed.
    if (!/^(?:\d{4}|\d{6})$/.test(resultDigits)) continue;

    return {
      date: rowDate,
      period: matchingPeriod,
      resultDigits,
      displayValue: resultDigits.slice(-4)
    };
  }
  return null;
}

function findDateKey_(text) {
  const value = String(text || '');
  let match = value.match(/\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/);
  if (match) return match[1] + '-' + match[2].padStart(2, '0') + '-' + match[3].padStart(2, '0');

  match = value.match(/\b(\d{1,2})[-/](\d{1,2})[-/](20\d{2})\b/);
  if (match) return match[3] + '-' + match[2].padStart(2, '0') + '-' + match[1].padStart(2, '0');
  return '';
}

function htmlToText_(html) {
  return String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;|&#xA0;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[\t\r\n ]+/g, ' ')
    .trim();
}

