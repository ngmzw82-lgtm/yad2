// מדביקים בקונסול של ה-service worker של התוסף (chrome://extensions > "סוכן רכבים - יד 2" > service worker).
// אם Chrome חוסם הדבקה, כותבים קודם: allow pasting
chrome.storage.local.get('agents').then(async ({ agents }) => {
  const s = await chrome.storage.sync.get(['scriptUrl', 'scriptSecret', 'emailTo', 'alertUndated']);
  const out = {
    mail: { scriptUrl: s.scriptUrl || '', scriptSecret: s.scriptSecret || '', emailTo: s.emailTo || '' },
    alertUndated: !!s.alertUndated,
    agents: (agents || []).map((a) => ({ id: a.id, name: a.name, pageUrl: a.pageUrl, feedUrl: a.feedUrl, interval: a.interval, pages: a.pages, enabled: a.enabled })),
  };
  copy(JSON.stringify(out));
  console.log('הועתק ללוח. סוכנים: ' + out.agents.length + ', מייל: ' + (out.mail.scriptUrl && out.mail.emailTo ? 'מוגדר' : 'לא מוגדר'));
});
