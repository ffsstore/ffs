// v2: счётчики просмотров, избранного и корзины
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
    for (const q of [
      'CREATE TABLE IF NOT EXISTS ev (pid INTEGER, kind TEXT, uid INTEGER, ts INTEGER, PRIMARY KEY (pid, kind, uid))',
      'CREATE TABLE IF NOT EXISTS rem (pid INTEGER, uid INTEGER, PRIMARY KEY (pid, uid))',
      'CREATE TABLE IF NOT EXISTS sub (uid INTEGER, kind TEXT, key TEXT, ts INTEGER, PRIMARY KEY (uid, kind, key))',
      'CREATE TABLE IF NOT EXISTS seen (pid INTEGER PRIMARY KEY)',
      'CREATE TABLE IF NOT EXISTS optout (uid INTEGER PRIMARY KEY)',
    ]) await env.DB.prepare(q).run();
    ready = true;
  }
  return env.DB;
}
async function track(env, body) {
  const kinds = ['view', 'fav', 'cart', 'order', 'unfav', 'uncart'];
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
  const { results } = await d.prepare("SELECT pid, kind, COUNT(*) AS n FROM ev WHERE kind IN ('view','fav','cart') GROUP BY pid, kind").all();
  const out = {};
  for (const r of results) (out[r.pid] ??= {})[r.kind] = r.n;
  return json(out, 200, { 'cache-control': 'public, max-age=60' });
}

// ---------- подписки «сообщить о новинках» ----------
async function subscribe(env, body) {
  const uid = await tgUser(env, body.initData);
  if (!uid) return json({ ok: false, reason: 'not telegram' });
  const kind = String(body.kind), key = String(body.key || '').slice(0, 60);
  if (!['cat', 'club'].includes(kind) || !key) return json({ ok: false }, 400);
  const d = await db(env);
  if (body.on) {
    await d.prepare('INSERT OR REPLACE INTO sub (uid, kind, key, ts) VALUES (?, ?, ?, ?)').bind(uid, kind, key, Date.now()).run();
    await d.prepare('DELETE FROM optout WHERE uid=?').bind(uid).run();
  } else await d.prepare('DELETE FROM sub WHERE uid=? AND kind=? AND key=?').bind(uid, kind, key).run();
  return json({ ok: true });
}
async function mysubs(env, body) {
  const uid = await tgUser(env, body.initData);
  if (!uid) return json({ subs: [] });
  const d = await db(env);
  const { results } = await d.prepare('SELECT kind, key FROM sub WHERE uid=?').bind(uid).all();
  return json({ subs: results });
}

// ---------- рассылки по расписанию (раз в час) ----------
const REMIND_AFTER = 24 * 3600000; // напоминание о корзине через сутки
const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const plur = (n, a, b, c) => { const m = n % 10, h = n % 100; return m === 1 && h !== 11 ? a : m >= 2 && m <= 4 && (h < 12 || h > 14) ? b : c; };
const line = p => '• ' + esc(p.title) + (p.size && !String(p.size).includes('/') ? ', размер ' + esc(p.size) : '') + (p.byn ? ' — ' + p.byn + ' BYN' : '');
const appBtn = (text, q) => ({ inline_keyboard: [[{ text, web_app: { url: SHOP + (q || '') } }]] });

async function cron(env) {
  if (!env.DB) return;
  const d = await db(env);
  const P = await (await fetch(SHOP + 'products.json?t=' + Date.now())).json();
  const byId = new Map(P.map(p => [p.id, p]));

  // 1) новые товары → подписчикам
  const seen = new Set((await d.prepare('SELECT pid FROM seen').all()).results.map(r => r.pid));
  const fresh = P.filter(p => !seen.has(p.id));
  if (fresh.length) {
    if (seen.size) {
      const subs = (await d.prepare('SELECT uid, kind, key FROM sub WHERE uid NOT IN (SELECT uid FROM optout)').all()).results;
      const per = new Map();
      for (const s of subs) for (const p of fresh)
        if ((s.kind === 'cat' && p.cat === s.key) || (s.kind === 'club' && p.club === s.key)) {
          if (!per.has(s.uid)) per.set(s.uid, new Map());
          per.get(s.uid).set(p.id, p);
        }
      for (const [uid, m] of per) {
        const items = [...m.values()];
        await tg(env, 'sendMessage', {
          chat_id: uid, parse_mode: 'HTML',
          text: '🔔 <b>Новинка в FootballFitStore!</b>\n\n' + items.map(line).join('\n') +
            '\n\nТы просил сообщить о новых поступлениях.\n<i>Не присылать уведомления — /stop</i>',
          reply_markup: items.length === 1 ? appBtn('👀 Посмотреть', '?p=' + items[0].id) : appBtn('🛍 Открыть магазин'),
        }).catch(() => {});
      }
    }
    for (const p of fresh) await d.prepare('INSERT OR IGNORE INTO seen (pid) VALUES (?)').bind(p.id).run();
  }

  // 2) напоминание о корзине (только днём: 9:00–21:59 по Минску)
  const h = new Date().getUTCHours();
  if (h < 6 || h > 18) return;
  const now = Date.now();
  const rows = (await d.prepare(
    "SELECT e.pid, e.uid FROM ev e WHERE e.kind='cart' AND e.ts < ? AND e.ts > ? " +
    "AND NOT EXISTS (SELECT 1 FROM rem r WHERE r.pid=e.pid AND r.uid=e.uid) " +
    "AND NOT EXISTS (SELECT 1 FROM ev o WHERE o.kind='order' AND o.pid=e.pid AND o.uid=e.uid) " +
    'AND e.uid NOT IN (SELECT uid FROM optout)').bind(now - REMIND_AFTER, now - 7 * 86400000).all()).results;
  if (!rows.length) return;
  const counts = new Map((await d.prepare("SELECT pid, COUNT(*) AS n FROM ev WHERE kind='cart' GROUP BY pid").all()).results.map(r => [r.pid, r.n]));
  const per = new Map();
  for (const r of rows) { if (!per.has(r.uid)) per.set(r.uid, []); per.get(r.uid).push(r.pid); }
  for (const [uid, pids] of per) {
    const items = pids.map(id => byId.get(id)).filter(p => p && p.stock !== 'Продано');
    if (items.length) {
      const body = items.map(p => {
        const others = (counts.get(p.id) || 1) - 1;
        return line(p) + (others > 0 ? '\n   🔥 в корзине ещё у ' + others + ' ' + plur(others, 'человека', 'человек', 'человек') : '');
      }).join('\n');
      await tg(env, 'sendMessage', {
        chat_id: uid, parse_mode: 'HTML',
        text: '🛒 <b>Ты оставил в корзине:</b>\n\n' + body +
          '\n\nВещи в одном экземпляре — оформи, пока их не забрали 👇\n<i>Не присылать напоминания — /stop</i>',
        reply_markup: appBtn('🛒 Открыть корзину', '?open=cart'),
      }).catch(() => {});
    }
    for (const pid of pids) await d.prepare('INSERT OR IGNORE INTO rem (pid, uid) VALUES (?, ?)').bind(pid, uid).run();
  }
}

async function handle(env, update) {
  // заявка на вступление в канал → приветствие с каталогом, затем одобряем заявку
  const jr = update.chat_join_request;
  if (jr) {
    const name = esc(jr.from && jr.from.first_name || '');
    await tg(env, 'sendMessage', {
      chat_id: jr.user_chat_id || jr.from.id, parse_mode: 'HTML',
      text: '👋 ' + (name ? name + ', с' : 'С') + 'пасибо за подписку на <b>' + esc(jr.chat.title) + '</b>!\n\n' +
        '⚽️ Все джерси, бутсы и мячи с ценами и размерами — в нашем каталоге\n' +
        '🚚 Бесплатная доставка по СНГ\n\n👇 Открой каталог прямо в Telegram',
      reply_markup: KEYBOARD,
    }).catch(() => {});
    await tg(env, 'approveChatJoinRequest', { chat_id: jr.chat.id, user_id: jr.from.id }).catch(() => {});
    return;
  }
  const msg = update.message;
  if (!msg || !msg.chat || msg.chat.type !== 'private') return;
  const text = msg.text || '';
  if (env.DB && (text.startsWith('/stop') || text.startsWith('/notify'))) {
    const d = await db(env), stop = text.startsWith('/stop');
    if (stop) await d.prepare('INSERT OR IGNORE INTO optout (uid) VALUES (?)').bind(msg.chat.id).run();
    else await d.prepare('DELETE FROM optout WHERE uid=?').bind(msg.chat.id).run();
    await tg(env, 'sendMessage', { chat_id: msg.chat.id,
      text: stop ? '🔕 Готово, больше не буду присылать напоминания и уведомления.\nВключить снова — /notify' : '🔔 Уведомления снова включены.',
      reply_markup: KEYBOARD });
    return;
  }
  const isStart = text.startsWith('/start');
  await tg(env, 'sendMessage', {
    chat_id: msg.chat.id,
    text: isStart ? WELCOME : OTHER,
    parse_mode: 'HTML',
    reply_markup: KEYBOARD,
  });
}

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(cron(env)); },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!env.BOT_TOKEN) return new Response('Не задан секрет BOT_TOKEN', { status: 500 });

    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (['/stats', '/track', '/sub', '/mysubs'].includes(url.pathname)) {
      if (!env.DB) return json({ ok: false, reason: 'no DB binding' }, 503);
      if (url.pathname === '/stats') return stats(env);
      if (request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        if (url.pathname === '/track') return track(env, body);
        if (url.pathname === '/sub') return subscribe(env, body);
        if (url.pathname === '/mysubs') return mysubs(env, body);
      }
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
        allowed_updates: ['message', 'chat_join_request'],
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
