/**
 * TYPE-AND-SHOOT — GOOGLE SHEETS API BRIDGE
 *
 * Source file for the test Worker.
 * Deploy as a SEPARATE Worker in Cloudflare:
 *   type-shoot-sheet-test
 *
 * Required Cloudflare Secrets:
 *   APPS_SCRIPT_TOKEN  = value printed by generateApiSecret()
 *   DASHBOARD_PIN      = 654321
 *
 * Do not place secret values in this file or in GitHub.
 */

const APPS_SCRIPT_URL =
  'https://script.google.com/macros/s/AKfycbxGqXjuaowVZcFIklcMP8in1Gh3rTjUMW8FusRH1Y_XMCHLF-8j4gqiw7q9nwPzmDTnIg/exec';

const ALLOWED_ORIGIN = 'https://vi-ils.github.io';

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      'Cache-Control': 'no-store',
      'Vary': 'Origin'
    }
  });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';

    if (origin && origin !== ALLOWED_ORIGIN) {
      return jsonResponse({
        ok: false,
        error: 'Origin tidak diizinkan.'
      }, 403);
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
          'Vary': 'Origin'
        }
      });
    }

    if (request.method !== 'POST') {
      return jsonResponse({
        ok: false,
        error: 'Gunakan metode POST.'
      }, 405);
    }

    if (!env.APPS_SCRIPT_TOKEN) {
      return jsonResponse({
        ok: false,
        error: 'Secret APPS_SCRIPT_TOKEN belum dipasang.'
      }, 500);
    }

    let payload;

    try {
      payload = await request.json();
    } catch {
      return jsonResponse({
        ok: false,
        error: 'Format JSON tidak valid.'
      }, 400);
    }

    const action = String(payload.action || '').trim();

    if (!['save', 'list'].includes(action)) {
      return jsonResponse({
        ok: false,
        error: 'Action tidak dikenal.'
      }, 400);
    }

    if (action === 'save') {
      if (!env.DASHBOARD_PIN ||
          String(payload.pin || '') !== env.DASHBOARD_PIN) {
        return jsonResponse({
          ok: false,
          error: 'PIN tidak sesuai.'
        }, 403);
      }

      if (typeof payload.input !== 'string' || !payload.input.trim()) {
        return jsonResponse({
          ok: false,
          error: 'Input data kosong.'
        }, 400);
      }
    }

    try {
      const upstream = await fetch(APPS_SCRIPT_URL, {
        method: 'POST',
        redirect: 'follow',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          token: env.APPS_SCRIPT_TOKEN,
          action,
          input: action === 'save' ? payload.input : undefined
        })
      });

      const responseText = await upstream.text();

      let result;
      try {
        result = JSON.parse(responseText);
      } catch {
        throw new Error(
          'Google Apps Script mengembalikan respons yang bukan JSON.'
        );
      }

      if (!upstream.ok || !result.ok) {
        return jsonResponse({
          ok: false,
          error: result.error || 'Permintaan ke Google Sheets gagal.'
        }, upstream.status >= 400 ? upstream.status : 400);
      }

      return jsonResponse(result, 200);
    } catch (error) {
      return jsonResponse({
        ok: false,
        error: error.message || 'Tidak dapat menghubungi Google Sheets.'
      }, 502);
    }
  }
};
