import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=', 'base64');
const files = count => Array.from({length: count}, (_, i) => ({name: `image-${i}.png`, mimeType: 'image/png', buffer: png}));
const server = await createServer({server:{host:'127.0.0.1',port:0,open:false,watch:null}});
await server.listen();
const browser = await chromium.launch({executablePath: process.env.TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
try {
  const page = await browser.newPage({viewport:{width:900,height:700}}), errors=[];
  page.on('pageerror', error => errors.push(error.message));
  const url = server.resolvedUrls.local[0] + 'tests/fixtures/composer-workbench.html';
  await page.goto(url);
  const input = page.locator('input[accept*="image/png"]'), region = page.locator('.composer-attachments');
  await input.setInputFiles(files(12));
  await page.waitForFunction(() => document.querySelectorAll('.composer-attachments figure').length === 12);
  assert(await region.evaluate(element => element.scrollWidth > element.clientWidth), 'image row can scroll horizontally');
  await region.evaluate(element => { element.scrollLeft = element.scrollWidth; });
  assert(await region.evaluate(element => element.scrollLeft > 0));
  await mkdir('.tmp/qa/many-images', {recursive:true});
  await page.screenshot({path:'.tmp/qa/many-images/composer.png'});
  await page.getByRole('button',{name:'移除 image-11.png'}).click();
  assert.equal(await region.locator('figure').count(), 11);
  await page.getByRole('button',{name:'发送',exact:true}).click();
  assert.equal(await page.evaluate(() => window.fixtureAttachments.length), 11);
  assert.equal(await region.count(), 0);
  await page.goto(url + '?cloud-images');
  await page.locator('input[accept*="image/png"]').setInputFiles(files(9));
  await page.waitForFunction(() => document.querySelectorAll('.composer-attachments figure').length === 9);
  await page.getByRole('button',{name:'发送',exact:true}).click();
  assert.equal(await page.evaluate(() => window.fixtureSendCount || 0), 0);
  assert.match(await page.evaluate(() => window.notices.at(-1)), /最多 8 张/);
  assert.equal(await page.locator('.composer-attachments figure').count(), 9, 'rejected Cloud send preserves draft');
  assert.deepEqual(errors, []);
  console.log('PASS 12 images, horizontal scrolling, removal, full send and explicit Cloud limit without losing the draft.');
} finally { await browser.close(); await server.close(); }
