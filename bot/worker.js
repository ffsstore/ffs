// Бот FootballFitStore: на /start присылает кнопку «Открыть магазин».
// Cloudflare Worker. Токен бота хранится в секрете BOT_TOKEN (Settings → Variables and Secrets).

const SHOP = 'https://ffsstore.github.io/ffs/';
const MANAGER = 'ffs_mngr';

const WELCOME =
  '👋 Привет! Это магазин <b>FootballFitStore</b>\n\n' +
  '⚽️ Джерси клубов, бутсы, сороконожки и мячи\n' +
  '🚚 Бесплатная доставка по СНГ\n\n' +
  '👇 Нажми кнопку, чтобы открыть каталог';

const OTHER =
  'Каталог и заказ — в магазине 👇\n' +
  'Если есть вопрос — напиши менеджеру @' + MANAGER;

const KEYBOARD = {
  inline_keyboard: [
    [{ text: '🛍 Открыть магазин', web_app: { url: SHOP } }],
    [{ text: '💬 Написать менеджеру', url: 'https://t.me/' + MANAGER }],
  ],
};

const token = env => String(env.BOT_TOKEN || '').replace(/\s+/g, '').replace(/^bot/i, '');

async function tg(env, method, body) {
  return fetch('https://api.telegram.org/bot' + token(env) + '/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// секрет для вебхука, вычисляется из токена (чтобы чужие не могли слать запросы)
async function hookSecret(env) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token(env)));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 40);
}

// ---------- счётчики товаров (D1, привязка DB) ----------
const DAYS = 7;
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type' };
const json = (o, st = 200, extra = {}) => new Response(JSON.stringify(o), { status: st, headers: { 'content-type': 'application/json', ...CORS, ...extra } });

async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', typeof key === 'string' ? new TextEncoder().encode(key) : key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(data)));
}
// проверка, что запрос пришёл из Telegram от настоящего пользователя
async function tgUser(env, initData) {
  if (!initData) return null;
  const p = new URLSearchParams(initData);
  const hash = p.get('hash'); if (!hash) return null;
  p.delete('hash');
  const check = [...p.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => k + '=' + v).join('\n');
  const secret = await hmac('WebAppData', token(env));
  const sig = [...await hmac(secret, check)].map(b => b.toString(16).padStart(2, '0')).join('');
  if (sig !== hash) return null;
  if (Date.now() / 1000 - Number(p.get('auth_date') || 0) > 86400 * 7) return null;
  try { return JSON.parse(p.get('user')).id; } catch { return null; }
}
let ready = false;
async function db(env) {
  if (!ready) {
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS ev (pid INTEGER, kind TEXT, uid INTEGER, ts INTEGER, PRIMARY KEY (pid, kind, uid))').run();
    ready = true;
  }
  return env.DB;
}
async function track(env, body) {
  const kinds = ['view', 'fav', 'cart', 'unfav', 'uncart'];
  const pid = Number(body.pid), kind = String(body.kind);
  if (!pid || !kinds.includes(kind)) return json({ ok: false }, 400);
  const uid = await tgUser(env, body.initData);
  if (!uid) return json({ ok: false, reason: 'not telegram' });
  const d = await db(env);
  if (kind.startsWith('un')) await d.prepare('DELETE FROM ev WHERE pid=? AND kind=? AND uid=?').bind(pid, kind.slice(2), uid).run();
  else await d.prepare('INSERT OR REPLACE INTO ev (pid, kind, uid, ts) VALUES (?, ?, ?, ?)').bind(pid, kind, uid, Date.now()).run();
  return json({ ok: true });
}
async function stats(env) {
  const d = await db(env);
  const since = Date.now() - DAYS * 86400000;
  const { results } = await d.prepare('SELECT pid, kind, COUNT(*) AS n FROM ev WHERE ts > ? GROUP BY pid, kind').bind(since).all();
  const out = {};
  for (const r of results) (out[r.pid] ??= {})[r.kind] = r.n;
  return json(out, 200, { 'cache-control': 'public, max-age=60' });
}

async function handle(env, update) {
  const msg = update.message;
  if (!msg || !msg.chat || msg.chat.type !== 'private') return;
  const isStart = (msg.text || '').startsWith('/start');
  await tg(env, 'sendMessage', {
    chat_id: msg.chat.id,
    text: isStart ? WELCOME : OTHER,
    parse_mode: 'HTML',
    reply_markup: KEYBOARD,
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!env.BOT_TOKEN) return new Response('Не задан секрет BOT_TOKEN', { status: 500 });

    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (url.pathname === '/stats' || url.pathname === '/track') {
      if (!env.DB) return json({ ok: false, reason: 'no DB binding' }, 503);
      if (url.pathname === '/stats') return stats(env);
      if (request.method === 'POST') return track(env, await request.json().catch(() => ({})));
    }

    // один раз открыть в браузере: …workers.dev/setup
    if (url.pathname === '/setup') {
      const t = token(env);
      const me = await (await tg(env, 'getMe', {})).json();
      if (!me.ok) {
        const ok = /^\d{6,12}:[A-Za-z0-9_-]{30,}$/.test(t);
        return new Response('❌ Telegram не принял токен.\n' +
          'Длина токена: ' + t.length + ' символов (должно быть около 46).\n' +
          'Формат: ' + (ok ? 'похож на правильный — возможно, токен устарел, возьми новый в @BotFather' : 'неправильный — скопируй токен заново, только сам токен') + '\n' +
          'Начинается с: ' + t.slice(0, 4) + '…',
          { headers: { 'content-type': 'text/plain; charset=utf-8' } });
      }
      const r = await tg(env, 'setWebhook', {
        url: url.origin + '/webhook',
        secret_token: await hookSecret(env),
        allowed_updates: ['message'],
        drop_pending_updates: true,
      });
      await tg(env, 'setChatMenuButton', {
        menu_button: { type: 'web_app', text: 'Магазин', web_app: { url: SHOP } },
      });
      const j = await r.json();
      return new Response(j.ok ? '✅ Бот @' + me.result.username + ' подключён! Напиши ему /start' : '❌ Ошибка: ' + j.description,
        { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }

    if (url.pathname === '/webhook' && request.method === 'POST') {
      if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== (await hookSecret(env)))
        return new Response('forbidden', { status: 403 });
      const update = await request.json();
      ctx.waitUntil(handle(env, update));
      return new Response('ok');
    }

    return new Response('FFS bot работает', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
  },
};
