/**
 * TYPE-AND-SHOOT — GOOGLE SHEETS API + SINGLE-SOURCE INDOTOGEL POLLER
 * Worker: type-shoot-sheet-test
 *
 * Public API (dashboard):
 *   POST { action: "save", pin, input }
 *   POST { action: "list" }
 *
 * Automatic polling:
 *   - Indotogel only: https://indotogel.jp.net
 *   - Seven markets: CAM, SDY, CHN, JPN, SGP, TWN, HKP
 *   - Exact draw date and period code required before ingest
 *   - 4-digit results are stored as-is; 6-digit results use the last 4 digits
 *   - Existing values are compared after fetch. If different, Indotogel is
 *     authoritative, the stored value is updated, and the old value is logged
 *     in SOURCE_AUDIT with status MISMATCH.
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
const MAX_SOURCE_HTML_BYTES = 2_000_000;
const FETCH_TIMEOUT_MS = 12_000;

// WIB result windows based on Indotogel's published market schedule.
// End times are polling cut-offs, not guaranteed result publication times.
const MARKETS = {
  CAM: { slug: 'MC', periods: ['MC'], resultMinute: 11 * 60 + 50, endMinute: 12 * 60 + 35 },
  SDY: { slug: 'SD', periods: ['SD'], resultMinute: 13 * 60 + 50, endMinute: 14 * 60 + 35 },
  CHN: { slug: 'CN', periods: ['CN'], resultMinute: 15 * 60 + 30, endMinute: 16 * 60 + 15 },
  JPN: { slug: 'JPN', periods: ['JPN', 'JP'], resultMinute: 17 * 60 + 20, endMinute: 18 * 60 + 5 },
  SGP: { slug: 'sg', periods: ['SG'], resultMinute: 17 * 60 + 40, endMinute: 18 * 60 + 25, drawDays: [0, 1, 3, 4, 6] },
  TWN: { slug: 'TW', periods: ['TW'], resultMinute: 20 * 60 + 45, endMinute: 21 * 60 + 30 },
  HKP: { slug: 'HK', periods: ['HK'], resultMinute: 23 * 60, endMinute: 23 * 60 + 45 }
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
    if (!['save', 'list', 'sourceTest', 'verifyPin'].includes(action)) {
      return jsonResponse({ ok: false, error: 'Action tidak dikenal.' }, 400, origin);
    }

    if (['sourceTest', 'verifyPin', 'save'].includes(action)) {
      if (!env.DASHBOARD_PIN || String(payload.pin || '') !== env.DASHBOARD_PIN) {
        return jsonResponse({ ok: false, error: 'PIN tidak sesuai.' }, 403, origin);
      }
    }

    if (action === 'verifyPin') {
      return jsonResponse({ ok: true, authenticated: true }, 200, origin);
    }

    if (action === 'sourceTest') {
      try {
        const date = String(payload.date || getJakartaDateKey(new Date())).trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          return jsonResponse({ ok: false, error: 'Tanggal tes tidak valid.' }, 400, origin);
        }
        const result = await testIndotogelSources_(date);
        return jsonResponse(result, 200, origin);
      } catch (error) {
        return jsonResponse({ ok: false, error: error.message || 'Tes sumber gagal.' }, 502, origin);
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
      if (minuteOfDay < market.resultMinute || minuteOfDay > market.endMinute) return false;
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

  // No Apps Script call and no external request outside exact WIB draw windows.
  if (!categories.length) return;

  await Promise.all(categories.map(category => pollOneMarket_(category, date, scheduledAt, env)));
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

// Diagnostic only: reads all seven pages from Indotogel and never writes to Sheets.
async function testIndotogelSources_(date) {
  const results = await Promise.all(Object.keys(MARKETS).map(async category => {
    const market = MARKETS[category];
    const sourceUrl = `${INDOTOGEL_BASE}/result/${market.slug}`;
    try {
      const fetched = await fetchIndotogelMarket_(category, date);
      if (!fetched.parsed) {
        return {
          category, date, url: sourceUrl, status: 'NOT_READY',
          value: '', rawDigits: '', period: '',
          message: 'Hasil belum terbit pada tanggal ini atau struktur halaman tidak dikenali.'
        };
      }
      return {
        category, date, url: sourceUrl, status: 'FOUND',
        value: fetched.parsed.displayValue,
        rawDigits: fetched.parsed.resultDigits,
        period: fetched.parsed.period,
        message: 'Hasil berhasil dibaca dari Indotogel.'
      };
    } catch (error) {
      return {
        category, date, url: sourceUrl, status: 'ERROR',
        value: '', rawDigits: '', period: '',
        message: String(error && error.message ? error.message : error)
      };
    }
  }));

  return {
    ok: true,
    source: 'INDOTOGEL',
    date,
    results,
    found: results.filter(item => item.status === 'FOUND').length,
    notReady: results.filter(item => item.status === 'NOT_READY').length,
    errors: results.filter(item => item.status === 'ERROR').length,
    saved: false
  };
}

async function pollOneMarket_(category, date, scheduledAt, env) {
  const state = await callAppsScript_(env, { action: 'pollState', category, date });
  if (state.done) return;

  try {
    const fetched = await fetchIndotogelMarket_(category, date);
    if (!fetched.parsed) {
      console.log(category + ' ' + date + ': hasil Indotogel belum tersedia atau format belum dikenali.');
      return;
    }

    const stored = await callAppsScript_(env, {
      action: 'ingest',
      category,
      date,
      period: fetched.parsed.period,
      resultDigits: fetched.parsed.resultDigits,
      sourceUrl: fetched.sourceUrl,
      sourceName: 'INDOTOGEL',
      fetchedAt: scheduledAt.toISOString()
    });

    console.log(JSON.stringify({
      source: 'INDOTOGEL', category, date,
      raw: fetched.parsed.resultDigits,
      value: stored.value,
      status: stored.status,
      previousValue: stored.previousValue || '',
      action: stored.action
    }));
  } catch (error) {
    console.error(category + ' ' + date + ' gagal:', String(error && error.message ? error.message : error));
  }
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

