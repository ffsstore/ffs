// v2: счётчики просмотров, избранного и корзины
// Бот FootballFitStore: на /start присылает кнопку «Открыть магазин».
// Cloudflare Worker. Токен бота хранится в секрете BOT_TOKEN (Settings → Variables and Secrets).

const SHOP = 'https://ffsstore.github.io/ffs/';
const MANAGER = 'ffs_mngr';
const MAIN_CHANNEL = 'footballfitstore'; // основной канал: на него нужно подписаться, чтобы попасть в другие каналы

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
      'CREATE TABLE IF NOT EXISTS draft (uid INTEGER, mid INTEGER, file_id TEXT, PRIMARY KEY (uid, mid))',
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


// ---------- фото товаров: хранятся в Cloudflare R2 (привязка IMG), сайт берёт их по адресу …workers.dev/img/имя.jpg ----------
// Если фото ещё нет в R2 — один раз берём его из GitHub (тег img-archive, потом main) и сохраняем в R2.
const IMG_TYPE = n => /\.webp$/i.test(n) ? 'image/webp' : /\.png$/i.test(n) ? 'image/png' : 'image/jpeg';
async function serveImg(env, request, ctx, key) {
  if (!/^img\/[\w.-]+$/.test(key)) return new Response('not found', { status: 404 });
  const cache = caches.default, hit = await cache.match(request);
  if (hit) return hit;
  const head = { 'content-type': IMG_TYPE(key), 'cache-control': 'public, max-age=31536000, immutable', ...CORS };
  let body = null;
  if (env.IMG) { const o = await env.IMG.get(key); if (o) body = await o.arrayBuffer(); }
  if (!body) for (const ref of ['img-archive', 'main']) {
    const r = await fetch('https://raw.githubusercontent.com/' + REPO + '/' + ref + '/' + key);
    if (!r.ok) continue;
    body = await r.arrayBuffer();
    if (env.IMG) ctx.waitUntil(env.IMG.put(key, body, { httpMetadata: { contentType: IMG_TYPE(key) } }));
    break;
  }
  if (!body) return new Response('not found', { status: 404, headers: CORS });
  const res = new Response(body, { headers: head });
  ctx.waitUntil(cache.put(request, res.clone()));
  return res;
}
// фото — в R2, а в GitHub коммитим только products.json (сайт пересобирается быстро).
// Если привязки IMG ещё нет — по-старому, фото коммитятся в репозиторий.
async function saveWithImgs(env, imgs, P, message) {
  if (!env.IMG) return commitFiles(env, [...imgs, pjson(P)], message);
  for (const f of imgs) await env.IMG.put(f.path, f.bytes, { httpMetadata: { contentType: IMG_TYPE(f.path) } });
  const { sha } = await loadP(env);
  await saveP(env, P, sha, message);
}

// ---------- админ: добавление товаров через бота ----------
// секреты в Cloudflare: GH_TOKEN (GitHub, доступ Contents: write к ffsstore/ffs), ADMIN_ID (твой Telegram ID, узнать — /myid)
const REPO = 'ffsstore/ffs';
const CLUBS = { 'Реал Мадрид': 'Ла Лига', 'Барселона': 'Ла Лига', 'Атлетико Мадрид': 'Ла Лига', 'Атлетико': 'Ла Лига',
  'Манчестер Юнайтед': 'АПЛ', 'Манчестер Сити': 'АПЛ', 'Ливерпуль': 'АПЛ', 'Челси': 'АПЛ', 'Арсенал': 'АПЛ', 'Тоттенхэм': 'АПЛ', 'Ньюкасл': 'АПЛ',
  'Бавария': 'Бундеслига', 'Боруссия Дортмунд': 'Бундеслига', 'Боруссия': 'Бундеслига', 'Байер': 'Бундеслига',
  'Ювентус': 'Серия А', 'Милан': 'Серия А', 'Интер': 'Серия А', 'Наполи': 'Серия А', 'Рома': 'Серия А', 'Лацио': 'Серия А',
  'ПСЖ': 'Лига 1', 'Марсель': 'Лига 1', 'Аякс': 'Эредивизи', 'Бенфика': 'Португалия', 'Порту': 'Португалия',
  'Аргентина': 'Сборные', 'Бразилия': 'Сборные', 'Португалия': 'Сборные', 'Франция': 'Сборные', 'Германия': 'Сборные', 'Испания': 'Сборные', 'Англия': 'Сборные', 'Италия': 'Сборные' };
const admin = (env, id) => env.ADMIN_ID && String(env.ADMIN_ID).split(',').map(s => s.trim()).includes(String(id));
const b64 = bytes => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = s => Uint8Array.from(atob(s.replace(/\s/g, '')), c => c.charCodeAt(0));
async function gh(env, path, opt = {}) {
  const r = await fetch('https://api.github.com/repos/' + REPO + '/contents/' + path, {
    ...opt, headers: { authorization: 'Bearer ' + env.GH_TOKEN, accept: 'application/vnd.github+json', 'user-agent': 'ffs-bot', 'content-type': 'application/json' } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok && !(opt.method == null && r.status === 404)) throw new Error('GitHub: ' + (j.message || r.status));
  return r.ok ? j : null;
}
async function ghApi(env, path, method = 'GET', body) {
  const r = await fetch('https://api.github.com/repos/' + REPO + '/' + path, { method, body: body && JSON.stringify(body),
    headers: { authorization: 'Bearer ' + env.GH_TOKEN, accept: 'application/vnd.github+json', 'user-agent': 'ffs-bot', 'content-type': 'application/json' } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('GitHub: ' + (j.message || r.status));
  return j;
}
// все файлы — одним коммитом (одна сборка сайта вместо десяти)
async function commitFiles(env, files, message) {
  const ref = await ghApi(env, 'git/ref/heads/main');
  const base = await ghApi(env, 'git/commits/' + ref.object.sha);
  const tree = [];
  for (const f of files) {
    const blob = await ghApi(env, 'git/blobs', 'POST', { content: b64(f.bytes), encoding: 'base64' });
    tree.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
  }
  const t = await ghApi(env, 'git/trees', 'POST', { base_tree: base.tree.sha, tree });
  const c = await ghApi(env, 'git/commits', 'POST', { message, tree: t.sha, parents: [ref.object.sha] });
  await ghApi(env, 'git/refs/heads/main', 'PATCH', { sha: c.sha });
}
const pjson = P => ({ path: 'products.json', bytes: new TextEncoder().encode(JSON.stringify(P, null, 1)) });
async function loadP(env) { const f = await gh(env, 'products.json'); return { sha: f.sha, P: JSON.parse(new TextDecoder().decode(unb64(f.content))) }; }
async function saveP(env, P, sha, message) {
  await gh(env, 'products.json', { method: 'PUT', body: JSON.stringify({ message, sha, content: b64(new TextEncoder().encode(JSON.stringify(P, null, 1))) }) });
}
function parseItem(text, P) {
  const parts = text.replace(/^\/add(@\w+)?\s*/i, '').split('|').map(s => s.trim());
  if (parts.length < 3) return null;
  let [title, size, bynS, rubS] = parts;
  const flags = parts.join(' ').toLowerCase().replace(/ё/g, 'е');   // метки можно писать где угодно, даже без «|»
  const byn = parseInt(bynS, 10), rub = parseInt((String(rubS || '').match(/\d[\d\s]*/) || ['0'])[0].replace(/\s/g, ''), 10) || 0;
  const SZ = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL'];
  const rg = String(size).toUpperCase().replace(/XXL/g, '2XL').match(/^(\d?X{0,1}[SML]|\dXL|XL)\s*[-–—]\s*(\d?X{0,1}[SML]|\dXL|XL)$/);
  if (rg && SZ.includes(rg[1]) && SZ.includes(rg[2])) size = SZ.slice(SZ.indexOf(rg[1]), SZ.indexOf(rg[2]) + 1).join(' / ');
  if (!title || !size || !byn) return null;
  const boots = /бутс|boots|nike|adidas|puma|mizuno|predator|mercurial|phantom|tiempo|f50|copa|future/i.test(flags) && !/джерси/i.test(flags);
  const o = { id: Math.max(0, ...P.map(p => p.id)) + 1, cat: boots ? 'boots' : 'jersey', auth: /оригинал/.test(flags) ? 'original' : 'replica', title };
  if (!boots) {
    const club = Object.keys(CLUBS).sort((a, b) => b.length - a.length).find(c => title.toLowerCase().startsWith(c.toLowerCase()));
    const same = club && P.find(p => p.club === club);
    const y = (title.match(/\b(\d{2})\/\d{2}\b/) || [])[1];
    Object.assign(o, {
      club: club || title.split(/\s\d/)[0], league: same ? same.league : CLUBS[club] || '',
      era: y ? (+y <= 19 || +y >= 80 ? 'Ретро' : 'Современные') : 'Современные',
      named: /\s\d{1,2}$/.test(title.replace(/·.*$/, '').trim()) ? 'С фамилией' : 'Без фамилии',
      sleeve: /длинн/.test(flags) ? 'Длинный' : 'Короткий', version: /игров/.test(flags) ? 'Игровая' : 'Фанатская' });
  } else {
    const brand = (title.match(/^(Nike|Adidas|Puma|Mizuno|New Balance)/i) || [])[1] || '';
    Object.assign(o, { brand, model: title.replace(new RegExp('^' + brand + '\\s*', 'i'), '').split('·')[0].trim(),
      surface: /\bag\b/i.test(title) ? 'AG (искусственный газон)' : /\bfg\b/i.test(title) ? 'FG (натуральный газон)' : '' });
    if (/б\/у|бу\b/.test(flags)) o.state = 'Б/у';
  }
  Object.assign(o, { size, byn });
  if (rub) o.rub = rub;
  o.stock = /под заказ/.test(flags) ? 'Под заказ' : 'В наличии';
  if (o.stock === 'Под заказ') o.sup = true;
  else if (o.cat === 'boots') o.ship = 'warehouse'; // бутсы в наличии: доставка 4–10 дней
  return o;
}
const say = (env, chat, text, extra = {}) => tg(env, 'sendMessage', { chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
const HELP =
  '🛠 <b>Добавить товар</b>\n' +
  '1. Пришли сюда фото (по одному или альбомом). Первое фото будет главным.\n' +
  '2. Отправь строку:\n<code>/add Название | Размер | BYN | ₽ | метки</code>\n\n' +
  'Примеры:\n<code>/add Челси 19/20 третья Ковачич 17 | S | 75 | 2690</code>\n' +
  '<code>/add Арсенал 26/27 домашняя | M | 50 | 1890 | игровая</code>\n' +
  '<code>/add Nike Phantom GT2 Elite FG | 42.5 (27 см) | 360 | 11490 | оригинал б/у</code>\n\n' +
  'Метки (необязательно): игровая, оригинал, под заказ, б/у, длинный рукав. ₽ можно не писать — посчитается по курсу.\n\n' +
  '<b>Другое:</b>\n/photos 12 — заменить фото у товара (сначала пришли фото)\n/list — последние товары с номерами\n/sold 45 — убрать проданный товар\n/price 45 70 2490 — новая цена (BYN и ₽)\n/cancel — сбросить присланные фото';

async function download(env, ph, prefix) {
  const out = [];
  for (let i = 0; i < ph.length; i++) {
    const f = await (await tg(env, 'getFile', { file_id: ph[i].file_id })).json();
    const bytes = new Uint8Array(await (await fetch('https://api.telegram.org/file/bot' + token(env) + '/' + f.result.file_path)).arrayBuffer());
    out.push({ path: prefix + '_' + (i + 1) + '.jpg', bytes });
  }
  return out;
}
async function adminCmd(env, msg) {
  const chat = msg.chat.id, text = (msg.text || msg.caption || '').trim(), d = await db(env);
  if (msg.photo) {
    const f = msg.photo[msg.photo.length - 1];
    await d.prepare('INSERT INTO draft (uid, mid, file_id) VALUES (?, ?, ?)').bind(chat, msg.message_id, f.file_id).run();
    const n = (await d.prepare('SELECT COUNT(*) AS n FROM draft WHERE uid=?').bind(chat).all()).results[0].n;
    if (n === 1) await say(env, chat, '📷 Фото принимаю. Когда пришлёшь все, отправь:\n• новый товар — <code>/add Название | Размер | BYN | ₽</code>\n• или заменить фото у товара — <code>/photos номер</code>\n(подсказка — /help)');
    return true;
  }
  if (/^\/(help|admin)/.test(text)) { await say(env, chat, HELP); return true; }
  if (/^\/cancel/.test(text)) { await d.prepare('DELETE FROM draft WHERE uid=?').bind(chat).run(); await say(env, chat, '🗑 Фото сброшены.'); return true; }
  if (!/^\/(add|list|sold|del|price|photos)/.test(text)) return false;
  if (!env.GH_TOKEN) { await say(env, chat, '❌ Не задан секрет GH_TOKEN в Cloudflare.'); return true; }
  try {
    const { sha, P } = await loadP(env);
    if (/^\/list/.test(text)) {
      await say(env, chat, '📋 <b>Товары</b> (номер — название — размер — цена):\n\n' + [...P].sort((a, b) => b.id - a.id).slice(0, 40).map(p => `<b>${p.id}</b> — ${esc(p.title)} — ${esc(p.size)} — ${p.byn || '?'} BYN`).join('\n'));
      return true;
    }
    if (/^\/(sold|del)/.test(text)) {
      const id = parseInt(text.split(/\s+/)[1], 10), p = P.find(x => x.id === id);
      if (!p) { await say(env, chat, '❌ Нет товара с номером ' + (id || '?') + '. Номера — /list'); return true; }
      await saveP(env, P.filter(x => x.id !== id), sha, 'Продано: ' + p.title);
      await say(env, chat, '✅ Убрал с сайта: <b>' + esc(p.title) + '</b>\nНа сайте обновится через 1–2 минуты.');
      return true;
    }
    if (/^\/price/.test(text)) {
      const [, idS, bynS, rubS] = text.split(/\s+/), p = P.find(x => x.id === parseInt(idS, 10));
      if (!p || !parseInt(bynS, 10)) { await say(env, chat, '❌ Формат: <code>/price 45 70 2490</code> (номер, BYN, ₽)'); return true; }
      p.byn = parseInt(bynS, 10); if (parseInt(rubS, 10)) p.rub = parseInt(rubS, 10); else delete p.rub;
      await saveP(env, P, sha, 'Цена: ' + p.title);
      await say(env, chat, '✅ Новая цена у <b>' + esc(p.title) + '</b>: ' + p.byn + ' BYN' + (p.rub ? ' / ' + p.rub + ' ₽' : ''));
      return true;
    }
    if (/^\/photos/.test(text)) {
      const id = parseInt(text.split(/\s+/)[1], 10), p = P.find(x => x.id === id);
      if (!p) { await say(env, chat, '❌ Формат: <code>/photos 12</code> (номер товара из /list). Сначала пришли фото.'); return true; }
      const ph = (await d.prepare('SELECT file_id FROM draft WHERE uid=? ORDER BY mid').bind(chat).all()).results;
      if (!ph.length) { await say(env, chat, '❌ Сначала пришли фото, потом <code>/photos ' + id + '</code>'); return true; }
      await say(env, chat, '⏳ Загружаю ' + ph.length + ' фото…');
      const imgs = await download(env, ph, 'img/p' + id + '_' + Date.now().toString(36));
      const paths = imgs.map(f => f.path);
      const fresh = await loadP(env), q = fresh.P.find(x => x.id === id);
      q.photos = paths;
      await saveWithImgs(env, imgs, fresh.P, 'Новые фото: ' + q.title);
      await d.prepare('DELETE FROM draft WHERE uid=?').bind(chat).run();
      await say(env, chat, '✅ Заменил фото у <b>' + esc(q.title) + '</b>: теперь ' + paths.length + ' шт. Первое — главное.', { reply_markup: appBtn('👀 Посмотреть', '?p=' + id) });
      return true;
    }
    // /add
    const o = parseItem(text, P);
    if (!o) { await say(env, chat, '❌ Не понял строку. Нужно так:\n<code>/add Название | Размер | BYN | ₽</code>\nПодробнее — /help'); return true; }
    const ph = (await d.prepare('SELECT file_id FROM draft WHERE uid=? ORDER BY mid').bind(chat).all()).results;
    if (!ph.length) { await say(env, chat, '❌ Сначала пришли фото товара, потом строку /add.'); return true; }
    await say(env, chat, '⏳ Загружаю ' + ph.length + ' фото…');
    const fresh = await loadP(env);
    o.id = Math.max(o.id, ...fresh.P.map(p => p.id + 1));
    const imgs = await download(env, ph, 'img/p' + o.id + '_' + Date.now().toString(36));
    o.photos = imgs.map(f => f.path);
    await saveWithImgs(env, imgs, [o, ...fresh.P].sort((a, b) => b.id - a.id), 'Добавлен: ' + o.title);
    await d.prepare('DELETE FROM draft WHERE uid=?').bind(chat).run();
    const rows = [['Категория', o.cat === 'boots' ? 'Бутсы' : 'Джерси'], ['Клуб', o.club], ['Лига', o.league], ['Тип', o.era], ['Версия', o.version],
      ['Размер', o.size], ['Цена', o.byn + ' BYN' + (o.rub ? ' / ' + o.rub + ' ₽' : ' (₽ по курсу)')], ['Наличие', o.stock], ['Оригинал/реплика', o.auth === 'original' ? 'Оригинал' : 'Реплика']]
      .filter(r => r[1]).map(r => r[0] + ': ' + esc(r[1])).join('\n');
    await say(env, chat, '✅ <b>Добавлено на сайт</b> (номер ' + o.id + ')\n' + esc(o.title) + '\n\n' + rows + '\n\nПоявится через 1–2 минуты. Ошибся — /sold ' + o.id + ' и добавь заново.',
      { reply_markup: appBtn('👀 Посмотреть', '?p=' + o.id) });
  } catch (e) { await say(env, chat, '❌ Ошибка: ' + esc(e.message)); }
  return true;
}

async function handle(env, update) {
  // заявка на вступление в канал → приветствие с каталогом, затем одобряем заявку
  const jr = update.chat_join_request;
  // заявка в другой канал (например, «Футбольные вещи из WB & OZON») → сначала подписка на FFS
  if (jr && (jr.chat.username || '').toLowerCase() !== MAIN_CHANNEL) {
    await tg(env, 'sendMessage', {
      chat_id: jr.user_chat_id || jr.from.id, parse_mode: 'HTML',
      text: '👋 Привет! Чтобы мы приняли заявку в <b>' + esc(jr.chat.title) + '</b>, подпишись на наш основной канал ' +
        '<b>FootballFitStore</b> — там джерси клубов и бутсы с доставкой по СНГ 👇',
      reply_markup: { inline_keyboard: [
        [{ text: '📢 Подписаться на FootballFitStore', url: 'https://t.me/' + MAIN_CHANNEL }],
        [{ text: '🛍 Каталог джерси и бутс', web_app: { url: SHOP } }],
      ] },
    }).catch(() => {});
    return;
  }
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
  const cq = update.callback_query;
  if (cq && String(cq.data || '').startsWith('chk:')) {
    const chatId = Number(cq.data.slice(4)), uid = cq.from.id;
    const m = await (await tg(env, 'getChatMember', { chat_id: '@' + MAIN_CHANNEL, user_id: uid })).json().catch(() => ({}));
    const st = m.ok && m.result.status;
    const subscribed = ['member', 'administrator', 'creator'].includes(st) || (st === 'restricted' && m.result.is_member);
    if (m.ok && !subscribed) {
      await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, show_alert: true,
        text: 'Ты ещё не подписан на FootballFitStore 🙂 Подпишись и нажми «✅ Я подписался» ещё раз.' });
      return;
    }
    // подписан (или проверить не удалось — тогда не задерживаем человека)
    await tg(env, 'approveChatJoinRequest', { chat_id: chatId, user_id: uid }).catch(() => {});
    await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: '✅ Заявка принята!' });
    if (cq.message) await tg(env, 'editMessageText', {
      chat_id: cq.message.chat.id, message_id: cq.message.message_id, parse_mode: 'HTML',
      text: '✅ <b>Готово! Заявка принята</b> — добро пожаловать!\n\n🛍 А вот наш каталог джерси и бутс с ценами и размерами 👇',
      reply_markup: KEYBOARD,
    });
    return;
  }
  const msg = update.message;
  if (!msg || !msg.chat || msg.chat.type !== 'private') return;
  const text = msg.text || '';
  if (text.startsWith('/myid')) { await say(env, msg.chat.id, 'Твой Telegram ID: <code>' + msg.chat.id + '</code>'); return; }
  if (env.DB && admin(env, msg.chat.id) && await adminCmd(env, msg)) return;
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
    if (request.method === 'GET' && url.pathname.startsWith('/img/')) return serveImg(env, request, ctx, url.pathname.slice(1));
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
        allowed_updates: ['message', 'chat_join_request', 'callback_query'],
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
