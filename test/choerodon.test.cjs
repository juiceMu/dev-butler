const test = require('node:test');
const assert = require('node:assert/strict');
const { createChoerodonClient } = require('../src/choerodon.cjs');

test('只构造已验证的只读命令，并以参数数组传递输入', async () => {
  const calls = [];
  const client = createChoerodonClient({ execute: async (...args) => {
    calls.push(args);
    return { stdout: '结果' };
  } });
  assert.deepEqual(await client.info(), { format: 'text', text: '结果' });
  await client.todos({ projectId: '12', keyword: '--help; touch /tmp/unwanted', page: 0, size: 20 });
  await client.detail({ projectId: 12, issueId: 34 });
  assert.deepEqual(calls.map((call) => call[1]), [
    ['info'],
    ['todos', '--project', '12', '--keyword=--help; touch /tmp/unwanted', '--page', '0', '--size', '20'],
    ['issue', 'detail', '34', '--project', '12'],
  ]);
  assert.equal(calls[0][2].timeout, 15000);
});

test('拒绝无效标识符与分页参数', () => {
  const client = createChoerodonClient();
  assert.throws(() => client.detail({ projectId: '1', issueId: '--help' }), /数字 ID/);
  assert.throws(() => client.detail({ projectId: '1', issueId: 9007199254740992 }), /数字 ID/);
  assert.throws(() => client.todos({ size: 0 }), /整数/);
  assert.throws(() => client.todos({ page: -1 }), /整数/);
});

test('错误不泄露进程输出', async () => {
  const client = createChoerodonClient({ execute: async () => {
    throw Object.assign(new Error('secret-output'), { code: 'ENOENT', stderr: 'secret-output' });
  } });
  await assert.rejects(client.info(), (error) => error.code === 'C7N_NOT_FOUND' && !error.message.includes('secret-output'));
});

test('分别报告超时和普通失败', async () => {
  for (const [failure, code] of [[{ killed: true }, 'C7N_TIMEOUT'], [{ code: 1 }, 'C7N_COMMAND_FAILED']]) {
    const client = createChoerodonClient({ execute: async () => { throw failure; } });
    await assert.rejects(client.info(), (error) => error.code === code);
  }
});

test('严格解析当前用户和项目列表，保留大整数 ID 与第一页范围', async () => {
  const calls = [];
  const client = createChoerodonClient({ execute: async (_, args) => {
    calls.push(args);
    return { stdout: args[0] === 'info' ? '用户 ID  564964552245518336\n登录名    45961\n租户     HZERO平台 (7)\n当前项目   -\n' : 'ID                  编码     名称                状态       分类\n282094011157413888  hlodm  技术应用-aPaaS移动端应用   success  DevOps, 敏捷管理\n1381                hlod   技术应用-aPaaS PC端应用  success  DevOps\n当前显示 2 个项目，共 5 个；当前仅展示第一页。\n' };
  } });
  assert.deepEqual(await client.identity(), { userId: '564964552245518336', login: '45961', tenantId: '7', tenantName: 'HZERO平台' });
  assert.deepEqual(await client.projects(), { items: [{ id: '282094011157413888', code: 'hlodm', name: '技术应用-aPaaS移动端应用' }, { id: '1381', code: 'hlod', name: '技术应用-aPaaS PC端应用' }], shown: 2, total: 5, complete: false, firstPageOnly: true });
  assert.deepEqual(calls, [['info'], ['projects']]);
});

test('无法识别、乱码、重复或数量不一致时不当作空结果', async () => {
  for (const output of ['', '用户 ID  1\n登录名 a\n租户 x (2)\n用户 ID  3', '用户 ID  1\n登录名 a\n租户 \ufffd (2)']) {
    const client = createChoerodonClient({ execute: async () => ({ stdout: output }) });
    await assert.rejects(client.identity(), (error) => error.code === 'C7N_INVALID_RESPONSE');
  }
  for (const output of ['', 'ID  编码  名称  状态  分类\n当前显示 1 个项目，共 2 个；当前仅展示第一页。', 'ID  编码  名称  状态  分类\n1  a  b  success  DevOps\n1  c  d  success  DevOps\n当前显示 2 个项目，共 2 个；当前仅展示第一页。']) {
    const client = createChoerodonClient({ execute: async () => ({ stdout: output }) });
    await assert.rejects(client.projects(), (error) => error.code === 'C7N_INVALID_RESPONSE');
  }
});

function searchPage(overrides = {}) {
  return { content: [{ issueId: '282094011157413888', issueNum: 'A-1', summary: '概要', typeCode: 'task', issueTypeVO: { id: '456', name: '任务' }, statusVO: { id: '789', name: '进行中' }, assigneeId: '123', assigneeName: '用户', projectVO: { id: '1381', name: '项目' }, creationDate: '2026-01-01', lastUpdateDate: '2026-01-02' }], totalPages: 1, totalElements: 1, numberOfElements: 1, size: 20, number: 0, empty: false, ...overrides };
}

test('类型与状态只读选项解析并过滤关联工作项', async () => {
  const calls = [];
  const client = createChoerodonClient({ execute: async (_, args) => {
    calls.push(args);
    if (args[2] === 'schemes') return { stdout: JSON.stringify({ totalPages: 1, content: [{ applyType: 'agile', issueTypeWithInfoList: [{ id: '456', name: '任务', enabled: true }, { id: '999', name: '停用', enabled: false }] }] }) };
    if (args[2] === 'transforms') return { stdout: JSON.stringify([{ id: '789', name: '进行中' }]) };
    const page = searchPage(); page.content.push({ ...page.content[0], issueId: '2', issueTypeVO: { id: '999', name: '关联项' } });
    return { stdout: JSON.stringify(page) };
  } });
  assert.deepEqual(await client.issueTypes({ projectId: '1381' }), { items: [{ id: '456', name: '任务' }] });
  assert.deepEqual(await client.issueStatuses({ projectId: '1381', typeId: '456' }), { items: [{ id: '789', name: '进行中' }] });
  assert.equal((await client.search({ projectId: '1381', typeIds: ['456'], statusIds: ['789'] })).items.length, 1);
  assert.deepEqual(calls[1], ['issue', 'status', 'transforms', '456', '--project', '1381']);
  const invalid = createChoerodonClient({ execute: async () => ({ stdout: JSON.stringify({ totalPages: 2, content: [] }) }) });
  await assert.rejects(invalid.issueTypes({ projectId: '1381' }), /不完整/);
});

test('结构化搜索限定项目并保留字符串 ID 和服务端分页信息', async () => {
  const calls = [];
  const client = createChoerodonClient({ execute: async (...args) => { calls.push(args); return { stdout: JSON.stringify(searchPage({ size: 1, numberOfElements: 2 })) }; } });
  const result = await client.search({ projectId: '1381', assigneeIds: ['123'], typeIds: ['456'], statusIds: ['789'], keyword: '--help; test', page: 0, size: 1 });
  assert.deepEqual(calls[0][1], ['issue', 'search', '--project', '1381', '--format', 'json', '--assignee', '123', '--type', '456', '--status', '789', '--keyword=--help; test', '--page', '0', '--size', '1']);
  assert.equal(result.format, 'json');
  assert.equal(result.items[0].issueId, '282094011157413888');
  assert.equal(result.items[0].projectId, '1381');
  assert.equal(result.pagination.numberOfElements, 2);
  assert.equal(result.pagination.size, 1);
});

test('项目占位 ID 为零时使用显式查询项目', async () => {
  const response = searchPage({ content: [{ issueId: '123', projectVO: { id: '0', name: '' } }] });
  const client = createChoerodonClient({ execute: async () => ({ stdout: JSON.stringify(response) }) });
  const result = await client.search({ projectId: '1381' });
  assert.equal(result.items[0].projectId, '1381');
});

test('结构化搜索拒绝无效输入和不可信响应', async () => {
  const client = createChoerodonClient({ execute: async () => ({ stdout: 'invalid secret response' }) });
  await assert.rejects(client.search({ projectId: '--help' }), /数字 ID/);
  await assert.rejects(client.search({ projectId: '1', assigneeIds: ['--help'] }), /数字 ID/);
  await assert.rejects(client.search({ projectId: '1' }), (error) => error.code === 'C7N_INVALID_RESPONSE' && !error.message.includes('secret'));
  for (const response of [searchPage({ content: [{ issueId: 9007199254740992 }] }), searchPage({ content: [{ issueId: '123', projectVO: { id: '2' } }] }), searchPage({ size: '20' })]) {
    const invalid = createChoerodonClient({ execute: async () => ({ stdout: JSON.stringify(response) }) });
    await assert.rejects(invalid.search({ projectId: '1' }), (error) => error.code === 'C7N_INVALID_RESPONSE');
  }
});

test('读取所有支持状态的冲刺并保留大整数 ID', async () => {
  const calls = [];
  const client = createChoerodonClient({ execute: async (_, args) => {
    calls.push(args);
    return { stdout: '冲刺ID                冲刺名称  冲刺状态  开始日期  结束日期\n898622805775282176  当前冲刺  started  2026-11-02 09:16:57  2026-11-15 23:59:59\n2  历史冲刺  closed  -  -\n' };
  } });
  assert.deepEqual(await client.sprints({ projectId: '1381' }), { items: [{ id: '898622805775282176', name: '当前冲刺', status: 'started' }, { id: '2', name: '历史冲刺', status: 'closed' }] });
  assert.deepEqual(calls[0], ['tests', 'plans', 'sprints', '--project', '1381', '--status', 'sprint_planning', '--status', 'started', '--status', 'closed']);
});

test('空冲刺列表与无法解析的输出严格区分', async () => {
  const header = '冲刺ID  冲刺名称  冲刺状态  开始日期  结束日期\n';
  const empty = createChoerodonClient({ execute: async () => ({ stdout: `${header}未查询到可用数据  -  -  -  -\n` }) });
  assert.deepEqual(await empty.sprints({ projectId: '1' }), { items: [] });
  for (const output of ['', `${header}1  名称  unknown  -  -`, `${header}1  名称  started  -  -\n1  重复  closed  -  -`]) {
    const invalid = createChoerodonClient({ execute: async () => ({ stdout: output }) });
    await assert.rejects(invalid.sprints({ projectId: '1' }), (error) => error.code === 'C7N_INVALID_RESPONSE');
  }
});

test('冲刺搜索只返回包含目标冲刺的工作项，不把关联项当成匹配项', async () => {
  const calls = [];
  const response = searchPage({ content: [
    { issueId: '1', issueSprintVOS: [{ sprintId: '898622805775282176' }] },
    { issueId: '2', issueSprintVOS: [{ sprintId: '3' }] },
  ] });
  const client = createChoerodonClient({ execute: async (_, args) => { calls.push(args); return { stdout: JSON.stringify(response) }; } });
  const result = await client.search({ projectId: '1381', sprintId: '898622805775282176' });
  assert.equal(result.returnedCount, 2);
  assert.deepEqual(result.items.map((item) => item.issueId), ['1']);
  assert.ok(calls[0].includes('--sprint'));
  await assert.rejects(client.search({ projectId: '1', sprintId: '--help' }), /数字 ID/);
  const invalid = createChoerodonClient({ execute: async () => ({ stdout: JSON.stringify(searchPage()) }) });
  await assert.rejects(invalid.search({ projectId: '1', sprintId: '2' }), (error) => error.code === 'C7N_INVALID_RESPONSE');
});
