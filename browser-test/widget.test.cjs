const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const esbuild = require('esbuild');
const { createHistoryCandidate } = require('../src/history-candidate.cjs');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'widget.html'), 'utf8');
const source = fs.readFileSync(path.join(root, 'widget.js'), 'utf8');
const shim = `class App {
  async connect() {}
  async downloadFile(params) { window.testDownloads.push(params); return {}; }
  async openLink({url}) {
    window.testOpenLinks.push(url);
    if (window.holdOpenLink) await new Promise(() => {});
    if (window.testOpenLinkError) throw new Error('模拟打开失败');
    return window.testOpenLinkResult || {};
  }
  async callServerTool({name, arguments: args}) {
    window.testCalls.push({name, args});
    if (name === 'knowledge_browse' && window.holdKnowledgeBrowse) {
      const reply = window.testReplies[name];
      await new Promise(resolve => { window.releaseKnowledgeBrowse = resolve; });
      return {content:[{type:'text', text:JSON.stringify(reply)}]};
    }
    if (name === 'codex_session_summary') {
      window.testSamplingCalls.push(args);
      if (window.holdSampling) await new Promise(resolve => { window.releaseSampling = resolve; });
      if (window.rejectSampling) throw new Error('生成失败');
      const result = window.testSamplingResult || { text: '候选正文' };
      return {content:[{type:'text', text:JSON.stringify(result)}]};
    }
    if (name === 'local_save_draft' && window.holdDraftSave) await new Promise(resolve => { window.releaseDraftSave = resolve; });
    if (name === 'codex_create_link' && window.holdCreation) await new Promise(resolve => { window.releaseCreation = resolve; });
    if (name === 'codex_create_link' && window.rejectCreation) throw new Error('连接中断');
    if (name === 'knowledge_inspect_content_references' && window.holdReferenceCheck) await new Promise(resolve => { window.releaseReferenceCheck = resolve; });
    if (name === 'draft_publication_get' && window.holdPublicationCheck) await new Promise(resolve => { window.releasePublicationCheck = resolve; });
    if (name === 'draft_note_update_submit' && window.holdNoteUpdate) await new Promise(resolve => { window.releaseNoteUpdate = resolve; });
    if (name === 'draft_note_update_preview' && args.mode === 'append' && window.holdAppendPreview) await new Promise(resolve => { window.releaseAppendPreview = resolve; });
    if (name === 'knowledge_catalog' && window.holdCatalog) await new Promise(resolve => { window.releaseCatalog = resolve; });
    const response = typeof window.testReplies[name] === 'function' ? window.testReplies[name](args) : window.testReplies[name];
    if (response && response.isError) return response;
    return {content:[{type:'text', text:JSON.stringify(response)}]};
  }
}`;
const script = esbuild.buildSync({ stdin: { contents: source.replace(/^import \{ App \}.*?;\s*/, `${shim}\n`), resolveDir: root, sourcefile: 'widget.js' }, bundle: true, write: false, format: 'esm' }).outputFiles[0].text;
const pageHtml = html.replace('/* WIDGET_BUNDLE */', () => script.replace(/<\/script/gi, '<\\/script'));

async function openPage(browser, viewport, sandbox = false, replies = {}) {
  const page = await browser.newPage({ viewport });
  await page.addInitScript(() => {
    window.testCalls = [];
    window.testSamplingCalls = [];
    window.testDownloads = [];
    window.testOpenLinks = [];
    window.testReplies = {
      choerodon_context: { identity: { userId: '11', tenantId: '7', login: 'user', tenantName: 'tenant' }, environment: 'https://example.test', projects: { complete: true, items: [{ id: '1', name: '猪齿鱼项目', code: 'p' }] } },
      choerodon_sprints: { items: [{ id: '2', name: '当前冲刺', status: 'started' }] },
      choerodon_scoped_issue_detail: { detail: '概要 测试工作项\n描述 <script>unsafe</script>' },
      choerodon_issue_types: { items: [{ id: '35', name: '开发子任务' }] },
      choerodon_issue_statuses: { items: [{ id: '4787', name: '完成任务' }] },
      choerodon_scoped_search: { items: [{ issueId: '3', issueNum: 'P-3', summary: '测试工作项' }], returnedCount: 1 },
      local_list: { links: [], drafts: [] }, codex_creation_attempts: [],
      draft_publication_reservations: [], draft_note_update_cleanups: [],
      codex_projects: { data: [{ id: 'project', name: '工程', roots: ['/work'] }], nextCursor: null },
      codex_sessions: { data: [{ id: 'thread', title: '测试会话' }], nextCursor: null }, codex_link_session: {},
      codex_create_link: { status: 'linked', messageStatus: 'sending', sessionId: 'new-thread' },
      knowledge_list: ['项目/设计.md', '记录.md'], knowledge_catalog: { items: [{ path: '项目/设计.md' }, { path: '记录.md' }], total: 2, nextOffset: null }, knowledge_read: { path: '项目/设计.md', revision: 'a', content: '# 设计\n<script>unsafe</script>' },
      knowledge_browse: ({ directory }) => ({ directory, items: directory ? [{ name: '子目录', path: '文档/子目录', kind: 'directory' }] .filter(() => directory === '文档') : [{ name: '记录.md', path: '记录.md', kind: 'note' }, { name: '文档', path: '文档', kind: 'directory' }], nextCursor: null }),
      knowledge_inspect_references: { path: '项目/设计.md', revision: 'a', references: [{ kind: 'image', destination: '../图.png', status: 'missing' }, { kind: 'link', destination: 'https://example.com', status: 'external' }] },
      knowledge_inspect_content_references: { path: '项目/设计.md', references: [] },
      knowledge_search: { query: '事件流', scanned: 2, skipped: 0, truncated: false, results: [{ path: '项目/设计.md', revision: 'a', matches: [{ number: 2, line: '事件流原因' }] }] },
    };
  });
  await page.addInitScript((replies) => { Object.assign(window.testReplies, replies); }, replies);
  await page.route('http://localhost/widget', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: pageHtml }));
  await page.route('http://localhost/host', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<iframe sandbox="allow-scripts allow-forms" src="/widget" style="width:100%;height:100vh;border:0"></iframe>' }));
  await page.goto(sandbox ? 'http://localhost/host' : 'http://localhost/widget', { waitUntil: 'load' });
  const view = sandbox ? page.frameLocator('iframe') : page;
  await view.locator('#search-result').getByText('测试工作项', { exact: true }).waitFor();
  return page;
}

async function confirmDialog(view, confirm) {
  const dialog = view.locator('#confirm-dialog');
  await dialog.getByRole('button', { name: confirm ? '确认' : '取消', exact: true }).click();
}

async function selectSession(view) {
  await view.getByRole('button', { name: '关联会话', exact: true }).click();
  await view.locator('select[name="codexProject"]').selectOption({ label: '工程 · /work' });
  await view.locator('select[name="sessionId"]').selectOption('thread');
}

async function previewNoteReplacement(view) {
  await view.getByRole('radio', { name: '替换整篇笔记', exact: true }).check();
  await view.getByRole('button', { name: '预览替换结果', exact: true }).click();
  await view.locator('#update-confirm:not([disabled])').waitFor();
}

for (const [label, viewport] of [['desktop', { width: 1280, height: 900 }], ['mobile', { width: 390, height: 844 }]]) {
  test(`${label}: 选择目录自动命名或选择已有文档，目录浏览失败可重试`, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await openPage(browser, viewport);
      await page.getByRole('tab', { name: '知识草稿' }).click();
      await page.locator('#draft-form input[name="title"]').fill('事件流总结');
      assert.equal(await page.locator('#draft-form input[name="target"]').getAttribute('readonly'), '');
      await page.getByRole('button', { name: '选择目录新建文档', exact: true }).click();
      await page.locator('#target-browser').getByRole('button', { name: '选择目录：文档/子目录' }).waitFor();
      await page.locator('#target-browser').screenshot({ path: path.join(root, 'verification', `target-tree-${label}.png`) });
      await page.locator('#target-browser').getByRole('button', { name: '选择目录：文档', exact: true }).click();
      assert.equal(await page.locator('#draft-form input[name="target"]').inputValue(), '文档/事件流总结.md');
      await page.locator('#draft-form input[name="title"]').fill('新标题');
      assert.equal(await page.locator('#draft-form input[name="target"]').inputValue(), '文档/新标题.md');
      await page.locator('#target-filename').fill('自定名称');
      await page.locator('#draft-form input[name="title"]').fill('再次修改标题');
      assert.equal(await page.locator('#draft-form input[name="target"]').inputValue(), '文档/自定名称.md');
      await page.evaluate(() => { window.testReplies.knowledge_browse = { isError: true, content: [{ type: 'text', text: '目录不可用' }] }; });
      await page.getByRole('button', { name: '选择已有文档', exact: true }).click();
      await page.locator('#target-browser-status').getByText(/目录加载失败/).waitFor();
      await page.evaluate(() => { window.testReplies.knowledge_browse = { directory: '', items: [{ name: '现有文档.md', path: '现有文档.md', kind: 'note' }], nextCursor: null }; });
      await page.locator('#target-browser').getByRole('button', { name: '重试' }).click();
      await page.screenshot({ path: path.join(root, 'verification', `target-picker-${label}.png`) });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await page.locator('#target-browser').getByRole('button', { name: '选择文档：现有文档.md' }).click();
      assert.equal(await page.locator('#draft-form input[name="target"]').inputValue(), '现有文档.md');
      assert.equal(await page.locator('#target-filename').isVisible(), false);
      assert.equal(await page.evaluate(() => window.testCalls.some((item) => ['local_save_draft', 'draft_publish', 'draft_note_update_submit'].includes(item.name))), false);
      await page.getByRole('button', { name: '清除位置', exact: true }).click();
      assert.equal(await page.locator('#draft-form input[name="target"]').inputValue(), '');
    } finally { await browser.close(); }
  });

  test(`${label}: 草稿 Markdown 预览保留原文且不执行 HTML 或加载图片`, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await openPage(browser, viewport);
      await page.getByRole('tab', { name: '知识草稿' }).click();
      const original = '# 标题\n\n**重点**\n\n- 条目\n\n<script>window.bad=true</script>\n\n![图片](https://example.test/a.png)';
      await page.locator('#draft-form textarea[name="content"]').fill(original);
      await page.getByRole('tab', { name: '预览' }).click();
      assert.equal(await page.locator('#draft-content-preview h1').textContent(), '标题');
      assert.equal(await page.locator('#draft-content-preview strong').textContent(), '重点');
      assert.equal(await page.locator('#draft-content-preview li').textContent(), '条目');
      assert.equal(await page.locator('#draft-content-preview script, #draft-content-preview img').count(), 0);
      assert.equal(await page.evaluate(() => window.bad), undefined);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
      await page.screenshot({ path: path.join(root, 'verification', `draft-preview-${label}.png`), fullPage: true });
      await page.getByRole('tab', { name: '编辑', exact: true }).click();
      assert.equal(await page.locator('#draft-form textarea[name="content"]').inputValue(), original);
    } finally { await browser.close(); }
  });
}

test('工作项列表按服务端分页并在筛选变化后回到首页', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await openPage(browser, { width: 1024, height: 768 }, false, {
      choerodon_scoped_search: { items: [{ issueId: '3', summary: '测试工作项' }], returnedCount: 20, pagination: { totalPages: 3 } },
    });
    assert.equal(await page.locator('input[name="page"]').count(), 0);
    assert.equal(await page.getByRole('button', { name: '上一页' }).isDisabled(), true);
    await page.getByRole('button', { name: '下一页' }).click();
    await page.getByText('第 2 页 / 共 3 页').waitFor();
    assert.equal(await page.evaluate(() => window.testCalls.filter(item => item.name === 'choerodon_scoped_search').at(-1).args.page), 1);
    await page.locator('input[name="keyword"]').fill('测试');
    await page.getByRole('button', { name: '查询工作项' }).click();
    await page.getByText('第 1 页 / 共 3 页').waitFor();
    assert.equal(await page.evaluate(() => window.testCalls.filter(item => item.name === 'choerodon_scoped_search').at(-1).args.page), 0);
  } finally { await browser.close(); }
});

for (const [label, viewport] of [['desktop', { width: 1280, height: 900 }], ['mobile', { width: 390, height: 844 }]]) {
  test(`${label}: 知识链路目录分页、全库切换及迟到响应`, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await openPage(browser, viewport);
      await page.evaluate(() => {
        window.testReplies.knowledge_catalog = ({ offset }) => offset
          ? { items: [{ path: '第二页.md' }], total: 2, nextOffset: null }
          : { items: [{ path: '第一条.md' }], total: 2, nextOffset: 1 };
        window.testReplies.knowledge_list = ['全库笔记.md'];
      });
      await page.getByRole('tab', { name: '知识库' }).click();
      await page.getByText('第一条.md', { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => window.testCalls.some(item => item.name === 'knowledge_list')), false);
      await page.getByRole('button', { name: '加载更多记录' }).click();
      await page.getByText('第二页.md', { exact: true }).waitFor();
      assert.match(await page.locator('#knowledge-list-status').textContent(), /筛选仅作用于已加载记录/);
      await page.locator('#knowledge-filter').fill('第二');
      assert.equal(await page.getByText('第一条.md', { exact: true }).count(), 0);
      await page.locator('#knowledge-filter').fill('');
      await page.evaluate(() => { window.holdCatalog = true; });
      await page.getByRole('button', { name: '刷新笔记' }).click();
      await page.waitForFunction(() => typeof window.releaseCatalog === 'function');
      await page.locator('#knowledge-scope').selectOption('all');
      await page.getByText('全库笔记.md', { exact: true }).waitFor();
      await page.evaluate(() => { window.holdCatalog = false; window.releaseCatalog(); });
      await page.waitForTimeout(50);
      assert.equal(await page.getByText('第一条.md', { exact: true }).count(), 0);
      assert.equal(await page.getByText('全库笔记.md', { exact: true }).count(), 1);
      const overflow = await page.locator('[data-panel="knowledge"]').evaluate(node => ({ client: node.clientWidth, scroll: node.scrollWidth }));
      assert.ok(overflow.scroll <= overflow.client + 1, `知识页横向溢出: ${JSON.stringify(overflow)}`);
    } finally { await browser.close(); }
  });
}

for (const [label, viewport] of [['desktop', { width: 1280, height: 900 }], ['mobile', { width: 390, height: 844 }]]) {
  test(`${label}: 工作项工程关联、检查及解除均需明确操作且布局不溢出`, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await openPage(browser, viewport);
      await page.evaluate(() => {
        window.projectLinks = [];
        window.testReplies.issue_project_links = ({ offset, limit }) => ({ items: window.projectLinks.slice(offset, offset + limit), total: window.projectLinks.length, nextOffset: null });
        window.testReplies.issue_project_link_add = ({ projectId, cwd }) => { window.projectLinks.push({ projectId, cwd, projectName: '工程' }); return {}; };
        window.testReplies.issue_project_link_check = () => ({ status: 'available' });
        window.testReplies.issue_project_link_remove = ({ projectId, cwd }) => { window.projectLinks = window.projectLinks.filter(item => item.projectId !== projectId || item.cwd !== cwd); return {}; };
      });
      await page.getByRole('button', { name: '关联会话', exact: true }).click();
      await page.locator('select[name="codexProject"]').selectOption({ label: '工程 · /work' });
      await page.locator('#project-link-add').click();
      await confirmDialog(page, false);
      assert.equal(await page.evaluate(() => window.testCalls.filter(item => item.name === 'issue_project_link_add').length), 0);
      await page.locator('#project-link-add').click();
      await confirmDialog(page, true);
      await page.locator('#project-links-list').getByText('/work', { exact: true }).waitFor();
      await page.getByRole('button', { name: '检查工程目录', exact: true }).click();
      await page.getByText('当前进程可读取并进入目录；不代表远端权限。').waitFor();
      await page.getByRole('button', { name: '解除工程关联', exact: true }).click();
      await confirmDialog(page, false);
      assert.equal(await page.evaluate(() => window.testCalls.filter(item => item.name === 'issue_project_link_remove').length), 0);
      await page.getByRole('button', { name: '解除工程关联', exact: true }).click();
      await confirmDialog(page, true);
      await page.locator('#project-links-status').getByText(/已解除关联/).waitFor();
      const calls = await page.evaluate(() => window.testCalls);
      assert.equal(calls.filter(item => item.name === 'issue_project_link_add').length, 1);
      assert.equal(calls.filter(item => item.name === 'issue_project_link_check').length, 1);
      assert.equal(calls.filter(item => item.name === 'issue_project_link_remove').length, 1);
      assert.equal(calls.some(item => ['codex_link_session', 'codex_create_link'].includes(item.name)), false);
      await page.evaluate(() => { window.projectLinks = [{ projectId: 'long', cwd: '/' + 'long-path-'.repeat(45), projectName: '长路径工程' }]; });
      await page.locator('#project-links-refresh').click();
      await page.getByText('长路径工程').waitFor();
      const overflow = await page.locator('#session-panel').evaluate(node => ({ client: node.clientWidth, scroll: node.scrollWidth, viewport: window.innerWidth, width: node.getBoundingClientRect().width }));
      assert.ok(overflow.scroll <= overflow.client + 1, `工程抽屉横向溢出: ${JSON.stringify(overflow)}`);
      assert.ok(overflow.width <= overflow.viewport + 1, `工程抽屉超出视口: ${JSON.stringify(overflow)}`);
    } finally { await browser.close(); }
  });
}

test('目标位置分页不重复，收起保留原位置，清空后丢弃迟到浏览结果', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const draft = { id: 'target-old', revision: 1, title: '已有草稿', target: '项目/原位置.md', content: '# 正文', status: 'pending', issues: [] };
    const page = await openPage(browser, { width: 1280, height: 900 }, false, { local_list: { links: [], drafts: [draft] } });
    await page.getByRole('tab', { name: '知识草稿' }).click();
    await page.locator('#drafts').getByRole('button', { name: '编辑', exact: true }).click();
    assert.equal(await page.locator('#draft-form input[name="target"]').inputValue(), '项目/原位置.md');
    await page.evaluate(() => {
      window.testReplies.knowledge_browse = args => ({ directory: '', items: [{ name: args.cursor ? '第二篇.md' : '第一篇.md', path: args.cursor ? '第二篇.md' : '第一篇.md', kind: 'note' }], nextCursor: args.cursor ? null : '第一篇.md' });
    });
    await page.getByRole('button', { name: '选择已有文档', exact: true }).click();
    await page.locator('#target-browser-list').getByText('第二篇.md', { exact: false }).waitFor();
    assert.equal(await page.locator('#target-browser').getByRole('button', { name: '加载更多', exact: true }).count(), 0);
    assert.equal(await page.locator('#target-browser-list .target-browser-row').count(), 2);
    await page.locator('#target-browser').getByRole('button', { name: '收起', exact: true }).click();
    assert.equal(await page.locator('#draft-form input[name="target"]').inputValue(), '项目/原位置.md');
    await page.evaluate(() => { window.holdKnowledgeBrowse = true; window.testReplies.knowledge_browse = { directory: '', items: [{ name: '迟到.md', path: '迟到.md', kind: 'note' }], nextCursor: null }; });
    await page.getByRole('button', { name: '选择已有文档', exact: true }).click();
    await page.waitForFunction(() => Boolean(window.releaseKnowledgeBrowse));
    await page.getByRole('button', { name: '清除位置', exact: true }).click();
    await page.evaluate(() => window.releaseKnowledgeBrowse());
    await page.waitForTimeout(50);
    assert.equal(await page.locator('#target-browser').isVisible(), false);
    assert.equal(await page.locator('#target-browser-list .target-browser-row').count(), 0);
    assert.equal(await page.locator('#draft-form input[name="target"]').inputValue(), '');
  } finally { await browser.close(); }
});

test('推荐位置可继续查找并由用户选择，草稿变化后不采用旧结果', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await openPage(browser, { width: 390, height: 844 });
    await page.evaluate(() => {
      window.testReplies.knowledge_recommend_locations = args => args.cursor
        ? { candidates: [{ path: '项目/设计.md', kind: 'note', reasons: [{ value: '设计' }] }], skipped: 0, truncated: false, nextCursor: null }
        : { candidates: [{ path: '项目', kind: 'directory', reasons: [{ value: '项目' }] }], skipped: 0, truncated: false, nextCursor: 'next' };
    });
    await page.getByRole('tab', { name: '知识草稿' }).click();
    await page.locator('#draft-form input[name="title"]').fill('项目设计');
    await page.locator('#recommend-locations').click();
    await page.getByRole('button', { name: '继续查找' }).click();
    await page.getByText('笔记：项目/设计.md（路径匹配：设计）').waitFor();
    await page.screenshot({ path: path.join(root, 'verification', 'location-recommend-mobile.png') });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({ path: path.join(root, 'verification', 'location-recommend-desktop.png') });
    await page.locator('#location-results').getByRole('button', { name: '选择' }).last().click();
    assert.equal(await page.locator('#draft-form input[name="target"]').inputValue(), '项目/设计.md');
    await page.locator('#recommend-locations').click();
    await page.locator('#draft-form input[name="title"]').fill('其他标题');
    await page.locator('#location-results').getByRole('button', { name: '选择' }).first().click();
    assert.match(await page.locator('#location-status').textContent(), /草稿已变化/);
    assert.equal(await page.locator('#draft-form input[name="target"]').inputValue(), '项目/设计.md');
    assert.equal(await page.evaluate(() => window.testCalls.filter(item => item.name === 'knowledge_recommend_locations').length), 3);
  } finally { await browser.close(); }
});

test('知识草稿自动显示发布预留，查询失败提示，释放最后一条后隐藏', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await openPage(browser, { width: 980, height: 850 }, true, {
      draft_publication_reservations: { isError: true, content: [{ type: 'text', text: '模拟查询失败' }] },
    });
    const view = page.frameLocator('iframe');
    await view.getByRole('tab', { name: '知识草稿' }).click();
    await view.getByText(/无法检查发布预留/).waitFor();
    assert.equal(await view.locator('#reservations-section').isVisible(), false);
    assert.equal(await view.locator('#cleanup-section').isVisible(), false);
    await view.locator('body').evaluate(() => {
      window.testReplies.draft_publication_reservations = [{ id: 'a'.repeat(64), generation: 'b'.repeat(32), target: '待处理.md', draftId: 'draft', revision: 1, status: 'not_written' }];
      window.testReplies.draft_publication_reservation_resolve = () => {
        window.testReplies.draft_publication_reservations = [];
        return { released: true };
      };
    });
    await view.getByRole('tab', { name: '工作项' }).click();
    await view.getByRole('tab', { name: '知识草稿' }).click();
    await view.getByText('待处理.md', { exact: true }).waitFor();
    assert.equal(await view.locator('#reservations-load-error').isVisible(), false);
    assert.equal(await view.locator('#cleanup-section').isVisible(), false);
    await view.getByRole('button', { name: '释放预留' }).click();
    await confirmDialog(view, true);
    await view.locator('#reservations-section').waitFor({ state: 'hidden' });
  } finally { await browser.close(); }
});

test('准备阶段恢复和清理锁均需确认且不重放笔记写入', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const draft = { id: 'prepared', revision: 1, title: '草稿', target: '笔记.md', content: '正文', status: 'pending', updateLock: { requestId: 'request', target: '笔记.md', status: 'preparing' } };
    const page = await openPage(browser, { width: 390, height: 844 }, false, {
      local_list: { links: [], drafts: [draft] },
      draft_note_update_inspect: { status: 'not_sent', recoverable: true },
    });
    await page.evaluate(() => {
      window.testReplies.draft_note_update_recover = () => {
        window.testReplies.draft_note_update_cleanups = [{ lockId: 'a'.repeat(32), target: '笔记.md', draftId: 'prepared', revision: 1 }];
        return { status: 'not_written', cleanupPending: true };
      };
      window.testReplies.draft_note_update_cleanup = () => {
        window.testReplies.draft_note_update_cleanups = [];
        return { cleaned: true };
      };
    });
    await page.getByRole('tab', { name: '知识草稿' }).click();
    assert.equal(await page.locator('#reservations-section').isVisible(), false);
    assert.equal(await page.locator('#cleanup-section').isVisible(), false);
    await page.getByRole('button', { name: '核对更新状态' }).click();
    await page.locator('#update-status').getByText(/尚未发送/).waitFor();
    await page.locator('#update-recover').click();
    await confirmDialog(page, true);
    await page.locator('#update-status').getByText(/冻结已解除/).waitFor();
    await page.locator('#update-close').click();
    await page.locator('#cleanup-section').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#reservations-section').isVisible(), false);
    await page.getByRole('button', { name: '清理锁' }).click();
    await confirmDialog(page, true);
    await page.waitForFunction(() => window.testCalls.some(item => item.name === 'draft_note_update_cleanup'));
    await page.locator('#cleanup-section').waitFor({ state: 'hidden' });
    const calls = await page.evaluate(() => window.testCalls);
    assert.equal(calls.filter(item => item.name === 'draft_note_update_submit').length, 0);
    assert.equal(calls.filter(item => item.name === 'draft_note_update_recover').length, 1);
    assert.equal(calls.filter(item => item.name === 'draft_note_update_cleanup').length, 1);
  } finally { await browser.close(); }
});

test('安全更新弹窗展示原文并绑定确认令牌，未知结果只允许核对', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const draft = { id: 'update-draft', revision: 3, title: '已有笔记更新', target: '项目/设计.md', content: '# 新结论\n保留历史。', status: 'pending' };
    const page = await openPage(browser, { width: 390, height: 844 }, false, {
      local_list: { links: [], drafts: [draft] },
      draft_note_update_submit: { status: 'unknown' },
      draft_note_update_inspect: { status: 'matches_before', currentContent: '# 原结论' },
    });
    await page.evaluate(() => {
      window.testReplies.draft_note_update_preview = (args) => ({ requestId: args.requestId, confirmation: 'c'.repeat(64), beforeDigest: 'b'.repeat(64), beforeContent: '# 原结论', afterContent: '# 新结论\n保留历史。', startLine: 1, unchanged: false, removed: '# 原结论', added: '# 新结论\n保留历史。' });
    });
    await page.getByRole('tab', { name: '知识草稿' }).click();
    await page.getByRole('button', { name: '更新已有笔记', exact: true }).click();
    await previewNoteReplacement(page);
    await page.locator('#update-before').getByText('# 原结论', { exact: true }).waitFor({ state: 'attached' });
    assert.equal(await page.locator('#update-confirm').isEnabled(), true);
    const width = await page.locator('#update-dialog').evaluate(node => node.getBoundingClientRect().width);
    assert.ok(width <= 390);
    await page.screenshot({ path: path.join(root, 'verification', 'safe-update-mobile.png') });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({ path: path.join(root, 'verification', 'safe-update-desktop.png') });
    await page.locator('#update-confirm').click();
    await page.locator('#update-status').getByText(/结果不确定/).waitFor();
    await page.locator('#update-inspect').click();
    await page.locator('#update-status').getByText(/仍与更新前原文一致/).waitFor();
    assert.equal(await page.locator('#update-recover').isHidden(), true);
    assert.equal(await page.locator('#update-confirm').isDisabled(), true);
    const submitted = await page.evaluate(() => window.testCalls.filter(item => item.name === 'draft_note_update_submit'));
    assert.equal(submitted.length, 1);
    assert.equal(submitted[0].args.confirmation, 'c'.repeat(64));
    await page.locator('#update-close').click();
  } finally { await browser.close(); }
});

test('更新提交超时后解除弹窗等待并保留冻结入口，丢弃迟到响应', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const draft = { id: 'update-timeout', revision: 1, title: '等待更新', target: '笔记.md', content: '新版', status: 'pending' };
    const page = await openPage(browser, { width: 1280, height: 900 }, false, { local_list: { links: [], drafts: [draft] }, draft_note_update_submit: { status: 'completed' } });
    await page.evaluate(() => {
      window.testReplies.draft_note_update_preview = args => ({ requestId: args.requestId, confirmation: 'c'.repeat(64), beforeDigest: 'b'.repeat(64), beforeContent: '旧版', afterContent: '新版', unchanged: false, startLine: 1, removed: '旧版', added: '新版' });
      window.holdNoteUpdate = true;
      const original = window.setTimeout;
      window.setTimeout = (callback, delay, ...args) => original(callback, delay === 8000 ? 40 : delay, ...args);
    });
    await page.getByRole('tab', { name: '知识草稿' }).click();
    await page.getByRole('button', { name: '更新已有笔记', exact: true }).click();
    await previewNoteReplacement(page);
    await page.locator('#update-confirm').click();
    await page.locator('#update-status').getByText(/请求超时/).waitFor();
    assert.equal(await page.locator('#update-close').isEnabled(), true);
    assert.equal(await page.locator('#update-confirm').isDisabled(), true);
    await page.locator('#update-close').click();
    assert.equal(await page.getByRole('button', { name: '核对更新状态' }).count(), 1);
    assert.equal(await page.getByRole('button', { name: '更新已有笔记', exact: true }).count(), 0);
    await page.evaluate(() => window.releaseNoteUpdate());
    assert.equal(await page.locator('#update-dialog').isVisible(), false);
    assert.equal(await page.evaluate(() => window.testCalls.filter(item => item.name === 'draft_note_update_submit').length), 1);
  } finally { await browser.close(); }
});

test('默认追加结论，引用原文并确认预览后写入，不改草稿', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const draft = { id: 'append-draft', revision: 2, title: '补充结论', target: '项目/设计.md', content: '# 新结论\n采用新方案。', status: 'pending' };
    const original = '# 笔记\r\n旧结论\r\n保留这行。';
    const source = { content: original, revision: createHash('sha256').update(original).digest('hex'), vaultId: 'b'.repeat(64) };
    const candidate = createHistoryCandidate({ before: original, beforeDigest: source.revision, selection: { start: 6, end: 9, text: '旧结论' }, conclusion: draft.content, fenceUnsafeConclusion: true });
    const page = await openPage(browser, { width: 390, height: 844 }, false, {
      local_list: { links: [], drafts: [draft] }, draft_history_source: source, draft_note_update_submit: { status: 'completed' },
    });
    await page.evaluate(({ original, candidate }) => {
      window.testReplies.draft_note_update_preview = ({ requestId }) => ({ ...candidate, requestId, confirmation: 'append-token', mode: 'append', beforeContent: original, startLine: 4, unchanged: false, removed: '', added: candidate.afterContent.slice(original.length) });
    }, { original, candidate });
    await page.getByRole('tab', { name: '知识草稿' }).click();
    await page.getByRole('button', { name: '更新已有笔记', exact: true }).click();
    assert.equal(await page.getByRole('radio', { name: '保留原文，追加结论', exact: true }).isChecked(), true);
    await page.locator('#update-quote:not([disabled])').waitFor();
    assert.equal(await page.locator('#update-preview').isDisabled(), true);
    assert.equal(await page.locator('#update-confirm').isDisabled(), true);
    await page.locator('#update-original').evaluate((input) => { input.focus(); input.setSelectionRange(5, 8); });
    await page.getByRole('button', { name: '引用所选文字', exact: true }).click();
    assert.equal(await page.locator('#update-quote-text').textContent(), '旧结论');
    await page.getByRole('button', { name: '预览追加结果', exact: true }).click();
    await page.locator('#update-confirm:not([disabled])').waitFor();
    assert.equal(await page.locator('#update-after').textContent(), candidate.afterContent);
    assert.match(await page.locator('#update-summary').textContent(), /保留为 Markdown 原文/);
    const diff = await page.locator('#update-diff').innerText();
    assert.match(diff, /引用原文\s+旧结论\s+新结论\s+# 新结论/);
    assert.doesNotMatch(diff, /记录标识|UTF-16|移除内容/);
    await page.getByText('查看完整原笔记', { exact: true }).click();
    await page.getByText('查看更新后的完整 Markdown', { exact: true }).click();
    for (const width of [390, 1000]) {
      await page.setViewportSize({ width, height: 844 });
      const summaryReadable = await page.locator('#update-summary').evaluate((summary) => {
        summary.scrollIntoView({ block: 'center' });
        const text = document.createRange();
        text.selectNodeContents(summary);
        return [...text.getClientRects()].every((rect) => [rect.top + 2, rect.bottom - 2].every(y => document.elementFromPoint(rect.left + 2, y) === summary));
      });
      assert.equal(summaryReadable, true);
    }
    const callsBeforeConfirm = await page.evaluate(() => window.testCalls);
    const [preview] = callsBeforeConfirm.filter(({ name }) => name === 'draft_note_update_preview');
    assert.equal(preview.args.mode, 'append');
    assert.equal(preview.args.vaultId, source.vaultId);
    assert.equal(preview.args.beforeDigest, source.revision);
    assert.deepEqual(preview.args.selection, { start: 6, end: 9, text: '旧结论' });
    assert.equal(callsBeforeConfirm.some(({ name }) => ['local_save_draft', 'draft_note_update_submit'].includes(name)), false);
    await page.getByRole('button', { name: '确认追加到笔记', exact: true }).click();
    await page.locator('#update-status').getByText(/更新已完成/).waitFor();
    const writes = await page.evaluate(() => window.testCalls.filter(({ name }) => ['local_save_draft', 'draft_note_update_submit'].includes(name)));
    assert.deepEqual(writes, [{ name: 'draft_note_update_submit', args: { id: draft.id, revision: draft.revision, target: draft.target, expectedContent: draft.content, requestId: preview.args.requestId, confirmation: 'append-token', confirmed: true } }]);
    await page.locator('#update-close').click();
    await page.locator('#drafts').getByRole('button', { name: '编辑', exact: true }).click();
    assert.equal(await page.locator('#draft-form textarea[name="content"]').inputValue(), draft.content);
  } finally { await browser.close(); }
});

test('切换为整篇替换后，迟到的追加预览不会替换当前确认内容', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const draft = { id: 'append-race', revision: 1, title: '切换预览', target: '笔记.md', content: '新版', status: 'pending' };
    const original = '原结论';
    const page = await openPage(browser, { width: 1280, height: 900 }, false, {
      local_list: { links: [], drafts: [draft] }, draft_history_source: { content: original, revision: 'a'.repeat(64), vaultId: 'b'.repeat(64) }, draft_note_update_submit: { status: 'completed' },
    });
    await page.evaluate((original) => {
      window.holdAppendPreview = true;
      window.testReplies.draft_note_update_preview = ({ mode, requestId, expectedContent }) => ({ mode, requestId, confirmation: mode, beforeContent: original, afterContent: mode === 'append' ? original + '\n' + expectedContent : expectedContent, unchanged: false, startLine: 1, removed: mode === 'append' ? '' : original, added: expectedContent, ...(mode === 'append' ? { appendedContent: expectedContent } : {}) });
    }, original);
    await page.getByRole('tab', { name: '知识草稿' }).click();
    await page.getByRole('button', { name: '更新已有笔记', exact: true }).click();
    await page.locator('#update-quote:not([disabled])').waitFor();
    await page.locator('#update-original').selectText();
    await page.locator('#update-quote').click();
    await page.getByRole('button', { name: '预览追加结果', exact: true }).click();
    await page.waitForFunction(() => typeof window.releaseAppendPreview === 'function');
    await previewNoteReplacement(page);
    await page.evaluate(async () => {
      window.releaseAppendPreview();
      await new Promise(resolve => requestAnimationFrame(resolve));
    });
    assert.equal(await page.locator('#update-after').textContent(), draft.content);
    await page.getByRole('button', { name: '确认替换整篇笔记', exact: true }).click();
    await page.locator('#update-status').getByText(/更新已完成/).waitFor();
    const submissions = await page.evaluate(() => window.testCalls.filter(({ name }) => name === 'draft_note_update_submit'));
    assert.equal(submissions.length, 1);
    assert.equal(submissions[0].args.confirmation, 'replace');
  } finally { await browser.close(); }
});

test('恢复知识库先校验，路径变更和取消不会写入', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await openPage(browser, { width: 390, height: 844 }, false, {
      knowledge_restore_preview: { target: '/restore/test', token: 'token', files: [{ path: '笔记.md' }], totalBytes: 12 },
      knowledge_restore_create: { target: '/restore/test', files: 1 },
    });
    await page.getByRole('tab', { name: '关联管理' }).click();
    await page.locator('#vault-restore-source').fill('/backup/test');
    await page.locator('#vault-restore-target').fill('/restore/test');
    await page.locator('#vault-restore-preview').click();
    await page.locator('#vault-restore-create').waitFor();
    await page.locator('#vault-restore-create').click(); await confirmDialog(page, false);
    assert.equal(await page.evaluate(() => window.testCalls.filter(item => item.name === 'knowledge_restore_create').length), 0);
    await page.locator('#vault-restore-target').fill('/restore/other');
    assert.equal(await page.locator('#vault-restore-create').isHidden(), true);
    await page.locator('#vault-restore-target').fill('/restore/test');
    await page.locator('#vault-restore-preview').click();
    await page.locator('#vault-restore-create').click(); await confirmDialog(page, true);
    await page.locator('#vault-restore-status').getByText(/恢复完成/).waitFor();
    const calls = await page.evaluate(() => window.testCalls.filter(item => item.name === 'knowledge_restore_create'));
    assert.deepEqual(calls.map(item => item.args), [{ source: '/backup/test', target: '/restore/test', token: 'token', confirmed: true }]);
    if (process.env.RESTORE_SCREENSHOT) await page.screenshot({ path: process.env.RESTORE_SCREENSHOT });
  } finally { await browser.close(); }
});

test('恢复失败后提示检查部分目录并清除预览', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await openPage(browser, { width: 1024, height: 768 }, false, {
      knowledge_restore_preview: { target: '/restore/test', token: 'token', files: [], totalBytes: 0 },
      knowledge_restore_create: { isError: true, content: [{ type: 'text', text: '写入失败' }] },
    });
    await page.getByRole('tab', { name: '关联管理' }).click();
    await page.locator('#vault-restore-source').fill('/backup/test'); await page.locator('#vault-restore-target').fill('/restore/test');
    await page.locator('#vault-restore-preview').click(); await page.locator('#vault-restore-create').click(); await confirmDialog(page, true);
    await page.locator('#vault-restore-status').getByText(/目标目录可能包含部分文件/).waitFor();
    assert.equal(await page.locator('#vault-restore-create').isHidden(), true);
  } finally { await browser.close(); }
});

test('草稿可暂缓并恢复，操作绑定版本且不覆盖正在编辑的内容', async () => {
  const browser = await chromium.launch({ headless: true });
  const draft = { id: 'draft-1', title: '测试草稿', target: '笔记.md', content: '原文', status: 'pending', revision: 1 };
  try {
    const page = await openPage(browser, { width: 390, height: 844 }, false, { local_list: { links: [], drafts: [draft] }, local_save_draft: {} });
    await page.getByRole('tab', { name: '知识草稿' }).click();
    const row = page.locator('#drafts article').filter({ hasText: '测试草稿' });
    await row.getByText(/待确认/).waitFor();
    await row.getByRole('button', { name: '编辑' }).click();
    await page.locator('#draft-form textarea[name="content"]').fill('未保存内容');
    await row.getByRole('button', { name: '暂缓' }).click();
    assert.equal(await page.evaluate(() => window.testCalls.filter(item => item.name === 'local_save_draft').length), 0);
    assert.equal(await page.locator('#draft-form textarea[name="content"]').inputValue(), '未保存内容');
    await page.getByRole('button', { name: '清空' }).click(); await confirmDialog(page, true);
    await row.getByRole('button', { name: '暂缓' }).click();
    await page.getByText('草稿已暂缓').waitFor();
    const calls = await page.evaluate(() => window.testCalls.filter(item => item.name === 'local_save_draft'));
    assert.equal(calls[0].args.status, 'deferred'); assert.equal(calls[0].args.expectedRevision, 1);
    assert.equal(calls[0].args.content, '原文'); assert.equal(calls[0].args.confirmed, true);
    const deferredPage = await openPage(browser, { width: 1024, height: 768 }, false, {
      local_list: { links: [], drafts: [{ ...draft, status: 'deferred', revision: 2 }] },
      local_save_draft: { isError: true, content: [{ type: 'text', text: '草稿已被修改' }] },
    });
    await deferredPage.getByRole('tab', { name: '知识草稿' }).click();
    await deferredPage.getByRole('button', { name: '恢复待确认' }).click();
    await deferredPage.getByText(/状态更新未确认成功：草稿已被修改/).waitFor();
    const retry = await deferredPage.evaluate(() => window.testCalls.find(item => item.name === 'local_save_draft'));
    assert.equal(retry.args.status, 'pending'); assert.equal(retry.args.expectedRevision, 2);
  } finally { await browser.close(); }
});

test('暂缓或舍弃草稿须恢复待确认后才能预览写入', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const status of ['deferred', 'discarded']) {
      const draft = { id: `draft-${status}`, title: `草稿-${status}`, target: '笔记.md', content: '正文', status, revision: 2 };
      const page = await openPage(browser, { width: 390, height: 844 }, false, {
        local_list: { links: [], drafts: [draft] }, local_save_draft: {},
        draft_publication_get: null,
        knowledge_inspect_content_references: { path: '笔记.md', references: [] },
      });
      await page.getByRole('tab', { name: '知识草稿' }).click();
      const row = page.locator('#drafts article').filter({ hasText: draft.title });
      assert.equal(await row.getByRole('button', { name: '新建笔记' }).count(), 0);
      await page.evaluate((draft) => { window.testReplies.local_list.drafts = [{ ...draft, status: 'pending', revision: 3 }]; }, draft);
      await row.getByRole('button', { name: '恢复待确认' }).click();
      await page.getByText('草稿已恢复待确认').waitFor();
      const call = await page.evaluate(() => window.testCalls.find((item) => item.name === 'local_save_draft'));
      assert.equal(call.args.status, 'pending');
      assert.equal(call.args.expectedRevision, 2);
      await row.getByRole('button', { name: '新建笔记' }).click();
      await page.locator('#publish-dialog[open]').waitFor();
      await page.close();
    }
  } finally { await browser.close(); }
});

test('写入结果不确定时只读核对，不解锁重复提交', async () => {
  const browser = await chromium.launch({ headless: true });
  const draft = { id: 'draft-1', title: '测试草稿', target: 'note.md', content: '正文', status: 'pending', revision: 1 };
  try {
    const page = await openPage(browser, { width: 390, height: 844 }, false, {
      local_list: { links: [], drafts: [draft] },
      draft_publication_get: { status: 'unknown' },
      draft_publication_inspect: { status: 'matches' },
    });
    await page.getByRole('tab', { name: '知识草稿' }).click();
    await page.getByRole('button', { name: '新建笔记' }).click();
    await page.getByRole('button', { name: '核对目标文件' }).click();
    await page.getByText(/不能证明由本次提交写入/).waitFor();
    assert.equal(await page.getByRole('button', { name: '确认新建' }).isDisabled(), true);
    const calls = await page.evaluate(() => window.testCalls.filter(item => item.name.startsWith('draft_')));
    assert.deepEqual(calls.map(item => item.name), ['draft_publication_get', 'draft_publication_inspect']);
    assert.equal(calls[1].args.expectedContent, '正文');
    await page.evaluate(() => { window.testReplies.draft_publication_inspect = { status: 'unavailable' }; });
    await page.getByRole('button', { name: '核对目标文件' }).click();
    await page.getByText(/无法读取目标文件/).waitFor();
  } finally { await browser.close(); }
});

test('工作项按项目类型和状态筛选', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await openPage(browser, { width: 1024, height: 768 });
    await page.locator('select[name="typeId"]').selectOption('35');
    await page.locator('select[name="statusId"]').selectOption('4787');
    await page.getByRole('button', { name: '查询工作项' }).click();
    await page.waitForFunction(() => window.testCalls.some(item => item.name === 'choerodon_scoped_search' && item.args.typeId === '35' && item.args.statusId === '4787'));
    await page.locator('select[name="typeId"]').selectOption('');
    await page.waitForFunction(() => !document.querySelector('select[name="statusId"]').disabled && [...document.querySelector('select[name="statusId"]').options].some(option => option.value === '4787'));
    assert.equal(await page.locator('select[name="statusId"]').isDisabled(), false);
    assert.equal(await page.locator('select[name="statusId"]').inputValue(), '');
    await page.locator('select[name="statusId"]').selectOption('4787');
    await page.getByRole('button', { name: '查询工作项' }).click();
    await page.waitForFunction(() => window.testCalls.some(item => item.name === 'choerodon_scoped_search' && !item.args.typeId && item.args.statusId === '4787'));
  } finally { await browser.close(); }
});

test('知识库支持筛选路径并安全查看 Markdown 原文', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await openPage(browser, { width: 1024, height: 768 });
    await page.getByRole('tab', { name: '知识库' }).click();
    await page.getByText('项目/设计.md', { exact: true }).waitFor();
    await page.locator('#knowledge-filter').fill('设计');
    assert.equal(await page.getByText('记录.md', { exact: true }).count(), 0);
    await page.locator('#knowledge-list .row').getByRole('button', { name: '查看' }).click();
    await page.locator('#knowledge-content').getByText('<script>unsafe</script>', { exact: false }).waitFor();
    assert.equal(await page.locator('#knowledge-content script').count(), 0);
    await page.evaluate(() => { window.testReplies.knowledge_catalog = { isError: true, content: [{ type: 'text', text: '知识库不可用' }] }; });
    await page.getByRole('button', { name: '刷新笔记' }).click();
    await page.getByText(/加载失败：知识库不可用/).waitFor();
  } finally { await browser.close(); }
});

test('笔记引用检查展示状态并拒绝过期结果', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await openPage(browser, process.env.REFERENCE_DESKTOP ? { width: 1280, height: 900 } : { width: 390, height: 844 });
    await page.getByRole('tab', { name: '知识库' }).click();
    await page.locator('#knowledge-list .row').first().getByRole('button', { name: '查看' }).click();
    await page.getByRole('button', { name: '检查图片和链接' }).click();
    await page.locator('#knowledge-references').getByText('图片 · 未找到').waitFor();
    if (process.env.REFERENCE_SCREENSHOT) await page.screenshot({ path: process.env.REFERENCE_SCREENSHOT, fullPage: true });
    assert.equal(await page.locator('#knowledge-references').getByText('链接 · 外部链接').count(), 1);
    assert.equal(await page.locator('#knowledge-references a').count(), 0);
    await page.evaluate(() => { window.testReplies.knowledge_inspect_references.revision = 'changed'; });
    await page.getByRole('button', { name: '检查图片和链接' }).click();
    await page.getByText(/笔记内容已变化，请重新查看后检查/).waitFor();
    assert.equal(await page.locator('#knowledge-references').getByText('图片 · 未找到').count(), 0);
  } finally { await browser.close(); }
});

test('知识库正文搜索展示匹配行并可打开笔记', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await openPage(browser, { width: 1024, height: 768 });
    await page.getByRole('tab', { name: '知识库' }).click();
    await page.locator('#knowledge-query').fill('事件流');
    await page.locator('#knowledge-search').click();
    await page.getByText('2: 事件流原因', { exact: true }).waitFor();
    assert.equal(await page.locator('#knowledge-search-results .row').count(), 1);
    await page.locator('#knowledge-search-results').getByRole('button', { name: '查看' }).click();
    await page.locator('#knowledge-status').waitFor();
    assert.equal(await page.locator('#knowledge-status').textContent(), 'Markdown 原文');
    const call = await page.evaluate(() => window.testCalls.find(item => item.name === 'knowledge_search'));
    assert.equal(call.args.query, '事件流');
  } finally { await browser.close(); }
});

test('正文搜索可继续扫描后续页面，修改关键词清除旧结果', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await openPage(browser, { width: 390, height: 844 });
    await page.evaluate(() => { window.testReplies.knowledge_search = { scanned: 1, skipped: 0, truncated: true, nextCursor: 'a.md', results: [{ path: 'a.md', matches: [{ number: 1, line: '事件流' }] }] }; });
    await page.getByRole('tab', { name: '知识库' }).click();
    await page.locator('#knowledge-query').fill('事件流');
    await page.locator('#knowledge-search').click();
    await page.getByRole('button', { name: '继续搜索' }).waitFor();
    await page.evaluate(() => { window.testReplies.knowledge_search = { scanned: 1, skipped: 0, truncated: false, nextCursor: null, results: [{ path: 'b.md', matches: [{ number: 2, line: '事件流原因' }] }] }; });
    await page.getByRole('button', { name: '继续搜索' }).click();
    await page.getByText('b.md', { exact: true }).waitFor();
    assert.equal(await page.locator('#knowledge-search-results .row').count(), 2);
    const calls = await page.evaluate(() => window.testCalls.filter(item => item.name === 'knowledge_search'));
    assert.equal(calls[1].args.cursor, 'a.md');
    await page.locator('#knowledge-query').fill('其他');
    assert.equal(await page.locator('#knowledge-search-results .row').count(), 0);
  } finally { await browser.close(); }
});

test('知识库备份预览绑定目标，取消不写入并确认后创建', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await openPage(browser, { width: 390, height: 844 }, false, {
      knowledge_backup_preview: { target: '/backup/test', token: 'token', totalBytes: 12, files: [{ path: '笔记.md' }, { path: '附件/图片.png' }] },
      knowledge_backup_create: { target: '/backup/test', files: 2, totalBytes: 12 },
    });
    await page.getByRole('tab', { name: '关联管理' }).click();
    await page.locator('#vault-backup-target').fill('/backup/test');
    await page.getByRole('button', { name: '预览知识库备份' }).click();
    await page.getByText(/2 个文件，共 12 字节/).waitFor();
    await page.getByText('查看文件清单').click();
    assert.equal(await page.getByText('附件/图片.png').count(), 1);
    if (process.env.VAULT_BACKUP_SCREENSHOT) await page.screenshot({ path: process.env.VAULT_BACKUP_SCREENSHOT, fullPage: true });
    await page.getByRole('button', { name: '确认创建备份' }).click(); await confirmDialog(page, false);
    assert.equal(await page.evaluate(() => window.testCalls.some(item => item.name === 'knowledge_backup_create')), false);
    await page.locator('#vault-backup-target').fill('/backup/other');
    assert.equal(await page.getByRole('button', { name: '确认创建备份' }).isVisible(), false);
    await page.locator('#vault-backup-target').fill('/backup/test');
    await page.getByRole('button', { name: '预览知识库备份' }).click();
    await page.getByRole('button', { name: '确认创建备份' }).click(); await confirmDialog(page, true);
    await page.getByText(/备份已创建/).waitFor();
    assert.deepEqual(await page.evaluate(() => window.testCalls.find(item => item.name === 'knowledge_backup_create').args), { target: '/backup/test', token: 'token', confirmed: true });
  } finally { await browser.close(); }
});

test('知识库备份失败后要求检查目标，不保留旧确认', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await openPage(browser, { width: 1024, height: 768 }, false, {
      knowledge_backup_preview: { target: '/backup/test', token: 'token', totalBytes: 12, files: [{ path: '笔记.md' }] },
      knowledge_backup_create: { isError: true, content: [{ type: 'text', text: '备份未完成' }] },
    });
    await page.getByRole('tab', { name: '关联管理' }).click();
    await page.locator('#vault-backup-target').fill('/backup/test');
    await page.getByRole('button', { name: '预览知识库备份' }).click();
    await page.getByRole('button', { name: '确认创建备份' }).click(); await confirmDialog(page, true);
    await page.getByText(/请先检查目标目录/).waitFor();
    assert.equal(await page.getByRole('button', { name: '确认创建备份' }).isVisible(), false);
    assert.equal(await page.getByRole('button', { name: '预览知识库备份' }).isEnabled(), true);
  } finally { await browser.close(); }
});

test('索引备份确认导出，导入需逐项处理冲突', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const backup = { version: 3, links: [], noteLinks: [], drafts: [] };
    const conflict = { collection: 'drafts', key: 'draft-1', current: { title: '当前' }, incoming: { title: '备份' } };
    const page = await openPage(browser, { width: 1024, height: 768 }, false, {
      local_export: backup, local_import_preview: { token: 'token', counts: { links: 0, noteLinks: 0, drafts: 1 }, conflicts: [conflict] }, local_import_apply: {},
    });
    await page.getByRole('tab', { name: '关联管理' }).click();
    await page.getByRole('button', { name: '导出索引' }).click(); await confirmDialog(page, false);
    assert.equal(await page.evaluate(() => window.testDownloads.length), 0);
    await page.getByRole('button', { name: '导出索引' }).click(); await confirmDialog(page, true);
    await page.getByText(/已向宿主提交保存请求/).waitFor();
    assert.equal(await page.evaluate(() => window.testDownloads.length), 1);
    await page.locator('#backup-file').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
    await page.getByText(/1 项冲突/).waitFor();
    await page.getByRole('button', { name: '确认导入' }).click();
    await page.getByText('请为每一项冲突选择处理方式。').waitFor();
    assert.equal(await page.evaluate(() => window.testCalls.some((item) => item.name === 'local_import_apply')), false);
    await page.locator('#backup-preview select').selectOption('skip');
    await page.getByRole('button', { name: '确认导入' }).click(); await confirmDialog(page, true);
    await page.getByText('索引已导入。').waitFor();
    const call = await page.evaluate(() => window.testCalls.find((item) => item.name === 'local_import_apply'));
    assert.equal(call.args.confirmed, true); assert.deepEqual(call.args.decisions, { '["drafts","draft-1"]': 'skip' });
  } finally { await browser.close(); }
});

test('工作项可查看知识关联并选择笔记关联', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const issue = { environment: 'https://example.test', tenantId: '7', projectId: '1', issueId: '3', title: '测试工作项' };
    const page = await openPage(browser, { width: 1024, height: 768 }, false, {
      local_list: { links: [], drafts: [], noteLinks: [{ issue, provider: 'markdown', path: '项目/设计.md', title: '设计', vaultId: 'vault' }] },
      knowledge_link_issue: {},
      knowledge_read_link: { path: '项目/设计.md', content: '# 设计\n<script>unsafe</script>' },
    });
    await page.getByRole('button', { name: '知识记录' }).click();
    await page.locator('#notes-linked').getByText('设计', { exact: true }).waitFor();
    await page.locator('#notes-linked').getByRole('button', { name: '查看' }).click();
    await page.locator('#notes-linked pre').getByText('<script>unsafe</script>', { exact: false }).waitFor();
    assert.equal(await page.locator('#notes-linked script').count(), 0);
    await page.locator('#notes-select').selectOption('记录.md');
    await page.locator('#notes-add').click();
    await confirmDialog(page, true);
    await page.getByText('关联已保存。').waitFor();
    const call = await page.evaluate(() => window.testCalls.find((item) => item.name === 'knowledge_link_issue'));
    assert.equal(call.args.path, '记录.md'); assert.equal(call.args.issue.issueId, '3'); assert.equal(call.args.confirmed, true);
  } finally { await browser.close(); }
});

test('从工作项新建草稿并在写入后单独关联', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const issue = { environment: 'https://example.test', tenantId: '7', projectId: '1', issueId: '3', title: '测试工作项' };
    const draft = { id: 'draft-1', revision: 1, title: '测试工作项', target: '记录.md', content: '# 记录', status: 'pending', issue };
    const page = await openPage(browser, { width: 1024, height: 768 }, false, { local_save_draft: {}, draft_publication_get: null, draft_publish: { status: 'completed' }, draft_link_publication: {} });
    await page.getByRole('button', { name: '知识记录' }).click();
    await page.getByRole('button', { name: '创建知识草稿' }).click();
    await page.locator('#draft-issue').getByText('关联工作项（1）', { exact: true }).waitFor();
    await page.locator('#draft-issue').getByText(/测试工作项.*租户 7.*项目 1.*工作项 3/).waitFor();
    await page.locator('#draft-form textarea[name="content"]').fill('# 记录');
    await page.getByRole('button', { name: '选择已有文档', exact: true }).click();
    await page.locator('#target-browser').getByRole('button', { name: '选择文档：记录.md', exact: true }).click();
    await page.locator('#draft-form button[type="submit"]').click();
    await page.getByText('草稿已保存').waitFor();
    const saved = await page.evaluate(() => window.testCalls.find(item => item.name === 'local_save_draft'));
    assert.equal(saved.args.issues[0].issueId, '3');
    const reviewPage = await openPage(browser, { width: 1024, height: 768 }, false, { local_list: { links: [], drafts: [draft], noteLinks: [] }, draft_publication_get: null, draft_publish: { status: 'completed' }, draft_link_publication: {} });
    await reviewPage.getByRole('tab', { name: '知识草稿' }).click();
    await reviewPage.getByRole('button', { name: '新建笔记' }).click();
    await reviewPage.locator('#publish-confirm').click();
    await reviewPage.locator('#publish-link').click(); await confirmDialog(reviewPage, true);
    await reviewPage.getByText('笔记已关联工作项。').waitFor();
    assert.equal(await reviewPage.evaluate(() => window.testCalls.filter(item => item.name === 'draft_publish').length), 1);
    assert.equal(await reviewPage.evaluate(() => window.testCalls.filter(item => item.name === 'draft_link_publication').length), 1);
  } finally { await browser.close(); }
});

test('草稿预览后确认新建，重复版本不可提交', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const draft = { id: 'draft-1', revision: 2, title: '设计', target: '项目/设计.md', content: '# 设计\n<script>unsafe</script>', status: 'pending' };
    const page = await openPage(browser, { width: 1024, height: 768 }, false, { local_list: { links: [], drafts: [draft] }, draft_publication_get: null, draft_publish: { status: 'completed' } });
    await page.getByRole('tab', { name: '知识草稿' }).click();
    await page.getByRole('button', { name: '新建笔记' }).click();
    await page.getByText('请核对路径和完整内容后确认新建。').waitFor();
    if (process.env.X_ASSISTANT_PREVIEW_SCREENSHOT) await page.screenshot({ path: process.env.X_ASSISTANT_PREVIEW_SCREENSHOT });
    assert.equal(await page.locator('#publish-content script').count(), 0);
    assert.equal(await page.locator('#publish-target').textContent(), draft.target);
    await page.locator('#publish-confirm').click();
    await page.getByText('此版本已写入知识库。').waitFor();
    const call = await page.evaluate(() => window.testCalls.find((item) => item.name === 'draft_publish'));
    assert.deepEqual(call.args, { id: draft.id, revision: 2, target: draft.target, expectedContent: draft.content, confirmed: true });
    assert.equal(await page.locator('#publish-confirm').isDisabled(), true);
    await page.locator('#publish-close').click();
    await page.evaluate(() => { window.testReplies.draft_publication_get = { status: 'completed' }; });
    await page.getByRole('button', { name: '新建笔记' }).click();
    await page.getByText('此版本已写入知识库。').waitFor();
    assert.equal(await page.locator('#publish-confirm').isDisabled(), true);
  } finally { await browser.close(); }
});

test('草稿可只读检查目标是否已存在', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const draft = { id: 'draft-1', revision: 1, title: '记录', target: '项目/设计.md', content: '新内容', status: 'pending' };
    const page = await openPage(browser, { width: 390, height: 844 }, false, {
      local_list: { links: [], drafts: [draft] }, draft_publication_get: null,
      draft_preview_note_update: { startLine: 2, unchanged: false, removed: '<script>旧内容</script>', added: '新内容', beforeContent: '完整原文\n<script>旧内容</script>' },
    });
    await page.getByRole('tab', { name: '知识草稿' }).click();
    await page.getByRole('button', { name: '新建笔记' }).click();
    await page.getByRole('button', { name: '检查目标是否已存在' }).click();
    await page.getByText('从第 2 行开始的变化（仅供预览）：').waitFor();
    assert.equal(await page.locator('#publish-comparison script').count(), 0);
    assert.equal(await page.locator('#publish-comparison pre').first().textContent(), '<script>旧内容</script>');
    assert.equal(await page.locator('#publish-comparison details pre').textContent(), '完整原文\n<script>旧内容</script>');
    const calls = await page.evaluate(() => window.testCalls);
    assert.deepEqual(calls.find((item) => item.name === 'draft_preview_note_update').args, { id: draft.id, revision: 1, target: draft.target, expectedContent: draft.content });
    assert.equal(calls.some((item) => item.name === 'draft_publish'), false);
    assert.equal(await page.locator('#publish-dialog').evaluate((el) => el.scrollWidth <= el.clientWidth), true);
  } finally { await browser.close(); }
});

test('旧服务仍显示草稿差异，异常原文不会显示', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const draft = { id: 'draft-1', revision: 1, title: '记录', target: '项目/设计.md', content: '新内容', status: 'pending' };
    const page = await openPage(browser, { width: 390, height: 844 }, false, {
      local_list: { links: [], drafts: [draft] }, draft_publication_get: null,
      draft_preview_note_update: { startLine: 2, unchanged: false, removed: '旧内容', added: '新内容' },
    });
    await page.getByRole('tab', { name: '知识草稿' }).click();
    await page.getByRole('button', { name: '新建笔记' }).click();
    await page.getByRole('button', { name: '检查目标是否已存在' }).click();
    await page.getByText('当前服务未提供完整原文，请更新服务后重新对比。').waitFor();
    assert.equal(await page.locator('#publish-comparison pre').first().textContent(), '旧内容');
    assert.equal(await page.locator('#publish-comparison details').count(), 0);
    await page.evaluate(() => { window.testReplies.draft_preview_note_update.beforeContent = null; });
    await page.getByRole('button', { name: '检查目标是否已存在' }).click();
    await page.getByText('无法对比：对比结果格式无效。请检查目标笔记及草稿版本。').waitFor();
    assert.equal(await page.locator('#publish-comparison pre').count(), 0);
    const calls = await page.evaluate(() => window.testCalls);
    assert.equal(calls.some((item) => item.name === 'draft_publish'), false);
  } finally { await browser.close(); }
});

test('草稿预览显示缺失图片与外部引用，不写入知识库', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const draft = { id: 'draft-1', revision: 1, title: '记录', target: '项目/设计.md', content: '![图](missing.png)', status: 'pending' };
    const page = await openPage(browser, { width: 390, height: 844 }, false, {
      local_list: { links: [], drafts: [draft] }, draft_publication_get: null,
      knowledge_inspect_content_references: { path: draft.target, references: [{ kind: 'image', destination: 'missing.png', status: 'missing' }, { kind: 'link', destination: 'https://example.com', status: 'external' }] },
    });
    await page.getByRole('tab', { name: '知识草稿' }).click();
    await page.getByRole('button', { name: '新建笔记' }).click();
    await page.locator('#publish-references').getByText('图片：missing.png · 未找到').waitFor();
    assert.equal(await page.locator('#publish-references').getByText('链接：https://example.com · 外部链接').count(), 1);
    assert.equal(await page.evaluate(() => window.testCalls.some((call) => call.name === 'draft_publish')), false);
  } finally { await browser.close(); }
});

test('草稿引用检查尚未完成时不能确认新建', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const draft = { id: 'draft-1', revision: 1, title: '记录', target: '项目/设计.md', content: '# 记录', status: 'pending' };
    const page = await openPage(browser, { width: 390, height: 844 }, false, { local_list: { links: [], drafts: [draft] }, draft_publication_get: null });
    await page.evaluate(() => { window.holdReferenceCheck = true; });
    await page.getByRole('tab', { name: '知识草稿' }).click();
    await page.getByRole('button', { name: '新建笔记' }).click();
    await page.waitForFunction(() => typeof window.releaseReferenceCheck === 'function');
    assert.equal(await page.locator('#publish-confirm').isDisabled(), true);
    await page.evaluate(() => window.releaseReferenceCheck());
    await page.waitForFunction(() => !document.querySelector('#publish-confirm').disabled);
  } finally { await browser.close(); }
});

test('引用检查超时后提示人工核对，并忽略迟到的结果', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const draft = { id: 'draft-1', revision: 1, title: '记录', target: '项目/设计.md', content: '# 记录', status: 'pending' };
    const page = await openPage(browser, { width: 390, height: 844 }, false, { local_list: { links: [], drafts: [draft] }, draft_publication_get: null });
    await page.clock.install();
    await page.evaluate(() => { window.holdReferenceCheck = true; });
    await page.getByRole('tab', { name: '知识草稿' }).click();
    await page.getByRole('button', { name: '新建笔记' }).click();
    await page.waitForFunction(() => typeof window.releaseReferenceCheck === 'function');
    await page.clock.fastForward(8000);
    await page.locator('#publish-references').getByText(/引用检查失败：请求超时/).waitFor();
    assert.equal(await page.locator('#publish-confirm').isEnabled(), true);
    await page.evaluate(() => window.releaseReferenceCheck());
    assert.match(await page.locator('#publish-references').textContent(), /请求超时/);
  } finally { await browser.close(); }
});

test('写入记录检查超时后禁止提交并可关闭', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const draft = { id: 'draft-1', revision: 1, title: '记录', target: '项目/设计.md', content: '# 记录', status: 'pending' };
    const page = await openPage(browser, { width: 390, height: 844 }, false, { local_list: { links: [], drafts: [draft] } });
    await page.clock.install();
    await page.evaluate(() => { window.holdPublicationCheck = true; });
    await page.getByRole('tab', { name: '知识草稿' }).click();
    await page.getByRole('button', { name: '新建笔记' }).click();
    await page.waitForFunction(() => typeof window.releasePublicationCheck === 'function');
    await page.clock.fastForward(8000);
    await page.locator('#publish-status').getByText(/无法检查写入记录：请求超时/).waitFor();
    assert.equal(await page.locator('#publish-confirm').isDisabled(), true);
    await page.locator('#publish-close').click();
    assert.equal(await page.evaluate(() => window.testCalls.some((call) => call.name === 'draft_publish')), false);
  } finally { await browser.close(); }
});

test('移动端草稿写入失败后禁止重复提交，可关闭核对', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await openPage(browser, { width: 390, height: 844 }, false, {
      local_list: { links: [], drafts: [{ id: 'draft-1', revision: 1, title: '草稿', target: '记录.md', content: '# 记录', status: 'pending' }] },
      draft_publication_get: null, draft_publish: { isError: true, content: [{ type: 'text', text: '连接中断' }] },
    });
    await page.getByRole('tab', { name: '知识草稿' }).click();
    await page.getByRole('button', { name: '新建笔记' }).click();
    await page.getByText('请核对路径和完整内容后确认新建。').waitFor();
    await page.locator('#publish-confirm').click();
    await page.getByText(/写入结果待核对：连接中断/).waitFor();
    assert.equal(await page.locator('#publish-confirm').isDisabled(), true);
    assert.equal(await page.evaluate(() => { const el = document.querySelector('#publish-dialog'); return el.scrollWidth <= el.clientWidth; }), true);
    await page.locator('#publish-close').click();
    await page.evaluate(() => { window.testReplies.draft_publication_get = { status: 'unknown' }; });
    await page.getByRole('button', { name: '新建笔记' }).click();
    await page.getByText('写入结果待核对，请先检查目标文件，勿重复提交。').waitFor();
    assert.equal(await page.locator('#publish-confirm').isDisabled(), true);
    assert.equal(await page.evaluate(() => window.testCalls.filter((x) => x.name === 'draft_publish').length), 1);
  } finally { await browser.close(); }
});

test('写入前检查失败可修复后重试', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await openPage(browser, { width: 390, height: 844 }, false, {
      local_list: { links: [], drafts: [{ id: 'draft-1', revision: 1, title: '草稿', target: '目录/记录.md', content: '# 记录', status: 'pending' }] },
      draft_publication_get: null, draft_publish: { status: 'preflight_failed' },
    });
    await page.getByRole('tab', { name: '知识草稿' }).click();
    await page.getByRole('button', { name: '新建笔记' }).click();
    await page.getByText('请核对路径和完整内容后确认新建。').waitFor();
    await page.locator('#publish-confirm').click();
    await page.getByText(/尚未写入。请检查知识库配置/).waitFor();
    assert.equal(await page.locator('#publish-confirm').isEnabled(), true);
    await page.evaluate(() => { window.testReplies.draft_publish = { status: 'completed' }; });
    await page.locator('#publish-confirm').click();
    await page.getByText('此版本已写入知识库。').waitFor();
    assert.equal(await page.evaluate(() => window.testCalls.filter((x) => x.name === 'draft_publish').length), 2);
  } finally { await browser.close(); }
});

test('草稿包含疑似凭据时提示处理并阻止重复提交', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await openPage(browser, { width: 390, height: 844 }, false, {
      local_list: { links: [], drafts: [{ id: 'draft-1', revision: 1, title: '草稿', target: '记录.md', content: '# 记录', status: 'pending' }] },
      draft_publication_get: null, draft_publish: { status: 'sensitive_detected', findings: ['密码或访问密钥'] },
    });
    await page.getByRole('tab', { name: '知识草稿' }).click();
    await page.getByRole('button', { name: '新建笔记' }).click();
    await page.getByText('请核对路径和完整内容后确认新建。').waitFor();
    await page.locator('#publish-confirm').click();
    await page.getByText(/检测到疑似敏感信息：密码或访问密钥/).waitFor();
    assert.equal(await page.locator('#publish-confirm').isDisabled(), true);
    assert.equal(await page.locator('#publish-close').isEnabled(), true);
  } finally { await browser.close(); }
});

for (const [name, viewport] of [['desktop', { width: 1280, height: 900 }], ['mobile', { width: 390, height: 844 }]]) {
  test(`${name}: 会话关键词搜索和分页保留工程范围`, async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await openPage(browser, viewport);
    try {
      await page.evaluate(() => {
        window.testReplies.codex_sessions = ({ searchTerm, cursor }) => searchTerm
          ? cursor ? { data: [{ id: 'second', title: '第二页' }], nextCursor: null } : { data: [{ id: 'first', title: '搜索结果' }], nextCursor: 'page-2' }
          : { data: [], nextCursor: null };
      });
      await page.getByRole('button', { name: '关联会话', exact: true }).click();
      await page.locator('select[name="codexProject"]').selectOption({ label: '工程 · /work' });
      await page.getByLabel('会话关键词').fill('设计');
      await page.getByRole('button', { name: '搜索会话' }).click();
      await page.locator('select[name="sessionId"] option[value="first"]').waitFor({ state: 'attached' });
      await page.getByRole('button', { name: '加载更多会话' }).click();
      await page.locator('select[name="sessionId"] option[value="second"]').waitFor({ state: 'attached' });
      const calls = await page.evaluate(() => window.testCalls.filter((item) => item.name === 'codex_sessions'));
      assert.deepEqual(calls.at(-1).args, { cwd: '/work', searchTerm: '设计', cursor: 'page-2' });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    } finally { await browser.close(); }
  });
  test(`${name}: 工作项选择会话并确认关联`, async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await openPage(browser, viewport);
    try {
      await page.getByRole('button', { name: '关联会话', exact: true }).click();
      await page.locator('select[name="codexProject"]').selectOption({ label: '工程 · /work' });
      await page.locator('select[name="sessionId"]').selectOption('thread');
      assert.equal(await page.locator('#create-session').isEnabled(), true);
      await page.getByRole('button', { name: '关联已有会话' }).click();
      await confirmDialog(page, true);
      await page.getByText('会话关联已保存').waitFor();
      const calls = await page.evaluate(() => window.testCalls);
      const link = calls.find((call) => call.name === 'codex_link_session');
      assert.equal(link.args.issue.issueId, '3');
      assert.equal(link.args.sessionId, 'thread');
      assert.equal(link.args.confirmed, true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    } finally { await browser.close(); }
  });
}

test('关联及创建确认期间变更主工作项不会提交', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const operation of ['link', 'create']) {
      const page = await openPage(browser, { width: 390, height: 844 });
      await selectSession(page);
      await page.getByRole('button', { name: operation === 'link' ? '关联已有会话' : '创建会话并关联' }).click();
      await page.locator('#confirm-message').getByText(/工程目录：\/work/).waitFor();
      if (operation === 'link') await page.locator('#confirm-message').getByText(/测试会话.*thread/).waitFor();
      await page.evaluate(() => { document.querySelector('#session-form [name="primary"]').checked = true; });
      await confirmDialog(page, true);
      await page.locator('#session-status').getByText(/已变化/).waitFor();
      const calls = await page.evaluate(() => window.testCalls);
      assert.equal(calls.some((item) => item.name === (operation === 'link' ? 'codex_link_session' : 'codex_create_link')), false);
      await page.close();
    }
  } finally { await browser.close(); }
});

test('创建确认展示完整身份并提交已确认工程', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await openPage(browser, { width: 390, height: 844 });
    await selectSession(page);
    await page.getByRole('button', { name: '创建会话并关联' }).click();
    const text = await page.locator('#confirm-message').textContent();
    for (const expected of ['https://example.test', '租户 ID：7', '项目 ID：1', '工作项 ID：3', '用户 ID：11', '工程目录：/work']) assert.ok(text.includes(expected));
    await confirmDialog(page, true);
    await page.getByRole('button', { name: '打开新会话', exact: true }).waitFor();
    const call = await page.evaluate(() => window.testCalls.find((item) => item.name === 'codex_create_link'));
    assert.equal(call.args.projectId, 'project'); assert.equal(call.args.cwd, '/work'); assert.equal(call.args.issue.issueId, '3'); assert.equal(call.args.userId, '11');
  } finally { await browser.close(); }
});

test('多工作项草稿支持加入移除、保存并逐项关联发布结果', async () => {
  const browser = await chromium.launch({ headless: true });
  const first = { environment: 'https://example.test', tenantId: '7', projectId: '1', issueId: '3', title: '测试工作项' };
  const second = { ...first, issueId: '4', title: '第二项' };
  const draft = { id: 'multi', title: '多工作项', content: '# 多项', target: 'multi.md', revision: 1, status: 'pending', issue: first, issues: [first, second], sourceSession: { id: 'source-thread', title: '来源会话' } };
  try {
    const page = await openPage(browser, { width: 390, height: 844 }, false, { local_list: { links: [], drafts: [draft] }, local_save_draft: {}, draft_publication_get: { status: 'completed' }, draft_link_publication: {} });
    await page.getByRole('tab', { name: '知识草稿' }).click();
    await page.getByRole('button', { name: '编辑', exact: true }).click();
    assert.equal(await page.locator('#draft-issue').getByRole('button', { name: '移除关联' }).count(), 2);
    await page.locator('#draft-issue').getByRole('button', { name: '移除关联' }).first().click();
    await page.getByLabel('已查询工作项').selectOption('0');
    await page.getByRole('button', { name: '加入草稿关联' }).click();
    await page.getByRole('button', { name: '移除来源会话' }).click();
    await page.getByRole('button', { name: '保存草稿', exact: true }).click();
    await page.getByText('草稿已保存', { exact: true }).waitFor();
    const saved = await page.evaluate(() => window.testCalls.find((item) => item.name === 'local_save_draft').args);
    assert.deepEqual(saved.issues.map((issue) => issue.issueId), ['4', '3']);
    assert.equal(saved.sourceSession, null);
    await page.getByRole('button', { name: '新建笔记', exact: true }).click();
    await page.getByRole('button', { name: '关联：测试工作项', exact: true }).click(); await confirmDialog(page, true);
    await page.locator('#publish-issue').getByText('已关联', { exact: true }).waitFor();
    const linked = await page.evaluate(() => window.testCalls.find((item) => item.name === 'draft_link_publication').args);
    assert.equal(linked.issue.issueId, '3');
  } finally { await browser.close(); }
});

test('复审截图：多工作项编辑和发布更新关联在桌面手机排版正常', async () => {
  const browser = await chromium.launch({ headless: true });
  const first = { environment: 'https://example.test', tenantId: '7', projectId: '1', issueId: '3', title: '测试工作项' };
  const second = { ...first, issueId: '4', title: '第二项：跨模块设计决策与知识回溯' };
  const draft = { id: 'review-multi', title: '多工作项知识记录', content: '# 设计决策\n\n保留来源会话，并逐项确认关联。', target: '项目/多工作项.md', revision: 1, status: 'pending', issues: [first, second], sourceSession: { id: 'source-thread', title: '架构设计与实现会话' } };
  try {
    for (const [label, viewport] of [['desktop', { width: 1280, height: 900 }], ['mobile', { width: 390, height: 844 }]]) {
      const page = await openPage(browser, viewport, false, { local_list: { links: [], drafts: [draft] }, draft_publication_get: { status: 'completed' }, knowledge_inspect_content_references: { path: draft.target, references: [] }, draft_note_update_submit: { status: 'completed' } });
      await page.getByRole('tab', { name: '知识草稿' }).click();
      await page.getByRole('button', { name: '编辑', exact: true }).click();
      await page.screenshot({ path: path.join(root, 'verification', `multi-issue-editor-${label}.png`), fullPage: true });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
      await page.getByRole('button', { name: '新建笔记', exact: true }).click();
      await page.getByRole('button', { name: '关联：测试工作项', exact: true }).waitFor();
      await page.screenshot({ path: path.join(root, 'verification', `multi-issue-publish-${label}.png`) });
      assert.equal(await page.locator('#publish-dialog').evaluate((node) => node.scrollWidth > node.clientWidth), false);
      await page.locator('#publish-close').click();
      await page.evaluate(() => { window.testReplies.draft_note_update_preview = (args) => ({ requestId: args.requestId, confirmation: 'token', beforeDigest: 'b'.repeat(64), beforeContent: '# 原文', afterContent: args.expectedContent, unchanged: false, startLine: 1, removed: '# 原文', added: args.expectedContent }); });
      await page.getByRole('button', { name: '更新已有笔记', exact: true }).click();
      await previewNoteReplacement(page);
      await page.locator('#update-confirm').click();
      await page.locator('#update-issue').getByRole('button', { name: '关联：测试工作项', exact: true }).waitFor();
      await page.screenshot({ path: path.join(root, 'verification', `multi-issue-update-${label}.png`) });
      assert.equal(await page.locator('#update-dialog').evaluate((node) => node.scrollWidth > node.clientWidth), false);
      await page.close();
    }
  } finally { await browser.close(); }
});

test('Choerodon 重新登录指引保留最近身份及本地草稿关联', async () => {
  const browser = await chromium.launch({ headless: true });
  const draft = { id: 'kept', title: '保留草稿', content: '# 保留', target: 'keep.md', status: 'pending', revision: 1 };
  try {
    const page = await openPage(browser, { width: 390, height: 844 }, false, { local_list: { links: [], drafts: [draft] } });
    await page.getByText('Choerodon 重新登录说明', { exact: true }).click();
    await page.locator('#auth-context').getByText(/user.*用户 ID：11.*https:\/\/example.test/).waitFor();
    await page.locator('#auth-help').getByText('c7n login', { exact: true }).waitFor();
    assert.equal(await page.locator('#auth-help input').count(), 0);
    await page.evaluate(() => { window.testReplies.choerodon_context = { isError: true, content: [{ type: 'text', text: '网络不可达' }] }; });
    await page.getByRole('button', { name: '刷新账号和项目' }).click();
    await page.locator('#account-status').getByText(/网络不可达/).waitFor();
    assert.equal(await page.locator('#auth-help').getAttribute('open'), '');
    await page.locator('#auth-help').getByText(/网络、API 配置或项目权限/).waitFor();
    await page.getByRole('tab', { name: '知识草稿' }).click();
    await page.locator('#drafts').getByText('保留草稿', { exact: true }).waitFor();
    const writes = await page.evaluate(() => window.testCalls.filter((item) => /local_(save|delete|remove)|login/.test(item.name)));
    assert.equal(writes.length, 0);
  } finally { await browser.close(); }
});

test('项目加载失败后展示错误且不创建关联', async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await openPage(browser, { width: 1024, height: 768 });
  try {
    await page.evaluate(() => { window.testReplies.codex_projects = { isError: true, content: [{ type: 'text', text: '连接失败' }] }; });
    await page.getByRole('button', { name: '关联会话', exact: true }).click();
    await page.getByText('项目加载失败：连接失败').waitFor();
    assert.equal(await page.getByRole('button', { name: '关联已有会话' }).isDisabled(), true);
    assert.equal(await page.evaluate(() => window.testCalls.some((call) => call.name === 'codex_link_session')), false);
  } finally { await browser.close(); }
});

test('工作项只显示自身的多个关联会话，并处理跳转失败', async () => {
  const browser = await chromium.launch({ headless: true });
  const issue = { environment: 'https://example.test', tenantId: '7', projectId: '1', issueId: '3', title: '测试工作项' };
  const link = (target, sessionId, sessionTitle) => ({ issue: target, sessionId, sessionTitle, primary: false });
  try {
    const page = await openPage(browser, { width: 1024, height: 768 }, false, {
      local_list: { links: [
        { ...link(issue, 'thread-a', '第一个会话'), primary: true },
        link(issue, 'thread-b', '第二个会话'),
        link({ ...issue, environment: 'https://other.test' }, 'other-env', '其他环境会话'),
        link({ ...issue, tenantId: '8' }, 'other-tenant', '其他租户会话'),
        link({ ...issue, projectId: '2' }, 'other-project', '其他项目会话'),
      ], drafts: [] },
    });
    const row = page.locator('#search-result article').filter({ hasText: '测试工作项' });
    await row.getByRole('button', { name: '查看会话' }).click();
    const sessions = page.locator('#linked-list');
    await sessions.getByText('第一个会话', { exact: true }).waitFor();
    assert.equal(await sessions.getByText('第二个会话', { exact: true }).count(), 1);
    assert.equal(await sessions.getByText(/其他.*会话/).count(), 0);
    assert.equal(await sessions.locator('article.linked-session').count(), 2);
    assert.equal(await sessions.locator('article.linked-session').first().locator('.linked-session-actions button').count(), 4);
    assert.equal(await sessions.locator('article.linked-session').nth(1).locator('.linked-session-actions button').count(), 4);
    assert.equal(await sessions.getByRole('button', { name: '打开会话' }).count(), 2);
    await sessions.getByRole('button', { name: '打开会话' }).first().click();
    assert.deepEqual(await page.evaluate(() => window.testOpenLinks), ['codex://threads/thread-a']);
    await page.evaluate(() => { window.testOpenLinkResult = { isError: true }; });
    await sessions.getByRole('button', { name: '打开会话' }).nth(1).click();
    await page.getByText(/无法确认打开会话/).waitFor();
    await page.evaluate(() => { window.testOpenLinkError = true; });
    await sessions.getByRole('button', { name: '打开会话' }).nth(1).click();
    assert.equal(await page.evaluate(() => window.testOpenLinks.length), 3);
    await page.locator('#close-linked').click();
    await page.getByRole('tab', { name: '关联管理' }).click();
    const group = page.locator('#links .link-group').filter({ hasText: '第一个会话' });
    assert.equal(await group.count(), 1);
    assert.equal(await group.getByText('第二个会话', { exact: true }).count(), 1);
    assert.equal(await group.getByText('已关联 2 个会话', { exact: false }).count(), 1);
    assert.equal(await group.locator('.link-group-header').getByText('工作项', { exact: true }).count(), 1);
    assert.equal(await group.getByRole('heading', { name: '关联会话' }).count(), 1);
    assert.equal(await group.locator('.link-session-row').count(), 2);
    assert.equal(await group.locator('.link-session-row').first().getByText('此工作项是该会话的主工作项').count(), 1);
    assert.equal(await group.locator('.link-session-row').nth(1).getByText('此工作项是该会话的主工作项').count(), 0);
    assert.equal(await page.locator('#links .link-group').count(), 4);
  } finally { await browser.close(); }
});

test('已有会话跳转无响应时提示并恢复按钮', async () => {
  const browser = await chromium.launch({ headless: true });
  const issue = { environment: 'https://example.test', tenantId: '7', projectId: '1', issueId: '3', title: '测试工作项' };
  try {
    const page = await openPage(browser, { width: 390, height: 844 }, false, { local_list: { links: [{ issue, sessionId: 'thread-a', sessionTitle: '测试会话', primary: false }], drafts: [] } });
    await page.getByRole('button', { name: '查看会话' }).click();
    await page.evaluate(() => { window.holdOpenLink = true; });
    const button = page.locator('#linked-list').getByRole('button', { name: '打开会话' });
    await button.click(); assert.equal(await button.isDisabled(), true);
    await page.locator('#linked-list').getByText(/无法确认打开会话/).waitFor({ timeout: 7000 });
    assert.equal(await button.isEnabled(), true);
    await page.evaluate(() => { window.holdOpenLink = false; });
    await button.click();
    assert.equal(await page.locator('#linked-list').getByText(/无法确认打开会话/).count(), 0);
    assert.equal(await page.evaluate(() => window.testOpenLinks.length), 2);
  } finally { await browser.close(); }
});

test('关联会话显示时间及本地索引摘要', async () => {
  const browser = await chromium.launch({ headless: true });
  const issue = { environment: 'https://example.test', tenantId: '7', projectId: '1', issueId: '3', title: '测试工作项' };
  try {
    const page = await openPage(browser, { width: 390, height: 844 }, false, { local_list: { links: [{ issue, sessionId: 'thread-a', sessionTitle: '测试会话', linkedAt: '2026-01-01T00:00:00Z', summary: '<script>摘要</script>' }], drafts: [] } });
    await page.getByRole('button', { name: '查看会话' }).click();
    await page.locator('#linked-list').getByText('关联时间：2026-01-01T00:00:00Z').waitFor();
    await page.locator('#linked-list').getByText('本地索引摘要（非会话原文）：<script>摘要</script>').waitFor();
    assert.equal(await page.locator('#linked-list script').count(), 0);
  } finally { await browser.close(); }
});

test('按需检查已关联会话元数据，失败保留关联', async () => {
  const browser = await chromium.launch({ headless: true });
  const issue = { environment: 'https://example.test', tenantId: '7', projectId: '1', issueId: '3', title: '测试工作项' };
  try {
    const page = await openPage(browser, { width: 390, height: 844 }, false, {
      local_list: { links: [{ issue, sessionId: 'thread-a', sessionTitle: '原名称', primary: false }], drafts: [] },
      codex_linked_session_info: { id: 'thread-a', title: '最新名称', updatedAt: 1700000000, status: 'idle' },
    });
    await page.getByRole('button', { name: '查看会话' }).click();
    const panel = page.locator('#linked-list');
    assert.equal(await page.evaluate(() => window.testCalls.some(item => item.name === 'codex_linked_session_info')), false);
    await panel.getByRole('button', { name: '检查会话' }).click();
    await panel.getByText(/当前标题：最新名称/).waitFor();
    await page.evaluate(() => { window.testReplies.codex_linked_session_info = { isError: true, content: [{ type: 'text', text: '服务不可用' }] }; });
    await panel.getByRole('button', { name: '检查会话' }).click();
    await panel.getByText(/无法核实会话：服务不可用。关联已保留/).waitFor();
    assert.equal(await panel.getByText('原名称', { exact: true }).count(), 1);
  } finally { await browser.close(); }
});

test('会话标题加粗并可从关联面板解除主工作项关联', async () => {
  const browser = await chromium.launch({ headless: true });
  const issue = { environment: 'https://example.test', tenantId: '7', projectId: '1', issueId: '3', title: '测试工作项' };
  try {
    const page = await openPage(browser, { width: 390, height: 844 }, false, { local_list: { links: [{ issue, sessionId: 'thread-a', sessionTitle: '会话标题', primary: true }], drafts: [] }, local_remove_link: {} });
    await page.getByRole('button', { name: '查看会话' }).click();
    const panel = page.locator('#linked-list');
    assert.equal(await panel.locator('strong.session-title').textContent(), '会话标题');
    await panel.getByRole('button', { name: '解除关联' }).click();
    await page.evaluate(() => { window.testReplies.local_list = { links: [], drafts: [] }; });
    await confirmDialog(page, true);
    await panel.getByText('该工作项暂无关联会话。').waitFor();
    const call = await page.evaluate(() => window.testCalls.find(item => item.name === 'local_remove_link'));
    assert.deepEqual(call.args, { issue, sessionId: 'thread-a', confirmed: true, confirmPrimaryRemoval: true });
  } finally { await browser.close(); }
});

test('部分类型状态失败时保留其他状态并提示不完整', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await openPage(browser, { width: 1024, height: 768 }, false, { choerodon_issue_types: { items: [{ id: '35', name: '开发子任务' }, { id: '1112', name: '特性' }] } });
    await page.evaluate(() => { window.testReplies.choerodon_issue_statuses = (args) => args.typeId === '1112' ? { isError: true, content: [{ type: 'text', text: '状态列表格式无效' }] } : { items: [{ id: '4787', name: '完成任务' }] }; });
    await page.locator('select[name="typeId"]').selectOption('35');
    await page.locator('select[name="typeId"]').selectOption('');
    await page.getByText(/部分状态未加载（特性）/).waitFor();
    assert.equal(await page.locator('select[name="statusId"]').isEnabled(), true);
    assert.equal(await page.locator('select[name="statusId"] option[value="4787"]').count(), 1);
  } finally { await browser.close(); }
});

test('原会话直接生成候选，不读取历史或自动保存', async () => {
  const browser = await chromium.launch({ headless: true });
  const issue = { environment: 'https://example.test', tenantId: '7', projectId: '1', issueId: '3', title: '测试工作项' };
  try {
    const page = await openPage(browser, { width: 1024, height: 768 }, false, { local_list: { links: [{ issue, sessionId: 'thread-a', sessionTitle: '会话' }], drafts: [] } });
    await page.getByRole('button', { name: '查看会话' }).click();
    await page.getByRole('button', { name: '总结会话生成草稿' }).click();
    await page.getByText(/候选基于原会话/).waitFor();
    assert.equal(await page.locator('#draft-form textarea[name="content"]').inputValue(), '候选正文');
    const calls = await page.evaluate(() => window.testCalls.filter(item => item.name === 'codex_session_summary'));
    assert.deepEqual(calls[0].args, { issue, userId: '11', sessionId: 'thread-a', confirmed: true });
    assert.equal(await page.evaluate(() => window.testCalls.some(item => ['codex_linked_session_history', 'local_save_draft', 'draft_publish'].includes(item.name))), false);
  } finally { await browser.close(); }
});

test('原会话总结失败或返回无效内容时保留草稿并可重试', async () => {
  const browser = await chromium.launch({ headless: true });
  const issue = { environment: 'https://example.test', tenantId: '7', projectId: '1', issueId: '3', title: '测试工作项' };
  try {
    const page = await openPage(browser, { width: 390, height: 844 }, false, { local_list: { links: [{ issue, sessionId: 'thread-a', sessionTitle: '会话' }], drafts: [] } });
    await page.getByRole('button', { name: '查看会话' }).click();
    const panel = page.locator('#linked-list');
    const button = panel.getByRole('button', { name: '总结会话生成草稿' });
    await page.evaluate(() => { window.rejectSampling = true; window.holdSampling = true; });
    await button.click();
    await panel.getByText('正在总结会话，完成后将打开草稿编辑器。').waitFor();
    await page.screenshot({ path: path.join(root, 'verification', 'generation-loading-mobile.png') });
    await page.evaluate(() => { window.holdSampling = false; window.releaseSampling(); });
    await panel.getByText(/生成失败/).waitFor();
    await page.screenshot({ path: path.join(root, 'verification', 'generation-error-mobile.png') });
    assert.equal(await button.isEnabled(), true);
    await page.evaluate(() => { window.rejectSampling = false; window.testSamplingResult = { text: null }; });
    await button.click();
    await panel.getByText(/没有返回有效文本/).waitFor();
    await page.evaluate(() => { window.testSamplingResult = { text: 'x'.repeat(100001) }; });
    await button.click();
    await panel.getByText(/没有返回有效文本/).waitFor();
    assert.equal(await page.evaluate(() => window.testCalls.some(item => item.name === 'local_save_draft')), false);
    await page.evaluate(() => { window.testSamplingResult = { text: '候选正文' }; });
    await button.click();
    await page.getByText(/候选基于原会话/).waitFor();
    assert.equal(await page.locator('#draft-form textarea[name="content"]').inputValue(), '候选正文');
  } finally { await browser.close(); }
});

test('生成期间草稿变化后丢弃迟到结果', async () => {
  const browser = await chromium.launch({ headless: true });
  const issue = { environment: 'https://example.test', tenantId: '7', projectId: '1', issueId: '3', title: '测试工作项' };
  try {
    const page = await openPage(browser, { width: 390, height: 844 }, false, { local_list: { links: [{ issue, sessionId: 'thread-a', sessionTitle: '会话' }], drafts: [] } });
    await page.evaluate(() => { window.holdSampling = true; });
    await page.getByRole('button', { name: '查看会话' }).click();
    await page.getByRole('button', { name: '总结会话生成草稿' }).click();
    await page.waitForFunction(() => typeof window.releaseSampling === 'function');
    await page.evaluate(() => { const input = document.querySelector('#draft-form textarea[name="content"]'); input.value = '用户修改'; input.dispatchEvent(new Event('input', { bubbles: true })); window.releaseSampling(); });
    await page.waitForFunction(() => !document.querySelector('#linked-list .linked-session-actions button:last-child').disabled);
    assert.equal(await page.locator('#draft-form textarea[name="content"]').inputValue(), '用户修改');
    assert.equal(await page.evaluate(() => window.testCalls.some(item => item.name === 'local_save_draft')), false);
  } finally { await browser.close(); }
});

test('生成期间关闭会话抽屉后不回填迟到结果', async () => {
  const browser = await chromium.launch({ headless: true });
  const issue = { environment: 'https://example.test', tenantId: '7', projectId: '1', issueId: '3', title: '测试工作项' };
  try {
    const page = await openPage(browser, { width: 390, height: 844 }, false, { local_list: { links: [{ issue, sessionId: 'thread-a', sessionTitle: '会话' }], drafts: [] } });
    await page.evaluate(() => { window.holdSampling = true; });
    await page.getByRole('button', { name: '查看会话' }).click();
    await page.getByRole('button', { name: '总结会话生成草稿' }).click();
    await page.waitForFunction(() => typeof window.releaseSampling === 'function');
    await page.locator('#close-linked').click();
    await page.evaluate(() => window.releaseSampling());
    await page.waitForFunction(() => !document.querySelector('#linked-list .linked-session-actions button:last-child').disabled);
    assert.equal(await page.locator('#draft-form textarea[name="content"]').inputValue(), '');
    assert.equal(await page.evaluate(() => window.testCalls.some(item => item.name === 'local_save_draft')), false);
  } finally { await browser.close(); }
});

test('保存挂起期间从会话创建草稿不会替换当前表单', async () => {
  const browser = await chromium.launch({ headless: true });
  const issue = { environment: 'https://example.test', tenantId: '7', projectId: '1', issueId: '3', title: '测试工作项' };
  try {
    const page = await openPage(browser, { width: 1024, height: 768 }, false, { local_list: { links: [{ issue, sessionId: 'source', sessionTitle: '来源' }], drafts: [] }, local_save_draft: {} });
    await page.getByRole('tab', { name: '知识草稿' }).click();
    await page.locator('#draft-form [name="title"]').fill('保存中的标题');
    await page.locator('#draft-form [name="content"]').fill('保存中的正文');
    await page.evaluate(() => { window.holdDraftSave = true; });
    await page.getByRole('button', { name: '保存草稿', exact: true }).click();
    await page.waitForFunction(() => typeof window.releaseDraftSave === 'function');
    await page.getByRole('tab', { name: '工作项' }).click();
    await page.getByRole('button', { name: '查看会话', exact: true }).click();
    await page.locator('#linked-list').getByRole('button', { name: '总结会话生成草稿' }).click();
    assert.equal(await page.locator('#draft-form [name="title"]').inputValue(), '保存中的标题');
    assert.equal(await page.locator('#linked-panel').isVisible(), true);
    await page.evaluate(() => window.releaseDraftSave());
    await page.getByText('草稿已保存', { exact: true }).waitFor();
    assert.equal(await page.locator('#draft-form [name="title"]').inputValue(), '');
  } finally { await browser.close(); }
});

test('从关联会话创建草稿并保留来源', async () => {
  const browser = await chromium.launch({ headless: true });
  const issue = { environment: 'https://example.test', tenantId: '7', projectId: '1', issueId: '3', title: '测试工作项' };
  try {
    const page = await openPage(browser, { width: 390, height: 844 }, false, {
      local_list: { links: [{ issue, sessionId: 'thread-a', sessionTitle: '来源会话' }], drafts: [] }, local_save_draft: {},
    });
    await page.getByRole('button', { name: '查看会话' }).click();
    await page.locator('#linked-list').getByRole('button', { name: '总结会话生成草稿' }).click();
    assert.equal(await page.locator('#draft-session > span').first().textContent(), '来源会话：来源会话');
    assert.equal(await page.locator('#draft-session').getByRole('button', { name: '移除来源会话' }).isVisible(), true);
    await page.locator('#draft-form textarea[name="content"]').fill('设计原因');
    await page.locator('#draft-form').getByRole('button', { name: '保存草稿' }).click();
    const call = await page.evaluate(() => window.testCalls.find(item => item.name === 'local_save_draft'));
    assert.deepEqual(call.args.sourceSession, { id: 'thread-a', title: '来源会话' });
    assert.equal(call.args.issues[0].issueId, '3');
    assert.equal(await page.evaluate(() => window.testCalls.some(item => item.name === 'codex_linked_session_history')), false);
    assert.equal(await page.evaluate(() => window.testCalls.some(item => item.name === 'draft_publish')), false);
  } finally { await browser.close(); }
});

test('草稿总结需确认替换正文，保留标题、位置和原文', async () => {
  const browser = await chromium.launch({ headless: true });
  const issue = { environment: 'https://example.test', tenantId: '7', projectId: '1', issueId: '3', title: '测试工作项' };
  try {
    const page = await openPage(browser, { width: 390, height: 844 }, false, { local_list: { links: [{ issue, sessionId: 'thread-a', sessionTitle: '原名称' }], drafts: [] } });
    await page.getByRole('button', { name: '查看会话' }).click();
    const panel = page.locator('#linked-list');
    assert.equal(await panel.getByRole('button', { name: '读取历史' }).count(), 0);
    await panel.getByRole('button', { name: '总结会话生成草稿' }).click();
    await page.locator('#draft-form input[name="title"]').fill('自定标题');
    await page.getByRole('button', { name: '选择目录新建文档', exact: true }).click();
    await page.locator('#target-browser').getByRole('button', { name: '选择目录：文档', exact: true }).click();
    await page.locator('#target-filename').fill('总结.md');
    await page.locator('#draft-form textarea[name="content"]').fill('原有内容');
    await page.getByRole('button', { name: '总结会话生成内容' }).click();
    await confirmDialog(page, false);
    assert.equal(await page.locator('#draft-form textarea[name="content"]').inputValue(), '原有内容');
    assert.equal(await page.evaluate(() => window.testCalls.filter(item => item.name === 'codex_session_summary').length), 1);
    await page.getByRole('button', { name: '总结会话生成内容' }).click();
    await confirmDialog(page, true);
    await page.waitForFunction(() => document.querySelector('#draft-form textarea[name="content"]').value === '候选正文');
    assert.equal(await page.locator('#draft-form input[name="title"]').inputValue(), '自定标题');
    assert.equal(await page.locator('#draft-form input[name="target"]').inputValue(), '文档/总结.md');
    assert.equal(await page.locator('#draft-form textarea[name="content"]').inputValue(), '候选正文');
    assert.equal(await page.evaluate(() => window.testCalls.some(item => ['codex_linked_session_history', 'local_save_draft'].includes(item.name))), false);
  } finally { await browser.close(); }
});

test('创建前取消不会调用服务，确认后发送指定初始消息', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await openPage(browser, { width: 1024, height: 768 });
    await page.getByRole('button', { name: '关联会话', exact: true }).click();
    await page.locator('#issue-detail').getByText('<script>unsafe</script>', { exact: false }).waitFor();
    assert.equal(await page.locator('#issue-detail script').count(), 0);
    await page.locator('select[name="codexProject"]').selectOption({ label: '工程 · /work' });
    await page.locator('#create-session').click();
    await confirmDialog(page, false);
    assert.equal(await page.evaluate(() => window.testCalls.some((call) => call.name === 'codex_create_link')), false);
    await page.locator('#create-session').click();
    await confirmDialog(page, true);
    await page.getByText(/初始消息正在处理/).waitFor();
    const call = await page.evaluate(() => window.testCalls.find((item) => item.name === 'codex_create_link'));
    assert.equal(call.args.confirmed, true);
    assert.match(call.args.initialMessage, /测试工作项/);
    assert.match(call.args.initialMessage, /项目 ID：1\n工作项 ID：3/);
    assert.doesNotMatch(call.args.initialMessage, /<script>/);
    assert.deepEqual(await page.evaluate(() => window.testOpenLinks), ['codex://threads/new-thread']);
    assert.equal(await page.locator('#close-session').isEnabled(), true);
    assert.equal(await page.locator('#create-session').isDisabled(), true);
  } finally { await browser.close(); }
});

for (const [status, expected] of [
  ['failed', '初始消息执行失败'],
  ['unknown', '初始消息结果不确定'],
  ['not_sent', '初始消息尚未发送'],
]) {
  test(`创建后正确提示首条消息状态：${status}`, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await openPage(browser, { width: 1024, height: 768 });
      await page.evaluate((messageStatus) => {
        window.testReplies.codex_create_link = { status: 'linked', messageStatus, sessionId: 'new-thread' };
      }, status);
      await page.getByRole('button', { name: '关联会话', exact: true }).click();
      await page.locator('select[name="codexProject"]').selectOption({ label: '工程 · /work' });
      await page.locator('#create-session').click();
      await confirmDialog(page, true);
      await page.getByText(expected, { exact: false }).waitFor();
      assert.equal(await page.locator('#create-session').isDisabled(), true);
    } finally { await browser.close(); }
  });
}

test('轮询确认创建成功后即使原请求未返回也可继续', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await openPage(browser, { width: 1024, height: 768 });
    await page.clock.install();
    await page.evaluate(() => { window.holdCreation = true; window.testReplies.codex_creation_attempt = { status: 'linked', sessionId: 'new-thread' }; });
    await page.getByRole('button', { name: '关联会话', exact: true }).click();
    await page.locator('select[name="codexProject"]').selectOption({ label: '工程 · /work' });
    await page.locator('#create-session').click(); await confirmDialog(page, true);
    await page.clock.fastForward(2000);
    await page.getByRole('button', { name: '打开新会话' }).waitFor();
    await page.locator('#close-session').click();
    await page.getByRole('button', { name: '关联会话', exact: true }).click();
    await page.locator('select[name="codexProject"]').selectOption({ label: '工程 · /work' });
    assert.equal(await page.locator('#create-session').isEnabled(), true);
  } finally { await browser.close(); }
});

test('创建调用中断后保留阻止状态，避免重复创建', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await openPage(browser, { width: 1024, height: 768 });
    await page.evaluate(() => { window.rejectCreation = true; });
    await page.getByRole('button', { name: '关联会话', exact: true }).click();
    await page.locator('select[name="codexProject"]').selectOption({ label: '工程 · /work' });
    await page.locator('#create-session').click(); await confirmDialog(page, true);
    await page.getByText(/创建结果待核对/).waitFor();
    await page.locator('#close-session').click();
    await page.getByRole('button', { name: '关联会话', exact: true }).click();
    await page.locator('select[name="codexProject"]').selectOption({ label: '工程 · /work' });
    assert.equal(await page.locator('#create-session').isDisabled(), true);
    assert.equal(await page.evaluate(() => window.testCalls.filter(item => item.name === 'codex_create_link').length), 1);
  } finally { await browser.close(); }
});

test('不确定记录可核查返回的会话，再单独确认保存关联', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await openPage(browser, { width: 390, height: 844 });
    const attempt = { attemptId: '12345678-1234-1234-1234-123456789abc', status: 'unknown', recoverySessionId: 'new-thread', issue: { title: '测试工作项' } };
    await page.evaluate((record) => { window.testReplies.codex_creation_attempts = [record]; window.testReplies.codex_recover_creation = { status: 'created' }; }, attempt);
    await page.getByRole('tab', { name: '关联管理' }).click();
    await page.getByRole('button', { name: '核查已返回的会话' }).click();
    await confirmDialog(page, false);
    assert.equal(await page.evaluate(() => window.testCalls.some(item => item.name === 'codex_recover_creation')), false);
    await page.getByRole('button', { name: '核查已返回的会话' }).click();
    await page.evaluate((record) => { window.testReplies.codex_creation_attempts = [{ ...record, status: 'created', sessionId: 'new-thread' }]; }, attempt);
    await confirmDialog(page, true);
    await page.getByRole('button', { name: '重试保存关联' }).waitFor();
    assert.equal(await page.evaluate(() => window.testCalls.some(item => item.name === 'codex_finish_link')), false);
  } finally { await browser.close(); }
});

for (const [status, button, tool] of [['unknown', '确认已核查', 'codex_abandon_attempt'], ['created', '重试保存关联', 'codex_finish_link']]) {
  test(`处理 ${status} 创建记录后解除页面内的创建限制`, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await openPage(browser, { width: 1024, height: 768 });
      await page.evaluate(() => { window.rejectCreation = true; });
      await page.getByRole('button', { name: '关联会话', exact: true }).click();
      await page.locator('select[name="codexProject"]').selectOption({ label: '工程 · /work' });
      await page.locator('#create-session').click(); await confirmDialog(page, true);
      await page.getByText(/创建结果待核对/).waitFor();
      await page.locator('#close-session').click();
      await page.evaluate(({ status, tool }) => {
        const attemptId = window.testCalls.find(item => item.name === 'codex_create_link').args.attemptId;
        window.testReplies.codex_creation_attempts = [{ attemptId, status, issue: { title: '测试工作项' }, sessionId: 'new-thread' }];
        window.testReplies[tool] = {};
      }, { status, tool });
      await page.getByRole('tab', { name: '关联管理' }).click();
      await page.locator('#creation-attempts').getByRole('button', { name: button }).click();
      await confirmDialog(page, true);
      await page.getByText(status === 'unknown' ? '已解除此记录的重复创建限制' : '关联已保存').waitFor();
      await page.getByRole('tab', { name: '工作项', exact: true }).click();
      await page.getByRole('button', { name: '关联会话', exact: true }).click();
      await page.locator('select[name="codexProject"]').selectOption({ label: '工程 · /work' });
      assert.equal(await page.locator('#create-session').isEnabled(), true);
    } finally { await browser.close(); }
  });
}

test('创建成功但刷新失败时不误报创建结果不确定', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await openPage(browser, { width: 1024, height: 768 });
    await page.evaluate(() => { window.testReplies.local_list = { isError: true, content: [{ type: 'text', text: '刷新失败' }] }; });
    await page.getByRole('button', { name: '关联会话', exact: true }).click();
    await page.locator('select[name="codexProject"]').selectOption({ label: '工程 · /work' });
    await page.locator('#create-session').click(); await confirmDialog(page, true);
    await page.getByText(/会话已创建并关联，但列表刷新失败/).waitFor();
    assert.equal(await page.getByText(/创建结果待核对/).count(), 0);
    await page.locator('#close-session').click();
    await page.getByRole('button', { name: '关联会话', exact: true }).click();
    await page.locator('select[name="codexProject"]').selectOption({ label: '工程 · /work' });
    assert.equal(await page.locator('#create-session').isEnabled(), true);
  } finally { await browser.close(); }
});

test('创建跳转未响应时恢复操作并保留手动打开入口', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await openPage(browser, { width: 1024, height: 768 });
    await page.clock.install();
    await page.evaluate(() => { window.holdOpenLink = true; });
    await page.getByRole('button', { name: '关联会话', exact: true }).click();
    await page.locator('select[name="codexProject"]').selectOption({ label: '工程 · /work' });
    await page.locator('#create-session').click(); await confirmDialog(page, true);
    await page.getByRole('button', { name: '打开新会话', exact: true }).waitFor();
    await page.clock.fastForward(5000);
    await page.getByText(/无法打开会话，请在 Codex 中搜索/).waitFor();
    await page.locator('#close-session').click();
    assert.equal(await page.locator('#session-panel').isVisible(), false);
    assert.equal(await page.evaluate(() => window.testCalls.filter(item => item.name === 'codex_create_link').length), 1);
  } finally { await browser.close(); }
});

test('创建刚开始即可关闭弹窗且不会重复创建', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await openPage(browser, { width: 1024, height: 768 });
    await page.evaluate(() => { window.holdCreation = true; });
    await page.getByRole('button', { name: '关联会话', exact: true }).click();
    await page.locator('select[name="codexProject"]').selectOption({ label: '工程 · /work' });
    await page.locator('#create-session').click(); await confirmDialog(page, true);
    await page.getByRole('button', { name: '正在创建…', exact: true }).waitFor();
    await page.locator('#close-session').click();
    await page.getByText(/创建仍在后台处理/).waitFor();
    await page.getByRole('button', { name: '关联会话', exact: true }).click();
    await page.locator('select[name="codexProject"]').selectOption({ label: '工程 · /work' });
    assert.equal(await page.locator('#create-session').isDisabled(), true);
    await page.evaluate(() => window.releaseCreation());
    await page.getByText(/会话已创建并关联，请在工作项的/).waitFor();
    assert.deepEqual(await page.evaluate(() => window.testOpenLinks), []);
  } finally { await browser.close(); }
});

test('工作项详情加载失败时不允许创建会话', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await openPage(browser, { width: 1024, height: 768 }, false, { choerodon_scoped_issue_detail: { isError: true, content: [{ type: 'text', text: '权限不足' }] } });
    await page.getByRole('button', { name: '关联会话', exact: true }).click();
    await page.getByText(/详情加载失败：权限不足/).waitFor();
    await page.locator('select[name="codexProject"]').selectOption({ label: '工程 · /work' });
    assert.equal(await page.locator('#create-session').isDisabled(), true);
  } finally { await browser.close(); }
});

test('创建结果不确定时阻止再次创建', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await openPage(browser, { width: 1024, height: 768 });
    await page.evaluate(() => { window.testReplies.codex_create_link = { status: 'unknown' }; });
    await page.getByRole('button', { name: '关联会话', exact: true }).click();
    await page.locator('select[name="codexProject"]').selectOption({ label: '工程 · /work' });
    await page.locator('#create-session').click();
    await confirmDialog(page, true);
    await page.getByText(/创建状态：unknown/).waitFor();
    assert.equal(await page.locator('#create-session').isDisabled(), true);
    assert.equal(await page.evaluate(() => window.testCalls.filter((item) => item.name === 'codex_create_link').length), 1);
  } finally { await browser.close(); }
});

test('创建请求长时间未返回时可关闭窗口且不能重复创建', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await openPage(browser, { width: 1024, height: 768 });
    await page.clock.install();
    await page.evaluate(() => { window.holdCreation = true; });
    await page.getByRole('button', { name: '关联会话', exact: true }).click();
    await page.locator('select[name="codexProject"]').selectOption({ label: '工程 · /work' });
    await page.locator('#create-session').click(); await confirmDialog(page, true);
    await page.clock.fastForward(8000);
    await page.getByText(/创建请求仍在处理/).waitFor();
    await page.locator('#close-session').click();
    await page.getByRole('button', { name: '关联会话', exact: true }).click();
    await page.locator('select[name="codexProject"]').selectOption({ label: '工程 · /work' });
    assert.equal(await page.locator('#create-session').isDisabled(), true);
    assert.equal(await page.evaluate(() => window.testCalls.filter(item => item.name === 'codex_create_link').length), 1);
    await page.evaluate(() => window.releaseCreation());
    await page.getByText(/会话已创建并关联，请在工作项的/).waitFor();
    await page.waitForFunction(() => !document.querySelector('#create-session').disabled);
    assert.deepEqual(await page.evaluate(() => window.testOpenLinks), []);
  } finally { await browser.close(); }
});

test('受限 iframe 中取消和确认关联，且取消不发送请求', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await openPage(browser, { width: 1024, height: 768 }, true);
    const view = page.frameLocator('iframe');
    const frame = page.frames().find((item) => item.url() === 'http://localhost/widget');
    await selectSession(view);
    await view.getByRole('button', { name: '关联已有会话' }).click();
    await confirmDialog(view, false);
    assert.equal(await frame.evaluate(() => window.testCalls.some((call) => call.name === 'codex_link_session')), false);
    await view.getByRole('button', { name: '关联已有会话' }).click();
    await confirmDialog(view, true);
    await view.getByText('会话关联已保存').waitFor();
    const calls = await frame.evaluate(() => window.testCalls.filter((call) => call.name === 'codex_link_session'));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args.sessionId, 'thread');
    assert.equal(calls[0].args.confirmed, true);
  } finally { await browser.close(); }
});

test('受限 iframe 中关联失败显示错误并允许重试', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await openPage(browser, { width: 1024, height: 768 }, true);
    const view = page.frameLocator('iframe');
    const frame = page.frames().find((item) => item.url() === 'http://localhost/widget');
    await frame.evaluate(() => { window.testReplies.codex_link_session = { isError: true, content: [{ type: 'text', text: '模拟关联失败' }] }; });
    await selectSession(view);
    await view.getByRole('button', { name: '关联已有会话' }).click();
    await confirmDialog(view, true);
    await view.getByText('关联失败：模拟关联失败').waitFor();
    assert.equal(await view.getByRole('button', { name: '关联已有会话' }).isEnabled(), true);
    assert.equal(await frame.evaluate(() => window.testCalls.filter((call) => call.name === 'codex_link_session').length), 1);
  } finally { await browser.close(); }
});
