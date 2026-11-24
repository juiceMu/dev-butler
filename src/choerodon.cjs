const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 15000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

function identifier(value, name) {
  if (typeof value !== 'string' && !(typeof value === 'number' && Number.isSafeInteger(value))) {
    throw new TypeError(`${name} 必须是数字 ID`);
  }
  const text = String(value ?? '');
  if (!/^\d+$/.test(text)) throw new TypeError(`${name} 必须是数字 ID`);
  return text;
}

function integer(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new TypeError(`${name} 必须是 ${min} 到 ${max} 之间的整数`);
  }
  return String(value);
}

function optionalText(value, name) {
  if (value == null) return '';
  if (typeof value !== 'string') throw new Error(`Choerodon 返回的 ${name} 格式无效`);
  return value;
}

function responseIdentifier(value, name) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new Error(`Choerodon 返回的 ${name} 格式无效`);
  return value;
}

function invalidResponse(message) {
  const error = new Error(message);
  error.code = 'C7N_INVALID_RESPONSE';
  return error;
}

function parseIdentity(output) {
  if (typeof output !== 'string' || output.includes('\ufffd')) throw invalidResponse('Choerodon 用户信息格式无效');
  const userIds = [...output.matchAll(/^用户 ID\s+(\d+)\s*$/gm)];
  const logins = [...output.matchAll(/^登录名\s+(\S+)\s*$/gm)];
  const tenants = [...output.matchAll(/^租户\s+(.+?)\s+\((\d+)\)\s*$/gm)];
  if (userIds.length !== 1 || logins.length !== 1 || tenants.length !== 1) throw invalidResponse('无法识别当前用户或租户，请检查 c7n 版本');
  return { userId: userIds[0][1], login: logins[0][1], tenantId: tenants[0][2], tenantName: tenants[0][1] };
}

function parseProjects(output) {
  if (typeof output !== 'string' || output.includes('\ufffd')) throw invalidResponse('Choerodon 项目列表格式无效');
  const lines = output.trim().split(/\r?\n/);
  if (!/^ID\s{2,}编码\s{2,}名称\s{2,}状态\s{2,}分类\s*$/.test(lines[0] || '')) throw invalidResponse('无法识别项目列表，请检查 c7n 版本');
  const footer = lines.at(-1).match(/^当前显示\s+(\d+)\s+个项目，共\s+(\d+)\s+个；当前仅展示第一页。$/);
  if (!footer) throw invalidResponse('无法确认项目列表范围');
  const items = lines.slice(1, -1).map((line) => {
    const parts = line.trim().split(/\s{2,}/);
    if (parts.length !== 5 || !/^\d+$/.test(parts[0]) || !parts[1] || !parts[2]) throw invalidResponse('项目列表包含无法识别的记录');
    return { id: parts[0], code: parts[1], name: parts[2] };
  });
  const shown = Number(footer[1]);
  const total = Number(footer[2]);
  if (!Number.isSafeInteger(shown) || !Number.isSafeInteger(total) || shown !== items.length || shown > total || new Set(items.map((item) => item.id)).size !== items.length) {
    throw invalidResponse('项目列表数量不一致');
  }
  return { items, shown, total, complete: shown === total, firstPageOnly: true };
}

function parseSprints(output) {
  if (typeof output !== 'string' || output.includes('\ufffd')) throw invalidResponse('Choerodon 冲刺列表格式无效');
  const lines = output.trim().split(/\r?\n/);
  if (!/^冲刺ID\s{2,}冲刺名称\s{2,}冲刺状态\s{2,}开始日期\s{2,}结束日期\s*$/.test(lines[0] || '')) throw invalidResponse('无法识别冲刺列表，请检查 c7n 版本');
  if (lines.length === 2 && /^未查询到可用数据\s{2,}-\s{2,}-\s{2,}-\s{2,}-\s*$/.test(lines[1])) return { items: [] };
  const items = lines.slice(1).map((line) => {
    const parts = line.trim().split(/\s{2,}/);
    if (parts.length !== 5 || !/^\d+$/.test(parts[0]) || !parts[1] || !['started', 'sprint_planning', 'closed'].includes(parts[2])) throw invalidResponse('冲刺列表包含无法识别的记录');
    return { id: parts[0], name: parts[1], status: parts[2] };
  });
  if (new Set(items.map((item) => item.id)).size !== items.length) throw invalidResponse('冲刺列表包含重复记录');
  return { items };
}

function parseSearchResponse(output, projectId, sprintId, typeIds = [], statusIds = []) {
  let page;
  try { page = JSON.parse(output); } catch { throw new Error('Choerodon 返回的工作项数据不是有效 JSON'); }
  if (!page || typeof page !== 'object' || !Array.isArray(page.content)) throw new Error('Choerodon 返回的工作项列表格式无效');
  const items = page.content.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Choerodon 返回的工作项格式无效');
    // 当前 CLI 在未填充项目对象时返回字符串 "0"。
    const returnedProjectId = item.projectVO?.id == null || item.projectVO.id === '0' ? projectId : responseIdentifier(item.projectVO.id, '项目 ID');
    if (returnedProjectId !== projectId) throw new Error('Choerodon 返回了其他项目的工作项');
    let sprintIds;
    if (sprintId !== undefined) {
      if (!Array.isArray(item.issueSprintVOS)) throw new Error('Choerodon 返回的工作项冲刺信息格式无效');
      sprintIds = item.issueSprintVOS.map((sprint) => responseIdentifier(sprint?.sprintId, '冲刺 ID'));
    }
    return {
      issueId: responseIdentifier(item.issueId, '工作项 ID'),
      issueNum: optionalText(item.issueNum, '工作项编号'),
      summary: optionalText(item.summary, '工作项概要'),
      typeCode: optionalText(item.typeCode, '工作项类型编码'),
      typeName: optionalText(item.issueTypeVO?.name, '工作项类型'),
      statusName: optionalText(item.statusVO?.name, '状态'),
      ...(typeIds.length ? { typeId: responseIdentifier(item.issueTypeVO?.id, '类型 ID') } : {}),
      ...(statusIds.length ? { statusId: responseIdentifier(item.statusVO?.id, '状态 ID') } : {}),
      assigneeId: item.assigneeId == null || item.assigneeId === '' ? '' : responseIdentifier(item.assigneeId, '经办人 ID'),
      assigneeName: optionalText(item.assigneeName, '经办人'),
      projectId: returnedProjectId,
      projectName: optionalText(item.projectVO?.name, '项目名称'),
      creationDate: optionalText(item.creationDate, '创建时间'),
      lastUpdateDate: optionalText(item.lastUpdateDate, '更新时间'),
      ...(sprintIds ? { sprintIds } : {}),
    };
  });
  const metadata = {};
  for (const key of ['totalPages', 'totalElements', 'numberOfElements', 'size', 'number']) {
    if (!Number.isSafeInteger(page[key]) || page[key] < 0) throw new Error(`Choerodon 返回的分页字段 ${key} 格式无效`);
    metadata[key] = page[key];
  }
  if (typeof page.empty !== 'boolean') throw new Error('Choerodon 返回的分页字段 empty 格式无效');
  metadata.empty = page.empty;
  return { format: 'json', items: items.filter((item) => (sprintId === undefined || item.sprintIds.includes(sprintId)) && (!typeIds.length || typeIds.includes(item.typeId)) && (!statusIds.length || statusIds.includes(item.statusId))), returnedCount: items.length, pagination: metadata };
}

function parseOptions(output, kind) {
  let value;
  try { value = JSON.parse(output); } catch { throw invalidResponse(`${kind}列表不是有效 JSON`); }
  let entries;
  if (kind === '类型') {
    if (!Array.isArray(value?.content) || !Number.isSafeInteger(value.totalPages) || value.totalPages < 0 || value.totalPages > 1) throw invalidResponse('类型方案不完整或格式无效');
    const agile = value.content.filter((item) => item.applyType === 'agile');
    if (agile.length !== 1 || !Array.isArray(agile[0].issueTypeWithInfoList)) throw invalidResponse('无法识别敏捷类型方案');
    entries = agile[0].issueTypeWithInfoList.filter((item) => item.enabled !== false && item.deleted !== true);
  } else {
    if (!Array.isArray(value)) throw invalidResponse('状态列表格式无效');
    entries = value;
  }
  const items = entries.map((item) => ({ id: responseIdentifier(item?.id, `${kind} ID`), name: optionalText(item?.name, kind) }));
  if (items.some((item) => !item.name) || new Set(items.map((item) => item.id)).size !== items.length) throw invalidResponse(`${kind}列表包含无效或重复记录`);
  return { items };
}

function createChoerodonClient({ command = 'c7n', execute = execFileAsync, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  async function run(args) {
    try {
      const result = await execute(command, args, {
        encoding: 'utf8',
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
      });
      return { format: 'text', text: result.stdout };
    } catch (error) {
      const code = error.code === 'ENOENT' ? 'C7N_NOT_FOUND' :
        error.killed ? 'C7N_TIMEOUT' : 'C7N_COMMAND_FAILED';
      const messages = {
        C7N_NOT_FOUND: '未找到 c7n 命令，请安装并检查 PATH。',
        C7N_TIMEOUT: 'Choerodon 查询超时，请检查连接后重试。',
        C7N_COMMAND_FAILED: 'Choerodon 查询失败，请检查登录状态、项目权限和网络。',
      };
      const safeError = new Error(messages[code]);
      safeError.code = code;
      throw safeError;
    }
  }

  return {
    info() {
      return run(['info']);
    },
    async identity() {
      return parseIdentity((await run(['info'])).text);
    },
    async projects() {
      return parseProjects((await run(['projects'])).text);
    },
    async sprints({ projectId }) {
      const result = await run(['tests', 'plans', 'sprints', '--project', identifier(projectId, 'projectId'), '--status', 'sprint_planning', '--status', 'started', '--status', 'closed']);
      return parseSprints(result.text);
    },
    async issueTypes({ projectId }) {
      return parseOptions((await run(['issue', 'status', 'schemes', '--project', identifier(projectId, 'projectId')])).text, '类型');
    },
    async issueStatuses({ projectId, typeId }) {
      return parseOptions((await run(['issue', 'status', 'transforms', identifier(typeId, 'typeId'), '--project', identifier(projectId, 'projectId')])).text, '状态');
    },
    todos({ projectId, keyword, page, size } = {}) {
      const args = ['todos'];
      if (projectId !== undefined) args.push('--project', identifier(projectId, 'projectId'));
      if (keyword !== undefined) {
        if (typeof keyword !== 'string' || keyword.length > 200) throw new TypeError('keyword 必须是不超过 200 字符的字符串');
        args.push(`--keyword=${keyword}`);
      }
      if (page !== undefined) args.push('--page', integer(page, 'page', 0, 1000000));
      if (size !== undefined) args.push('--size', integer(size, 'size', 1, 100));
      return run(args);
    },
    detail({ projectId, issueId }) {
      return run(['issue', 'detail', identifier(issueId, 'issueId'), '--project', identifier(projectId, 'projectId')]);
    },
    async search({ projectId, assigneeIds = [], typeIds = [], statusIds = [], sprintId, keyword, page = 0, size = 20 }) {
      const args = ['issue', 'search', '--project', identifier(projectId, 'projectId'), '--format', 'json'];
      for (const [flag, values] of [['assignee', assigneeIds], ['type', typeIds], ['status', statusIds]]) {
        if (!Array.isArray(values) || values.length > 100) throw new TypeError(`${flag} 必须是不超过 100 项的 ID 数组`);
        for (const value of values) args.push(`--${flag}`, identifier(value, flag));
      }
      if (sprintId !== undefined) args.push('--sprint', identifier(sprintId, 'sprintId'));
      if (keyword !== undefined) {
        if (typeof keyword !== 'string' || keyword.length > 200) throw new TypeError('keyword 必须是不超过 200 字符的字符串');
        args.push(`--keyword=${keyword}`);
      }
      args.push('--page', integer(page, 'page', 0, 1000000), '--size', integer(size, 'size', 1, 100));
      const result = await run(args);
      try { return parseSearchResponse(result.text, identifier(projectId, 'projectId'), sprintId === undefined ? undefined : identifier(sprintId, 'sprintId'), typeIds.map((value) => identifier(value, 'type')), statusIds.map((value) => identifier(value, 'status'))); } catch (error) {
        const safeError = new Error(error.message);
        safeError.code = 'C7N_INVALID_RESPONSE';
        throw safeError;
      }
    },
  };
}

module.exports = { createChoerodonClient };
