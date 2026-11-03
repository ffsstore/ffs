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

async function tg(env, method, body) {
  return fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// секрет для вебхука, вычисляется из токена (чтобы чужие не могли слать запросы)
async function hookSecret(env) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(env.BOT_TOKEN));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 40);
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

    // один раз открыть в браузере: …workers.dev/setup
    if (url.pathname === '/setup') {
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
      return new Response(j.ok ? '✅ Бот подключён! Напиши ему /start' : '❌ Ошибка: ' + j.description,
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
