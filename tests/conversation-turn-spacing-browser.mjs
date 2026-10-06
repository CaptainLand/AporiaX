import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { readFile } from 'node:fs/promises';

process.env.GOMAXPROCS ||= '2';
const server = await createServer({
  configFile:false,
  cacheDir:'.tmp/conversation-turn-spacing-vite',
  optimizeDeps:{entries:['tests/fixtures/conversation-turn-spacing.html']},
  server:{host:'127.0.0.1',port:0,open:false,watch:null},
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({executablePath:process.env.TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
  const page = await browser.newPage();
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/conversation-turn-spacing.html`);
  await page.locator('#files .edited-files-card').waitFor();
  if (process.argv.includes('--built-css')) {
    const index = await readFile('dist/index.html','utf8');
    const stylesheet = index.match(/href="\.\/(assets\/[^" ]+\.css)"/);
    assert(stylesheet,'built index must reference its CSS');
    const css = await readFile(`dist/${stylesheet[1]}`,'utf8');
    assert(css.includes('.message-list>:not(.user-message)+.user-message{margin-top:32px}'));
    await page.evaluate(()=>document.querySelectorAll('style,link[rel="stylesheet"]').forEach(element=>element.remove()));
    await page.addStyleTag({content:css});
    console.log('Checking the production stylesheet used by npm start');
  }
  for (const theme of ['light','dark']) {
    await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
    for (const width of [1280,736]) {
      await page.setViewportSize({width,height:900});
      const measurements=await page.evaluate(()=>{
        const gap=id=>{
          const prompt=document.querySelector(`#${id} .user-message:last-child`);
          return prompt.getBoundingClientRect().top-prompt.previousElementSibling.getBoundingClientRect().bottom;
        };
        return {files:gap('files'),plain:gap('plain'),consecutive:gap('consecutive'),firstMargin:getComputedStyle(document.querySelector('#files .user-message:first-child')).marginTop};
      });
      assert.equal(measurements.files,32,`${theme}/${width}: result card must not touch the next prompt`);
      assert(measurements.plain>=32,`${theme}/${width}: ordinary turns also remain separated`);
      assert.equal(measurements.consecutive,18,'consecutive user messages keep the original spacing');
      assert.equal(measurements.firstMargin,'0px','first prompt has no extra leading gap');
      console.log('PASS',theme,width,measurements);
    }
  }
  assert.deepEqual(errors,[]);
} finally {
  await browser?.close();
  await server.close();
}
