import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer, preview } from 'vite';
import { chromium } from 'playwright-core';

const production = process.argv.includes('--production');
const server = production ? await preview({ preview: { host: '127.0.0.1', port: 0, open: false } })
  : await createServer({ server: { host: '127.0.0.1', port: 0, open: false, watch: null } });
let browser;
try {
  if (!production) await server.listen();
  browser = await chromium.launch({ executablePath: process.env.TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  // Dev Vite injects CSS through style tags; production uses CSP-safe links.
  const page = await browser.newPage({ viewport: { width: 1360, height: 950 }, bypassCSP: !production });
  page.setDefaultTimeout(15000);
  const errors = []; page.on('pageerror', error => { errors.push(error.message); console.error('PAGE ERROR:', error.message); });
  await page.addInitScript(() => {
    if (!localStorage.getItem('delivery-fixture-started')) {
      localStorage.clear(); localStorage.setItem('delivery-fixture-started', 'yes');
      localStorage.setItem('aporiax.language.v1', 'zh-CN'); localStorage.setItem('aporiax.theme.v2', 'light');
      localStorage.setItem('aporiax.session-ui.v1', JSON.stringify({ taskId: 'delivery-ui', welcomeDismissed: true }));
    }
    const task = { id: 'delivery-ui', title: '回复展示检查', workspaceName: 'Fixture', workspacePath: 'D:/Fixture',
      providerId: 'fixture', modelId: 'fixture', messages: [], createdAt: '2026-10-21T00:00:00Z' };
    window.desktop = {
      theme: { set: async () => {} }, account: { get: async () => ({ status: 'anonymous' }) },
      providers: { list: async () => [{ id: 'fixture', name: 'Fixture', models: [{ id: 'fixture', name: 'Fixture', supportsTools: true }] }] },
      tasks: { load: async () => JSON.parse(localStorage.getItem('delivery-fixture-tasks') || 'null') || [task],
        save: async tasks => { localStorage.setItem('delivery-fixture-tasks', JSON.stringify(tasks)); } },
      harness: { onEvent: () => () => {}, recoverableRuns: async () => [], run: async () => {
        window.fixtureRuns = (window.fixtureRuns || 0) + 1;
        return { status: 'completed', replyDelivered: true, content: ['计算器做好了，直接打开 calc.html 就能用。支持常用运算和键盘输入，没有覆盖原来的文件。', '预览服务在任务结束后会停止；之后请直接打开文件。'].join(String.fromCharCode(10, 10)),
          deliveryDetails: ['## 具体分析', '', '第 194 行的计算需要统一单位。', '', '```js', 'const angle = value / Math.PI;', '```', '', '验证说明：仅检查代码，未运行浏览器；实际效果仍需验证。', '', '<script>window.UNSAFE_DETAILS = true</script>'].join(String.fromCharCode(10)),
          anchor: { id: 'fixture-anchor' }, steps: [], subagents: [], changes: [
            { path: '12345.txt', created: true, beforeContent: '', afterContent: '12345\n', additions: 2, deletions: 0 },
            { path: 'old.txt', deleted: true, afterMissing: true, beforeContent: 'original\n', afterContent: '', additions: 0, deletions: 1 },
            { path: 'existing.txt', beforeContent: 'before\n', afterContent: 'after\n', additions: 1, deletions: 1 },
            { path: 'new.png', binary: true, created: true, beforeMissing: true, afterContent: '' },
          ] };
      } },
      sandbox: { status: async () => ({ localAvailable: true }) }, workspace: { listTree: async () => ({ entries: [] }) },
      workbench: { subscribe: () => () => {}, request: async input => input.action === 'list' ? [] : true },
    };
  });
  await page.goto(server.resolvedUrls.local[0]);
  if (await page.locator('.ax-welcome__enter').isVisible()) await page.locator('.ax-welcome__enter').click();
  const input = page.getByRole('textbox', { name: '任务输入', exact: true });
  await input.fill('合成展示测试，不请求真实模型。'); await input.press('Enter');
  const disclosure = page.locator('.assistant-delivery-details');
  await disclosure.waitFor({ state: 'attached' });
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('delivery-fixture-tasks') || '[]').some(task => task.messages?.some(message => message.deliveryDetails)));
  assert.equal(await page.evaluate(() => window.fixtureRuns), 1, 'the fixture submits only one synthetic turn');
  await page.evaluate(() => {
    const tasks = JSON.parse(localStorage.getItem('delivery-fixture-tasks'));
    for (const task of tasks) for (const message of task.messages || []) if (message.role === 'assistant') {
      message.progressUpdates = [
        { id: 'progress-one', kind: 'progress', title: '阶段进展', content: '先核对工作区中的目标文件，避免误改其他文件。' },
        { id: 'progress-plan', kind: 'plan', title: '计划', explanation: '按顺序处理。', steps: [{ id: 'p1', title: '核对目标文件', status: 'completed' }, { id: 'p2', title: '完成修改', status: 'completed' }] },
        { id: 'progress-last', kind: 'progress', title: '阶段进展', content: '文件处理完成，最后一条进展仍完整保留。' },
      ];
    }
    localStorage.setItem('delivery-fixture-tasks', JSON.stringify(tasks));
  });
  await page.reload();
  await page.locator('.ax-welcome__enter, .thread-view-tabs').first().waitFor();
  if (await page.locator('.ax-welcome__enter').isVisible()) await page.locator('.ax-welcome__enter').click();
  await disclosure.waitFor({ state: 'attached' });
  await mkdir('.tmp/qa/user-facing-delivery', { recursive: true });
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    const progress = page.locator('.assistant-progress-disclosure');
    const progressToggle = progress.locator('summary');
    const progressLine = progress.locator('.assistant-progress-line');
    assert.equal(await progressToggle.innerText(), '', 'collapsed progress shows only a line');
    assert.equal(await progressToggle.getAttribute('aria-label'), '展开任务进展');
    assert.equal(await progress.getAttribute('open'), null);
    assert.equal(await progress.locator('.assistant-progress-journal').isVisible(), false, 'no preview text leaks when closed');
    assert.equal(await progressLine.evaluate(element => getComputedStyle(element).height), '1px');
    const lineTone = await progressLine.evaluate(element => ({
      actual: getComputedStyle(element).getPropertyValue('--progress-rule-color').trim(),
      expected: getComputedStyle(document.documentElement).getPropertyValue('--gray-6').trim(),
    }));
    assert.equal(lineTone.actual, lineTone.expected, 'line uses the near-black border tone in dark mode, with no blue tint');
    const metadata = await page.locator('.assistant-message-heading').evaluate(header => {
      return ['.aporiax-run-duration', '.turn-anchor-button'].map(selector => {
        const element = header.querySelector(selector), style = getComputedStyle(element), rect = element.getBoundingClientRect();
        return { border: style.borderTopWidth, background: style.backgroundColor, shadow: style.boxShadow, height: rect.height, center: rect.top + rect.height / 2 };
      });
    });
    for (const item of metadata) {
      assert.equal(item.border, '0px', 'time and Anchor have no outline');
      assert.equal(item.background, 'rgba(0, 0, 0, 0)', 'metadata has no default pill background');
      assert.equal(item.shadow, 'none');
      assert.equal(item.height, 22);
    }
    assert.ok(Math.abs(metadata[0].center - metadata[1].center) < 0.5, 'metadata controls stay aligned');
    assert.match(await progressLine.evaluate(element => getComputedStyle(element).backgroundImage), /linear-gradient\(90deg/);
    assert.match(await progressLine.evaluate(element => getComputedStyle(element).backgroundImage), /60%/, 'the shortened line keeps its original fade');
    const lineLayout = await progressLine.evaluate(line => {
      const disclosure = line.closest('.assistant-progress-disclosure');
      const assistant = disclosure.closest('.assistant-message');
      const header = assistant.querySelector('.assistant-message-heading');
      const body = assistant.querySelector(':scope > .assistant-message-content');
      return { ratio: line.getBoundingClientRect().width / disclosure.getBoundingClientRect().width,
        gap: line.getBoundingClientRect().top - header.getBoundingClientRect().bottom,
        bodyGap: body.getBoundingClientRect().top - line.getBoundingClientRect().bottom };
    });
    assert.ok(Math.abs(lineLayout.ratio - 0.375) < 0.01, 'line and click target are half their previous width');
    assert.ok(lineLayout.gap >= 0 && lineLayout.gap <= 4, 'line sits close to AporiaX without overlapping its controls');
    assert.ok(lineLayout.bodyGap >= 0 && lineLayout.bodyGap <= 20, 'reply moves up into the old 14px spacer without overlapping the click area');
    assert.ok((await progressToggle.boundingBox()).height >= 20, 'the thin line has an easier click target');
    await page.mouse.move(0, 0);
    await progressLine.evaluate(async element => { await Promise.all(element.getAnimations().map(animation => animation.finished)); });
    const dim = await progressLine.evaluate(element => Number(getComputedStyle(element).opacity));
    assert.ok(dim <= 0.6, 'the collapsed rule stays quiet by default');
    await progressToggle.hover();
    await progressLine.evaluate(async element => { await Promise.all(element.getAnimations().map(animation => animation.finished)); });
    assert.ok(await progressLine.evaluate(element => Number(getComputedStyle(element).opacity)) > dim, 'hover visibly brightens the line');
    await progressToggle.click();
    assert.equal(await progress.locator('.assistant-progress-journal').evaluate(element => getComputedStyle(element).animationName), 'none', 'opening reveals all progress immediately, without staggered or fade-in animation');
    await progress.getByText('文件处理完成，最后一条进展仍完整保留。', { exact: true }).waitFor();
    assert.equal(await progress.locator('.assistant-progress-entry').count(), 3, 'all progress entries and the plan remain available');
    const fullJournal = await progress.locator('.assistant-progress-journal').evaluate(element => {
      const style = getComputedStyle(element), bounds = element.getBoundingClientRect();
      return { maxHeight: style.maxHeight, overflow: style.overflowY, mask: style.maskImage,
        height: bounds.height, bottom: bounds.bottom, lastBottom: element.lastElementChild.getBoundingClientRect().bottom };
    });
    assert.equal(fullJournal.maxHeight, 'none', 'no old 78px height cap remains');
    assert.equal(fullJournal.overflow, 'visible');
    assert.equal(fullJournal.mask, 'none', 'no partial-preview mask remains');
    assert.ok(fullJournal.height > 78 && fullJournal.lastBottom <= fullJournal.bottom + 1, 'the last entry is inside the full expanded layout, not merely present in clipped DOM');
    await progress.getByText('先核对工作区中的目标文件，避免误改其他文件。', { exact: true }).click();
    assert.equal(await progress.locator('.assistant-progress-journal').getAttribute('role'), null, 'journal text is not a second disclosure button');
    assert.equal(await progress.locator('.manual-expanded').count(), 0);
    assert.equal(await progress.getAttribute('open'), '', 'clicking progress text does not trigger the retired second fold');
    await progress.getByText('核对目标文件', { exact: true }).waitFor();
    await progressToggle.focus(); await page.keyboard.press('Enter');
    assert.equal(await progress.locator('.assistant-progress-journal').isVisible(), false);
    await page.keyboard.press('Space');
    await progress.locator('.assistant-progress-journal').waitFor();
    await progressToggle.click();
    const summary = page.locator('.assistant-delivery-toggle');
    assert.equal(await summary.innerText(), '', 'only an arrow is visible');
    assert.equal(await summary.getAttribute('aria-label'), '展开回复', 'icon-only disclosure keeps its accessible name');
    assert.equal(await summary.locator('svg').count(), 1);
    assert.ok((await summary.boundingBox()).height >= 24, 'the arrow retains a usable click target');
    assert.equal(await summary.getAttribute('aria-expanded'), 'false', 'details default to collapsed, including after reload');
    const inline = await summary.evaluate(button => {
      const paragraph = button.parentElement;
      const range = document.createRange(); range.setStart(paragraph, 0); range.setEndBefore(button);
      const last = [...range.getClientRects()].filter(rect => rect.width > 0).at(-1);
      const arrow = button.getBoundingClientRect();
      return { tag: paragraph.tagName, gap: arrow.left - last.right, line: Math.abs(arrow.top + arrow.height / 2 - last.top - last.height / 2) };
    });
    assert.equal(inline.tag, 'P', 'the arrow belongs to the last prose paragraph');
    assert.ok(inline.gap >= 0 && inline.gap < 10 && inline.line < 5, 'arrow follows the final punctuation on the same line');
    assert.equal(await page.getByText('第 194 行的计算需要统一单位。', { exact: true }).isVisible(), false);
    assert.equal(await page.getByText(/仅检查代码，未运行浏览器/).isVisible(), false, 'routine check notes stay in the full reply');
    assert.equal(await page.getByText(/预览服务在任务结束后会停止/).isVisible(), true, 'important usage instructions remain visible');
    assert.equal(await page.locator('.edited-files-card').isVisible(), false, 'file results default to folded');
    await summary.focus(); await page.keyboard.press('Enter');
    assert.equal(await summary.evaluate(element => element === document.activeElement), true, 'toggling does not remount the button or lose keyboard focus');
    assert.equal(await summary.getAttribute('aria-expanded'), 'true');
    assert.equal(await disclosure.locator('.edited-files-card').isVisible(), true, 'file results share the reply disclosure');
    await disclosure.getByRole('button', { name: '审核', exact: true }).click();
    await page.locator('.review-panel:not(.turn-anchor-review)').waitFor();
    await page.getByRole('button', { name: '关闭审核', exact: true }).click();
    await page.getByText('第 194 行的计算需要统一单位。', { exact: true }).waitFor();
    assert.equal(await page.getByText(/仅检查代码，未运行浏览器/).isVisible(), true, 'full reply retains the unverified scope');
    assert.ok(!(await disclosure.innerText()).includes('验证说明'), 'legacy report labels are not shown');
    const text = disclosure.locator('.markdown-message');
    assert.equal(await text.evaluate(el => getComputedStyle(el).fontSize), '14px');
    assert.equal(await page.evaluate(() => window.UNSAFE_DETAILS), undefined, 'details do not execute raw HTML');
    assert.equal(await disclosure.locator('.code-block').count(), 1, 'fenced code retains its component');
    await summary.click();
    await summary.locator('svg').evaluate(async element => { await Promise.all(element.getAnimations().map(animation => animation.finished)); });
    assert.equal(await summary.locator('svg').evaluate(element => getComputedStyle(element).transform), 'none', 'collapsed arrow points down after its rotation finishes');
    await page.locator('.assistant-message').screenshot({ path: `.tmp/qa/user-facing-delivery/${theme}-collapsed.png` });
    await page.getByRole('button', { name: '预览并回退这一轮', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '回退本轮 Anchor' });
    await dialog.waitFor();
    assert.equal(await dialog.locator('.diff-preview-header .deleted').innerText(), '将删除');
    assert.match(await dialog.locator('.diff-line.removed').innerText(), /12345/);
    assert.equal(await dialog.locator('.diff-line.added').count(), 0);
    await dialog.locator('.review-file-list button').filter({ hasText: 'old.txt' }).click();
    assert.match(await dialog.locator('.diff-preview-header').innerText(), /将恢复/);
    assert.match(await dialog.locator('.diff-line.added').innerText(), /original/);
    await dialog.locator('.review-file-list button').filter({ hasText: 'existing.txt' }).click();
    assert.match(await dialog.locator('.diff-line.removed').innerText(), /after/);
    assert.match(await dialog.locator('.diff-line.added').innerText(), /before/);
    await dialog.locator('.review-file-list button').filter({ hasText: 'new.png' }).click();
    assert.match(await dialog.locator('.turn-anchor-binary-preview').innerText(), /回退后会删除这个文件/);
    await dialog.locator('.review-file-list button').filter({ hasText: '12345.txt' }).click();
    await dialog.screenshot({ path: `.tmp/qa/user-facing-delivery/${theme}-restore-preview.png` });
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
  }
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.locator('.assistant-delivery-toggle').click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.locator('.assistant-message').screenshot({ path: '.tmp/qa/user-facing-delivery/dark-expanded.png' });
  await page.evaluate(() => {
    const tasks = JSON.parse(localStorage.getItem('delivery-fixture-tasks'));
    for (const task of tasks) for (const message of task.messages || []) if (message.role === 'assistant') message.deliveryDetails = '';
    localStorage.setItem('delivery-fixture-tasks', JSON.stringify(tasks));
  });
  await page.reload();
  await page.locator('.ax-welcome__enter, .thread-view-tabs').first().waitFor();
  if (await page.locator('.ax-welcome__enter').isVisible()) await page.locator('.ax-welcome__enter').click();
  await page.locator('.assistant-delivery-toggle').waitFor();
  assert.equal(await disclosure.locator('.edited-files-card').isVisible(), false, 'files alone still get a collapsed arrow');
  await page.locator('.assistant-delivery-toggle').focus(); await page.keyboard.press('Space');
  await disclosure.locator('.edited-files-card').waitFor();
  assert.equal(await disclosure.locator('.markdown-message').count(), 0, 'files-only disclosure has no empty text block');
  for (const [content, parent] of [
    ['- 已删除 calc.html。\n- 其他文件没有改。', 'LI'],
    ['- 已处理。\n  - 最后一个嵌套条目。', 'LI'],
    ['已完成，参见 [说明](https://example.invalid/)。', 'P'],
    ['命令示例：\n\n```js\nconst value = true;\n```', 'P'],
    ['| 文件 | 状态 |\n| --- | --- |\n| calc.html | 已删除 |', 'P'],
  ]) {
    await page.evaluate(content => {
      const tasks = JSON.parse(localStorage.getItem('delivery-fixture-tasks'));
      for (const task of tasks) for (const message of task.messages || []) if (message.role === 'assistant') message.content = content;
      localStorage.setItem('delivery-fixture-tasks', JSON.stringify(tasks));
    }, content);
    await page.reload();
    await page.locator('.ax-welcome__enter, .thread-view-tabs').first().waitFor();
    if (await page.locator('.ax-welcome__enter').isVisible()) await page.locator('.ax-welcome__enter').click();
    const toggle = page.locator('.assistant-delivery-toggle');
    await toggle.waitFor();
    assert.equal(await toggle.count(), 1);
    assert.equal(await toggle.evaluate(element => element.parentElement.tagName), parent);
    assert.equal(await toggle.evaluate(element => Boolean(element.closest('a, pre, table'))), false, 'controls do not break links, code or tables');
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    await toggle.click(); await disclosure.locator('.edited-files-card').waitFor();
    await toggle.click(); assert.equal(await disclosure.locator('.edited-files-card').isVisible(), false);
  }
  for (const mode of ['empty', 'duplicate', 'label-only']) {
    await page.evaluate(mode => {
      const tasks = JSON.parse(localStorage.getItem('delivery-fixture-tasks'));
      for (const task of tasks) for (const message of task.messages || []) if (message.role === 'assistant') {
        message.deliveryDetails = mode === 'empty' ? '' : mode === 'duplicate' ? message.content : '验证说明：';
        message.changes = [];
      }
      localStorage.setItem('delivery-fixture-tasks', JSON.stringify(tasks));
    }, mode);
    await page.reload();
    await page.locator('.ax-welcome__enter, .thread-view-tabs').first().waitFor();
    if (await page.locator('.ax-welcome__enter').isVisible()) await page.locator('.ax-welcome__enter').click();
    await page.locator('.assistant-message').waitFor();
    assert.equal(await disclosure.count(), 0, `${mode}: no empty or duplicate disclosure`);
  }
  assert.deepEqual(errors, []);
  console.log(`PASS ${production ? 'production CSP' : 'dev'} icon-only disclosure, folded file results/review, files-only and empty cases, save/reload, keyboard, light/dark, narrow viewport and safe Markdown. No real model requests.`);
} finally { await browser?.close(); if (production) await new Promise(resolve => server.httpServer.close(resolve)); else await server.close(); }
