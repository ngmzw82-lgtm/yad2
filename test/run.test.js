// בדיקה עם נתוני דמה (בלי רשת): בסיס התחלתי, מודעה חדשה, מודעה ישנה שהוקפצה, מודעה מחוץ לטווח, שליחת מייל, כשלון שליחה וניסיון חוזר
const assert = require('assert');
process.env.STATE_FILE = require('path').join(require('os').tmpdir(), 'yad2-test-state.json');
const scan = require('../scan.js');
const now = Date.now();
const ago = (m) => new Date(now - m * 60000).toISOString();
let feed = [];
const sent = [];
let mailFail = false;
globalThis.fetch = async (url, opts) => {
  url = String(url);
  const json = (o, ok = true, status = 200) => ({ ok, status, text: async () => JSON.stringify(o) });
  if (url.startsWith('https://script.google.com/')) {
    if (mailFail) return { ok: true, status: 200, text: async () => 'error: x' };
    sent.push(JSON.parse(opts.body).subject); return { ok: true, status: 200, text: async () => 'ok' };
  }
  if (url.includes('feed-search')) return json({ data: { feed: feed } });
  if (url.includes('vehicles-item')) {
    const t = url.split('/').pop();
    const it = feed.find((x) => x.token === t);
    return json({ token: t, dates: { createdAt: it ? it.dates.createdAt : ago(0) } });
  }
  return json({}, false, 404);
};
const car = (token, created, price, km) => ({ token, manufacturer: { text: 'טויוטה' }, model: { text: 'קורולה' }, year: 2020, price, km, dates: { createdAt: created } });
(async () => {
  scan.setConfig({ mail: { scriptUrl: 'https://script.google.com/macros/s/ABC/exec', scriptSecret: 's', emailTo: 'a@b.c' } });
  const agent = { id: 'x', name: 'בדיקה', feedUrl: 'https://gw.yad2.co.il/feed-search-vehicles/cars?price=-1-100000&year=2018-2024', pageUrl: 'https://www.yad2.co.il/vehicles/cars?price=-1-100000&year=2018-2024', pages: 1 };
  const st = {};
  feed = [car('AAAAA1', ago(5000), 50000, 40000), car('AAAAA2', ago(6000), 60000, 30000)];
  let r = await scan.runAgent(agent, st, 't1');
  assert(r.ok && st.baselineDone && sent.length === 0, 'baseline: בלי התראות');

  feed.unshift(car('NEWAAA1', ago(2), 70000, 20000));          // חדשה ותואמת
  feed.unshift(car('OLDBUMP', ago(60 * 24 * 10), 55000, 10000)); // ישנה שהוקפצה
  feed.unshift(car('TOOPRICY', ago(1), 150000, 10000));         // מחוץ לטווח מחיר
  r = await scan.runAgent(agent, st, 't2');
  assert.strictEqual(sent.length, 1, 'רק מודעה אחת חדשה צריכה לשלוח מייל, נשלחו: ' + sent.length);
  assert(/קורולה/.test(sent[0]));

  r = await scan.runAgent(agent, st, 't3');
  assert.strictEqual(sent.length, 1, 'אין שליחה כפולה');

  mailFail = true;
  feed.unshift(car('NEWAAA2', ago(1), 71000, 21000));
  await scan.runAgent(agent, st, 't4');
  assert.strictEqual(sent.length, 1, 'שליחה נכשלה');
  mailFail = false;
  await scan.runAgent(agent, st, 't5');
  assert.strictEqual(sent.length, 2, 'ניסיון חוזר הצליח');
  await scan.runAgent(agent, st, 't6');
  assert.strictEqual(sent.length, 2, 'אין שליחה כפולה אחרי הצלחה');

  // כשלון סריקה
  const bad = Object.assign({}, agent, { feedUrl: 'https://gw.yad2.co.il/other' });
  const st2 = {};
  r = await scan.runAgent(bad, st2, 't7');
  assert(!r.ok && st2.failures === 1);
  console.log('כל הבדיקות עברו ✔');
})().catch((e) => { console.error('נכשל:', e.message); process.exit(1); });
