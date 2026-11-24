import { App } from '@modelcontextprotocol/ext-apps';
import MarkdownIt from 'markdown-it';

const app = new App({ name: 'Choerodon 与语雀联动', version: '0.1.0' });
const $ = (selector) => document.querySelector(selector);
const draftMarkdown = new MarkdownIt({ html: false, linkify: false });
draftMarkdown.renderer.rules.image = (tokens, index) => draftMarkdown.utils.escapeHtml(`[图片: ${tokens[index].content || tokens[index].attrGet('src') || ''}]`);
draftMarkdown.renderer.rules.link_open = () => '<span class="markdown-link">';
draftMarkdown.renderer.rules.link_close = () => '</span>';
let data = { links: [], drafts: [] };
let editing = null;
let draftIssue = null;
let draftIssues = [];
let draftIssuesBaseline = '[]';
let draftSessionBaseline = 'null';
let queriedIssues = [];
function issuesOf(item) { return Array.isArray(item?.issues) ? item.issues : item?.issue ? [item.issue] : []; }
function draftIssueKey(issue) { return JSON.stringify([issue.environment, issue.tenantId, issue.projectId, issue.issueId]); }
function issueLabel(issue) { return `${issue.title || issue.issueId} · ${issue.environment} · 租户 ${issue.tenantId} · 项目 ${issue.projectId} · 工作项 ${issue.issueId}`; }
function setDraftIssues(issues) { draftIssues = issues.slice(); draftIssue = draftIssues[0] || null; renderDraftIssues(); }
function renderDraftIssues() {
  const target = $('#draft-issue'); target.replaceChildren();
  target.append(make('span', `关联工作项（${draftIssues.length}）`));
  for (const issue of draftIssues) {
    const row = make('span');
    row.append(make('span', issueLabel(issue)), action('移除关联', () => {
      if (savingDraft) return;
      setDraftIssues(draftIssues.filter((entry) => draftIssueKey(entry) !== draftIssueKey(issue))); ++draftMutation;
    })); target.append(row);
  }
  const candidates = queriedIssues.filter((issue) => !draftIssues.some((entry) => draftIssueKey(entry) === draftIssueKey(issue)));
  const select = document.createElement('select'); select.setAttribute('aria-label', '已查询工作项');
  const placeholder = new Option(candidates.length ? '请选择工作项' : '暂无可关联的工作项', '', true, true);
  placeholder.disabled = true;
  placeholder.hidden = candidates.length > 0;
  select.add(placeholder);
  select.disabled = candidates.length === 0;
  candidates.forEach((issue, index) => select.add(new Option(issue.title || issue.issueId, String(index))));
  const add = action('加入草稿关联', () => {
    if (savingDraft || select.value === '' || !candidates[Number(select.value)]) return;
    setDraftIssues([...draftIssues, candidates[Number(select.value)]]); ++draftMutation;
  });
  const updateAddStatus = () => { add.disabled = select.value === '' || draftIssues.length >= 100; };
  select.addEventListener('change', updateAddStatus);
  updateAddStatus();
  target.append(select, add);
  const sessionTarget = $('#draft-session'); sessionTarget.replaceChildren();
  if (draftSession) sessionTarget.append(make('span', `来源会话：${draftSession.title || draftSession.id}`), action('移除来源会话', () => { if (!savingDraft) { draftSession = null; ++draftMutation; renderDraftIssues(); } }));
  if (draftSession) {
    const source = draftSession;
    const link = data.links.find((entry) => entry.sessionId === source.id && draftIssues.some((issue) => draftIssueKey(issue) === draftIssueKey(entry.issue)));
    const status = make('span', '', 'muted'); status.setAttribute('role', 'status');
    const generate = action('总结会话生成内容', () => {
      if (!link) { status.textContent = '请先将来源会话关联到草稿中的工作项。'; return; }
      void prepareGeneration({ issue: link.issue, session: source, mode: 'editor', status, button: generate });
    });
    if (!link) status.textContent = '请先将来源会话关联到草稿中的工作项。';
    sessionTarget.append(generate, status);
  }
  const selectedSession = $('#session-form').elements.sessionId;
  if (selectedSession.value) {
    const source = { id: selectedSession.value, title: selectedSession.selectedOptions[0]?.textContent || selectedSession.value };
    sessionTarget.append(action('使用已选择会话作为来源', async () => {
      const state = currentDraftState(); const sequence = sessionSequence;
      if (savingDraft || !await confirmAction(`确认将来源会话设为“${source.title}”（${source.id}）？`)) return;
      if (savingDraft || state !== currentDraftState() || sequence !== sessionSequence || selectedSession.value !== source.id) return;
      draftSession = source; ++draftMutation; renderDraftIssues();
    }));
  }
}
function renderNoteIssueLinks(target, issues, tool, request, valid) {
  for (const issue of issues) {
    const row = make('span'); const status = make('span', '');
    const button = action(`关联：${issue.title || issue.issueId}`, async () => {
      const context = choerodonContext;
      if (button.disabled || !context?.identity?.userId || !valid()) return;
      if (!await confirmAction(`确认关联笔记到 ${issueLabel(issue)}？不会再次写入笔记。`)) return;
      if (context !== choerodonContext || !valid()) return;
      button.disabled = true;
      try { await call(tool, { ...request, issue, userId: context.identity.userId, confirmed: true }); if (valid()) status.textContent = '已关联'; }
      catch (error) { if (valid()) { status.textContent = `关联未完成：${error.message}，可重试`; button.disabled = false; } }
      finally { if (tool === 'draft_link_publication') void refreshReservations(); }
    });
    row.append(button, status); target.append(row);
  }
}
let draftSession = null;
let baseline = { title: '', target: '', content: '' };
let pendingDraftId = null;
let savingDraft = false;
let choerodonContext = null;
let searchSequence = 0;
let issuePage = 0;
let contextSequence = 0;
let sprintSequence = 0;
let filterSequence = 0;
let statusSequence = 0;
let issueTypes = [];
let selectedIssue = null;
let codexProjects = [];
let projectCursor = null;
let projectLinksSequence = 0;
let projectLinksNextOffset = null;
let sessionCursor = null;
let sessionSequence = 0;
let sessionLoading = false;
let sessionSearchTerm = '';
let issueDetailSequence = 0;
let issueDetailReady = false;
let sessionBusy = false;
let creationAttempt = null;
let pendingCreation = null;
let confirmationPending = false;
let attemptListSequence = 0;
let issueRows = [];
let linkedSequence = 0;
let knowledgeNotes = null;
let knowledgeListSequence = 0;
let knowledgeNextOffset = null;
let knowledgeReadSequence = 0;
let knowledgeReferenceSequence = 0;
let selectedKnowledgeNote = null;
let knowledgeSearchSequence = 0;
let publication = null;
let publicationSequence = 0;
let publicationBusy = false;
let noteUpdate = null;
let noteUpdateSequence = 0;
let noteUpdateBusy = false;
let notesIssue = null;
let notesSequence = 0;
let notesBusy = false;
let backupPreview = null;
let backupSequence = 0;
let backupBusy = false;
let vaultBackupPreview = null;
let vaultBackupSequence = 0;
let vaultBackupBusy = false;
let vaultRestorePreview = null;
let vaultRestoreSequence = 0;
let vaultRestoreBusy = false;
let generationSequence = 0;
let generation = null;
let draftMutation = 0;
let locationSequence = 0;
let pendingLinksSequence = 0;
let pendingLinksBusy = false;
let reservationsSequence = 0;
let reservationsBusy = false;
let reservationsRefreshQueued = false;
let cleanupSequence = 0;
const uncertainReservationActions = new Set();
let activeView = 'issues';

async function call(name, args = {}) {
  const result = await app.callServerTool({ name, arguments: args });
  const value = result.content?.find((item) => item.type === 'text')?.text || '';
  if (result.isError) throw new Error(value || '操作失败');
  try { return JSON.parse(value); } catch { return value; }
}
async function callReadWithTimeout(name, args) {
  let timer;
  try {
    return await Promise.race([
      call(name, args),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('请求超时')), 8000); }),
    ]);
  } finally { clearTimeout(timer); }
}
function message(value, error = false) {
  const node = $('#notice'); node.textContent = value; node.className = error ? 'notice error' : 'notice';
}
function confirmAction(text) {
  const dialog = $('#confirm-dialog');
  if (confirmationPending) return Promise.resolve(false);
  confirmationPending = true;
  $('#confirm-message').textContent = text;
  dialog.returnValue = 'cancel';
  return new Promise((resolve) => {
    const onClose = () => { confirmationPending = false; resolve(dialog.returnValue === 'confirm'); };
    dialog.addEventListener('close', onClose, { once: true });
    try { dialog.showModal(); } catch (error) { dialog.removeEventListener('close', onClose); confirmationPending = false; throw error; }
  });
}
document.querySelectorAll('#confirm-dialog button').forEach((button) => button.addEventListener('click', () => $('#confirm-dialog').close(button.value)));
function make(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function action(label, handler) {
  const button = make('button', label, 'secondary'); button.type = 'button';
  button.addEventListener('click', () => Promise.resolve(handler()).catch((error) => message(error.message, true)));
  return button;
}
$('#backup-export').addEventListener('click', async () => {
  if (backupBusy || !await confirmAction('导出包含本机关联和草稿，可能包含敏感信息，不含笔记、附件或会话。确认导出？')) return;
  backupBusy = true; $('#backup-export').disabled = true;
  try {
    const result = await call('local_export', { confirmed: true });
    const download = await app.downloadFile({ contents: [{ type: 'resource', resource: { uri: 'file:///x-assistant-index.json', mimeType: 'application/json', text: JSON.stringify(result, null, 2) } }] });
    $('#backup-status').textContent = download?.isError ? '导出已取消或宿主拒绝保存。' : '已向宿主提交保存请求，请确认文件已保存。';
  } catch (error) { $('#backup-status').textContent = `无法导出：${error.message}。请检查敏感信息或宿主保存能力。`; }
  finally { backupBusy = false; $('#backup-export').disabled = false; }
});
$('#backup-file').addEventListener('change', async (event) => {
  const sequence = ++backupSequence; backupPreview = null; $('#backup-import').hidden = true; $('#backup-preview').replaceChildren();
  const file = event.currentTarget.files[0]; if (!file) return;
  if (file.size > 10000000) { $('#backup-status').textContent = '备份文件超过 10 MB，无法导入。'; return; }
  $('#backup-status').textContent = '正在检查备份…';
  try {
    const backup = await file.text(); const preview = await call('local_import_preview', { backup });
    if (sequence !== backupSequence) return;
    backupPreview = { backup, token: preview.token, conflicts: preview.conflicts };
    $('#backup-status').textContent = `备份包含 ${preview.counts.links} 条会话关联、${preview.counts.noteLinks} 条知识关联、${preview.counts.projectLinks ?? 0} 条工程关联、${preview.counts.knowledgeEntries ?? 0} 条知识目录记录、${preview.counts.drafts} 条草稿；${preview.conflicts.length} 项冲突。`;
    const target = $('#backup-preview');
    for (const conflict of preview.conflicts) {
      const row = make('div', undefined, 'link-group');
      row.append(make('strong', `${{ links: '会话关联', noteLinks: '知识关联', projectLinks: '工程关联', knowledgeEntries: '知识目录记录', drafts: '草稿' }[conflict.collection] || conflict.collection}：${conflict.incoming.title || conflict.incoming.issue?.title || conflict.incoming.path || conflict.key}`));
      const details = make('details'); details.append(make('summary', '查看当前与备份内容'), make('pre', `当前：\n${JSON.stringify(conflict.current, null, 2)}\n\n备份：\n${JSON.stringify(conflict.incoming, null, 2)}`)); row.append(details);
      const label = make('label', '冲突处理'); const select = make('select');
      select.add(new Option('请选择处理方式', '')); select.add(new Option('跳过', 'skip')); select.add(new Option('替换', 'replace')); select.add(new Option('合并空字段', 'merge'));
      select.dataset.key = JSON.stringify([conflict.collection, conflict.key]); label.append(select); row.append(label); target.append(row);
    }
    $('#backup-import').hidden = false;
  } catch (error) { if (sequence === backupSequence) $('#backup-status').textContent = `备份检查失败：${error.message}`; }
});
$('#backup-import').addEventListener('click', async () => {
  if (!backupPreview || backupBusy) return;
  const decisions = {};
  for (const select of $('#backup-preview').querySelectorAll('select')) { if (!select.value) { $('#backup-status').textContent = '请为每一项冲突选择处理方式。'; return; } decisions[select.dataset.key] = select.value; }
  const snapshot = backupPreview; const sequence = backupSequence;
  if (!await confirmAction('确认按所选方式导入索引和草稿？不会修改知识库笔记。') || sequence !== backupSequence) return;
  backupBusy = true; $('#backup-import').disabled = true; $('#backup-file').disabled = true;
  try {
    await call('local_import_apply', { backup: snapshot.backup, token: snapshot.token, decisions, confirmed: true });
    backupPreview = null; $('#backup-import').hidden = true; $('#backup-preview').replaceChildren();
    try { await refresh(); $('#backup-status').textContent = '索引已导入。'; } catch { $('#backup-status').textContent = '索引已导入，但列表刷新失败，请重新打开页面。'; }
  } catch (error) { backupPreview = null; $('#backup-import').hidden = true; $('#backup-status').textContent = `导入未确认成功：${error.message}。请先核对当前数据，再重新选择文件预览。`; }
  finally { backupBusy = false; $('#backup-import').disabled = false; $('#backup-file').disabled = false; }
});
$('#vault-backup-target').addEventListener('input', () => {
  ++vaultBackupSequence; vaultBackupPreview = null;
  $('#vault-backup-create').hidden = true; $('#vault-backup-files').replaceChildren(); $('#vault-backup-status').textContent = '';
});
$('#vault-backup-preview').addEventListener('click', async () => {
  if (vaultBackupBusy) return;
  const target = $('#vault-backup-target').value.trim(); const sequence = ++vaultBackupSequence;
  vaultBackupPreview = null; $('#vault-backup-create').hidden = true; $('#vault-backup-files').replaceChildren();
  if (!target) { $('#vault-backup-status').textContent = '请输入新的备份目录路径。'; return; }
  vaultBackupBusy = true; $('#vault-backup-preview').disabled = true; $('#vault-backup-status').textContent = '正在检查知识库文件…';
  try {
    const result = await call('knowledge_backup_preview', { target });
    if (sequence !== vaultBackupSequence) return;
    if (!result || typeof result.target !== 'string' || typeof result.token !== 'string' || !Array.isArray(result.files) || !Number.isSafeInteger(result.totalBytes) || !result.files.every(item => typeof item.path === 'string')) throw new Error('备份预览格式无效');
    vaultBackupPreview = { target: result.target, input: target, token: result.token, count: result.files.length, totalBytes: result.totalBytes };
    $('#vault-backup-status').textContent = `目标：${result.target}；${result.files.length} 个文件，共 ${result.totalBytes} 字节。`;
    const details = make('details'); details.append(make('summary', '查看文件清单'));
    const list = make('ul'); for (const item of result.files.slice(0, 200)) list.append(make('li', item.path)); details.append(list);
    if (result.files.length > 200) details.append(make('p', '仅显示前 200 个文件，备份范围包括全部文件。', 'muted'));
    $('#vault-backup-files').append(details);
    $('#vault-backup-create').hidden = false;
  } catch (error) { if (sequence === vaultBackupSequence) $('#vault-backup-status').textContent = `预览失败：${error.message}`; }
  finally { vaultBackupBusy = false; $('#vault-backup-preview').disabled = false; }
});
$('#vault-backup-create').addEventListener('click', async () => {
  const preview = vaultBackupPreview; const sequence = vaultBackupSequence;
  if (vaultBackupBusy || !preview || $('#vault-backup-target').value.trim() !== preview.input) return;
  if (!await confirmAction(`确认将 ${preview.count} 个文件（${preview.totalBytes} 字节）备份到：\n${preview.target}\n备份未加密，不会覆盖已有目录。`) || sequence !== vaultBackupSequence) return;
  vaultBackupBusy = true; vaultBackupPreview = null; $('#vault-backup-create').hidden = true; $('#vault-backup-target').disabled = true; $('#vault-backup-preview').disabled = true;
  $('#vault-backup-status').textContent = '正在创建备份，请稍候…';
  try {
    const result = await call('knowledge_backup_create', { target: preview.target, token: preview.token, confirmed: true });
    if (result?.target !== preview.target || !Number.isSafeInteger(result.files)) throw new Error('备份结果格式无效');
    $('#vault-backup-status').textContent = `备份已创建：${result.target}（${result.files} 个文件）。`;
  } catch (error) { $('#vault-backup-status').textContent = `备份未确认成功：${error.message}。请先检查目标目录，再决定是否重新预览。`; }
  finally { vaultBackupBusy = false; $('#vault-backup-target').disabled = false; $('#vault-backup-preview').disabled = false; }
});
for (const selector of ['#vault-restore-source', '#vault-restore-target']) $(selector).addEventListener('input', () => {
  ++vaultRestoreSequence; vaultRestorePreview = null;
  $('#vault-restore-create').hidden = true; $('#vault-restore-files').replaceChildren(); $('#vault-restore-status').textContent = '';
});
$('#vault-restore-preview').addEventListener('click', async () => {
  if (vaultRestoreBusy) return;
  const source = $('#vault-restore-source').value.trim(); const target = $('#vault-restore-target').value.trim(); const sequence = ++vaultRestoreSequence;
  vaultRestorePreview = null; $('#vault-restore-create').hidden = true; $('#vault-restore-files').replaceChildren();
  if (!source || !target) { $('#vault-restore-status').textContent = '请输入备份目录和新恢复目录。'; return; }
  vaultRestoreBusy = true; $('#vault-restore-preview').disabled = true; $('#vault-restore-status').textContent = '正在校验备份…';
  try {
    const result = await call('knowledge_restore_preview', { source, target });
    if (sequence !== vaultRestoreSequence) return;
    if (!result || typeof result.target !== 'string' || typeof result.token !== 'string' || !Array.isArray(result.files) || !Number.isSafeInteger(result.totalBytes) || !result.files.every(item => typeof item.path === 'string')) throw new Error('恢复预览格式无效');
    vaultRestorePreview = { source, input: target, target: result.target, token: result.token, count: result.files.length, totalBytes: result.totalBytes };
    $('#vault-restore-status').textContent = `恢复目标：${result.target}；${result.files.length} 个文件，共 ${result.totalBytes} 字节。`;
    const details = make('details'); details.append(make('summary', '查看文件清单'));
    const list = make('ul'); for (const item of result.files.slice(0, 200)) list.append(make('li', item.path)); details.append(list);
    if (result.files.length > 200) details.append(make('p', '仅显示前 200 个文件，恢复范围包括全部文件。', 'muted'));
    $('#vault-restore-files').append(details); $('#vault-restore-create').hidden = false;
  } catch (error) { if (sequence === vaultRestoreSequence) $('#vault-restore-status').textContent = `校验失败：${error.message}`; }
  finally { vaultRestoreBusy = false; $('#vault-restore-preview').disabled = false; }
});
$('#vault-restore-create').addEventListener('click', async () => {
  const preview = vaultRestorePreview; const sequence = vaultRestoreSequence;
  if (vaultRestoreBusy || !preview || $('#vault-restore-source').value.trim() !== preview.source || $('#vault-restore-target').value.trim() !== preview.input) return;
  if (!await confirmAction(`确认从备份目录：\n${preview.source}\n恢复 ${preview.count} 个文件（${preview.totalBytes} 字节）到新目录：\n${preview.target}\n不会覆盖或切换当前知识库。`) || sequence !== vaultRestoreSequence) return;
  vaultRestoreBusy = true; vaultRestorePreview = null; $('#vault-restore-create').hidden = true;
  $('#vault-restore-source').disabled = true; $('#vault-restore-target').disabled = true; $('#vault-restore-preview').disabled = true;
  $('#vault-restore-status').textContent = '正在恢复，请稍候…';
  try {
    const result = await call('knowledge_restore_create', { source: preview.source, target: preview.target, token: preview.token, confirmed: true });
    if (result?.target !== preview.target || !Number.isSafeInteger(result.files)) throw new Error('恢复结果格式无效');
    $('#vault-restore-status').textContent = `恢复完成：${result.target}（${result.files} 个文件）。当前知识库未切换。`;
  } catch (error) { $('#vault-restore-status').textContent = `恢复未确认成功：${error.message}。目标目录可能包含部分文件，请先检查，再决定是否重新预览。`; }
  finally { vaultRestoreBusy = false; $('#vault-restore-source').disabled = false; $('#vault-restore-target').disabled = false; $('#vault-restore-preview').disabled = false; }
});
async function refresh() { data = await call('local_list'); render(); renderIssueSessions(); await refreshAttempts(); }
async function openLinkedPanel(issue) {
  const sequence = ++linkedSequence;
  const panel = $('#linked-panel'); const target = $('#linked-list');
  $('#linked-issue').textContent = issue.title; target.replaceChildren(make('p', '正在加载关联会话…', 'muted'));
  panel.showModal();
  try {
    const result = await call('local_list');
    if (sequence !== linkedSequence || !panel.open) return;
    data = result;
    issueRows.push({ issue, target }); renderIssueSessions(); issueRows.pop();
    if (!target.children.length) target.append(make('p', '该工作项暂无关联会话。', 'empty'));
  } catch (error) { if (sequence === linkedSequence && panel.open) target.replaceChildren(make('p', `加载关联失败：${error.message}`, 'error')); }
}
async function openNotesPanel(issue) {
  const sequence = ++notesSequence; notesIssue = issue;
  const panel = $('#notes-panel'); const select = $('#notes-select');
  $('#notes-issue').textContent = issue.title; $('#notes-status').textContent = '正在加载笔记和关联…';
  $('#notes-linked').replaceChildren(); select.replaceChildren(new Option('请选择笔记', '')); select.disabled = true; $('#notes-add').disabled = true;
  panel.showModal();
  try {
    const state = await call('local_list');
    if (sequence !== notesSequence || !panel.open) return;
    data = state;
    renderNoteLinks();
    const notes = await call('knowledge_list');
    if (sequence !== notesSequence || !panel.open) return;
    for (const note of notes) select.add(new Option(note, note));
    select.disabled = false;
    $('#notes-status').textContent = notes.length ? '' : '知识库中没有 Markdown 笔记。';
  } catch (error) { if (sequence === notesSequence && panel.open) $('#notes-status').textContent = `加载失败：${error.message}。已有的本地关联不会被删除。`; }
}
function renderNoteLinks() {
  const target = $('#notes-linked'); target.replaceChildren();
  const links = (data.noteLinks || []).filter((link) => ['environment', 'tenantId', 'projectId', 'issueId'].every((key) => String(link.issue[key]) === String(notesIssue[key])));
  if (!links.length) target.append(make('p', '尚未关联知识记录。', 'empty'));
  for (const link of links) {
    const row = make('div', undefined, 'row'); const info = make('div');
    info.append(make('strong', link.title || link.path), make('p', link.provider, 'muted'));
    const actions = make('div', undefined, 'actions');
    if (link.provider === 'markdown') actions.append(action('查看', async () => {
      const sequence = notesSequence;
      try { if (!link.vaultId) throw new Error('关联缺少知识库标识，请核对后重新关联'); const note = await call('knowledge_read_link', { path: link.path, vaultId: link.vaultId }); if (sequence !== notesSequence) return; let pre = info.querySelector('pre'); if (!pre) { pre = make('pre'); info.append(pre); } pre.textContent = note.content; }
      catch (error) { if (sequence === notesSequence) $('#notes-status').textContent = `笔记不可访问：${error.message}。关联已保留。`; }
    }));
    actions.append(action('解除关联', async () => {
      const issue = notesIssue; const sequence = notesSequence;
      if (notesBusy || !await confirmAction('确认解除此关联？不会删除笔记。') || sequence !== notesSequence) return;
      notesBusy = true;
      try { await call('knowledge_unlink_issue', { issue, userId: choerodonContext.identity.userId, provider: link.provider, path: link.path, ...(link.vaultId ? { vaultId: link.vaultId } : {}), confirmed: true }); try { data = await call('local_list'); renderNoteLinks(); $('#notes-status').textContent = '关联已解除。'; } catch { $('#notes-status').textContent = '关联已解除，但列表刷新失败，请重新打开。'; } }
      catch (error) { $('#notes-status').textContent = `解除失败：${error.message}`; } finally { notesBusy = false; }
    }));
    row.append(info, actions); target.append(row);
  }
}
$('#close-notes').addEventListener('click', () => { if (!notesBusy) $('#notes-panel').close(); });
$('#notes-draft').addEventListener('click', async () => {
  if (notesBusy || savingDraft || !notesIssue) return;
  const issue = notesIssue; const sequence = notesSequence; const state = currentDraftState();
  if (draftChanged() && !await confirmAction('当前草稿有未保存的修改，确定放弃并新建？')) return;
  if (savingDraft || sequence !== notesSequence || state !== currentDraftState()) return;
  resetDraft(); setDraftIssues([issue]);
  $('#notes-panel').close(); document.querySelector('[data-view="drafts"]').click();
  $('#draft-form').elements.title.value = issue.title || '';
  $('#draft-form').elements.content.focus();
});
$('#notes-panel').addEventListener('close', () => { ++notesSequence; notesIssue = null; });
$('#notes-panel').addEventListener('cancel', (event) => { if (notesBusy) event.preventDefault(); });
$('#notes-select').addEventListener('change', () => { $('#notes-add').disabled = !$('#notes-select').value; });
$('#notes-add').addEventListener('click', async () => {
  if (notesBusy || !notesIssue || !$('#notes-select').value) return;
  const notePath = $('#notes-select').value; const issue = notesIssue; const sequence = notesSequence;
  if (!await confirmAction(`确认关联笔记“${notePath}”？不会修改笔记。`) || sequence !== notesSequence) return;
  notesBusy = true; $('#notes-add').disabled = true;
  try { await call('knowledge_link_issue', { issue, userId: choerodonContext.identity.userId, path: notePath, confirmed: true }); try { data = await call('local_list'); renderNoteLinks(); $('#notes-status').textContent = '关联已保存。'; } catch { $('#notes-status').textContent = '关联已保存，但列表刷新失败，请重新打开。'; } }
  catch (error) { $('#notes-status').textContent = `关联失败：${error.message}`; }
  finally { notesBusy = false; $('#notes-add').disabled = !$('#notes-select').value; }
});
async function requestOpenSession(sessionId) {
  let timeout;
  try {
    const result = await Promise.race([
      app.openLink({ url: `codex://threads/${encodeURIComponent(sessionId)}` }),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('跳转超时')), 5000); }),
    ]);
    if (result?.isError) throw new Error('宿主拒绝打开');
  } finally { clearTimeout(timeout); }
}
async function openCreatedSession(sessionId, sequence = sessionSequence) {
  try {
    await requestOpenSession(sessionId); return true;
  } catch {
    if (sequence === sessionSequence && $('#session-panel').open) $('#session-status').append(make('p', `无法打开会话，请在 Codex 中搜索会话 ID：${sessionId}`, 'error'));
    return false;
  }
}
$('#close-linked').addEventListener('click', () => $('#linked-panel').close());
$('#linked-panel').addEventListener('close', () => { ++linkedSequence; if ($('#generate-dialog').open) $('#generate-dialog').close(); $('#linked-list').replaceChildren(); });
$('#generate-cancel').addEventListener('click', () => $('#generate-dialog').close());
$('#generate-dialog').addEventListener('close', () => { ++generationSequence; generation = null; $('#generate-confirm').disabled = false; });
$('#draft-form').addEventListener('input', () => { ++draftMutation; });
function setDraftPreview(preview) {
  const edit = $('#draft-content-edit');
  const rendered = $('#draft-content-preview');
  edit.hidden = preview;
  rendered.hidden = !preview;
  $('#draft-edit-tab').setAttribute('aria-selected', String(!preview));
  $('#draft-preview-tab').setAttribute('aria-selected', String(preview));
  if (preview) rendered.innerHTML = draftMarkdown.render($('#draft-form').elements.content.value);
}
$('#draft-edit-tab').addEventListener('click', () => setDraftPreview(false));
$('#draft-preview-tab').addEventListener('click', () => setDraftPreview(true));
$('#draft-form').elements.content.addEventListener('invalid', () => setDraftPreview(false));
let targetBrowseSequence = 0;
let targetDirectory = null;
let targetNameAutomatic = true;
const targetInput = $('#draft-form').elements.target;
targetInput.readOnly = true;
targetInput.placeholder = '选择目录新建文档，或选择已有文档';
targetInput.parentElement.firstChild.textContent = '目标位置';
const targetControls = make('div', undefined, 'target-controls');
const targetActions = make('div', undefined, 'actions');
const targetFilenameLabel = make('label', '文件名');
const targetFilename = make('input'); targetFilename.id = 'target-filename'; targetFilename.maxLength = 200;
targetFilenameLabel.append(targetFilename); targetFilenameLabel.hidden = true;
const targetBrowser = make('div'); targetBrowser.id = 'target-browser'; targetBrowser.hidden = true;
const targetBrowserActions = make('div', undefined, 'actions');
const targetBrowserPath = make('p', undefined, 'muted'); targetBrowserPath.id = 'target-browser-path';
const targetBrowserStatus = make('p', undefined, 'muted'); targetBrowserStatus.id = 'target-browser-status'; targetBrowserStatus.setAttribute('role', 'status');
const targetBrowserList = make('div'); targetBrowserList.id = 'target-browser-list';
targetBrowser.append(targetBrowserActions, targetBrowserPath, targetBrowserList, targetBrowserStatus);
targetActions.append(action('选择目录新建文档', () => { void browseTarget('directory'); }), action('选择已有文档', () => { void browseTarget('note'); }), action('清除位置', () => { if (!savingDraft) { targetInput.value = ''; ++draftMutation; resetTargetPicker(); } }));
targetControls.append(targetActions, targetFilenameLabel, targetBrowser);
targetInput.parentElement.after(targetControls);
function filenameFromTitle() {
  const title = $('#draft-form').elements.title.value.trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/^\.+|[. ]+$/g, '').slice(0, 170);
  return `${(title || '未命名文档').replace(/\.md$/i, '')}.md`;
}
function updateTargetFromFilename() {
  const value = targetFilename.value.trim();
  const valid = Boolean(value && value !== '.' && value !== '..' && !value.startsWith('.') && !/[\\/:*?"<>|\u0000-\u001f]/.test(value));
  targetFilename.setCustomValidity(valid ? '' : '请输入文件名，不要包含目录或特殊字符。');
  targetInput.value = valid ? `${targetDirectory ? `${targetDirectory}/` : ''}${/\.md$/i.test(value) ? value : `${value}.md`}` : '';
  ++draftMutation;
}
targetFilename.addEventListener('input', () => { targetNameAutomatic = false; updateTargetFromFilename(); });
$('#draft-form').elements.title.addEventListener('input', () => {
  if (targetDirectory !== null && targetNameAutomatic) { targetFilename.value = filenameFromTitle(); updateTargetFromFilename(); }
});
function resetTargetPicker() {
  ++targetBrowseSequence; targetDirectory = null; targetNameAutomatic = true;
  targetFilename.value = ''; targetFilename.setCustomValidity(''); targetFilenameLabel.hidden = true;
  targetBrowser.hidden = true; targetBrowserList.replaceChildren(); targetBrowserStatus.textContent = '';
}
function selectTarget(kind, path) {
  if (savingDraft) return;
  resetTargetPicker();
  if (kind === 'directory') {
    targetDirectory = path; targetFilenameLabel.hidden = false;
    targetFilename.value = filenameFromTitle(); updateTargetFromFilename(); targetFilename.focus();
  } else { targetInput.value = path; ++draftMutation; }
}
async function browseTarget(mode, directory = '', cursor) {
  if (savingDraft) return;
  const sequence = ++targetBrowseSequence;
  targetBrowser.hidden = false;
  targetBrowserPath.textContent = '知识库目录';
  targetBrowserActions.replaceChildren();
  if (mode === 'directory') targetBrowserActions.append(action('选择根目录', () => selectTarget('directory', '')));
  targetBrowserActions.append(action('收起', () => { ++targetBrowseSequence; targetBrowser.hidden = true; }));
  targetBrowserList.replaceChildren();
  targetBrowserStatus.textContent = '正在加载目录树…';
  let count = 0;
  let incomplete = false;
  const limit = 1000;
  const queue = [{ path: '', depth: 0, container: targetBrowserList }];
  try {
    while (queue.length && count < limit) {
      const current = queue.shift();
      let nextCursor;
      do {
        const result = await callReadWithTimeout('knowledge_browse', { directory: current.path, ...(nextCursor ? { cursor: nextCursor } : {}) });
        if (sequence !== targetBrowseSequence || targetBrowser.hidden) return;
        if (result?.directory !== current.path || !Array.isArray(result.items)) throw new Error('目录结果格式无效');
        for (const item of result.items) {
          if (typeof item?.name !== 'string' || typeof item.path !== 'string' || !['directory', 'note'].includes(item.kind)) continue;
          if (++count > limit) { incomplete = true; break; }
          if (item.kind === 'note' && mode === 'directory') continue;
          const row = make('div', undefined, 'target-browser-row');
          const choose = action(item.name, () => selectTarget(item.kind, item.path));
          choose.setAttribute('aria-label', `${item.kind === 'directory' ? '选择目录' : '选择文档'}：${item.path}`);
          row.append(choose, make('small', item.kind === 'directory' ? '目录' : '文档'));
          current.container.append(row);
          if (item.kind === 'directory') {
            const children = make('div', undefined, 'target-browser-children');
            current.container.append(children);
            if (current.depth < 12) queue.push({ path: item.path, depth: current.depth + 1, container: children });
            else incomplete = true;
          }
        }
        nextCursor = result.nextCursor;
      } while (nextCursor && count < limit);
      if (nextCursor) incomplete = true;
    }
    if (queue.length) incomplete = true;
    targetBrowserStatus.textContent = incomplete ? '目录数量或层级超过显示上限，结果不完整。' : count ? '' : '知识库中没有可选项。';
  } catch (error) {
    if (sequence === targetBrowseSequence) {
      targetBrowserStatus.textContent = `目录加载失败，显示的结果可能不完整：${error.message}`;
      targetBrowserActions.append(action('重试', () => { void browseTarget(mode); }));
    }
  }
}
$('#recommend-locations').addEventListener('click', () => { void recommendLocations(); });
async function recommendLocations() {
  const form = $('#draft-form');
  const title = form.elements.title.value.trim().slice(0, 200);
  const keywords = $('#location-keywords').value.trim().split(/\s+/).filter(Boolean).slice(0, 10).map((word) => word.slice(0, 100));
  const snapshot = currentDraftState();
  const keywordSnapshot = $('#location-keywords').value;
  const sequence = ++locationSequence;
  const results = $('#location-results');
  results.replaceChildren();
  if (!title && !keywords.length) { $('#location-status').textContent = '请先填写标题或推荐关键词。'; return; }
  const project = choerodonContext?.projects?.items?.find((item) => item.id === draftIssue?.projectId)?.name?.slice(0, 200) || '';
  const args = { title, project, keywords };
  async function load(cursor) {
    $('#recommend-locations').disabled = true;
    $('#location-status').textContent = '正在检查知识库路径…';
    try {
      const result = await callReadWithTimeout('knowledge_recommend_locations', { ...args, ...(cursor ? { cursor } : {}) });
      if (sequence !== locationSequence || snapshot !== currentDraftState() || keywordSnapshot !== $('#location-keywords').value) return;
      if (!Array.isArray(result?.candidates)) throw new Error('推荐结果格式无效');
      for (const candidate of result.candidates) {
        if (typeof candidate?.path !== 'string' || !['note', 'directory'].includes(candidate.kind) || !Array.isArray(candidate.reasons)) continue;
        const row = make('div');
        row.append(make('span', `${candidate.kind === 'note' ? '笔记' : '目录'}：${candidate.path}（路径匹配：${candidate.reasons.map((reason) => reason.value).join('、')}）`));
        row.append(action('选择', () => {
          if (snapshot !== currentDraftState() || keywordSnapshot !== $('#location-keywords').value) { $('#location-status').textContent = '草稿已变化，请重新推荐。'; return; }
          selectTarget(candidate.kind, candidate.path);
          ++locationSequence;
          results.replaceChildren();
          $('#location-status').textContent = candidate.kind === 'directory' ? '已选择目录，文件名已根据标题生成，可继续修改。' : '已选择笔记，请在写入前核对。';
        }));
        results.append(row);
      }
      $('#location-status').textContent = `${results.children.length ? '请选择候选位置；结果按批次排序。' : '本批没有匹配位置。'}${result.truncated ? '扫描已达到上限，结果不完整。' : ''}${result.skipped ? ` 有 ${result.skipped} 处无法扫描。` : ''}`;
      if (result.nextCursor) {
        const more = action('继续查找', () => { more.remove(); void load(result.nextCursor); });
        results.append(more);
      }
    } catch (error) {
      if (sequence === locationSequence) $('#location-status').textContent = `推荐失败：${error.message}。请重新点击推荐位置。`;
    } finally { $('#recommend-locations').disabled = false; }
  }
  await load();
}
$('#cleanup-refresh').addEventListener('click', () => { void refreshUpdateCleanups(); });
$('#pending-links-refresh').addEventListener('click', () => { void refreshPendingLinks(); });
$('#reservations-refresh').addEventListener('click', () => { void refreshReservations(); });
let catalogReservationsBusy = false;
let catalogReservationsSequence = 0;
const catalogUncertain = new Set();
$('#catalog-reservations-refresh').addEventListener('click', () => { void refreshCatalogReservations(); });
async function refreshCatalogReservations() {
  if (catalogReservationsBusy) return;
  const sequence = ++catalogReservationsSequence;
  const list = $('#catalog-reservations-list');
  const status = $('#catalog-reservations-status');
  const refresh = $('#catalog-reservations-refresh');
  catalogReservationsBusy = true; refresh.disabled = true;
  list.replaceChildren();
  status.textContent = '正在加载目录预留…';
  try {
    const items = await callReadWithTimeout('knowledge_catalog_reservations', {});
    if (!Array.isArray(items)) throw new Error('目录预留格式无效');
    list.replaceChildren();
    for (const item of items) {
      if (typeof item?.operationId !== 'string' || typeof item.generation !== 'string' || typeof item.path !== 'string') continue;
      const row = make('div', undefined, 'row'); const details = make('div');
      const kind = { draft: '草稿发布', direct: '直接新建', legacy: '旧版记录' }[item.kind] || '未知类型';
      const labels = { not_started: '尚未开始写入', not_written: '确认未写入', completed: '已完成，等待恢复目录', unknown: '写入结果不确定，请人工检查', legacy: '旧版记录，请人工检查' };
      details.append(make('strong', item.title || item.path), make('p', `${item.path} · ${kind} · ${labels[item.status] || '状态未知，请人工检查'}`, 'muted'));
      row.append(details);
      const args = { operationId: item.operationId, generation: item.generation };
      if (['draft', 'direct'].includes(item.kind) && ['not_started', 'not_written'].includes(item.status)) {
        const button = action('释放预留', async () => {
          if (catalogReservationsBusy || sequence !== catalogReservationsSequence) return;
          if (!await confirmAction(`确认释放“${item.path}”的目录预留？此操作不会写入笔记。`)) return;
          if (catalogReservationsBusy || sequence !== catalogReservationsSequence) return;
          catalogReservationsBusy = true; refresh.disabled = true; button.disabled = true;
          try {
            await callReadWithTimeout('knowledge_catalog_release', { ...args, confirmed: true });
            catalogReservationsBusy = false; await refreshCatalogReservations();
          } catch (error) { status.textContent = `释放结果未确认：${error.message}。请刷新核查，不要自动重试。`; }
          finally { catalogReservationsBusy = false; refresh.disabled = false; }
        });
        row.append(button);
      }
      if (['draft', 'direct'].includes(item.kind) && item.status === 'unknown') {
        const key = JSON.stringify([item.operationId, item.generation]);
        const actions = make('div', undefined, 'actions'); let uncertain = catalogUncertain.has(key);
        async function queryStatus() {
          if (catalogReservationsBusy || sequence !== catalogReservationsSequence) return;
          catalogReservationsBusy = true; refresh.disabled = true; check.disabled = true;
          try {
            const result = await callReadWithTimeout('knowledge_catalog_resolution', args);
            if (result?.status === 'resolved' && ['link', 'discard'].includes(result.decision)) {
              status.textContent = `历史处置：${result.decision === 'link' ? '选择关联' : '放弃关联'}。写入来源仍无法确定，历史选择不代表当前关联仍存在。`;
              catalogUncertain.delete(key);
              actions.replaceChildren();
            } else if (result?.status === 'pending') {
              uncertain = false; catalogUncertain.delete(key); check.hidden = true; status.textContent = '预留仍待处理，请人工核查后决定。';
            } else throw new Error('处置状态格式无效');
          } catch (error) { status.textContent = `无法确认处置状态：${error.message}。请重新查询，不要重复操作。`; }
          finally { catalogReservationsBusy = false; refresh.disabled = false; check.disabled = false; for (const control of actions.children) if (control !== check) control.disabled = uncertain; }
        }
        const check = action('查询处置状态', queryStatus);
        check.hidden = !uncertain;
        for (const [decision, label] of [['link', '核查后关联'], ['discard', '核查后放弃关联']]) {
          const button = action(label, async () => {
            if (catalogReservationsBusy || sequence !== catalogReservationsSequence) return;
            if (!await confirmAction(`请先人工检查“${item.path}”。原写入来源无法确定，关联仅校验当前内容，不能证明来源。确认接受风险并${label}？此操作不会重写笔记。`)) return;
            if (catalogReservationsBusy || sequence !== catalogReservationsSequence) return;
            catalogReservationsBusy = true; refresh.disabled = true; for (const control of actions.children) control.disabled = true;
            try {
              await callReadWithTimeout('knowledge_catalog_resolve', { ...args, decision, acceptUncertain: true, confirmed: true });
              catalogReservationsBusy = false; await refreshCatalogReservations();
              status.textContent += ' 处置已记录，写入来源仍无法确定，历史选择不代表当前关联仍存在。';
            } catch (error) {
              uncertain = true; catalogUncertain.add(key); check.hidden = false; status.textContent = `处置结果未确认：${error.message}。正在查询状态。`;
              catalogReservationsBusy = false; await queryStatus();
            } finally { catalogReservationsBusy = false; refresh.disabled = false; for (const control of actions.children) if (control !== check) control.disabled = uncertain; }
          });
          button.disabled = uncertain; actions.append(button);
        }
        actions.append(check); row.append(actions);
      }
      list.append(row);
    }
    status.textContent = items.length ? `共 ${items.length} 条目录预留。` : '当前知识库没有目录预留。';
  } catch (error) { status.textContent = `加载失败：${error.message}。请重试。`; }
  finally { catalogReservationsBusy = false; refresh.disabled = false; }
}
function finishReservationActivity() {
  reservationsBusy = false;
  $('#reservations-refresh').disabled = false;
  // 让当前操作先完成，再读取操作后的预留列表。
  if (reservationsRefreshQueued) setTimeout(() => {
    if (reservationsRefreshQueued && !reservationsBusy) void refreshReservations();
  }, 0);
}
async function refreshReservations() {
  if (reservationsBusy) {
    reservationsRefreshQueued = true;
    return;
  }
  reservationsRefreshQueued = false;
  const context = choerodonContext; const sequence = ++reservationsSequence;
  const list = $('#reservations-list');
  if (!context?.identity?.userId) return;
  const section = $('#reservations-section');
  const errorStatus = $('#reservations-load-error');
  errorStatus.hidden = true;
  reservationsBusy = true; $('#reservations-refresh').disabled = true;
  $('#reservations-status').textContent = '正在加载发布预留…';
  try {
    const items = await callReadWithTimeout('draft_publication_reservations', { userId: context.identity.userId });
    if (sequence !== reservationsSequence || context !== choerodonContext) return;
    if (!Array.isArray(items) || items.some((item) => typeof item?.id !== 'string' || typeof item.generation !== 'string' || typeof item.target !== 'string')) throw new Error('发布预留格式无效');
    list.replaceChildren();
    for (const item of items) {
      const row = make('div', undefined, 'row'); const details = make('div');
      const releasable = ['not_started', 'not_written'].includes(item.status);
      const status = item.status === 'not_started' ? '尚未开始写入' : item.status === 'not_written' ? '确认未写入' : item.status === 'completed' ? '已完成记录，等待恢复关联' : '写入结果不确定，请人工核查目标笔记';
      details.append(make('strong', item.target), make('p', `草稿 ${item.draftId}，版本 ${item.revision} · ${status}`, 'muted'));
      row.append(details);
      if (releasable) {
        const button = action('释放预留', async () => {
          if (reservationsBusy || sequence !== reservationsSequence || context !== choerodonContext) return;
          if (!await confirmAction(`确认释放“${item.target}”的发布预留？该操作不会写入笔记。`)) return;
          if (reservationsBusy || sequence !== reservationsSequence || context !== choerodonContext) return;
          reservationsBusy = true; button.disabled = true; $('#reservations-refresh').disabled = true;
          $('#reservations-status').textContent = '正在释放发布预留…';
          try {
            await call('draft_publication_reservation_resolve', { id: item.id, generation: item.generation, userId: context.identity.userId, confirmed: true });
            if (sequence !== reservationsSequence || context !== choerodonContext) return;
            reservationsBusy = false; await refreshReservations();
          } catch (error) {
            if (sequence === reservationsSequence && context === choerodonContext) $('#reservations-status').textContent = `释放失败：${error.message}。请核对后重试或刷新列表。`;
          } finally { button.disabled = false; finishReservationActivity(); }
        });
        row.append(button);
      }
      if (item.status === 'unknown') {
        const actions = make('div', undefined, 'actions');
        const key = `${item.id}:${item.generation}`;
        let outcomeUncertain = uncertainReservationActions.has(key);
        async function queryStatus() {
          if (reservationsBusy || sequence !== reservationsSequence || context !== choerodonContext) return;
          reservationsBusy = true; $('#reservations-refresh').disabled = true; checkStatus.disabled = true;
          $('#reservations-status').textContent = '正在查询处置状态…';
          try {
            const result = await callReadWithTimeout('draft_publication_reservation_status', { id: item.id, generation: item.generation, userId: context.identity.userId });
            if (sequence !== reservationsSequence || context !== choerodonContext) return;
            if (result?.status === 'resolved' && ['link', 'discard'].includes(result.decision)) {
              uncertainReservationActions.delete(key);
              message(`历史处置：${result.decision === 'link' ? '选择关联' : '放弃关联'}。写入来源仍无法确定，当前关联以实际记录为准。`);
              list.replaceChildren(...Array.from(list.children).filter((child) => child !== row));
              section.hidden = list.children.length === 0;
              $('#reservations-status').textContent = list.children.length ? `共 ${list.children.length} 条发布预留。` : '';
            } else if (result?.status === 'pending') {
              uncertainReservationActions.delete(key);
              outcomeUncertain = false; checkStatus.hidden = true;
              $('#reservations-status').textContent = '预留仍待处理。请人工核查后决定是否重新操作。';
            } else throw new Error('处置状态格式无效');
          } catch (error) {
            if (sequence === reservationsSequence && context === choerodonContext) $('#reservations-status').textContent = `无法确认处置状态：${error.message}。请重新查询，不要重复操作。`;
          } finally {
            finishReservationActivity();
            checkStatus.disabled = false;
            for (const control of actions.children) if (control !== checkStatus) control.disabled = outcomeUncertain;
          }
        }
        const checkStatus = action('查询处置状态', queryStatus);
        checkStatus.hidden = !outcomeUncertain;
        for (const [decision, label] of [['link', '核查后关联'], ['discard', '核查后放弃关联']]) {
          const button = action(label, async () => {
            if (outcomeUncertain || reservationsBusy || sequence !== reservationsSequence || context !== choerodonContext) return;
            const operation = decision === 'link' ? '核对当前笔记内容并保存关联' : '放弃本次关联';
            if (!await confirmAction(`请先人工检查“${item.target}”。原写入来源无法确定；关联仅校验当前内容，不能证明来源。确认接受这一风险并${operation}？此操作不会重写笔记。`)) return;
            if (outcomeUncertain || reservationsBusy || sequence !== reservationsSequence || context !== choerodonContext) return;
            reservationsBusy = true; $('#reservations-refresh').disabled = true;
            for (const control of actions.children) control.disabled = true;
            $('#reservations-status').textContent = '正在处理结果不确定的预留…';
            try {
              await call('draft_publication_reservation_uncertain', { id: item.id, generation: item.generation, userId: context.identity.userId, decision, acceptUncertain: true, confirmed: true });
              if (sequence !== reservationsSequence || context !== choerodonContext) return;
              reservationsBusy = false; await refreshReservations();
              if (context === choerodonContext) message('处置已记录，写入来源仍无法确定，当前关联以实际记录为准。');
            } catch (error) {
              uncertainReservationActions.add(key);
              if (sequence === reservationsSequence && context === choerodonContext) {
                outcomeUncertain = true; checkStatus.hidden = false;
                $('#reservations-status').textContent = `处置结果未确认：${error.message}。正在查询状态。`;
                reservationsBusy = false; await queryStatus();
              }
            } finally {
              for (const control of actions.children) if (control !== checkStatus) control.disabled = outcomeUncertain;
              finishReservationActivity();
            }
          });
          button.disabled = outcomeUncertain;
          actions.append(button);
        }
        actions.append(checkStatus);
        row.append(actions);
      }
      list.append(row);
    }
    section.hidden = items.length === 0;
    $('#reservations-status').textContent = items.length ? `共 ${items.length} 条发布预留。` : '';
  } catch (error) {
    if (sequence === reservationsSequence && context === choerodonContext) {
      section.hidden = true;
      list.replaceChildren();
      errorStatus.textContent = `无法检查发布预留：${error.message}。请重新打开知识草稿页重试。`;
      errorStatus.hidden = false;
    }
  } finally { finishReservationActivity(); }
}
async function refreshPendingLinks() {
  if (pendingLinksBusy) return;
  const context = choerodonContext;
  const sequence = ++pendingLinksSequence;
  const list = $('#pending-links-list');
  if (!context?.identity?.userId) { list.replaceChildren(); $('#pending-links-status').textContent = '请先加载当前猪齿鱼账号。'; return; }
  pendingLinksBusy = true; $('#pending-links-refresh').disabled = true;
  $('#pending-links-status').textContent = '正在加载待关联笔记…';
  try {
    const result = await callReadWithTimeout('pending_note_links', { userId: context.identity.userId });
    if (sequence !== pendingLinksSequence || context !== choerodonContext) return;
    if (!Array.isArray(result?.items) || !Array.isArray(result?.warnings)) throw new Error('待关联记录格式无效');
    list.replaceChildren();
    for (const item of result.items) {
      if (typeof item?.id !== 'string' || typeof item.target !== 'string' || !item.issue) continue;
      const row = make('div', undefined, 'row'); const details = make('div');
      details.append(make('strong', item.target), make('p', `工作项：${item.issue.title || item.issue.issueId}（项目 ${item.issue.projectId}，ID ${item.issue.issueId}）`, 'muted'));
      const button = action('补充关联', async () => {
        if (pendingLinksBusy || sequence !== pendingLinksSequence || context !== choerodonContext) return;
        if (!await confirmAction(`确认将笔记“${item.target}”关联到工作项“${item.issue.title || item.issue.issueId}”（项目 ${item.issue.projectId}，ID ${item.issue.issueId}）？仅保存关联，不会重写笔记。`)) return;
        if (sequence !== pendingLinksSequence || context !== choerodonContext) return;
        pendingLinksBusy = true; button.disabled = true; $('#pending-links-refresh').disabled = true;
        $('#pending-links-status').textContent = '正在核对笔记并保存关联…';
        try {
          await call('pending_note_link', { id: item.id, userId: context.identity.userId, confirmed: true });
          if (sequence !== pendingLinksSequence || context !== choerodonContext) return;
          pendingLinksBusy = false; await refreshPendingLinks();
        } catch (error) {
          if (sequence === pendingLinksSequence && context === choerodonContext) $('#pending-links-status').textContent = `关联失败：${error.message}。请核对后重试或刷新列表。`;
        } finally { pendingLinksBusy = false; button.disabled = false; $('#pending-links-refresh').disabled = false; }
      });
      row.append(details, button); list.append(row);
    }
    $('#pending-links-status').textContent = `${result.items.length ? `共 ${result.items.length} 条待关联记录。` : '当前账号和知识库没有待关联记录。'}${result.warnings.length ? `另有 ${result.warnings.length} 条发布记录无法自动恢复，请检查发布记录。` : ''}`;
  } catch (error) { if (sequence === pendingLinksSequence && context === choerodonContext) $('#pending-links-status').textContent = `加载失败：${error.message}。请重试。`; }
  finally { pendingLinksBusy = false; $('#pending-links-refresh').disabled = false; }
}
function originalOffset(text, normalizedOffset) {
  let raw = 0; let normalized = 0;
  while (raw < text.length && normalized < normalizedOffset) {
    if (text[raw] === '\r' && text[raw + 1] === '\n') raw++;
    raw++; normalized++;
  }
  return raw;
}
async function refreshUpdateCleanups() {
  const list = $('#cleanup-list');
  const refreshButton = $('#cleanup-refresh');
  const sequence = ++cleanupSequence;
  refreshButton.disabled = true;
  const section = $('#cleanup-section');
  const errorStatus = $('#cleanup-load-error');
  errorStatus.hidden = true;
  $('#cleanup-status').textContent = '正在检查待清理记录…';
  try {
    const records = await callReadWithTimeout('draft_note_update_cleanups', {});
    if (sequence !== cleanupSequence) return;
    if (!Array.isArray(records) || records.some((record) => typeof record?.lockId !== 'string' || typeof record.target !== 'string')) throw new Error('清理记录格式无效');
    list.replaceChildren();
    for (const record of records) {
      const row = make('div', undefined, 'row');
      const details = make('div'); details.append(make('strong', record.target), make('p', `草稿 ${record.draftId}，版本 ${record.revision}`));
      const button = action('清理锁', async () => {
        if (!await confirmAction(`确认清理“${record.target}”的本地更新锁？不会修改笔记。`)) return;
        if (sequence !== cleanupSequence || refreshButton.disabled || button.disabled) return;
        button.disabled = true;
        try { await call('draft_note_update_cleanup', { lockId: record.lockId, confirmed: true }); await refreshUpdateCleanups(); }
        catch (error) {
          if (sequence === cleanupSequence) $('#cleanup-status').textContent = `清理失败：${error.message}。记录已保留。`;
        } finally { button.disabled = false; }
      });
      row.append(details, button);
      list.append(row);
    }
    section.hidden = records.length === 0;
    $('#cleanup-status').textContent = records.length ? '仅清理可以核实归属的锁。' : '';
  } catch (error) {
    if (sequence !== cleanupSequence) return;
    section.hidden = true;
    list.replaceChildren();
    errorStatus.textContent = `无法检查更新锁：${error.message}。请重新打开知识草稿页重试。`;
    errorStatus.hidden = false;
  } finally { if (sequence === cleanupSequence) refreshButton.disabled = false; }
}
function generationValid(snapshot) {
  return !savingDraft && generation === snapshot && snapshot.sequence === generationSequence && snapshot.linkedSequence === linkedSequence && snapshot.contextSequence === contextSequence && snapshot.draftMutation === draftMutation && snapshot.draftState === currentDraftState() && (snapshot.mode === 'editor' || $('#linked-panel').open);
}
function currentDraftState() { const form = $('#draft-form'); return JSON.stringify([editing?.id, editing?.revision, draftIssues, draftSession, form.elements.title.value, form.elements.target.value, form.elements.content.value]); }
async function prepareGeneration({ issue, session, mode, status, button }) {
  if (savingDraft || button.disabled) return;
  const state = currentDraftState(); const currentLinked = linkedSequence; const currentContext = contextSequence; const currentMutation = draftMutation;
  const valid = () => !savingDraft && currentLinked === linkedSequence && currentContext === contextSequence && currentMutation === draftMutation && state === currentDraftState();
  if (!choerodonContext?.identity?.userId) { status.textContent = '账号未就绪，请刷新后重试。'; return; }
  if (mode === 'editor' && $('#draft-form').elements.content.value && !await confirmAction('生成成功后将替换当前内容，是否继续？')) return;
  if (!valid()) return;
  const buttonLabel = button.textContent;
  status.className = 'generation-status';
  status.setAttribute('data-state', 'loading');
  status.setAttribute('aria-live', 'polite');
  button.disabled = true; button.textContent = '正在生成…';
  status.textContent = mode === 'editor' ? '正在总结会话，完成后将更新草稿内容。' : '正在总结会话，完成后将打开草稿编辑器。';
  try {
    const snapshot = generation = { sequence: ++generationSequence, linkedSequence: currentLinked, contextSequence: currentContext, draftMutation: currentMutation, draftState: state, issue, session, mode };
    const result = await call('codex_session_summary', { issue, userId: choerodonContext.identity.userId, sessionId: session.id, confirmed: true });
    if (!generationValid(snapshot)) return;
    if (typeof result?.text !== 'string' || !result.text.trim() || result.text.length > 100000) throw new Error('模型没有返回有效文本');
    const output = result.text;
    if (snapshot.mode !== 'editor') {
      $('#linked-panel').close(); resetDraft(); setDraftIssues([snapshot.issue]); draftSession = snapshot.session;
      renderDraftIssues(); document.querySelector('[data-view="drafts"]').click();
      $('#draft-form').elements.title.value = snapshot.issue.title || '';
    }
    $('#draft-form').elements.content.value = output;
    setDraftPreview(false);
    ++draftMutation;
    status.textContent = '';
    message('候选基于原会话可读取的最近已完成上下文生成，可能不含进行中回合；请核对并编辑后再保存。');
  } catch (error) {
    if (valid()) {
      status.setAttribute('data-state', 'error');
      status.textContent = `未能生成草稿：${error.message}。可点击上方按钮重试，当前内容已保留。`;
    }
  } finally {
    button.disabled = false; button.textContent = buttonLabel;
    if (status.getAttribute('data-state') === 'loading') { status.textContent = ''; status.setAttribute('data-state', 'idle'); }
  }
}
function renderIssueSessions() {
  for (const { issue, target } of issueRows) {
    target.replaceChildren();
    const links = data.links.filter((link) => ['environment', 'tenantId', 'projectId', 'issueId'].every((key) => String(link.issue[key]) === String(issue[key])));
    if (!links.length) return;
    target.append(make('p', `已关联 ${links.length} 个会话`, 'session-count'));
    for (const link of links) {
      const item = make('article', undefined, 'linked-session');
      const info = make('div', undefined, 'linked-session-info');
      info.append(make('strong', link.sessionTitle || link.sessionId, 'session-title'), make('span', `会话 ID：${link.sessionId}`, 'session-id'));
      if (link.linkedAt) info.append(make('p', `关联时间：${link.linkedAt}`, 'muted'));
      if (link.summary) info.append(make('p', `本地索引摘要（非会话原文）：${link.summary}`, 'muted'));
      const status = make('p', '', 'error'); status.setAttribute('role', 'status');
      const metadata = make('p', '', 'muted'); metadata.setAttribute('role', 'status');
      const check = action('检查会话', async () => {
        if (check.disabled) return;
        check.disabled = true; metadata.textContent = '正在检查会话…';
        try {
          const result = await call('codex_linked_session_info', { issue, userId: choerodonContext.identity.userId, sessionId: link.sessionId });
          if (result?.id !== link.sessionId) throw new Error('返回的会话标识不匹配');
          const date = Number.isFinite(result.updatedAt) ? new Date(result.updatedAt * 1000) : null;
          const updated = date && Number.isFinite(date.getTime()) ? date.toLocaleString() : '未提供';
          metadata.textContent = `当前标题：${result.title || '未提供'} · 最近更新：${updated} · 状态：${result.status || '未提供'}`;
        } catch (error) { metadata.textContent = `无法核实会话：${error.message}。关联已保留。`; }
        finally { check.disabled = false; }
      });
      const open = action('打开会话', async () => {
        if (open.disabled) return;
        open.disabled = true; status.textContent = '';
        try {
          await requestOpenSession(link.sessionId);
        } catch {
          status.textContent = `无法确认打开会话，请在 Codex 中按标题或 ID 查找：${link.sessionId}`;
        } finally { open.disabled = false; }
      });
      const generateDraft = action('总结会话生成草稿', async () => {
        if (savingDraft) return;
        const initialState = currentDraftState();
        if (draftChanged() && !await confirmAction('当前草稿有未保存的修改，生成成功后将替换表单内容，是否继续？')) return;
        if (savingDraft || initialState !== currentDraftState() || !$('#linked-panel').open) return;
        await prepareGeneration({ issue, session: { id: link.sessionId, title: link.sessionTitle || '' }, mode: 'linked', status, button: generateDraft });
      });
      const unlink = action('解除关联', async () => {
        if (unlink.disabled) return;
        const sequence = linkedSequence;
        if (!await confirmAction(link.primary ? '这是该会话的主工作项，确定解除关联？会话本身不会删除。' : '确定解除关联？会话本身不会删除。')) return;
        if (sequence !== linkedSequence || !$('#linked-panel').open) return;
        unlink.disabled = true;
        try {
          await call('local_remove_link', { issue: link.issue, sessionId: link.sessionId, confirmed: true, confirmPrimaryRemoval: Boolean(link.primary) });
          await refresh();
          if (sequence === linkedSequence && $('#linked-panel').open) {
            issueRows.push({ issue, target });
            try { renderIssueSessions(); } finally { issueRows.pop(); }
            if (!target.children.length) target.append(make('p', '该工作项暂无关联会话。', 'empty'));
          }
        } catch (error) { if (sequence === linkedSequence) status.textContent = `解除关联或刷新失败：${error.message}，请重新打开核对。`; }
        finally { unlink.disabled = false; }
      });
      open.title = '尝试在 Codex 中打开会话；是否支持取决于宿主';
      const actions = make('div', undefined, 'actions linked-session-actions');
      actions.append(open, check, generateDraft, unlink);
      item.append(info, actions, metadata, status); target.append(item);
    }
  }
}
async function refreshAttempts() {
  const sequence = ++attemptListSequence;
  const target = $('#creation-attempts'); target.replaceChildren();
  try {
    const attempts = await call('codex_creation_attempts');
    if (sequence !== attemptListSequence) return;
    if (!attempts.length) target.append(make('p', '暂无创建记录', 'empty'));
    for (const item of attempts) {
      if (['linked', 'abandoned'].includes(item.status)) resolvePendingCreation(item.attemptId);
      const row = make('article', undefined, 'row'); const details = make('div');
      const states = { creating: '创建结果待核对', unknown: '创建结果待核对', created: '已创建，关联待保存', linked: '已关联' };
      const messages = { not_sent: '初始消息未发送', sending: '初始消息发送中，请勿重试', unknown: '初始消息结果待核对', failed: '初始消息失败', completed: '初始消息已完成' };
      details.append(make('strong', item.issue.title || item.issue.issueId), make('p', `${states[item.status] || item.status}${item.messageStatus ? ` · ${messages[item.messageStatus] || item.messageStatus}` : ''}${item.sessionId || item.recoverySessionId ? ` · 会话 ${item.sessionId || item.recoverySessionId}` : ''}`, 'muted'));
      row.append(details);
      if (item.status === 'created') row.append(action('重试保存关联', async () => {
        if (!await confirmAction('确认重试保存此会话关联？不会再次创建会话。')) return;
        await call('codex_finish_link', { attemptId: item.attemptId, confirmed: true });
        resolvePendingCreation(item.attemptId);
        await refreshAfterSave('关联已保存');
      }));
      if (item.status === 'linked' && item.messageStatus === 'not_sent') row.append(action('发送初始消息', async () => {
        const initialMessage = item.initialMessage;
        if (!await confirmAction(`确认向已创建的会话发送：\n\n${initialMessage}`)) return;
        await call('codex_send_initial', { attemptId: item.attemptId, confirmed: true }); await refreshAfterSave('已提交初始消息，请查看创建记录确认状态');
      }));
      if (item.status === 'unknown' && item.recoverySessionId) row.append(action('核查已返回的会话', async () => {
        if (!await confirmAction(`确认核查会话 ${item.recoverySessionId} 的工程目录？核查后仍需确认保存关联，不会创建会话或发送消息。`)) return;
        await call('codex_recover_creation', { attemptId: item.attemptId, confirmed: true });
        await refreshAfterSave('会话 ID 和工程目录已核对，请确认是否保存关联');
      }));
      if (item.status === 'unknown') row.append(action('确认已核查', async () => {
        if (!await confirmAction('请先在 Codex 中核查是否已创建会话。确认已核查并解除重复创建限制？这可能产生重复会话。')) return;
        await call('codex_abandon_attempt', { attemptId: item.attemptId, confirmed: true });
        resolvePendingCreation(item.attemptId);
        await refreshAfterSave('已解除此记录的重复创建限制');
      }));
      target.append(row);
    }
  } catch (error) { if (sequence === attemptListSequence) target.append(make('p', `创建记录加载失败：${error.message}`, 'error')); }
}
function resolvePendingCreation(attemptId) {
  if (pendingCreation !== attemptId) return;
  pendingCreation = null;
  if (creationAttempt === attemptId) creationAttempt = null;
  if ($('#session-panel').open && !sessionBusy) {
    $('#session-status').textContent = '创建记录已处理，可以继续操作。';
    setSessionBusy(false);
  }
}
function render() {
  const links = $('#links'); links.replaceChildren();
  if (!data.links.length) links.append(make('p', '暂无关联', 'empty'));
  const groups = new Map();
  for (const item of data.links) {
    const key = JSON.stringify(['environment', 'tenantId', 'projectId', 'issueId'].map((field) => item.issue[field]));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  for (const items of groups.values()) {
    const issue = items[0].issue;
    const group = make('article', undefined, 'link-group');
    const header = make('div', undefined, 'link-group-header');
    const title = make('div', undefined, 'link-group-title');
    title.append(make('span', '工作项', 'link-kind'), make('strong', issue.title || `工作项 ${issue.issueId}`));
    header.append(title, make('p', `项目 ${issue.projectId} · 已关联 ${items.length} 个会话`, 'link-group-meta muted'));
    group.append(header);
    const sessionList = make('div', undefined, 'link-session-list');
    sessionList.append(make('h3', '关联会话', 'link-session-heading'));
    for (const item of items) {
    const row = make('article', undefined, 'row link-session-row'); const details = make('div', undefined, 'link-session-details');
    details.append(make('strong', item.sessionTitle || item.sessionId));
    details.append(make('p', `会话 ID：${item.sessionId}`, 'muted'));
    if (item.primary) details.append(make('span', '此工作项是该会话的主工作项', 'link-primary'));
    const actions = make('div', undefined, 'actions');
    if (!item.primary) actions.append(action('设为主工作项', async () => {
      if (!await confirmAction('确定将此工作项设为该会话的主工作项？')) return;
      await call('local_set_primary', { issue: item.issue, sessionId: item.sessionId, confirmed: true }); await refresh(); message('主工作项已更新');
    }));
    actions.append(action('解除关联', async () => {
      if (!await confirmAction(item.primary ? '这是主工作项，确定解除关联？' : '确定解除关联？')) return;
      await call('local_remove_link', { issue: item.issue, sessionId: item.sessionId, confirmed: true, confirmPrimaryRemoval: item.primary }); await refresh(); message('关联已解除');
    }));
    row.append(details, actions); sessionList.append(row);
    }
    group.append(sessionList); links.append(group);
  }
  const drafts = $('#drafts'); drafts.replaceChildren();
  if (!data.drafts.length) drafts.append(make('p', '暂无草稿', 'empty'));
  for (const item of data.drafts) {
    const row = make('article', undefined, 'row draft-list-item'); const details = make('div', undefined, 'draft-list-details');
    const draftStatus = { pending: '待确认', deferred: '已暂缓', discarded: '已舍弃' };
    const locked = Boolean(item.updateLock);
    details.append(make('strong', item.title), make('p', `${locked ? '更新结果待核对' : draftStatus[item.status] || item.status} · 版本 ${item.revision}`, 'muted'), make('p', item.target || '未指定位置', 'muted'));
    const relatedIssues = issuesOf(item).filter((issue) => (issue.title || issue.issueId) !== item.title);
    if (relatedIssues.length) details.append(make('p', `关联工作项：${relatedIssues.map((issue) => issue.title || issue.issueId).join('、')}`, 'muted'));
    if (item.sourceSession) details.append(make('p', `来源会话：${item.sourceSession.title || item.sourceSession.id}`, 'muted'));
    const actions = make('div', undefined, 'actions draft-list-actions');
    if (locked) actions.append(action('核对更新状态', () => openNoteUpdateRecovery(item)));
    else if (item.status === 'pending') {
      actions.append(action('新建笔记', () => openPublication(item)));
      if (item.target) actions.append(action('更新已有笔记', () => openNoteUpdate(item)));
    }
    const statusAction = action(item.status === 'pending' ? '暂缓' : '恢复待确认', async () => {
      if (statusAction.disabled) return;
      if (savingDraft || editing?.id === item.id) { message('请先保存或清空正在编辑的草稿，再更改其状态。', true); return; }
      statusAction.disabled = true;
      try {
        const status = item.status === 'pending' ? 'deferred' : 'pending';
        await call('local_save_draft', { id: item.id, title: item.title, content: item.content, target: item.target, issues: issuesOf(item), ...(item.sourceSession ? { sourceSession: item.sourceSession } : {}), status, expectedRevision: item.revision, confirmed: true });
        await refreshAfterSave(status === 'deferred' ? '草稿已暂缓' : '草稿已恢复待确认');
      } catch (error) { message(`状态更新未确认成功：${error.message}。请重新打开页面核对草稿。`, true); }
      finally { statusAction.disabled = false; }
    });
    if (!locked) actions.append(statusAction);
    if (!locked) actions.append(action('编辑', async () => {
      if (savingDraft) { message('草稿正在保存，请稍候。', true); return; }
      const state = currentDraftState();
      if (draftChanged() && !await confirmAction('当前草稿有未保存的修改，确定放弃并切换？')) return;
      if (savingDraft || state !== currentDraftState()) return;
      editing = item; setDraftPreview(false); setDraftIssues(issuesOf(item)); draftIssuesBaseline = JSON.stringify(draftIssues); draftSession = item.sourceSession || null; $('#draft-session').textContent = draftSession ? `来源会话：${draftSession.title || draftSession.id}` : ''; const form = $('#draft-form');
      form.elements.title.value = item.title; form.elements.target.value = item.target; form.elements.content.value = item.content;
      resetTargetPicker();
      draftSessionBaseline = JSON.stringify(draftSession); renderDraftIssues(); baseline = { title: item.title, target: item.target, content: item.content };
      $('#draft-heading').textContent = '编辑草稿'; form.elements.title.focus();
    }));
    if (!locked) actions.append(action('删除', async () => {
      if (savingDraft) { message('草稿正在保存，请稍候。', true); return; }
      if (!await confirmAction(`确定删除草稿“${item.title}”？`)) return;
      await call('local_delete_draft', { id: item.id, expectedRevision: item.revision, confirmed: true });
      if (editing?.id === item.id) resetDraft(); await refresh(); message('草稿已删除');
    }));
    row.append(details, actions); drafts.append(row);
  }
}
function clearNoteUpdatePreview() {
  delete noteUpdate.requestId;
  delete noteUpdate.confirmation;
  $('#update-summary').textContent = '';
  $('#update-result').hidden = true;
  $('#update-confirm').disabled = true;
}
function syncNoteUpdateControls() {
  const append = noteUpdate.mode === 'append';
  const inactive = noteUpdateBusy || noteUpdate.finished || noteUpdate.recovery;
  $('#update-method').disabled = Boolean(inactive);
  $('#update-append').hidden = !append;
  $('#update-quote').disabled = Boolean(inactive || !noteUpdate.source?.content.trim() || noteUpdate.loadingSource);
  $('#update-reload').disabled = Boolean(inactive || noteUpdate.loadingSource);
  $('#update-preview').disabled = Boolean(inactive || noteUpdate.previewing || (append && !noteUpdate.selection));
  $('#update-preview').textContent = append ? '预览追加结果' : '预览替换结果';
  $('#update-confirm').textContent = append ? '确认追加到笔记' : '确认替换整篇笔记';
}
function resetNoteUpdateDialog() {
  $('#update-summary').textContent = '';
  $('#update-diff').replaceChildren();
  $('#update-before').textContent = '';
  $('#update-after').textContent = '';
  $('#update-status').textContent = '';
  $('#update-result').hidden = true;
  $('#update-diff-section').hidden = false;
  $('#update-diff-section').open = true;
  $('#update-before-section').open = false;
  $('#update-before-label').textContent = '查看完整原笔记';
  $('#update-after-section').hidden = false;
  $('#update-after-section').open = false;
  $('#update-confirm').hidden = false;
  $('#update-confirm').disabled = true;
  $('#update-inspect').hidden = true;
  $('#update-recover').hidden = true;
}
function openNoteUpdate(item) {
  const dialog = $('#update-dialog');
  if (dialog.open || noteUpdateBusy || !item?.target) return;
  ++noteUpdateSequence;
  noteUpdate = { id: item.id, revision: item.revision, target: item.target, expectedContent: item.content, issues: issuesOf(item), mode: 'append' };
  resetNoteUpdateDialog();
  $('#update-heading').textContent = '更新已有笔记';
  $('#update-target').textContent = item.target;
  $('#update-issue').textContent = issuesOf(item).map(issueLabel).join('\n') || '独立知识记录';
  $('#update-method').hidden = false;
  $('#update-preview-actions').hidden = false;
  $('[name="update-mode"][value="append"]').checked = true;
  $('#update-conclusion-text').textContent = item.content;
  dialog.showModal();
  void loadNoteUpdateSource();
}
async function loadNoteUpdateSource() {
  const state = noteUpdate;
  if (!state || state.mode !== 'append' || noteUpdateBusy || state.finished || state.recovery) return;
  const sequence = ++noteUpdateSequence;
  state.source = null;
  state.selection = null;
  state.previewing = false;
  state.loadingSource = true;
  clearNoteUpdatePreview();
  $('#update-original').value = '';
  $('#update-quote-text').hidden = true;
  $('#update-quote-summary').textContent = '尚未引用原文片段。';
  $('#update-status').textContent = '正在读取笔记原文…';
  syncNoteUpdateControls();
  try {
    const { id, revision, target, expectedContent } = state;
    const result = await callReadWithTimeout('draft_history_source', { id, revision, target, expectedContent });
    if (sequence !== noteUpdateSequence || !$('#update-dialog').open) return;
    if (typeof result?.content !== 'string' || typeof result.revision !== 'string' || typeof result.vaultId !== 'string') throw new Error('原文格式无效');
    state.source = result;
    $('#update-original').value = result.content;
    $('#update-status').textContent = result.content.trim() ? '' : '目标笔记没有可引用的原文片段。';
  } catch (error) {
    if (sequence === noteUpdateSequence && $('#update-dialog').open) $('#update-status').textContent = `无法读取原文：${error.message}`;
  } finally {
    if (sequence === noteUpdateSequence && $('#update-dialog').open) { state.loadingSource = false; syncNoteUpdateControls(); }
  }
}
$('#update-reload').addEventListener('click', () => { void loadNoteUpdateSource(); });
$('#update-method').addEventListener('change', (event) => {
  if (!noteUpdate || noteUpdateBusy || noteUpdate.finished || noteUpdate.recovery || !['append', 'replace'].includes(event.target.value)) return;
  ++noteUpdateSequence;
  noteUpdate.mode = event.target.value;
  noteUpdate.loadingSource = false;
  noteUpdate.previewing = false;
  clearNoteUpdatePreview();
  $('#update-status').textContent = '';
  syncNoteUpdateControls();
  if (noteUpdate.mode === 'append' && !noteUpdate.source) void loadNoteUpdateSource();
});
$('#update-quote').addEventListener('click', () => {
  const state = noteUpdate;
  if (!state?.source || state.mode !== 'append' || noteUpdateBusy || state.finished || state.recovery) return;
  const input = $('#update-original');
  const original = state.source.content;
  const start = originalOffset(original, input.selectionStart);
  const end = originalOffset(original, input.selectionEnd);
  const text = original.slice(start, end);
  ++noteUpdateSequence;
  state.previewing = false;
  state.selection = null;
  clearNoteUpdatePreview();
  $('#update-quote-text').hidden = true;
  $('#update-quote-summary').textContent = '尚未引用原文片段。';
  $('#update-status').textContent = '';
  if (!text.trim() || text.length > 10000) {
    $('#update-status').textContent = !text.trim() ? '请先在笔记原文中选中一段文字。' : '所选片段超过 10,000 字符，请缩短后再引用。';
    syncNoteUpdateControls();
    input.focus();
    return;
  }
  state.selection = { start, end, text };
  const startLine = original.slice(0, start).split(/\r\n|\r|\n/).length;
  const endLine = original.slice(0, end - 1).split(/\r\n|\r|\n/).length;
  $('#update-quote-summary').textContent = startLine === endLine ? `已引用第 ${startLine} 行的片段` : `已引用第 ${startLine} 至 ${endLine} 行的片段`;
  $('#update-quote-text').textContent = text;
  $('#update-quote-text').hidden = false;
  syncNoteUpdateControls();
});
$('#update-preview').addEventListener('click', async () => {
  const state = noteUpdate;
  if (!state || state.previewing || state.finished || state.recovery || noteUpdateBusy || (state.mode === 'append' && !state.selection)) return;
  const sequence = ++noteUpdateSequence;
  const { id, revision, target, expectedContent, mode } = state;
  const requestId = crypto.randomUUID();
  const append = mode === 'append';
  const options = append ? { selection: state.selection, beforeDigest: state.source.revision, vaultId: state.source.vaultId } : {};
  state.previewing = true;
  clearNoteUpdatePreview();
  $('#update-status').textContent = '正在生成更新预览…';
  syncNoteUpdateControls();
  try {
    const result = await callReadWithTimeout('draft_note_update_preview', { id, revision, target, expectedContent, requestId, mode, ...options });
    if (sequence !== noteUpdateSequence || !$('#update-dialog').open) return;
    if (result?.requestId !== requestId || typeof result.confirmation !== 'string' || typeof result.beforeContent !== 'string' || typeof result.afterContent !== 'string' || typeof result.unchanged !== 'boolean') throw new Error('预览结果无效');
    if (append && (result.mode !== 'append' || result.beforeContent !== state.source.content || !result.afterContent.startsWith(result.beforeContent) || result.afterContent === result.beforeContent)) throw new Error('预览未保留原文，请重新读取或重新加载插件后再试');
    if (append && (typeof result.appendedContent !== 'string' || !result.appendedContent.trim() || !result.afterContent.slice(result.beforeContent.length).trimEnd().endsWith(result.appendedContent.trimEnd()))) throw new Error('追加预览与更新后的正文不一致，请重新加载插件后再试');
    if (!append && (result.mode === 'append' || result.afterContent !== expectedContent)) throw new Error('预览与当前草稿不一致');
    state.requestId = requestId;
    state.confirmation = result.confirmation;
    $('#update-before').textContent = result.beforeContent;
    $('#update-after').textContent = result.afterContent;
    $('#update-before-section').open = false;
    $('#update-after-section').open = false;
    $('#update-diff-section').open = true;
    $('#update-result').hidden = false;
    $('#update-diff-section').hidden = result.unchanged;
    $('#update-summary').textContent = result.unchanged ? '当前笔记与草稿正文完全一致。' : append ? '原文保持不变，以下内容将追加到笔记末尾。' : '整篇目标笔记将替换为这份草稿正文。';
    if (result.conclusionFormat === 'markdown-source') $('#update-summary').textContent += ' 本次结论将保留为 Markdown 原文。';
    if (append) {
      const preview = make('div', '', 'update-added-preview');
      preview.innerHTML = draftMarkdown.render(result.appendedContent);
      $('#update-diff').replaceChildren(make('h4', '新增内容'), preview);
    } else {
      $('#update-diff').replaceChildren(make('h4', '移除内容'), make('pre', result.removed || '（无）'), make('h4', '新增内容'), make('pre', result.added || '（无）'));
    }
    $('#update-status').textContent = result.unchanged ? '无需更新。' : '预览已生成，笔记尚未修改。';
    $('#update-confirm').disabled = result.unchanged;
  } catch (error) {
    if (sequence === noteUpdateSequence && $('#update-dialog').open) $('#update-status').textContent = `无法预览：${error.message}。笔记未修改。`;
  } finally {
    if (sequence === noteUpdateSequence && $('#update-dialog').open) { state.previewing = false; syncNoteUpdateControls(); }
  }
});
function showNoteUpdateRecovery() {
  $('#update-heading').textContent = '核对笔记更新结果';
  $('#update-method').hidden = true;
  $('#update-append').hidden = true;
  $('#update-preview-actions').hidden = true;
  $('#update-summary').textContent = '';
  $('#update-result').hidden = true;
  $('#update-diff-section').hidden = true;
  $('#update-after-section').hidden = true;
  $('#update-before-section').open = false;
  $('#update-before-label').textContent = '查看当前笔记正文';
  $('#update-confirm').hidden = true;
  $('#update-inspect').hidden = false;
}
function openNoteUpdateRecovery(item) {
  const dialog = $('#update-dialog');
  if (dialog.open || noteUpdateBusy || !item?.updateLock?.requestId) return;
  const sequence = ++noteUpdateSequence;
  noteUpdate = { id: item.id, revision: item.revision, target: item.updateLock.target, requestId: item.updateLock.requestId, expectedContent: item.content, recovery: true };
  resetNoteUpdateDialog();
  showNoteUpdateRecovery();
  $('#update-target').textContent = item.updateLock.target;
  $('#update-issue').textContent = '草稿更新曾遇到不确定结果；核对不会重试写入。';
  $('#update-status').textContent = '正在读取目标笔记…';
  dialog.showModal();
  void inspectNoteUpdate(sequence);
}
async function inspectNoteUpdate(sequence = noteUpdateSequence) {
  if (!noteUpdate || !noteUpdate.requestId) return;
  $('#update-inspect').disabled = true;
  try {
    const result = await callReadWithTimeout('draft_note_update_inspect', { id: noteUpdate.id, revision: noteUpdate.revision, requestId: noteUpdate.requestId });
    if (sequence !== noteUpdateSequence || !$('#update-dialog').open) return;
    const messages = {
      not_sent: '请求停留在准备阶段，尚未发送到桥接。确认原进程已退出后，可解除冻结；此操作不会写入笔记。',
      matches_after: '当前笔记与确认写入的正文一致，但无法确认由哪次操作写入。接受当前正文后可解除草稿冻结。',
      matches_before: '目标仍与更新前原文一致，不能据此安全重试。草稿保持冻结，请勿手动重试。',
      differs: '目标内容与更新前后均不一致，可能有并发编辑。草稿保持冻结，请人工核对。',
      unavailable: '当前知识库或目标笔记不可读取，草稿保持冻结。',
    };
    $('#update-status').textContent = messages[result?.status] || '核对结果无效；草稿保持冻结。';
    $('#update-before').textContent = typeof result?.currentContent === 'string' ? result.currentContent : '';
    $('#update-result').hidden = typeof result?.currentContent !== 'string';
    noteUpdate.recoveryStatus = result?.status;
    $('#update-recover').hidden = !['matches_after', 'not_sent'].includes(result?.status) || result?.recoverable !== true;
    if (result?.status === 'not_sent' && result?.recoverable !== true) $('#update-status').textContent += ' 原进程仍在运行或无法核实，暂时不能解除冻结。';
    if (result?.status === 'matches_after' && result?.recoverable !== true) $('#update-status').textContent += ' 尚未确认桥接原请求已结束，暂时不能解除冻结。';
  } catch (error) {
    if (sequence === noteUpdateSequence && $('#update-dialog').open) $('#update-status').textContent = `核对失败：${error.message}。草稿保持冻结。`;
  } finally { if (sequence === noteUpdateSequence) $('#update-inspect').disabled = false; }
}
$('#update-close').addEventListener('click', () => { if (!noteUpdateBusy) $('#update-dialog').close(); });
$('#update-dialog').addEventListener('cancel', (event) => { if (noteUpdateBusy) event.preventDefault(); });
$('#update-dialog').addEventListener('close', () => { if (!$('#update-dialog').open) { ++noteUpdateSequence; noteUpdate = null; } });
$('#update-inspect').addEventListener('click', () => { void inspectNoteUpdate(); });
function markNoteUpdateUncertain(snapshot) {
  if (noteUpdate?.requestId === snapshot.requestId) {
    noteUpdate.recovery = true;
    showNoteUpdateRecovery();
  }
  const draft = data.drafts.find(item => item.id === snapshot.id && item.revision === snapshot.revision);
  if (draft) draft.updateLock = { requestId: snapshot.requestId, target: snapshot.target, status: 'unknown' };
  render();
}
async function refreshNoteUpdateList(sequence) {
  const context = contextSequence;
  try {
    const fresh = await callReadWithTimeout('local_list', {});
    if (sequence !== noteUpdateSequence || context !== contextSequence || !Array.isArray(fresh?.drafts) || !Array.isArray(fresh?.links)) return;
    data = fresh; render(); renderIssueSessions();
  } catch {
    if (sequence === noteUpdateSequence && $('#update-dialog').open) $('#update-status').textContent += ' 列表刷新未完成，请稍后重新打开页面核对。';
  }
}
$('#update-confirm').addEventListener('click', async () => {
  if (noteUpdateBusy || !noteUpdate?.confirmation || $('#update-confirm').disabled) return;
  const snapshot = { ...noteUpdate }; const sequence = noteUpdateSequence;
  noteUpdateBusy = true; $('#update-confirm').disabled = true; $('#update-close').disabled = true;
  syncNoteUpdateControls();
  $('#update-status').textContent = '正在通过 Obsidian 安全更新…';
  try {
    const result = await callReadWithTimeout('draft_note_update_submit', { id: snapshot.id, revision: snapshot.revision, target: snapshot.target, expectedContent: snapshot.expectedContent, requestId: snapshot.requestId, confirmation: snapshot.confirmation, confirmed: true });
    if (sequence !== noteUpdateSequence) return;
    const messages = {
      completed: snapshot.mode === 'append' ? '更新已完成。原文已保留，结论已追加。' : '更新已完成。',
      not_written: `没有写入（${result.reason || '目标或桥接状态不满足'}），可以重新读取后再预览。`,
      unknown: '更新结果不确定。系统不会自动重试，草稿已冻结；请核对目标内容。',
      unavailable: 'Obsidian 桥不可用，笔记未修改。请确认插件正在运行后重新预览。',
    };
    $('#update-status').textContent = (messages[result?.status] || '更新状态无法确认；请勿重试，先核对目标。') + (result?.cleanupPending ? ' 本地更新锁待清理，请在草稿页面查看清理记录。' : '');
    if (result?.status === 'completed') {
      noteUpdate.finished = true;
      renderNoteIssueLinks($('#update-issue'), snapshot.issues, 'draft_note_update_link', { id: snapshot.id, revision: snapshot.revision, requestId: snapshot.requestId }, () => sequence === noteUpdateSequence && $('#update-dialog').open);
    } else if (['not_written', 'unavailable'].includes(result?.status)) clearNoteUpdatePreview();
    if (!['completed', 'not_written', 'unavailable'].includes(result?.status)) { markNoteUpdateUncertain(snapshot); $('#update-inspect').hidden = false; }
    void refreshNoteUpdateList(sequence);
  } catch (error) {
    if (sequence === noteUpdateSequence) { markNoteUpdateUncertain(snapshot); $('#update-status').textContent = `更新结果待核对：${error.message}。请勿重试，先核对目标笔记。`; $('#update-inspect').hidden = false; }
  } finally {
    noteUpdateBusy = false;
    $('#update-close').disabled = false;
    if (sequence === noteUpdateSequence && noteUpdate && !noteUpdate.recovery) syncNoteUpdateControls();
    void refreshUpdateCleanups();
  }
});
$('#update-recover').addEventListener('click', async () => {
  if (noteUpdateBusy || !noteUpdate?.recovery) return;
  const prompt = noteUpdate.recoveryStatus === 'not_sent' ? '该请求尚未发送到桥接。确认解除草稿冻结？此操作不会写入笔记。' : '当前笔记与确认写入的正文一致。接受当前内容并解除草稿冻结？此操作不会写入笔记。';
  if (!await confirmAction(prompt)) return;
  const snapshot = { ...noteUpdate }; const sequence = noteUpdateSequence;
  noteUpdateBusy = true; $('#update-recover').disabled = true; $('#update-close').disabled = true;
  try {
    const result = await callReadWithTimeout('draft_note_update_recover', { id: snapshot.id, revision: snapshot.revision, requestId: snapshot.requestId, confirmed: true });
    if (sequence === noteUpdateSequence) { $('#update-status').textContent = `草稿冻结已解除，没有修改笔记。${result?.cleanupPending ? '本地更新锁待清理，请在草稿页面查看清理记录。' : ''}`; $('#update-recover').hidden = true; void refreshNoteUpdateList(sequence); }
  } catch (error) { if (sequence === noteUpdateSequence) { $('#update-status').textContent = `解除冻结结果待核对：${error.message}。请重新打开页面核查，不会重试写入。`; $('#update-recover').hidden = true; } }
  finally {
    noteUpdateBusy = false;
    $('#update-recover').disabled = false;
    $('#update-close').disabled = false;
    void refreshUpdateCleanups();
  }
});
function publicationStatus(record) {
  if (!record) return '请核对路径和完整内容后确认新建。';
  if (record.status === 'sensitive_detected') return `检测到疑似敏感信息：${Array.isArray(record.findings) ? record.findings.join('、') : '凭据'}。尚未写入，请关闭并编辑草稿后重试。`;
  const states = {
    completed: '此版本已写入知识库。',
    target_exists: '目标文件已存在，未覆盖。请修改草稿目标后重新保存。',
    submitting: '写入结果待核对，请先检查目标文件，勿重复提交。',
    unknown: '写入结果待核对，请先检查目标文件，勿重复提交。',
    conflict: '此草稿编号和版本已有不同内容的提交记录，请检查历史记录与目标文件。',
    preflight_failed: '尚未写入。请检查知识库配置、Markdown 相对路径和目标目录是否存在，然后重试。',
  };
  return states[record.status] || '写入状态无法识别，请先检查目标文件。';
}
async function openPublication(item) {
  const dialog = $('#publish-dialog');
  if (dialog.open || publicationBusy) return;
  const sequence = ++publicationSequence;
  publication = { id: item.id, revision: item.revision, target: item.target, expectedContent: item.content, issue: item.issue || null, issues: issuesOf(item) };
  $('#publish-issue').textContent = issuesOf(item).map(issueLabel).join('\n') || '独立知识记录';
  $('#publish-link').hidden = true;
  $('#publish-inspect').hidden = true;
  $('#publish-target').textContent = item.target || '未设置目标路径，请先编辑草稿。';
  $('#publish-content').textContent = item.content;
  $('#publish-comparison').replaceChildren();
  $('#publish-compare').disabled = !item.target;
  $('#publish-references').replaceChildren(make('p', item.target ? '正在检查 Markdown 引用…' : '设置目标路径后可检查引用。', 'muted'));
  $('#publish-status').textContent = item.target ? '正在检查写入记录…' : '请先编辑草稿，填写知识库内的相对路径。';
  $('#publish-confirm').disabled = true;
  dialog.showModal();
  if (!item.target) return;
  const referenceCheck = (async () => {
    try {
      const result = await callReadWithTimeout('knowledge_inspect_content_references', { path: item.target, content: item.content });
      if (sequence !== publicationSequence || !dialog.open) return;
      if (result?.path !== item.target || !Array.isArray(result.references)) throw new Error('检查结果格式无效');
      const target = $('#publish-references');
      const labels = { missing: '未找到', invalid: '路径不可用', external: '外部链接' };
      const issues = result.references.filter((reference) => Object.hasOwn(labels, reference.status));
      target.replaceChildren(make('p', `已检查 ${result.references.length} 条标准 Markdown 引用，其中 ${issues.length} 条需核对；不检查 HTML 或 Obsidian 专属语法。`, 'muted'));
      for (const reference of issues) target.append(make('p', `${reference.kind === 'image' ? '图片' : '链接'}：${reference.destination} · ${labels[reference.status]}`, 'muted'));
    } catch (error) {
      if (sequence === publicationSequence && dialog.open) $('#publish-references').replaceChildren(make('p', `引用检查失败：${error.message}。请手动核对路径。`, 'error'));
    }
  })();
  try {
    const record = await callReadWithTimeout('draft_publication_get', { id: item.id, revision: item.revision, target: item.target, expectedContent: item.content });
    await referenceCheck;
    if (sequence !== publicationSequence || !dialog.open) return;
    $('#publish-status').textContent = publicationStatus(record);
    $('#publish-confirm').disabled = Boolean(record);
    $('#publish-link').hidden = !(record?.status === 'completed' && publication.issues.length === 1);
    if (record?.status === 'completed' && publication.issues.length > 1) renderNoteIssueLinks($('#publish-issue'), publication.issues, 'draft_link_publication', { id: item.id, revision: item.revision, target: item.target, expectedContent: item.content }, () => sequence === publicationSequence && dialog.open);
    $('#publish-inspect').hidden = !['unknown', 'submitting'].includes(record?.status);
  } catch (error) {
    if (sequence === publicationSequence && dialog.open) $('#publish-status').textContent = `无法检查写入记录：${error.message}。请关闭后重试。`;
  }
}
$('#publish-close').addEventListener('click', () => { if (!publicationBusy) $('#publish-dialog').close(); });
$('#publish-dialog').addEventListener('cancel', (event) => { if (publicationBusy) event.preventDefault(); });
$('#publish-dialog').addEventListener('close', () => { ++publicationSequence; publication = null; });
$('#publish-compare').addEventListener('click', async () => {
  if (!publication || !publication.target) return;
  const sequence = publicationSequence;
  const output = $('#publish-comparison');
  $('#publish-compare').disabled = true;
  output.replaceChildren(make('p', '正在对比已有笔记…', 'muted'));
  try {
    const result = await callReadWithTimeout('draft_preview_note_update', { id: publication.id, revision: publication.revision, target: publication.target, expectedContent: publication.expectedContent });
    if (sequence !== publicationSequence || !$('#publish-dialog').open) return;
    if (typeof result?.unchanged !== 'boolean' || !Number.isSafeInteger(result.startLine) || result.startLine < 1 || typeof result.removed !== 'string' || typeof result.added !== 'string' || (Object.hasOwn(result, 'beforeContent') && typeof result.beforeContent !== 'string')) throw new Error('对比结果格式无效');
    if (result.unchanged) output.replaceChildren(make('p', '已有笔记与草稿内容一致。', 'muted'));
    else output.replaceChildren(make('p', `从第 ${result.startLine} 行开始的变化（仅供预览）：`, 'muted'), make('h3', '现有内容'), make('pre', result.removed || '（无）'), make('h3', '草稿内容'), make('pre', result.added || '（无）'));
    if (Object.hasOwn(result, 'beforeContent')) {
      const original = make('details'); original.append(make('summary', '查看完整原笔记'), make('pre', result.beforeContent)); output.append(original);
    } else {
      output.append(make('p', '当前服务未提供完整原文，请更新服务后重新对比。', 'muted'));
    }
  } catch (error) {
    if (sequence === publicationSequence && $('#publish-dialog').open) output.replaceChildren(make('p', `无法对比：${error.message}。请检查目标笔记及草稿版本。`, 'error'));
  } finally { if (sequence === publicationSequence) $('#publish-compare').disabled = false; }
});
$('#publish-confirm').addEventListener('click', async () => {
  if (publicationBusy || !publication || $('#publish-confirm').disabled) return;
  const snapshot = { ...publication }; const sequence = publicationSequence;
  publicationBusy = true; $('#publish-confirm').disabled = true; $('#publish-close').disabled = true;
  $('#publish-status').textContent = '正在写入知识库…';
  try {
    const { issue, issues, ...request } = snapshot;
    const result = await call('draft_publish', { ...request, confirmed: true });
    if (sequence !== publicationSequence) return;
    $('#publish-status').textContent = publicationStatus(result);
    if (result?.status === 'preflight_failed') $('#publish-confirm').disabled = false;
    if (result?.status === 'completed') {
      knowledgeNotes = null; $('#publish-link').hidden = issues.length !== 1;
      if (issues.length > 1) renderNoteIssueLinks($('#publish-issue'), issues, 'draft_link_publication', request, () => sequence === publicationSequence && $('#publish-dialog').open);
    }
    $('#publish-inspect').hidden = !['unknown', 'submitting'].includes(result?.status);
  } catch (error) {
    if (sequence === publicationSequence) $('#publish-status').textContent = `写入结果待核对：${error.message}。请检查目标文件，再重新打开草稿查看记录。`;
  } finally {
    publicationBusy = false;
    $('#publish-close').disabled = false;
    void refreshReservations();
  }
});
$('#publish-inspect').addEventListener('click', async () => {
  if (publicationBusy || !publication) return;
  const { issue, issues, ...request } = publication; const sequence = publicationSequence;
  publicationBusy = true; $('#publish-inspect').disabled = true; $('#publish-close').disabled = true;
  $('#publish-status').textContent = '正在核对目标文件…';
  try {
    const result = await call('draft_publication_inspect', request);
    if (sequence !== publicationSequence) return;
    const messages = {
      matches: '目标文件内容与草稿一致，但不能证明由本次提交写入。请人工核实，勿重复提交。',
      differs: '目标文件内容与草稿不同，请人工核实，勿重复提交。',
      unavailable: '无法读取目标文件，不能确定写入结果。请检查路径和权限，勿重复提交。',
    };
    $('#publish-status').textContent = messages[result?.status] || '核对结果无效，请人工检查目标文件，勿重复提交。';
  } catch (error) { if (sequence === publicationSequence) $('#publish-status').textContent = `无法核对目标文件：${error.message}。请人工检查，勿重复提交。`; }
  finally { publicationBusy = false; $('#publish-inspect').disabled = false; $('#publish-close').disabled = false; }
});
$('#publish-link').addEventListener('click', async () => {
  if (publicationBusy || !publication?.issues?.length || !choerodonContext) return;
  if (!await confirmAction(`确认将笔记关联到“${issueLabel(publication.issues[0])}”？不会再次写入笔记。`)) return;
  const { issue, issues, ...snapshot } = publication; const sequence = publicationSequence;
  publicationBusy = true; $('#publish-link').disabled = true; $('#publish-close').disabled = true;
  try {
    await call('draft_link_publication', { ...snapshot, issue: issues[0] || issue, userId: choerodonContext.identity.userId, confirmed: true });
    if (sequence === publicationSequence) { $('#publish-status').textContent = '笔记已关联工作项。'; $('#publish-link').hidden = true; }
  } catch (error) { if (sequence === publicationSequence) $('#publish-status').textContent = `笔记已写入，关联未完成：${error.message}。可核对后重试关联，不会重复写入。`; }
  finally {
    publicationBusy = false;
    $('#publish-link').disabled = false;
    $('#publish-close').disabled = false;
    void refreshReservations();
  }
});
function draftChanged() {
  const form = $('#draft-form');
  return JSON.stringify(draftSession) !== draftSessionBaseline || JSON.stringify(draftIssues) !== draftIssuesBaseline || ['title', 'target', 'content'].some((field) => form.elements[field].value !== baseline[field]);
}
function resetDraft() { editing = null; draftIssue = null; draftIssues = []; draftIssuesBaseline = '[]'; draftSession = null; draftSessionBaseline = 'null'; pendingDraftId = null; baseline = { title: '', target: '', content: '' }; ++locationSequence; $('#location-results').replaceChildren(); $('#location-status').textContent = ''; $('#draft-form').reset(); resetTargetPicker(); setDraftPreview(false); $('#draft-heading').textContent = '新建草稿'; renderDraftIssues(); }
async function refreshAfterSave(success) {
  try { await refresh(); message(success); } catch { message(`${success}，但列表刷新失败，请重新打开页面。`, true); }
}
document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => {
  activeView = button.dataset.view;
  document.querySelectorAll('[data-view]').forEach((item) => item.setAttribute('aria-selected', String(item === button)));
  document.querySelectorAll('[data-panel]').forEach((panel) => { panel.hidden = panel.dataset.panel !== button.dataset.view; }); message('');
  if (button.dataset.view === 'links') void refreshAttempts();
  if (activeView === 'drafts') {
    void refreshReservations();
    void refreshUpdateCleanups();
  }
  if (button.dataset.view === 'knowledge' && knowledgeNotes === null) loadKnowledge();
}));
function renderKnowledge() {
  const target = $('#knowledge-list'); target.replaceChildren();
  const filter = $('#knowledge-filter').value.trim().toLocaleLowerCase();
  const notes = knowledgeNotes.filter((name) => name.toLocaleLowerCase().includes(filter));
  if (!notes.length) target.append(make('p', filter ? '已加载的记录中没有匹配的路径。' : ($('#knowledge-scope').value === 'catalog' ? '当前知识库没有链路记录。' : '知识库中没有 Markdown 笔记。'), 'empty'));
  for (const path of notes) {
    const row = make('div', undefined, 'row');
    row.append(make('span', path), action('查看', () => readKnowledge(path))); target.append(row);
  }
}
async function loadKnowledge(offset = 0) {
  const sequence = ++knowledgeListSequence;
  const scope = $('#knowledge-scope').value;
  if (!offset) { knowledgeNotes = null; knowledgeNextOffset = null; $('#knowledge-list').replaceChildren(); $('#knowledge-more').hidden = true; }
  $('#knowledge-list-status').textContent = '正在加载笔记…'; $('#knowledge-more').disabled = true;
  try {
    if (scope === 'all') {
      const notes = await callReadWithTimeout('knowledge_list');
      if (sequence !== knowledgeListSequence || scope !== $('#knowledge-scope').value) return;
      if (!Array.isArray(notes) || !notes.every((name) => typeof name === 'string')) throw new Error('笔记列表格式无效');
      knowledgeNotes = notes; knowledgeNextOffset = null;
      $('#knowledge-list-status').textContent = `整个知识库共 ${notes.length} 篇笔记。`;
    } else {
      const result = await callReadWithTimeout('knowledge_catalog', { offset, limit: 20 });
      if (sequence !== knowledgeListSequence || scope !== $('#knowledge-scope').value) return;
      if (!Array.isArray(result?.items) || !result.items.every((item) => typeof item?.path === 'string') || !Number.isSafeInteger(result.total) || !(result.nextOffset === null || (Number.isSafeInteger(result.nextOffset) && result.nextOffset > offset))) throw new Error('链路记录格式无效');
      knowledgeNotes = [...(offset ? knowledgeNotes || [] : []), ...result.items.map((item) => item.path)];
      knowledgeNextOffset = result.nextOffset;
      const warnings = Array.isArray(result.warnings) ? result.warnings.length : 0;
      $('#knowledge-list-status').textContent = `已加载 ${knowledgeNotes.length} / ${result.total} 条链路记录；路径筛选仅作用于已加载记录。${warnings ? ` ${warnings} 条发布记录需检查。` : ''}`;
    }
    $('#knowledge-more').hidden = knowledgeNextOffset === null; renderKnowledge();
  } catch (error) {
    if (sequence !== knowledgeListSequence || scope !== $('#knowledge-scope').value) return;
    $('#knowledge-list-status').textContent = `加载失败：${error.message}。请检查配置后重试。`;
    if (!offset) { knowledgeNotes = null; $('#knowledge-list').replaceChildren(); }
  } finally { if (sequence === knowledgeListSequence) $('#knowledge-more').disabled = false; }
}
async function readKnowledge(path) {
  const sequence = ++knowledgeReadSequence;
  ++knowledgeReferenceSequence; selectedKnowledgeNote = null;
  $('#knowledge-inspect').hidden = true; $('#knowledge-inspect').disabled = false; $('#knowledge-references').replaceChildren();
  $('#knowledge-title').textContent = path; $('#knowledge-content').hidden = true; $('#knowledge-status').textContent = '正在读取笔记…';
  try {
    const note = await call('knowledge_read', { path });
    if (sequence !== knowledgeReadSequence) return;
    if (!note || note.path !== path || typeof note.content !== 'string' || typeof note.revision !== 'string') throw new Error('笔记内容格式无效');
    selectedKnowledgeNote = { path, revision: note.revision }; $('#knowledge-inspect').hidden = false;
    $('#knowledge-content').textContent = note.content; $('#knowledge-content').hidden = false; $('#knowledge-status').textContent = 'Markdown 原文';
  } catch (error) { if (sequence === knowledgeReadSequence) $('#knowledge-status').textContent = `读取失败：${error.message}`; }
}
$('#knowledge-inspect').addEventListener('click', async () => {
  if (!selectedKnowledgeNote) return;
  const note = selectedKnowledgeNote; const sequence = ++knowledgeReferenceSequence; const target = $('#knowledge-references');
  $('#knowledge-inspect').disabled = true; target.replaceChildren(make('p', '正在检查引用…', 'muted'));
  try {
    const result = await call('knowledge_inspect_references', { path: note.path });
    if (sequence !== knowledgeReferenceSequence) return;
    if (result?.path !== note.path || !Array.isArray(result.references)) throw new Error('检查结果格式无效');
    if (result.revision !== note.revision) throw new Error('笔记内容已变化，请重新查看后检查');
    const labels = { available: '路径存在', missing: '未找到', invalid: '路径不可用', external: '外部链接', fragment: '本页锚点' };
    target.replaceChildren(make('p', `检查到 ${result.references.length} 条标准 Markdown 引用。结果不包含 HTML 或 Obsidian 专属语法，也不代表已备份。`, 'muted'));
    if (!result.references.length) target.append(make('p', '未发现标准 Markdown 图片或链接。', 'empty'));
    for (const reference of result.references) {
      if (!reference || !['image', 'link'].includes(reference.kind) || typeof reference.destination !== 'string' || !Object.hasOwn(labels, reference.status)) throw new Error('检查结果格式无效');
      const row = make('div', undefined, 'row'); const info = make('div');
      info.append(make('strong', reference.destination), make('p', `${reference.kind === 'image' ? '图片' : '链接'} · ${labels[reference.status]}`, 'muted')); row.append(info); target.append(row);
    }
  } catch (error) { if (sequence === knowledgeReferenceSequence) target.replaceChildren(make('p', `引用检查失败：${error.message}。`, 'error')); }
  finally { if (sequence === knowledgeReferenceSequence) $('#knowledge-inspect').disabled = false; }
});
$('#knowledge-filter').addEventListener('input', () => { if (knowledgeNotes !== null) renderKnowledge(); });
$('#knowledge-reload').addEventListener('click', () => { void loadKnowledge(); });
$('#knowledge-more').addEventListener('click', () => { if (knowledgeNextOffset !== null) void loadKnowledge(knowledgeNextOffset); });
$('#knowledge-scope').addEventListener('change', () => {
  ++knowledgeReadSequence; ++knowledgeReferenceSequence; selectedKnowledgeNote = null;
  $('#knowledge-title').textContent = '选择笔记'; $('#knowledge-status').textContent = ''; $('#knowledge-content').hidden = true;
  $('#knowledge-inspect').hidden = true; $('#knowledge-references').replaceChildren();
  void loadKnowledge();
});
$('#knowledge-query').addEventListener('input', () => {
  ++knowledgeSearchSequence;
  $('#knowledge-search').disabled = false;
  $('#knowledge-search-results').replaceChildren();
});
$('#knowledge-search').addEventListener('click', async () => {
  const query = $('#knowledge-query').value.trim(); if (!query) { $('#knowledge-search-results').replaceChildren(make('p', '请输入要搜索的正文内容。', 'muted')); return; }
  const sequence = ++knowledgeSearchSequence; const target = $('#knowledge-search-results'); target.replaceChildren(make('p', '正在搜索正文…', 'muted')); $('#knowledge-search').disabled = true;
  async function loadPage(cursor) {
    try {
      const result = await call('knowledge_search', { query, limit: 200, ...(cursor ? { cursor } : {}) }); if (sequence !== knowledgeSearchSequence) return;
      if (!Array.isArray(result?.results) || !Number.isSafeInteger(result.scanned) || !Number.isSafeInteger(result.skipped) || typeof result.truncated !== 'boolean' || (result.truncated && (typeof result.nextCursor !== 'string' || !result.nextCursor || result.nextCursor === cursor))) throw new Error('搜索结果格式无效');
      const page = make('div');
      page.append(make('p', `本次搜索 ${result.scanned} 篇笔记，命中 ${result.results.length} 篇${result.skipped ? `，${result.skipped} 篇读取失败` : ''}。`, 'muted'));
      for (const item of result.results) { const row = make('div', undefined, 'row'); const info = make('div'); info.append(make('strong', item.path), make('p', item.matches.map((match) => `${match.number}: ${match.line}`).join('\n'), 'muted')); row.append(info, action('查看', () => readKnowledge(item.path))); page.append(row); }
      if (!result.results.length) page.append(make('p', '本次扫描没有匹配的正文。', 'empty'));
      if (result.truncated) {
        const more = action('继续搜索', async () => {
          more.disabled = true; more.textContent = '正在搜索…';
          if (await loadPage(result.nextCursor)) more.remove();
          else if (sequence === knowledgeSearchSequence) { more.disabled = false; more.textContent = '重试继续搜索'; }
        });
        page.append(more);
      }
      if (cursor) target.append(page); else target.replaceChildren(page);
      return true;
    } catch (error) {
      if (sequence === knowledgeSearchSequence) {
        const notice = make('p', `正文搜索失败：${error.message}。`, 'error');
        if (cursor) target.append(notice); else target.replaceChildren(notice);
      }
      return false;
    }
  }
  try { await loadPage(); } finally { if (sequence === knowledgeSearchSequence) $('#knowledge-search').disabled = false; }
});
async function loadAccount() {
  if (sessionBusy) return;
  issuePage = 0;
  const contextRequest = ++contextSequence;
  ++pendingLinksSequence; $('#pending-links-list').replaceChildren(); $('#pending-links-status').textContent = '';
  ++reservationsSequence; $('#reservations-list').replaceChildren(); $('#reservations-status').textContent = '';
  $('#reservations-section').hidden = true;
  $('#reservations-load-error').hidden = true;
  const form = $('#search-form'); const selector = form.elements.projectId;
  const previousProject = selector.value;
  ++sessionSequence; if ($('#session-panel').open) $('#session-panel').close(); selectedIssue = null;
  ++searchSequence; ++sprintSequence; ++filterSequence; ++statusSequence; choerodonContext = null; selector.disabled = true; form.elements.sprintId.disabled = true; form.elements.typeId.disabled = true; form.elements.statusId.disabled = true; form.querySelector('[type="submit"]').disabled = true;
  issueRows = []; queriedIssues = []; renderDraftIssues();
  $('#search-result').replaceChildren(); $('#project-scope').textContent = '';
  $('#account-status').textContent = '正在获取猪齿鱼账号和项目…';
  try {
    const result = await call('choerodon_context');
    if (contextRequest !== contextSequence) return;
    choerodonContext = result;
    $('#auth-context').textContent = `最近确认的 Choerodon 账号：${result.identity.login || result.identity.userId}（用户 ID：${result.identity.userId}）；租户：${result.identity.tenantName || result.identity.tenantId}（${result.identity.tenantId}）；API 环境：${result.environment}。刷新失败后，此信息不代表当前登录仍有效。`;
    selector.replaceChildren(new Option('选择项目', ''));
    for (const project of result.projects.items) selector.add(new Option(`${project.name} (${project.code})`, project.id));
    selector.disabled = false;
    $('#account-status').textContent = `当前账号：${result.identity.login} · ${result.identity.tenantName}`;
    $('#project-scope').textContent = result.projects.complete ? '项目列表来自当前租户。' : '项目列表仅显示第一页，可能不完整。';
    if (result.projects.items.some((project) => project.id === previousProject)) selector.value = previousProject;
    else if (result.projects.items.length === 1) selector.value = result.projects.items[0].id;
    if (selector.value) { loadSprints(); loadIssueTypes(); }
    if (activeView === 'drafts') void refreshReservations();
  } catch (error) {
    if (contextRequest !== contextSequence) return;
    selector.replaceChildren(new Option('项目加载失败', ''));
    $('#account-status').textContent = `账号或项目加载失败：${error.message}`;
    $('#auth-help').open = true;
    $('#reservations-load-error').textContent = '暂时无法检查发布预留。请在「工作项」页刷新账号。';
    $('#reservations-load-error').hidden = false;
  }
}
$('#reload-account').addEventListener('click', loadAccount);
function invalidateSearch() {
  ++searchSequence;
  issueRows = []; queriedIssues = []; renderDraftIssues();
  $('#search-result').replaceChildren(make('p', '查询条件已变化，请重新查询。', 'muted'));
}
async function loadIssueTypes() {
  const form = $('#search-form'); const selector = form.elements.typeId; const statuses = form.elements.statusId;
  const projectId = form.elements.projectId.value; const sequence = ++filterSequence; ++statusSequence;
  issueTypes = []; selector.disabled = true; statuses.disabled = true;
  selector.replaceChildren(new Option('正在加载类型', '')); statuses.replaceChildren(new Option('请先选择类型', ''));
  $('#filter-status').textContent = '';
  if (!projectId || !choerodonContext) return;
  try {
    const result = await call('choerodon_issue_types', { projectId, userId: choerodonContext.identity.userId, tenantId: choerodonContext.identity.tenantId });
    if (sequence !== filterSequence) return;
    issueTypes = result.items;
    selector.replaceChildren(new Option('全部类型', ''));
    for (const item of result.items) selector.add(new Option(item.name, item.id));
    selector.disabled = false;
    void loadIssueStatuses();
  } catch (error) { if (sequence === filterSequence) { selector.replaceChildren(new Option('类型加载失败', '')); $('#filter-status').textContent = `类型加载失败：${error.message}。可刷新账号和项目重试。`; } }
}
async function loadIssueStatuses() {
  const form = $('#search-form'); const selector = form.elements.statusId; const typeId = form.elements.typeId.value;
  const sequence = ++statusSequence; selector.disabled = true;
  selector.replaceChildren(new Option('正在加载状态', '')); $('#filter-status').textContent = '';
  if (!choerodonContext || !form.elements.projectId.value) return;
  try {
    const typeIds = typeId ? [typeId] : issueTypes.map((item) => item.id);
    const results = await Promise.allSettled(typeIds.map((id) => call('choerodon_issue_statuses', { projectId: form.elements.projectId.value, typeId: id, userId: choerodonContext.identity.userId, tenantId: choerodonContext.identity.tenantId })));
    if (sequence !== statusSequence) return;
    const failures = results.flatMap((result, index) => result.status === 'rejected' ? [issueTypes.find((item) => item.id === typeIds[index])?.name || typeIds[index]] : []);
    if (failures.length === results.length && failures.length) throw new Error(`${failures.join('、')}状态无法加载`);
    selector.replaceChildren(new Option('全部状态', ''));
    const seen = new Set();
    for (const result of results) if (result.status === 'fulfilled') for (const item of result.value.items) {
      if (!seen.has(item.id)) { seen.add(item.id); selector.add(new Option(item.name, item.id)); }
    }
    selector.disabled = false;
    if (failures.length) $('#filter-status').textContent = `部分状态未加载（${failures.join('、')}），当前选项可能不完整。可选择具体类型重试。`;
  } catch (error) { if (sequence === statusSequence) { selector.replaceChildren(new Option('状态加载失败', '')); $('#filter-status').textContent = `状态加载失败：${error.message}。可重新选择类型重试。`; } }
}
async function loadSprints() {
  const form = $('#search-form'); const selector = form.elements.sprintId;
  const projectId = form.elements.projectId.value; const sequence = ++sprintSequence;
  const submit = form.querySelector('[type="submit"]');
  selector.disabled = true; submit.disabled = true;
  selector.replaceChildren(new Option(projectId ? '正在加载冲刺' : '请先选择项目', ''));
  if (!projectId || !choerodonContext) return;
  try {
    const result = await call('choerodon_sprints', { projectId, userId: choerodonContext.identity.userId, tenantId: choerodonContext.identity.tenantId });
    if (sequence !== sprintSequence) return;
    selector.replaceChildren(new Option('请选择冲刺范围', ''), new Option('全部冲刺', 'all'));
    for (const sprint of result.items) selector.add(new Option(`${sprint.name}${sprint.status === 'started' ? '（进行中）' : ''}`, sprint.id));
    const active = result.items.filter((sprint) => sprint.status === 'started');
    if (active.length === 1) selector.value = active[0].id;
    selector.disabled = false; submit.disabled = false;
    if (selector.value) form.requestSubmit();
    else $('#search-result').replaceChildren(make('p', active.length ? '存在多个进行中冲刺，请选择冲刺。' : '没有进行中冲刺，请选择冲刺或全部冲刺。', 'muted'));
  } catch (error) {
    if (sequence !== sprintSequence) return;
    selector.replaceChildren(new Option('冲刺加载失败', ''));
    $('#search-result').replaceChildren(make('p', `冲刺加载失败：${error.message}。请刷新账号和项目后重试。`, 'error'));
  }
}
$('#search-form').elements.projectId.addEventListener('change', (event) => {
  invalidateSearch();
  issuePage = 0;
  loadSprints();
  loadIssueTypes();
});
$('#search-form').elements.typeId.addEventListener('change', () => { issuePage = 0; invalidateSearch(); loadIssueStatuses(); });
$('#search-form').elements.statusId.addEventListener('change', () => { issuePage = 0; invalidateSearch(); });
$('#search-form').elements.sprintId.addEventListener('change', (event) => {
  issuePage = 0; invalidateSearch();
  if (event.currentTarget.value) event.currentTarget.form.requestSubmit();
});
$('#search-form').elements.scope.addEventListener('change', (event) => {
  issuePage = 0; invalidateSearch();
});
$('#search-form').elements.keyword.addEventListener('input', () => { issuePage = 0; invalidateSearch(); });
$('#search-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const form = event.currentTarget;
  if (!choerodonContext || !form.elements.projectId.value || !form.elements.sprintId.value || form.elements.sprintId.disabled) return;
  const sequence = ++searchSequence;
  const args = { projectId: form.elements.projectId.value, userId: choerodonContext.identity.userId, tenantId: choerodonContext.identity.tenantId, mine: form.elements.scope.value === 'mine', page: issuePage };
  if (form.elements.sprintId.value !== 'all') args.sprintId = form.elements.sprintId.value;
  if (form.elements.typeId.value) args.typeId = form.elements.typeId.value;
  if (form.elements.statusId.value) args.statusId = form.elements.statusId.value;
  const sprintName = form.elements.sprintId.selectedOptions[0].textContent;
  if (form.elements.keyword.value.trim()) args.keyword = form.elements.keyword.value.trim();
  const target = $('#search-result'); target.replaceChildren(make('p', '正在查询…', 'muted'));
  issueRows = [];
  try {
    const result = await call('choerodon_scoped_search', args);
    if (sequence !== searchSequence) return;
    target.replaceChildren();
    issueRows = []; queriedIssues = [];
    const project = choerodonContext.projects.items.find((item) => item.id === args.projectId);
    target.append(make('p', `${project?.name || args.projectId} · ${args.mine ? '分配给我' : '项目全部工作项'} · ${sprintName} · 关键词：${args.keyword || '不限'} · 显示 ${result.items.length} 条，接口返回 ${result.returnedCount} 条。工作列表可能包含关联项，分页数量不保证准确。`, 'muted'));
    if (!result.items.length) target.append(make('p', '本页没有匹配的工作项。', 'empty'));
    for (const item of result.items) {
      const row = make('article', undefined, 'row'); const details = make('div');
      details.append(make('strong', item.summary || item.issueNum || item.issueId), make('p', `${item.issueNum || item.issueId} · ${item.typeName || '类型未知'} · ${item.statusName || '状态未知'} · ${item.assigneeName || '未显示经办人'}`, 'muted'));
      const issue = { environment: choerodonContext.environment, tenantId: args.tenantId, projectId: args.projectId, issueId: item.issueId, title: item.summary || item.issueNum || item.issueId };
      queriedIssues.push(issue);
      const actions = make('div', undefined, 'actions');
      actions.append(action('知识记录', () => openNotesPanel(issue)), action('查看会话', () => openLinkedPanel(issue)), action('关联会话', () => openSessionPanel(issue)));
      row.append(details, actions); target.append(row);
    }
    const pagination = result.pagination;
    const pager = make('div', undefined, 'issue-pagination');
    const previous = action('上一页', () => { issuePage = args.page - 1; form.requestSubmit(); });
    previous.disabled = args.page === 0;
    const next = action('下一页', () => { issuePage = args.page + 1; form.requestSubmit(); });
    next.disabled = !Number.isSafeInteger(pagination?.totalPages) || args.page + 1 >= pagination.totalPages || args.page >= 1000000;
    pager.append(previous, make('span', `第 ${args.page + 1} 页${Number.isSafeInteger(pagination?.totalPages) ? ` / 共 ${Math.max(1, pagination.totalPages)} 页` : ''}`, 'muted'), next);
    target.append(pager);
    renderIssueSessions(); renderDraftIssues();
  } catch (error) { if (sequence !== searchSequence) return; target.replaceChildren(); message(error.message, true); }
});
function selectedCodexProject() {
  const option = $('#session-form').elements.codexProject.selectedOptions[0];
  return option?.dataset.projectId ? { id: option.dataset.projectId, cwd: option.dataset.cwd } : null;
}
function setSessionBusy(busy) {
  sessionBusy = busy;
  const form = $('#session-form');
  $('#reload-account').disabled = busy;
  form.elements.codexProject.disabled = (busy && !sessionLoading) || !codexProjects.length;
  form.elements.sessionSearch.disabled = (busy && !sessionLoading) || !selectedCodexProject();
  $('#session-search').disabled = (busy && !sessionLoading) || !selectedCodexProject();
  form.elements.sessionId.disabled = busy || !selectedCodexProject();
  form.querySelector('[type="submit"]').disabled = busy || !form.elements.sessionId.value;
  $('#create-session').disabled = busy || !selectedCodexProject() || !issueDetailReady || Boolean(creationAttempt) || Boolean(pendingCreation);
  $('#create-session').textContent = pendingCreation ? '正在创建…' : '创建会话并关联';
  $('#more-projects').disabled = busy;
  $('#more-sessions').disabled = busy;
  $('#project-link-add').disabled = busy || !selectedCodexProject();
  $('#project-links-more').disabled = busy;
  $('#project-links-refresh').disabled = busy;
}
async function loadProjectLinks(offset = 0) {
  const issue = selectedIssue; const context = choerodonContext; const sequence = ++projectLinksSequence;
  if (!issue || !context?.identity?.userId) return;
  const list = $('#project-links-list');
  $('#project-links-status').textContent = '正在加载关联工程…';
  $('#project-links-more').disabled = true;
  try {
    const result = await callReadWithTimeout('issue_project_links', { issue, userId: context.identity.userId, offset, limit: 20 });
    if (sequence !== projectLinksSequence || issue !== selectedIssue || context !== choerodonContext || !$('#session-panel').open) return;
    if (!Array.isArray(result?.items) || !(result.nextOffset === null || Number.isSafeInteger(result.nextOffset))) throw new Error('关联工程数据格式无效');
    if (!offset) list.replaceChildren();
    for (const item of result.items) {
      if (typeof item.projectId !== 'string' || typeof item.cwd !== 'string') continue;
      const row = make('div', undefined, 'row'); const details = make('div');
      const availability = make('p', '未检查工程目录；不代表远端权限。', 'muted');
      details.append(make('strong', item.projectName || item.projectId), make('p', item.cwd, 'muted'), availability);
      const check = action('检查工程目录', async () => {
        if (sessionBusy || issue !== selectedIssue || context !== choerodonContext) return;
        setSessionBusy(true); check.disabled = true; availability.textContent = '正在检查工程目录…';
        try {
          const result = await callReadWithTimeout('issue_project_link_check', { issue, userId: context.identity.userId, projectId: item.projectId, cwd: item.cwd });
          if (issue !== selectedIssue || context !== choerodonContext || !$('#session-panel').open) return;
          availability.textContent = result.status === 'available' ? '当前进程可读取并进入目录；不代表远端权限。' : result.status === 'not_directory' ? '当前路径不是目录；关联仍保留。' : '当前进程无法访问目录；关联仍保留。';
        } catch (error) { if (issue === selectedIssue && context === choerodonContext) availability.textContent = `检查失败：${error.message}。关联仍保留，可重试。`; }
        finally { check.disabled = false; setSessionBusy(false); }
      });
      const remove = action('解除工程关联', async () => {
        if (sessionBusy || issue !== selectedIssue || context !== choerodonContext) return;
        if (!await confirmAction(`确认解除工作项“${issue.title}”与工程“${item.projectName || item.projectId}”（${item.cwd}）的关联？不会删除工程或会话。`)) return;
        if (issue !== selectedIssue || context !== choerodonContext || !$('#session-panel').open) return;
        setSessionBusy(true);
        try {
          await call('issue_project_link_remove', { issue, userId: context.identity.userId, projectId: item.projectId, cwd: item.cwd, confirmed: true });
          if (issue !== selectedIssue || context !== choerodonContext) return;
          if (await loadProjectLinks()) $('#project-links-status').textContent += ' 已解除关联。';
          else if (issue === selectedIssue && context === choerodonContext) $('#project-links-status').textContent = '已解除关联，但列表刷新失败，请刷新关联工程。';
        } catch (error) { if (issue === selectedIssue && context === choerodonContext) $('#project-links-status').textContent = `解除失败：${error.message}。请刷新后重试。`; }
        finally { setSessionBusy(false); }
      });
      const actions = make('div', undefined, 'actions'); actions.append(check, remove);
      row.append(details, actions); list.append(row);
    }
    projectLinksNextOffset = result.nextOffset; $('#project-links-more').hidden = projectLinksNextOffset === null;
    $('#project-links-status').textContent = result.total ? `共 ${result.total} 个关联工程。` : '尚未关联工程。';
    return true;
  } catch (error) { if (sequence === projectLinksSequence && issue === selectedIssue && context === choerodonContext) $('#project-links-status').textContent = `关联工程加载失败：${error.message}。请重试。`; }
  finally { if (sequence === projectLinksSequence) $('#project-links-more').disabled = false; }
}
$('#project-links-more').addEventListener('click', () => { if (projectLinksNextOffset !== null) void loadProjectLinks(projectLinksNextOffset); });
$('#project-links-refresh').addEventListener('click', () => { void loadProjectLinks(); });
$('#project-link-add').addEventListener('click', async () => {
  const issue = selectedIssue; const context = choerodonContext; const project = selectedCodexProject();
  if (sessionBusy || !issue || !context?.identity?.userId || !project) return;
  if (!await confirmAction(`确认将工程“${project.cwd}”关联到工作项“${issue.title}”？不会创建或修改会话。`)) return;
  if (issue !== selectedIssue || context !== choerodonContext || !$('#session-panel').open || JSON.stringify(project) !== JSON.stringify(selectedCodexProject())) return;
  setSessionBusy(true);
  try {
    await call('issue_project_link_add', { issue, userId: context.identity.userId, projectId: project.id, cwd: project.cwd, confirmed: true });
    if (issue !== selectedIssue || context !== choerodonContext) return;
    if (await loadProjectLinks()) $('#project-links-status').textContent += ' 已保存关联。';
    else if (issue === selectedIssue && context === choerodonContext) $('#project-links-status').textContent = '已保存关联，但列表刷新失败，请刷新关联工程。';
  } catch (error) { if (issue === selectedIssue && context === choerodonContext) $('#project-links-status').textContent = `关联失败：${error.message}。请核对项目后重试。`; }
  finally { setSessionBusy(false); }
});
async function openSessionPanel(issue) {
  if (sessionBusy) return;
  selectedIssue = issue; creationAttempt = null; codexProjects = []; projectCursor = null; sessionSearchTerm = ''; sessionLoading = false; ++sessionSequence;
  const panel = $('#session-panel'); const form = $('#session-form');
  panel.showModal(); form.reset();
  $('#selected-issue').textContent = issue.title;
  void loadIssueDetail(issue);
  form.elements.codexProject.replaceChildren(new Option('正在加载项目', ''));
  form.elements.sessionId.replaceChildren(new Option('请选择项目', ''));
  $('#session-status').textContent = pendingCreation ? '已有创建请求尚未结束，请勿重复创建；可在关联管理中查看创建记录。' : ''; $('#more-projects').hidden = true; $('#more-sessions').hidden = true;
  $('#project-links-list').replaceChildren(); $('#project-links-more').hidden = true; projectLinksNextOffset = null;
  void loadProjectLinks();
  await loadCodexProjects();
}
async function loadIssueDetail(issue) {
  const sequence = ++issueDetailSequence;
  issueDetailReady = false;
  $('#issue-detail').hidden = true; $('#issue-detail-status').textContent = '正在加载工作项详情…';
  try {
    const result = await call('choerodon_scoped_issue_detail', { issue, userId: choerodonContext.identity.userId });
    if (sequence !== issueDetailSequence || !$('#session-panel').open) return;
    if (typeof result?.detail !== 'string' || !result.detail.trim()) throw new Error('详情格式无效');
    $('#issue-detail').textContent = result.detail; $('#issue-detail').hidden = false; $('#issue-detail-status').textContent = ''; issueDetailReady = true;
  } catch (error) { if (sequence === issueDetailSequence && $('#session-panel').open) $('#issue-detail-status').textContent = `详情加载失败：${error.message}。请核对后重试。`; }
  finally { if (sequence === issueDetailSequence && $('#session-panel').open && !sessionBusy) setSessionBusy(false); }
}
async function loadCodexProjects(cursor) {
  const sequence = sessionSequence; setSessionBusy(true);
  try {
    const result = await call('codex_projects', cursor ? { cursor } : {});
    if (sequence !== sessionSequence) return;
    const selector = $('#session-form').elements.codexProject;
    if (!cursor) selector.replaceChildren(new Option('请选择 Codex 项目', ''));
    for (const project of result.data) {
      codexProjects.push(project);
      for (const root of project.roots) {
        const option = new Option(`${project.name} · ${root}`, `${project.id}\n${root}`);
        option.dataset.projectId = project.id; option.dataset.cwd = root; selector.add(option);
      }
    }
    projectCursor = result.nextCursor; $('#more-projects').hidden = !projectCursor;
    if (!codexProjects.length) $('#session-status').textContent = '没有可用的 Codex 项目。';
  } catch (error) { if (sequence === sessionSequence) $('#session-status').textContent = `项目加载失败：${error.message}`; }
  finally { if (sequence === sessionSequence) setSessionBusy(false); }
}
async function loadSessions(cursor) {
  const form = $('#session-form'); const project = selectedCodexProject(); const sequence = ++sessionSequence;
  if (!project) { sessionLoading = false; setSessionBusy(false); return; }
  if (!cursor) {
    sessionSearchTerm = form.elements.sessionSearch.value.trim(); sessionCursor = null;
    form.elements.sessionId.replaceChildren(new Option('请选择已有会话', '')); $('#more-sessions').hidden = true;
  }
  sessionLoading = true;
  setSessionBusy(true); $('#session-status').textContent = '正在加载会话…';
  try {
    const result = await call('codex_sessions', { cwd: project.cwd, ...(sessionSearchTerm ? { searchTerm: sessionSearchTerm } : {}), ...(cursor ? { cursor } : {}) });
    if (sequence !== sessionSequence) return;
    const selector = form.elements.sessionId;
    if (!cursor) selector.replaceChildren(new Option('请选择已有会话', ''));
    for (const session of result.data) selector.add(new Option(session.title || `未命名会话 (${session.id})`, session.id));
    sessionCursor = result.nextCursor; $('#more-sessions').hidden = !sessionCursor;
    $('#session-status').textContent = result.data.length ? '' : '未找到会话。';
  } catch (error) { if (sequence === sessionSequence) $('#session-status').textContent = `会话加载失败：${error.message}`; }
  finally { if (sequence === sessionSequence) { sessionLoading = false; setSessionBusy(false); } }
}
$('#more-projects').addEventListener('click', () => loadCodexProjects(projectCursor));
$('#more-sessions').addEventListener('click', () => loadSessions(sessionCursor));
$('#session-search').addEventListener('click', () => loadSessions());
$('#session-form').elements.sessionSearch.addEventListener('input', () => {
  ++sessionSequence; sessionCursor = null; $('#more-sessions').hidden = true;
  $('#session-form').elements.sessionId.replaceChildren(new Option('请搜索会话', ''));
  if (sessionLoading) { sessionLoading = false; setSessionBusy(false); }
  else setSessionBusy(sessionBusy);
});
$('#session-form').elements.sessionSearch.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') { event.preventDefault(); if (!$('#session-search').disabled) void loadSessions(); }
});
$('#session-form').elements.codexProject.addEventListener('change', () => {
  $('#session-form').elements.sessionId.replaceChildren(new Option('请选择已有会话', ''));
  $('#more-sessions').hidden = true; loadSessions();
});
$('#session-form').elements.sessionId.addEventListener('change', () => { setSessionBusy(false); renderDraftIssues(); });
function closeSessionPanel() {
  if (sessionBusy && !pendingCreation) return;
  if (pendingCreation) {
    message('创建仍在后台处理，关闭窗口不会取消。请勿重复创建，可在关联管理中核对结果。');
    setSessionBusy(false);
  }
  ++sessionSequence; ++issueDetailSequence; ++projectLinksSequence; $('#session-panel').close(); selectedIssue = null;
}
$('#cancel-session').addEventListener('click', closeSessionPanel);
$('#close-session').addEventListener('click', closeSessionPanel);
$('#session-panel').addEventListener('cancel', (event) => {
  event.preventDefault(); closeSessionPanel();
});
$('#session-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const form = event.currentTarget; const project = selectedCodexProject();
  if (sessionBusy || !selectedIssue || !project || !form.elements.sessionId.value) return;
  const issue = selectedIssue; const userId = choerodonContext.identity.userId;
  const sessionId = form.elements.sessionId.value; const sessionTitle = form.elements.sessionId.selectedOptions[0]?.textContent || sessionId;
  const primary = form.elements.primary.checked; const sequence = sessionSequence; const context = contextSequence;
  if (!await confirmAction(`确认关联以下会话？\n工作项：${issue.title}\n环境：${issue.environment}\n租户 ID：${issue.tenantId}\n项目 ID：${issue.projectId}\n工作项 ID：${issue.issueId}\n用户 ID：${userId}\n工程 ID：${project.id}\n工程目录：${project.cwd}\n会话：${sessionTitle}（${sessionId}）\n主工作项：${primary ? '是' : '否'}`)) return;
  const currentProject = selectedCodexProject();
  if (sessionBusy || !$('#session-panel').open || sequence !== sessionSequence || context !== contextSequence || selectedIssue !== issue || choerodonContext?.identity?.userId !== userId || currentProject?.id !== project.id || currentProject?.cwd !== project.cwd || form.elements.sessionId.value !== sessionId || (form.elements.sessionId.selectedOptions[0]?.textContent || sessionId) !== sessionTitle || form.elements.primary.checked !== primary) {
    if ($('#session-panel').open) $('#session-status').textContent = '关联信息已变化，请重新选择并确认。';
    return;
  }
  setSessionBusy(true);
  try {
    await call('codex_link_session', { issue, userId, sessionId, cwd: project.cwd, primary, confirmed: true });
    $('#session-panel').close(); selectedIssue = null; await refreshAfterSave('会话关联已保存');
  } catch (error) { $('#session-status').textContent = `关联失败：${error.message}`; }
  finally { setSessionBusy(false); }
});
$('#create-session').addEventListener('click', async () => {
  const form = $('#session-form'); const project = selectedCodexProject();
  if (sessionBusy || !selectedIssue || !project || !issueDetailReady || creationAttempt || pendingCreation) return;
  const issue = selectedIssue; const userId = choerodonContext.identity.userId; const primary = form.elements.primary.checked; const confirmationSequence = sessionSequence; const context = contextSequence;
  const initialMessage = [`工作项：${issue.title}`, `环境：${issue.environment}`, `租户 ID：${issue.tenantId}`, `项目 ID：${issue.projectId}`, `工作项 ID：${issue.issueId}`, ...(issue.url ? [`工作项链接：${issue.url}`] : []), '请先了解这个工作项，等待我的进一步指示。'].join('\n');
  if (!await confirmAction(`确认创建会话并关联？\n用户 ID：${userId}\n工程 ID：${project.id}\n工程目录：${project.cwd}\n主工作项：${primary ? '是' : '否'}\n\n将发送以下消息：\n\n${initialMessage}`)) return;
  const currentProject = selectedCodexProject();
  if (sessionBusy || !$('#session-panel').open || confirmationSequence !== sessionSequence || context !== contextSequence || selectedIssue !== issue || choerodonContext?.identity?.userId !== userId || currentProject?.id !== project.id || currentProject?.cwd !== project.cwd || form.elements.primary.checked !== primary || !issueDetailReady || creationAttempt || pendingCreation) {
    if ($('#session-panel').open) $('#session-status').textContent = '创建信息已变化，请重新选择并确认。';
    return;
  }
  creationAttempt = crypto.randomUUID(); pendingCreation = creationAttempt; setSessionBusy(true);
  $('#session-status').textContent = '正在创建会话并保存关联，完成后自动打开。您可以关闭窗口；请勿重复创建。';
  $('#session-status').scrollIntoView({ block: 'nearest' });
  const attemptId = creationAttempt;
  const sequence = sessionSequence;
  const slowTimer = setTimeout(() => {
    if (sequence !== sessionSequence || pendingCreation !== attemptId) return;
    $('#session-status').textContent = '创建请求仍在处理，您可以关闭此窗口。请勿重复创建，并在关联管理中核对创建记录。';
    setSessionBusy(false);
  }, 8000);
  let polling = false;
  let opened = false;
  let unresolved = false;
  let confirmedCreated = false;
  function creationMessage(attempt) {
    const prefix = '会话已创建并关联；';
    switch (attempt.messageStatus) {
      case 'completed': return `${prefix}初始消息已完成。`;
      case 'failed': return `${prefix}初始消息执行失败，请打开会话核查。`;
      case 'unknown': return `${prefix}初始消息结果不确定，请打开会话核查，勿重复发送。`;
      case 'not_sent': return `${prefix}初始消息尚未发送，请在关联管理中核查并按需重试。`;
      default: return `${prefix}初始消息正在处理，请勿重复发送。`;
    }
  }
  async function showCreated(attempt, detail) {
    if (!$('#session-panel').open || sequence !== sessionSequence || attemptId !== creationAttempt) return;
    $('#session-status').replaceChildren(document.createTextNode(detail));
    $('#session-status').append(action('打开新会话', () => openCreatedSession(attempt.sessionId)));
    setSessionBusy(false);
    if (!opened) { opened = true; await openCreatedSession(attempt.sessionId); }
  }
  const timer = setInterval(async () => {
    if (polling) return;
    polling = true;
    try {
      const attempt = await call('codex_creation_attempt', { attemptId });
      if (attempt.status === 'linked' && attempt.sessionId) {
        clearInterval(timer);
        confirmedCreated = true;
        if (pendingCreation === attemptId) pendingCreation = null;
        if (sequence !== sessionSequence) {
          message('会话已创建并关联，请在工作项的“查看会话”中打开。');
          if ($('#session-panel').open && !sessionBusy) setSessionBusy(false);
        }
        await showCreated(attempt, creationMessage(attempt));
      }
    } catch {} finally { polling = false; }
  }, 2000);
  try {
    const result = await call('codex_create_link', { attemptId: creationAttempt, issue, userId, projectId: project.id, cwd: project.cwd, primary, initialMessage, confirmed: true });
    if (result.status === 'linked') confirmedCreated = true;
    if (sequence !== sessionSequence) {
      message(result.status === 'linked' ? '会话已创建并关联，请在工作项的“查看会话”中打开。' : '会话创建结果需要核对，请在关联管理中查看创建记录，勿重复创建。', result.status !== 'linked');
      if (result.status === 'linked') { try { await refresh(); } catch { message('会话已创建并关联，但列表刷新失败，请重新打开页面。', true); } }
      return;
    }
    if (result.status === 'linked') {
      if (result.sessionId) await showCreated(result, creationMessage(result));
      await refresh();
    } else {
      $('#session-status').textContent = `创建状态：${result.status}。${result.recoverySessionId ? `已返回会话 ID：${result.recoverySessionId}，请记录此 ID。` : ''}请勿重复创建，在关联管理中核对创建记录。`;
      await refreshAttempts();
    }
  } catch (error) {
    unresolved = !confirmedCreated;
    if (confirmedCreated) message('会话已创建并关联，但列表刷新失败，请重新打开页面查看。', true);
    else if (sequence === sessionSequence) $('#session-status').textContent = `创建结果待核对：${error.message}。请勿重复创建。`;
    else message('会话创建结果待核对，请在关联管理中查看创建记录，勿重复创建。', true);
  }
  finally {
    clearTimeout(slowTimer); clearInterval(timer);
    if (!unresolved && pendingCreation === attemptId) pendingCreation = null;
    if (sequence === sessionSequence || ($('#session-panel').open && !sessionBusy)) setSessionBusy(false);
  }
});
$('#draft-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const form = event.currentTarget;
  if (form.dataset.busy === 'true') return;
  form.dataset.busy = 'true'; savingDraft = true; form.inert = true;
  const savedState = currentDraftState();
  try {
    const args = { title: form.elements.title.value, target: form.elements.target.value, content: form.elements.content.value, confirmed: true, issues: draftIssues, sourceSession: draftSession };
    if (editing) Object.assign(args, { id: editing.id, status: editing.status, expectedRevision: editing.revision });
    else { pendingDraftId ||= crypto.randomUUID(); args.id = pendingDraftId; }
    await call('local_save_draft', args); if (savedState === currentDraftState()) resetDraft(); await refreshAfterSave('草稿已保存');
  } catch (error) { message(`${error.message}。如结果不确定，请先重新打开页面核对草稿。`, true); }
  finally { form.dataset.busy = 'false'; savingDraft = false; form.inert = false; }
});
$('#cancel-edit').addEventListener('click', async () => {
  if (savingDraft) return;
  const state = currentDraftState();
  if ((!draftChanged() || await confirmAction('当前草稿有未保存的修改，确定清空？')) && !savingDraft && state === currentDraftState()) resetDraft();
});
app.connect().then(async () => {
  $('#connection').textContent = '已连接';
  loadAccount();
  try { await refresh(); } catch (error) { message(error.message, true); }
}).catch(() => { $('#connection').textContent = '连接失败'; message('无法连接 Codex 宿主，请重新打开页面。', true); });
