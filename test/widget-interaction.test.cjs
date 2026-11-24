const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const MarkdownIt = require('markdown-it');

// 使用项目已有 Node 运行时模拟最小 DOM 和 MCP 宿主，不替代真实宿主验收。
class Element {
  constructor(tag = 'div') { this.tag = tag; this.children = []; this.listeners = {}; this.dataset = {}; this._value = ''; this.disabled = false; this.hidden = false; this.checked = false; this.textContent = ''; }
  addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }
  async fire(type, target = this) { if (this.disabled && type === 'click') return; for (const handler of this.listeners[type] || []) await handler({ currentTarget: this, target, preventDefault() {} }); await flush(); }
  append(...items) { this.children.push(...items); }
  after(...items) { (this.siblingsAfter ||= []).push(...items); }
  get firstChild() { return this.children[0] || null; }
  setCustomValidity(message) { this.validationMessage = message; }
  replaceChildren(...items) { this.children = items; if (this.tag === 'select') this._value = items[0]?.value || ''; }
  add(item) { this.children.push(item); }
  set value(value) { this._value = this.tag === 'textarea' ? String(value).replace(/\r\n?/g, '\n') : String(value); }
  get value() { return this._value; }
  get selectedOptions() { return [this.children.find((item) => item.value === this.value)].filter(Boolean); }
  setAttribute() {}
  scrollIntoView() {}
  focus() {}
  reset() { for (const item of Object.values(this.elements || {})) { item.value = ''; item.checked = false; } }
  querySelector(selector) { return selector === '[type="submit"]' ? this.submit : null; }
  requestSubmit() { void this.fire('submit'); }
}
class Option extends Element {
  constructor(text, value) { super('option'); this.textContent = text; this.value = value; }
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
async function settle() { for (let i = 0; i < 8; i++) await flush(); }

function createHarness(overrides = {}) {
  const nodes = new Map();
  for (const id of ['notice', 'links', 'drafts', 'draft-heading', 'draft-issue', 'connection', 'account-status', 'filter-status', 'project-scope', 'search-result', 'reload-account', 'session-panel', 'linked-panel', 'linked-list', 'linked-issue', 'close-linked', 'close-session', 'selected-issue', 'issue-detail', 'issue-detail-status', 'session-status', 'more-projects', 'more-sessions', 'create-session', 'cancel-session', 'cancel-edit', 'creation-attempts', 'knowledge-filter', 'knowledge-query', 'knowledge-search', 'knowledge-search-results', 'knowledge-reload', 'knowledge-list', 'knowledge-title', 'knowledge-status', 'knowledge-content', 'knowledge-inspect', 'knowledge-references', 'publish-dialog', 'publish-close', 'publish-confirm', 'publish-link', 'publish-issue', 'publish-target', 'publish-content', 'publish-status', 'update-dialog', 'update-target', 'update-issue', 'update-summary', 'update-diff', 'update-before', 'update-after', 'update-status', 'update-close', 'update-inspect', 'update-recover', 'update-confirm', 'notes-panel', 'close-notes', 'notes-draft', 'notes-select', 'notes-add', 'notes-status', 'notes-issue', 'notes-linked', 'backup-export', 'backup-file', 'backup-import', 'backup-status', 'backup-preview', 'vault-backup-target', 'vault-backup-preview', 'vault-backup-create', 'vault-backup-status', 'vault-backup-files', 'generate-dialog', 'generate-cancel', 'generate-confirm', 'generate-range', 'generate-input', 'generate-status']) nodes.set(`#${id}`, new Element());
  for (const id of ['vault-restore-source', 'vault-restore-target', 'vault-restore-preview', 'vault-restore-create', 'vault-restore-status', 'vault-restore-files', 'publish-inspect', 'publish-references', 'publish-compare', 'publish-comparison', 'draft-session']) nodes.set(`#${id}`, new Element());
  nodes.set('#session-search', new Element('button'));
  for (const id of ['draft-content-edit', 'draft-content-preview', 'draft-edit-tab', 'draft-preview-tab']) nodes.set(`#${id}`, new Element());
  nodes.set('#auth-context', new Element()); nodes.set('#auth-help', new Element('details'));
  for (const id of ['session-panel', 'linked-panel', 'generate-dialog', 'update-dialog']) { const panel = nodes.get(`#${id}`); panel.showModal = () => { panel.open = true; panel.hidden = false; }; panel.close = () => { panel.open = false; panel.hidden = true; void panel.fire('close'); }; }
  const dialog = new Element('dialog');
  dialog.showModal = () => { dialog.open = true; setImmediate(() => { dialog.open = false; dialog.returnValue = 'confirm'; void dialog.fire('close'); }); };
  nodes.set('#confirm-dialog', dialog); nodes.set('#confirm-message', new Element());
  const form = (id, fields) => {
    const node = new Element('form'); node.elements = {};
    for (const name of fields) { const field = new Element(['projectId', 'scope', 'sprintId', 'typeId', 'statusId', 'codexProject', 'sessionId'].includes(name) ? 'select' : 'input'); field.form = node; field.parentElement = new Element('label'); field.parentElement.append(new Element('#text'), field); node.elements[name] = field; }
    node.submit = new Element('button'); nodes.set(`#${id}`, node); return node;
  };
  const search = form('search-form', ['projectId', 'scope', 'sprintId', 'typeId', 'statusId', 'keyword', 'page']);
  search.elements.scope.value = 'mine'; search.elements.page.value = '0';
  const session = form('session-form', ['codexProject', 'sessionSearch', 'sessionId', 'primary']);
  for (const id of ['recommend-locations', 'location-keywords', 'location-status', 'location-results', 'cleanup-refresh', 'cleanup-status', 'cleanup-list']) nodes.set(`#${id}`, new Element());
  for (const id of ['update-heading', 'update-method', 'update-append', 'update-original', 'update-quote', 'update-reload', 'update-quote-summary', 'update-quote-text', 'update-conclusion-text', 'update-preview-actions', 'update-preview', 'update-result', 'update-diff-section', 'update-before-section', 'update-before-label', 'update-after-section']) nodes.set(`#${id}`, new Element());
  nodes.set('[name="update-mode"][value="append"]', new Element('input'));
  for (const id of ['pending-links-refresh', 'pending-links-status', 'pending-links-list', 'reservations-refresh', 'reservations-status', 'reservations-list']) nodes.set(`#${id}`, new Element());
  for (const id of ['reservations-section', 'reservations-load-error', 'cleanup-section', 'cleanup-load-error']) {
    const node = new Element();
    node.hidden = true;
    nodes.set(`#${id}`, node);
  }
  for (const id of ['project-link-add', 'project-links-list', 'project-links-more', 'project-links-refresh', 'project-links-status']) nodes.set(`#${id}`, new Element());
  for (const id of ['knowledge-scope', 'knowledge-more', 'knowledge-list-status', 'catalog-reservations-refresh', 'catalog-reservations-status', 'catalog-reservations-list']) nodes.set(`#${id}`, new Element());
  nodes.get('#knowledge-scope').value = 'catalog';
  nodes.set('#update-original', new Element('textarea'));
  form('draft-form', ['title', 'target', 'content']);
  const calls = [];
  const replies = {
    choerodon_context: { identity: { userId: '11', tenantId: '7', login: 'user', tenantName: 'tenant' }, environment: 'https://example.test', projects: { complete: true, items: [{ id: '1', name: '猪齿鱼项目', code: 'p' }] } },
    choerodon_sprints: { items: [{ id: '2', name: '当前冲刺', status: 'started' }] },
    choerodon_scoped_issue_detail: { detail: '概要 测试工作项' },
    choerodon_issue_types: { items: [] },
    choerodon_scoped_search: { items: [{ issueId: '3', issueNum: 'P-3', summary: '测试工作项' }], returnedCount: 1 },
    local_list: { links: [], drafts: [] }, codex_creation_attempts: [], knowledge_catalog: { items: [], total: 0, nextOffset: null }, knowledge_list: [],
    draft_note_update_cleanups: [], draft_publication_reservations: [],
    draft_history_source: { content: '# 原文', revision: 'digest', vaultId: 'vault' },
    codex_projects: { data: [{ id: 'project', name: '工程', roots: ['/work'] }], nextCursor: null },
    codex_sessions: { data: [{ id: 'thread', title: '会话' }], nextCursor: null }, codex_link_session: {},
    issue_project_links: { items: [], total: 0, nextOffset: null }, issue_project_link_add: {}, issue_project_link_remove: {}, issue_project_link_check: { status: 'available' },
    ...overrides,
  };
  class App {
    async connect() {}
    async callServerTool({ name, arguments: args }) {
      calls.push({ name, args });
      const value = typeof replies[name] === 'function' ? await replies[name](args) : replies[name];
      if (value instanceof Error) return { isError: true, content: [{ type: 'text', text: value.message }] };
      return { content: [{ type: 'text', text: JSON.stringify(value) }] };
    }
  }
  const document = { querySelector: (selector) => nodes.get(selector), querySelectorAll: () => [], createElement: (tag) => new Element(tag) };
  const source = fs.readFileSync(path.join(__dirname, '..', 'widget.js'), 'utf8').replace(/^import .*?;\s*/gm, '');
  vm.runInNewContext(source, { App, MarkdownIt, document, Option, window: { confirm: () => true }, crypto: { randomUUID: () => 'test-attempt' }, console, setTimeout, clearTimeout });
  return { nodes, search, session, calls };
}
function find(node, text) {
  if (node.textContent === text) return node;
  for (const child of node.children) { const result = find(child, text); if (result) return result; }
  return null;
}

test('目录预留区分旧版、可释放和未知结果，并确认释放参数', async () => {
  const h = createHarness({ knowledge_catalog_reservations: [
    { operationId: 'one', generation: 'g', path: 'a.md', kind: 'draft', status: 'not_written' },
    { operationId: 'two', generation: 'g', path: 'b.md', kind: 'legacy', status: 'unknown' },
    { operationId: 'three', generation: 'g', path: 'c.md', kind: 'direct', status: 'unknown' },
  ], knowledge_catalog_release: {} });
  await settle(); await h.nodes.get('#catalog-reservations-refresh').fire('click');
  const rows = h.nodes.get('#catalog-reservations-list').children;
  assert.ok(find(rows[0], '释放预留')); assert.equal(find(rows[1], '核查后关联'), null);
  assert.ok(find(rows[2], '核查后关联'));
  await find(rows[0], '释放预留').fire('click'); await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls.find((call) => call.name === 'knowledge_catalog_release').args)), { operationId: 'one', generation: 'g', confirmed: true });
});

test('未知处置失败后查询状态，查询失败时刷新也不能重复处置', async () => {
  const h = createHarness({ knowledge_catalog_reservations: [{ operationId: 'op', generation: 'g', path: 'a.md', kind: 'direct', status: 'unknown' }], knowledge_catalog_resolve: new Error('超时'), knowledge_catalog_resolution: new Error('不可用') });
  await settle(); await h.nodes.get('#catalog-reservations-refresh').fire('click');
  let row = h.nodes.get('#catalog-reservations-list').children[0];
  await find(row, '核查后关联').fire('click'); await settle();
  assert.equal(h.calls.filter((call) => call.name === 'knowledge_catalog_resolution').length, 1);
  assert.equal(find(row, '核查后关联').disabled, true);
  assert.equal(find(row, '查询处置状态').hidden, false);
  await h.nodes.get('#catalog-reservations-refresh').fire('click');
  row = h.nodes.get('#catalog-reservations-list').children[0];
  assert.equal(find(row, '核查后放弃关联').disabled, true);
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls.find((call) => call.name === 'knowledge_catalog_resolve').args)), { operationId: 'op', generation: 'g', decision: 'link', acceptUncertain: true, confirmed: true });
  assert.equal(h.calls.some((call) => ['knowledge_create', 'draft_publish'].includes(call.name)), false);
});

test('知识页默认链路目录，分页筛选并显式切换全库', async () => {
  const h = createHarness({ knowledge_catalog: ({ offset }) => offset ? { items: [{ path: '二.md' }], total: 2, nextOffset: null } : { items: [{ path: '一.md' }], total: 2, nextOffset: 1 }, knowledge_list: ['全部.md'] });
  await settle(); await h.nodes.get('#knowledge-reload').fire('click');
  assert.ok(find(h.nodes.get('#knowledge-list'), '一.md'));
  assert.equal(h.calls.some((entry) => entry.name === 'knowledge_list'), false);
  assert.match(h.nodes.get('#knowledge-list-status').textContent, /筛选仅作用于已加载记录/);
  await h.nodes.get('#knowledge-more').fire('click');
  assert.ok(find(h.nodes.get('#knowledge-list'), '二.md'));
  h.nodes.get('#knowledge-filter').value = '二'; await h.nodes.get('#knowledge-filter').fire('input');
  assert.equal(find(h.nodes.get('#knowledge-list'), '一.md'), null);
  h.nodes.get('#knowledge-filter').value = '';
  h.nodes.get('#knowledge-scope').value = 'all'; await h.nodes.get('#knowledge-scope').fire('change'); await settle();
  assert.ok(find(h.nodes.get('#knowledge-list'), '全部.md'));
});

test('切换知识范围后丢弃迟到的目录响应，失败允许重试', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const h = createHarness({ knowledge_catalog: () => pending, knowledge_list: ['全库.md'] });
  await settle(); void h.nodes.get('#knowledge-reload').fire('click'); await settle();
  h.nodes.get('#knowledge-scope').value = 'all'; await h.nodes.get('#knowledge-scope').fire('change'); await settle();
  release({ items: [{ path: '旧结果.md' }], total: 1, nextOffset: null }); await settle();
  assert.ok(find(h.nodes.get('#knowledge-list'), '全库.md'));
  assert.equal(find(h.nodes.get('#knowledge-list'), '旧结果.md'), null);
  const failed = createHarness({ knowledge_catalog: new Error('不可用') });
  await settle(); await failed.nodes.get('#knowledge-reload').fire('click');
  assert.match(failed.nodes.get('#knowledge-list-status').textContent, /不可用/);
});

test('待关联笔记显示目标和工作项，确认后仅补充关联', async () => {
  const item = { id: 'a'.repeat(64), target: '项目/设计.md', issue: { title: '工作项标题', projectId: '1', issueId: '3' } };
  let linked = false;
  const h = createHarness({ pending_note_links: () => ({ items: linked ? [] : [item], warnings: [] }), pending_note_link: () => { linked = true; return {}; } });
  await settle(); await h.nodes.get('#pending-links-refresh').fire('click'); await settle();
  const list = h.nodes.get('#pending-links-list');
  assert.ok(find(list, item.target)); assert.ok(find(list, '工作项：工作项标题（项目 1，ID 3）'));
  await find(list, '补充关联').fire('click'); await settle();
  const call = h.calls.find((entry) => entry.name === 'pending_note_link');
  assert.deepEqual(JSON.parse(JSON.stringify(call.args)), { id: item.id, userId: '11', confirmed: true });
  assert.match(h.nodes.get('#confirm-message').textContent, /不会重写笔记/);
  assert.equal(h.calls.some((entry) => ['draft_publish', 'knowledge_create', 'draft_note_update_submit'].includes(entry.name)), false);
  assert.match(h.nodes.get('#pending-links-status').textContent, /没有待关联记录/);
});

test('待关联失败保留记录并支持重试，账号刷新清除旧记录', async () => {
  const item = { id: 'b'.repeat(64), target: '设计.md', issue: { title: '工作项', projectId: '1', issueId: '3' } };
  const h = createHarness({ pending_note_links: { items: [item], warnings: [] }, pending_note_link: new Error('笔记已变化') });
  await settle(); await h.nodes.get('#pending-links-refresh').fire('click'); await settle();
  await find(h.nodes.get('#pending-links-list'), '补充关联').fire('click'); await settle();
  assert.match(h.nodes.get('#pending-links-status').textContent, /笔记已变化/);
  assert.ok(find(h.nodes.get('#pending-links-list'), '补充关联'));
  await h.nodes.get('#reload-account').fire('click'); await settle();
  assert.equal(h.nodes.get('#pending-links-list').children.length, 0);
});

test('发布预留仅允许释放确定未写入记录，未知结果须人工核查', async () => {
  const ready = { id: 'c'.repeat(64), generation: 'd'.repeat(32), target: '未写入.md', draftId: 'draft', revision: 1, status: 'not_written' };
  const unknown = { ...ready, id: 'e'.repeat(64), target: '未知.md', status: 'unknown' };
  let released = false;
  const h = createHarness({ draft_publication_reservations: () => released ? [unknown] : [ready, unknown], draft_publication_reservation_resolve: () => { released = true; return {}; } });
  await settle(); await h.nodes.get('#reservations-refresh').fire('click'); await settle();
  const list = h.nodes.get('#reservations-list');
  assert.ok(find(list, '草稿 draft，版本 1 · 确认未写入'));
  assert.ok(find(list, '草稿 draft，版本 1 · 写入结果不确定，请人工核查目标笔记'));
  assert.ok(find(list.children[1], '核查后关联'));
  assert.ok(find(list.children[1], '核查后放弃关联'));
  await find(list, '释放预留').fire('click'); await settle();
  const call = h.calls.find((entry) => entry.name === 'draft_publication_reservation_resolve');
  assert.deepEqual(JSON.parse(JSON.stringify(call.args)), { id: ready.id, generation: ready.generation, userId: '11', confirmed: true });
  assert.match(h.nodes.get('#confirm-message').textContent, /不会写入笔记/);
  assert.equal(h.calls.some((entry) => ['draft_publish', 'knowledge_create', 'draft_note_update_submit'].includes(entry.name)), false);
  assert.equal(find(list, '释放预留'), null);
});

for (const [decision, label] of [['link', '核查后关联'], ['discard', '核查后放弃关联']]) {
  test(`发布未知结果需确认后选择 ${decision}，不会重写笔记`, async () => {
    const item = { id: 'f'.repeat(64), generation: 'a'.repeat(32), target: '未知.md', draftId: 'draft', revision: 1, status: 'unknown' };
    let resolved = false;
    const h = createHarness({ draft_publication_reservations: () => resolved ? [] : [item], draft_publication_reservation_uncertain: () => { resolved = true; return {}; } });
    await settle(); await h.nodes.get('#reservations-refresh').fire('click'); await settle();
    await find(h.nodes.get('#reservations-list'), label).fire('click'); await settle();
    const call = h.calls.find((entry) => entry.name === 'draft_publication_reservation_uncertain');
    assert.deepEqual(JSON.parse(JSON.stringify(call.args)), { id: item.id, generation: item.generation, userId: '11', decision, acceptUncertain: true, confirmed: true });
    assert.match(h.nodes.get('#confirm-message').textContent, /原写入来源无法确定/);
    assert.match(h.nodes.get('#confirm-message').textContent, /仅校验当前内容/);
    assert.match(h.nodes.get('#confirm-message').textContent, /不会重写笔记/);
    assert.match(h.nodes.get('#notice').textContent, /当前关联以实际记录为准/);
    assert.equal(h.nodes.get('#reservations-section').hidden, true);
    assert.equal(h.calls.some((entry) => ['draft_publish', 'knowledge_create', 'draft_note_update_submit'].includes(entry.name)), false);
  });
}

test('未知处置失败后只读查询历史结果，不自动重试写操作', async () => {
  const item = { id: 'f'.repeat(64), generation: 'a'.repeat(32), target: '未知.md', draftId: 'draft', revision: 1, status: 'unknown' };
  const h = createHarness({ draft_publication_reservations: [item], draft_publication_reservation_uncertain: new Error('连接中断'), draft_publication_reservation_status: { status: 'resolved', decision: 'link' } });
  await settle(); await h.nodes.get('#reservations-refresh').fire('click'); await settle();
  await find(h.nodes.get('#reservations-list'), '核查后关联').fire('click'); await settle();
  assert.equal(h.calls.filter((entry) => entry.name === 'draft_publication_reservation_uncertain').length, 1);
  const query = h.calls.find((entry) => entry.name === 'draft_publication_reservation_status');
  assert.deepEqual(JSON.parse(JSON.stringify(query.args)), { id: item.id, generation: item.generation, userId: '11' });
  assert.match(h.nodes.get('#notice').textContent, /历史处置：选择关联/);
  assert.match(h.nodes.get('#notice').textContent, /当前关联以实际记录为准/);
  assert.equal(h.nodes.get('#reservations-section').hidden, true);
  assert.equal(find(h.nodes.get('#reservations-list'), '核查后关联'), null);
});

test('未知处置状态查询失败时禁止重复操作并提供查询入口', async () => {
  const item = { id: 'f'.repeat(64), generation: 'a'.repeat(32), target: '未知.md', draftId: 'draft', revision: 1, status: 'unknown' };
  const h = createHarness({ draft_publication_reservations: [item], draft_publication_reservation_uncertain: new Error('连接中断'), draft_publication_reservation_status: new Error('查询失败') });
  await settle(); await h.nodes.get('#reservations-refresh').fire('click'); await settle();
  await find(h.nodes.get('#reservations-list'), '核查后放弃关联').fire('click'); await settle();
  assert.equal(find(h.nodes.get('#reservations-list'), '核查后关联').disabled, true);
  assert.equal(find(h.nodes.get('#reservations-list'), '查询处置状态').hidden, false);
  assert.match(h.nodes.get('#reservations-status').textContent, /不要重复操作/);
  await h.nodes.get('#reservations-refresh').fire('click'); await settle();
  assert.equal(find(h.nodes.get('#reservations-list'), '核查后关联').disabled, true);
  assert.equal(find(h.nodes.get('#reservations-list'), '查询处置状态').hidden, false);
});


test('选择项目和已有会话后确认关联', async () => {
  const h = createHarness(); await settle();
  const link = find(h.nodes.get('#search-result'), '关联会话'); assert.ok(link);
  await link.fire('click'); await settle();
  h.session.elements.codexProject.value = 'project\n/work'; await h.session.elements.codexProject.fire('change'); await settle();
  assert.equal(h.nodes.get('#create-session').disabled, false);
  h.session.elements.sessionId.value = 'thread'; await h.session.elements.sessionId.fire('change');
  await h.session.fire('submit'); await settle();
  const call = h.calls.find((item) => item.name === 'codex_link_session');
  assert.equal(call.args.issue.issueId, '3'); assert.equal(call.args.sessionId, 'thread'); assert.equal(call.args.cwd, '/work'); assert.equal(call.args.confirmed, true);
  assert.equal(h.nodes.get('#session-panel').hidden, true);
});

test('关联或创建确认期间变更主工作项时不提交', async () => {
  for (const operation of ['link', 'create']) {
    const h = createHarness(); await settle();
    await find(h.nodes.get('#search-result'), '关联会话').fire('click'); await settle();
    h.session.elements.codexProject.value = 'project\n/work'; await h.session.elements.codexProject.fire('change'); await settle();
    h.session.elements.sessionId.value = 'thread'; await h.session.elements.sessionId.fire('change');
    const pending = operation === 'link' ? h.session.fire('submit') : h.nodes.get('#create-session').fire('click');
    assert.match(h.nodes.get('#confirm-message').textContent, /工程目录：\/work/);
    h.session.elements.primary.checked = true;
    await pending; await settle();
    assert.equal(h.calls.some((item) => item.name === (operation === 'link' ? 'codex_link_session' : 'codex_create_link')), false);
    assert.match(h.nodes.get('#session-status').textContent, /已变化/);
  }
});

test('确认期间更换工程、会话或账号不会提交旧选择', async () => {
  for (const change of ['project', 'session', 'account', 'close']) {
    const h = createHarness({ codex_projects: { data: [{ id: 'project', name: '工程', roots: ['/work', '/other'] }], nextCursor: null } });
    await settle(); await find(h.nodes.get('#search-result'), '关联会话').fire('click'); await settle();
    h.session.elements.codexProject.value = 'project\n/work'; await h.session.elements.codexProject.fire('change'); await settle();
    h.session.elements.sessionId.value = 'thread'; await h.session.elements.sessionId.fire('change');
    const pending = h.session.fire('submit');
    const text = h.nodes.get('#confirm-message').textContent;
    for (const expected of ['https://example.test', '租户 ID：7', '项目 ID：1', '工作项 ID：3', '用户 ID：11', '会话']) assert.ok(text.includes(expected));
    if (change === 'project') h.session.elements.codexProject.value = 'project\n/other';
    if (change === 'session') h.session.elements.sessionId.value = 'another';
    if (change === 'account') void h.nodes.get('#reload-account').fire('click');
    if (change === 'close') void h.nodes.get('#close-session').fire('click');
    await pending; await settle();
    assert.equal(h.calls.some((item) => item.name === 'codex_link_session'), false, change);
  }
});

test('工程关联独立确认并分页展示，解除不删除工程或会话', async () => {
  const linked = [{ projectId: 'project', projectName: '工程', cwd: '/work' }, { projectId: 'second', projectName: '第二工程', cwd: '/second' }];
  const h = createHarness({ issue_project_links: ({ offset }) => ({ items: linked.slice(offset, offset + 1), total: linked.length, nextOffset: offset === 0 ? 1 : null }) });
  await settle(); await find(h.nodes.get('#search-result'), '关联会话').fire('click'); await settle();
  assert.ok(find(h.nodes.get('#project-links-list'), '/work'));
  await find(h.nodes.get('#project-links-list'), '检查工程目录').fire('click'); await settle();
  assert.ok(find(h.nodes.get('#project-links-list'), '当前进程可读取并进入目录；不代表远端权限。'));
  await h.nodes.get('#project-links-more').fire('click'); await settle();
  assert.ok(find(h.nodes.get('#project-links-list'), '/second'));
  h.session.elements.codexProject.value = 'project\n/work'; await h.session.elements.codexProject.fire('change'); await settle();
  await h.nodes.get('#project-link-add').fire('click'); await settle();
  const added = h.calls.find((item) => item.name === 'issue_project_link_add');
  assert.equal(added.args.issue.issueId, '3'); assert.equal(added.args.projectId, 'project'); assert.equal(added.args.cwd, '/work'); assert.equal(added.args.confirmed, true);
  assert.match(h.nodes.get('#confirm-message').textContent, /不会创建或修改会话/);
  await find(h.nodes.get('#project-links-list'), '解除工程关联').fire('click'); await settle();
  const removed = h.calls.find((item) => item.name === 'issue_project_link_remove');
  assert.equal(removed.args.cwd, '/work'); assert.equal(removed.args.confirmed, true);
  assert.match(h.nodes.get('#confirm-message').textContent, /不会删除工程或会话/);
  assert.equal(h.calls.some((item) => ['codex_link_session', 'codex_create_link'].includes(item.name)), false);
});

test('导入预览展示工程关联和知识目录数量及中文冲突名称', async () => {
  const h = createHarness({ local_import_preview: { token: 'preview', counts: { links: 1, noteLinks: 2, projectLinks: 3, knowledgeEntries: 5, drafts: 4 }, conflicts: [{ collection: 'projectLinks', key: 'key', incoming: { issue: { title: '工作项' } }, current: {} }, { collection: 'knowledgeEntries', key: 'internal-key', incoming: { path: '笔记.md' }, current: {} }] } });
  await settle();
  h.nodes.get('#backup-file').files = [{ size: 2, text: async () => '{}' }];
  await h.nodes.get('#backup-file').fire('change'); await settle();
  assert.match(h.nodes.get('#backup-status').textContent, /3 条工程关联/);
  assert.match(h.nodes.get('#backup-status').textContent, /5 条知识目录记录/);
  assert.ok(find(h.nodes.get('#backup-preview'), '工程关联：工作项'));
  assert.ok(find(h.nodes.get('#backup-preview'), '知识目录记录：笔记.md'));
});

test('目录预留刷新失败时移除已失效的旧操作', async () => {
  let reads = 0;
  const h = createHarness({ knowledge_catalog_reservations: () => ++reads === 1 ? [{ operationId: 'op', generation: 'g', path: 'a.md', kind: 'draft', status: 'not_written' }] : new Error('不可用') });
  await settle(); await h.nodes.get('#catalog-reservations-refresh').fire('click');
  assert.ok(find(h.nodes.get('#catalog-reservations-list'), '释放预留'));
  await h.nodes.get('#catalog-reservations-refresh').fire('click');
  assert.equal(h.nodes.get('#catalog-reservations-list').children.length, 0);
  assert.match(h.nodes.get('#catalog-reservations-status').textContent, /不可用/);
});

test('工程关联列表加载失败后可刷新，旧工作项响应不会覆盖新页面', async () => {
  let count = 0; let complete;
  const delayed = new Promise((resolve) => { complete = resolve; });
  const h = createHarness({ issue_project_links: () => { count++; return count === 1 ? delayed : count === 2 ? new Error('网络异常') : { items: [], total: 0, nextOffset: null }; } });
  await settle(); await find(h.nodes.get('#search-result'), '关联会话').fire('click'); await settle();
  await h.nodes.get('#project-links-refresh').fire('click'); await settle();
  assert.match(h.nodes.get('#project-links-status').textContent, /网络异常/);
  complete({ items: [{ projectId: 'old', projectName: '过期工程', cwd: '/old' }], total: 1, nextOffset: null }); await settle();
  assert.equal(find(h.nodes.get('#project-links-list'), '过期工程'), null);
  await h.nodes.get('#project-links-refresh').fire('click'); await settle();
  assert.match(h.nodes.get('#project-links-status').textContent, /尚未关联工程/);
});

test('工程关联保存成功但刷新失败时不误报保存失败', async () => {
  let loads = 0;
  const h = createHarness({ issue_project_links: () => ++loads === 1 ? { items: [], total: 0, nextOffset: null } : new Error('加载失败') });
  await settle(); await find(h.nodes.get('#search-result'), '关联会话').fire('click'); await settle();
  h.session.elements.codexProject.value = 'project\n/work'; await h.session.elements.codexProject.fire('change'); await settle();
  await h.nodes.get('#project-link-add').fire('click'); await settle();
  assert.match(h.nodes.get('#project-links-status').textContent, /已保存关联，但列表刷新失败/);
  assert.equal(h.calls.filter((item) => item.name === 'issue_project_link_add').length, 1);
});

test('项目加载失败可见，不执行关联', async () => {
  const h = createHarness({ codex_projects: new Error('连接失败') }); await settle();
  await find(h.nodes.get('#search-result'), '关联会话').fire('click'); await settle();
  assert.match(h.nodes.get('#session-status').textContent, /项目加载失败/);
  assert.equal(h.calls.some((item) => item.name === 'codex_link_session'), false);
});

test('分页追加项目和会话，空结果不会提示新建可用', async () => {
  const h = createHarness({
    codex_projects: ({ cursor }) => cursor ? { data: [{ id: 'second', name: '第二工程', roots: ['/second'] }], nextCursor: null } : { data: [{ id: 'project', name: '工程', roots: ['/work'] }], nextCursor: 'p2' },
    codex_sessions: ({ cursor }) => cursor ? { data: [{ id: 'thread2', title: '第二会话' }], nextCursor: null } : { data: [{ id: 'thread', title: '会话' }], nextCursor: 's2' },
  });
  await settle(); await find(h.nodes.get('#search-result'), '关联会话').fire('click'); await settle();
  await h.nodes.get('#more-projects').fire('click');
  assert.equal(h.session.elements.codexProject.children.some((item) => item.value === 'second\n/second'), true);
  h.session.elements.codexProject.value = 'project\n/work'; await h.session.elements.codexProject.fire('change'); await settle();
  await h.nodes.get('#more-sessions').fire('click');
  assert.equal(h.session.elements.sessionId.children.some((item) => item.value === 'thread2'), true);
  assert.equal(h.nodes.get('#more-sessions').hidden, true);
  const empty = createHarness({ codex_sessions: { data: [], nextCursor: null } });
  await settle(); await find(empty.nodes.get('#search-result'), '关联会话').fire('click'); await settle();
  empty.session.elements.codexProject.value = 'project\n/work'; await empty.session.elements.codexProject.fire('change'); await settle();
  assert.equal(empty.nodes.get('#session-status').textContent, '未找到会话。');
});

test('加载会话期间禁止刷新账号，完成后恢复', async () => {
  let resolveSessions;
  const waiting = new Promise((resolve) => { resolveSessions = resolve; });
  const h = createHarness({ codex_sessions: () => waiting });
  await settle(); await find(h.nodes.get('#search-result'), '关联会话').fire('click'); await settle();
  h.session.elements.codexProject.value = 'project\n/work';
  const change = h.session.elements.codexProject.fire('change'); await settle();
  assert.equal(h.nodes.get('#reload-account').disabled, true);
  const before = h.calls.filter((item) => item.name === 'choerodon_context').length;
  await h.nodes.get('#reload-account').fire('click');
  assert.equal(h.calls.filter((item) => item.name === 'choerodon_context').length, before);
  resolveSessions({ data: [], nextCursor: null }); await change; await settle();
  assert.equal(h.nodes.get('#reload-account').disabled, false);
});

test('会话搜索分页保持工程和关键词，输入变化丢弃迟到结果', async () => {
  let resolveOld;
  const waiting = new Promise((resolve) => { resolveOld = resolve; });
  const h = createHarness({ codex_sessions: ({ searchTerm, cursor }) => {
    if (searchTerm === '旧词') return waiting;
    if (searchTerm === '新词') return cursor ? { data: [{ id: 'next', title: '下一页' }], nextCursor: null } : { data: [{ id: 'new', title: '新结果' }], nextCursor: 'next-page' };
    return { data: [], nextCursor: null };
  } });
  await settle(); await find(h.nodes.get('#search-result'), '关联会话').fire('click'); await settle();
  h.session.elements.codexProject.value = 'project\n/work'; await h.session.elements.codexProject.fire('change'); await settle();
  h.session.elements.sessionSearch.value = '旧词'; await h.session.elements.sessionSearch.fire('input');
  const oldRequest = h.nodes.get('#session-search').fire('click'); await settle();
  h.session.elements.sessionSearch.value = '新词'; await h.session.elements.sessionSearch.fire('input');
  await h.nodes.get('#session-search').fire('click'); await h.nodes.get('#more-sessions').fire('click');
  resolveOld({ data: [{ id: 'old', title: '过期结果' }], nextCursor: 'old-page' }); await oldRequest; await settle();
  const choices = h.session.elements.sessionId.children.map((item) => item.value);
  assert.equal(choices.includes('old'), false); assert.equal(choices.includes('new'), true); assert.equal(choices.includes('next'), true);
  const page = h.calls.filter((item) => item.name === 'codex_sessions').at(-1);
  assert.deepEqual({ ...page.args }, { cwd: '/work', searchTerm: '新词', cursor: 'next-page' });
});

test('切换工程时丢弃旧工程的会话结果', async () => {
  let resolveOld;
  const waiting = new Promise((resolve) => { resolveOld = resolve; });
  const h = createHarness({
    codex_projects: { data: [{ id: 'project', name: '工程', roots: ['/work', '/other'] }], nextCursor: null },
    codex_sessions: ({ cwd }) => cwd === '/work' ? waiting : { data: [{ id: 'new', title: '新工程' }], nextCursor: null },
  });
  await settle(); await find(h.nodes.get('#search-result'), '关联会话').fire('click'); await settle();
  h.session.elements.codexProject.value = 'project\n/work'; const old = h.session.elements.codexProject.fire('change'); await settle();
  h.session.elements.codexProject.value = 'project\n/other'; await h.session.elements.codexProject.fire('change'); await settle();
  resolveOld({ data: [{ id: 'old', title: '旧工程' }], nextCursor: 'old' }); await old; await settle();
  const choices = h.session.elements.sessionId.children.map((item) => item.value);
  assert.equal(choices.includes('old'), false); assert.equal(choices.includes('new'), true);
});

test('已有笔记更新通过独立弹窗预览并以同一令牌确认提交', async () => {
  const draft = { id: 'draft-update', title: '更新记录', content: '# 更新后\n', target: 'notes/topic.md', status: 'pending', revision: 1 };
  const h = createHarness({
    local_list: { links: [], drafts: [draft] },
    draft_note_update_preview: { requestId: 'test-attempt', confirmation: 'c'.repeat(64), target: draft.target, beforeDigest: 'b'.repeat(64), beforeContent: '# 原文\n', afterContent: draft.content, unchanged: false, startLine: 1, removed: '# 原文', added: '# 更新后' },
    draft_note_update_submit: { status: 'completed' },
  });
  await settle();
  await find(h.nodes.get('#drafts'), '更新已有笔记').fire('click');
  await settle();
  await h.nodes.get('#update-method').fire('change', { value: 'replace' });
  await h.nodes.get('#update-preview').fire('click');
  assert.equal(h.nodes.get('#update-dialog').open, true);
  assert.equal(h.nodes.get('#update-before').textContent, '# 原文\n', h.nodes.get('#update-status').textContent);
  assert.equal(h.nodes.get('#update-after').textContent, draft.content);
  assert.equal(h.nodes.get('#update-confirm').disabled, false);
  await h.nodes.get('#update-confirm').fire('click');
  const call = h.calls.find((entry) => entry.name === 'draft_note_update_submit');
  assert.equal(call.args.confirmation, 'c'.repeat(64));
  assert.equal(call.args.confirmed, true);
  assert.match(h.nodes.get('#update-status').textContent, /更新已完成/);
});

test('编辑多工作项草稿移除一项并保存完整列表，状态调整保留全部', async () => {
  const first = { environment: 'https://example.test', tenantId: '7', projectId: '1', issueId: '3', title: '第一项' };
  const second = { ...first, issueId: '4', title: '第二项' };
  const draft = { id: 'multi', title: '多项', target: 'multi.md', content: '# 多项', revision: 1, status: 'pending', issue: first, issues: [first, second] };
  const h = createHarness({ local_list: { links: [], drafts: [draft] }, local_save_draft: {} }); await settle();
  await find(h.nodes.get('#drafts'), '暂缓').fire('click');
  assert.equal(h.calls.find((item) => item.name === 'local_save_draft').args.issues.length, 2);
  await find(h.nodes.get('#drafts'), '编辑').fire('click');
  await find(h.nodes.get('#draft-issue'), '移除关联').fire('click');
  await h.nodes.get('#draft-form').fire('submit');
  const saved = h.calls.filter((item) => item.name === 'local_save_draft').at(-1).args;
  assert.equal(saved.issues.length, 1); assert.equal(saved.issues[0].issueId, '4'); assert.equal(Object.hasOwn(saved, 'issue'), false);
});

test('移除来源会话后显式保存 null', async () => {
  const draft = { id: 'source', title: '来源', target: 'source.md', content: '# 来源', revision: 1, status: 'pending', issues: [], sourceSession: { id: 'thread', title: '来源会话' } };
  const h = createHarness({ local_list: { links: [], drafts: [draft] }, local_save_draft: {} }); await settle();
  await find(h.nodes.get('#drafts'), '编辑').fire('click');
  await find(h.nodes.get('#draft-session'), '移除来源会话').fire('click');
  await h.nodes.get('#draft-form').fire('submit');
  assert.equal(h.calls.find((item) => item.name === 'local_save_draft').args.sourceSession, null);
});

test('延迟保存期间禁止从关联会话替换草稿，保存返回不清除后续变化', async () => {
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const issue = { environment: 'https://example.test', tenantId: '7', projectId: '1', issueId: '3', title: '测试工作项' };
  const h = createHarness({ local_list: { links: [{ issue, sessionId: 'source', sessionTitle: '来源' }], drafts: [] }, local_save_draft: () => waiting }); await settle();
  await find(h.nodes.get('#search-result'), '查看会话').fire('click'); await settle();
  const form = h.nodes.get('#draft-form'); form.elements.title.value = '保存中的标题'; form.elements.content.value = '保存中的正文';
  const saving = form.fire('submit'); await settle();
  await find(h.nodes.get('#linked-list'), '总结会话生成草稿').fire('click');
  assert.equal(form.elements.title.value, '保存中的标题');
  assert.equal(h.nodes.get('#linked-panel').open, true);
  form.elements.content.value = '后续正文';
  release({}); await saving; await settle();
  assert.equal(form.elements.content.value, '后续正文');
});

test('更新成功后逐项关联，失败只重试当前关联不重写笔记', async () => {
  const first = { environment: 'https://example.test', tenantId: '7', projectId: '1', issueId: '3', title: '第一项' };
  const second = { ...first, issueId: '4', title: '第二项' };
  const draft = { id: 'multi-update', title: '更新', target: 'multi.md', content: '# 更新', revision: 1, status: 'pending', issues: [first, second] };
  let attempts = 0;
  const h = createHarness({ local_list: { links: [], drafts: [draft] }, draft_note_update_preview: { requestId: 'test-attempt', beforeDigest: 'b'.repeat(64), confirmation: 'c'.repeat(64), target: draft.target, beforeContent: '# 原文', afterContent: draft.content, unchanged: false, startLine: 1, removed: '# 原文', added: '# 更新' }, draft_note_update_submit: { status: 'completed' }, draft_note_update_link: () => ++attempts === 1 ? new Error('关联失败') : {} });
  await settle(); await find(h.nodes.get('#drafts'), '更新已有笔记').fire('click'); await settle();
  await h.nodes.get('#update-method').fire('change', { value: 'replace' });
  await h.nodes.get('#update-preview').fire('click');
  await h.nodes.get('#update-confirm').fire('click');
  const button = find(h.nodes.get('#update-issue'), '关联：第二项');
  await button.fire('click'); assert.equal(button.disabled, false);
  await button.fire('click'); assert.equal(button.disabled, true);
  assert.equal(h.calls.filter((item) => item.name === 'draft_note_update_submit').length, 1);
  assert.equal(h.calls.filter((item) => item.name === 'draft_note_update_link').every((item) => item.args.issue.issueId === '4'), true);
});

test('重新引用片段会清除前一次追加预览', async () => {
  const draft = { id: 'history', title: '历史', content: '草稿', target: 'note.md', status: 'pending', revision: 1 };
  const original = '甲乙丙';
  const h = createHarness({ local_list: { links: [], drafts: [draft] }, draft_history_source: { content: original, revision: 'digest', vaultId: 'vault' }, draft_note_update_preview: args => ({ requestId: args.requestId, mode: 'append', confirmation: 'token', beforeContent: original, afterContent: original + args.selection.text + draft.content, appendedContent: args.selection.text + draft.content, unchanged: false }) });
  await settle(); await find(h.nodes.get('#drafts'), '更新已有笔记').fire('click'); await settle();
  const input = h.nodes.get('#update-original'); input.selectionStart = 0; input.selectionEnd = 1;
  await h.nodes.get('#update-quote').fire('click');
  await h.nodes.get('#update-preview').fire('click');
  assert.equal(h.nodes.get('#update-confirm').disabled, false);
  input.selectionEnd = 2;
  await h.nodes.get('#update-quote').fire('click');
  assert.equal(h.nodes.get('#update-confirm').disabled, true);
  assert.equal(h.nodes.get('#update-result').hidden, true);
  await h.nodes.get('#update-confirm').fire('click');
  assert.equal(h.calls.some(item => item.name === 'draft_note_update_submit'), false);
  await h.nodes.get('#update-preview').fire('click');
  assert.equal(h.nodes.get('#update-after').textContent, '甲乙丙甲乙草稿');
});
