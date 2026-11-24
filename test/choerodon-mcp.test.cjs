const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

test('MCP 根据当前身份限定本人工作项，并拒绝上下文或项目不一致', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'c7n-mcp-'));
  const c7n = path.join(directory, 'c7n');
  const state = path.join(directory, 'scenario');
  const calls = path.join(directory, 'calls');
  const script = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.C7N_TEST_CALLS, JSON.stringify(args) + '\\n');
const scenario = fs.readFileSync(process.env.C7N_TEST_SCENARIO, 'utf8');
if (args[0] === 'info') {
  console.log('用户 ID  123\\n登录名    test\\n租户     示例 (' + (scenario === 'tenant-change' ? '9' : '7') + ')');
} else if (args[0] === 'projects') {
  console.log('ID  编码  名称  状态  分类\\n1381  demo  项目  success  敏捷管理\\n当前显示 1 个项目，共 1 个；当前仅展示第一页。');
} else if (args[0] === 'issue' && args[1] === 'search') {
  const project = scenario === 'wrong-project' ? '99' : '1381';
  console.log(JSON.stringify({content:[{issueId:'1',summary:'本人任务',assigneeId:'123',projectVO:{id:project}},{issueId:'2',summary:'其他人任务',assigneeId:'456',projectVO:{id:project}}],totalPages:1,totalElements:2,numberOfElements:2,size:20,number:0,empty:false}));
} else { process.exitCode = 1; }
`;
  fs.writeFileSync(c7n, script, { mode: 0o700 });
  fs.writeFileSync(state, 'normal');
  const client = new Client({ name: 'c7n-mcp-test', version: '1' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, '..', 'server.cjs')],
    env: { ...process.env, PATH: `${directory}${path.delimiter}${process.env.PATH || ''}`, C7N_TEST_CALLS: calls, C7N_TEST_SCENARIO: state, CODEX_LINK_DATA_DIR: directory },
  });
  t.after(async () => { await client.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  await client.connect(transport);
  const context = await client.callTool({ name: 'choerodon_context', arguments: {} });
  assert.notEqual(context.isError, true);
  const contextData = JSON.parse(context.content[0].text);
  assert.equal(contextData.identity.userId, '123');
  assert.equal(contextData.identity.tenantId, '7');
  assert.deepEqual(contextData.projects.items, [{ id: '1381', code: 'demo', name: '项目' }]);

  const query = { projectId: '1381', userId: '123', tenantId: '7', mine: true, page: 0 };
  const result = await client.callTool({ name: 'choerodon_scoped_search', arguments: query });
  assert.notEqual(result.isError, true);
  assert.deepEqual(JSON.parse(result.content[0].text).items.map((item) => item.issueId), ['1']);
  const recorded = fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse);
  const search = recorded.find((args) => args[0] === 'issue');
  assert.ok(search.includes('--assignee'));
  assert.equal(search[search.indexOf('--assignee') + 1], '123');
  assert.equal(search[search.indexOf('--project') + 1], '1381');

  fs.writeFileSync(state, 'tenant-change');
  const rejected = await client.callTool({ name: 'choerodon_scoped_search', arguments: query });
  assert.equal(rejected.isError, true);
  const after = fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(after.filter((args) => args[0] === 'issue').length, 1);

  fs.writeFileSync(state, 'wrong-project');
  const wrongProject = await client.callTool({ name: 'choerodon_scoped_search', arguments: query });
  assert.equal(wrongProject.isError, true);
});
