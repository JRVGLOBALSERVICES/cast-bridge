const puppeteer = require('puppeteer-core');
(async () => {
  const b = await puppeteer.launch({executablePath:'/usr/bin/google-chrome',headless:'new',
    args:['--no-sandbox','--disable-dev-shm-usage','--lang=zh-CN']});
  const p = await b.newPage();
  await p.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
  const r = await p.goto('https://www.bilibili.com/video/BV1GJ411x7h7', {waitUntil:'domcontentloaded', timeout:30000}).catch(e=>({err:String(e)}));
  if (r.err) { console.log('nav failed:', r.err); await b.close(); return; }
  console.log('page status:', r.status(), '| title:', await p.title());
  const api = await p.evaluate(async () => {
    try {
      const res = await fetch('https://api.bilibili.com/x/web-interface/view?bvid=BV1GJ411x7h7', {credentials:'include'});
      const t = await res.text();
      return { status: res.status, head: t.slice(0,140) };
    } catch (e) { return { err: String(e) }; }
  });
  console.log('view api from page context:', JSON.stringify(api));
  const cookies = (await p.cookies()).map(c=>c.name);
  console.log('cookies acquired:', cookies.join(','));
  await b.close();
})();
