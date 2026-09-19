const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('@playwright/test');

(async () => {
  const browser = await chromium.launch({headless:true});
  try {
    const page = await browser.newPage();
    const requests = [], errors = [];
    page.on('pageerror',e=>errors.push(e.message));
    const subscriber = {id:'synthetic',status:'active',source:'manual',email:'test@example.invalid',
      wantsEmail:true,wantsSms:false,createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z',managementUrl:'/manage'};
    // Every request is fulfilled locally; no application or provider traffic escapes.
    await page.route('**/*',async route=>{
      const req=route.request(), url=new URL(req.url());
      if (url.pathname.startsWith('/api/')) {
        assert.equal(req.method(),'GET','Browser test must never send a message');
        requests.push(url);
        let payload={ok:true};
        if(url.pathname==='/api/admin/test-alert') {
          payload={ok:true,subscribers:[subscriber],page:Number(url.searchParams.get('page')||1),pageSize:20};
          if(url.searchParams.get('includeStats')!=='0') Object.assign(payload,{total:40,summary:{total:40,active:40},dailyStats:[]});
          if(url.searchParams.get('emailSearch') && url.searchParams.get('exactSearch')==='0') {
            payload.nextSearchCursor=url.searchParams.has('searchCursor')?null:'cursor-25';
            payload.subscribers=url.searchParams.has('searchCursor')?[]:[subscriber];
          }
        } else if(url.pathname==='/api/admin/subscriber-history') payload={ok:true,subscriber,messages:[],total:0,limit:250};
        await route.fulfill({json:payload});return;
      }
      if(url.hostname!=='vibecheck.local') { await route.fulfill({status:204,body:''});return; }
      let file=path.join(process.cwd(),'client/dist',url.pathname);
      if(!fs.existsSync(file)||fs.statSync(file).isDirectory())file=path.join(process.cwd(),'client/dist/index.html');
      const type=file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':file.endsWith('.svg')?'image/svg+xml':'text/html';
      await route.fulfill({contentType:type,body:fs.readFileSync(file)});
    });
    await page.goto('http://vibecheck.local/admin');
    await page.getByRole('checkbox',{name:'Exact match'}).waitFor();
    await page.getByRole('button',{name:'Next',exact:true}).click();
    await page.waitForFunction(()=>document.body.textContent.includes('Page 2'));
    assert.ok(requests.some(u=>u.searchParams.get('page')==='2'&&u.searchParams.get('includeStats')==='0'));
    await page.getByRole('searchbox').fill('test@example.invalid');
    await Promise.all([page.waitForResponse(r=>r.url().includes('emailSearch=')&&r.url().includes('exactSearch=1')),
      page.getByRole('button',{name:'Search',exact:true}).click()]);
    await Promise.all([page.waitForResponse(r=>r.url().includes('searchCursor=cursor-25')),
      page.getByRole('checkbox',{name:'Exact match'}).uncheck()]);
    assert.ok(await page.getByText('test@example.invalid',{exact:true}).count());

    await page.clock.install();
    await Promise.all([page.waitForResponse(r=>r.url().includes('/api/admin/subscriber-history')),
      page.goto('http://vibecheck.local/admin/history?subscriber=synthetic')]);
    await page.evaluate(()=>Object.defineProperty(document,'hidden',{configurable:true,value:true}));
    let before=requests.filter(u=>u.pathname.endsWith('subscriber-history')).length;
    await page.clock.fastForward(120_000);
    assert.equal(requests.filter(u=>u.pathname.endsWith('subscriber-history')).length,before);
    await page.evaluate(()=>Object.defineProperty(document,'hidden',{configurable:true,value:false}));
    await Promise.all([page.waitForResponse(r=>r.url().includes('/api/admin/subscriber-history')),
      page.clock.fastForward(60_000)]);
    assert.equal(requests.filter(u=>u.pathname.endsWith('subscriber-history')).length,before+1);
    assert.deepEqual(errors,[]);
    console.log('Admin browser checks passed: exact/partial search, summary reuse, hidden-tab polling. All traffic mocked.');
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
