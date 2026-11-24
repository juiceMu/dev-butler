const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const MarkdownIt = require('markdown-it');

const MAX_NOTE_BYTES = 4 * 1024 * 1024;
const markdown = new MarkdownIt({ html: false });
const recommendationCursors = new Map();
const RECOMMENDATION_TTL = 5 * 60 * 1000;
const MAX_RECOMMENDATION_ENTRIES = 10000;
const MAX_RECOMMENDATION_CURSORS = 8;

function relativePath(value, label) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0') || path.posix.isAbsolute(value)) {
    throw new Error(`${label}必须是相对路径`);
  }
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) throw new Error(`${label}包含无效路径段`);
  return parts.join('/');
}

function createMarkdownStore(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('知识库目录必须是绝对路径');
  const requestedRoot = path.resolve(root);
  const rootStat = fs.lstatSync(requestedRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error('知识库目录必须是非符号链接目录');
  }
  const resolvedRoot = fs.realpathSync(requestedRoot);

  function resolveExisting(relative, directory = false) {
    const name = relativePath(relative, '路径');
    let current = resolvedRoot;
    for (const part of name.split('/')) {
      current = path.join(current, part);
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error('不允许访问符号链接');
    }
    const stat = fs.statSync(current);
    if (directory ? !stat.isDirectory() : !stat.isFile()) throw new Error('路径类型无效');
    return current;
  }

  function noteName(value) {
    const name = relativePath(value, '笔记路径');
    if (!name.toLowerCase().endsWith('.md')) throw new Error('笔记必须使用 Markdown 文件扩展名');
    return name;
  }

  function read(name) {
    const relative = noteName(name);
    const file = resolveExisting(relative);
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_NOTE_BYTES) throw new Error('笔记不是普通文件或超过大小限制');
      const content = fs.readFileSync(fd, 'utf8');
      return { path: relative, content, revision: crypto.createHash('sha256').update(content).digest('hex') };
    } finally { fs.closeSync(fd); }
  }

  function list() {
    const notes = [];
    function visit(directory, prefix = '') {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) visit(resolveExisting(relative, true), relative);
        else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) notes.push(relative);
      }
    }
    visit(resolvedRoot);
    return notes.sort();
  }

  function browse({ directory = '', cursor, limit = 100 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('浏览上限必须为 1 到 200');
    if (directory && relativePath(directory, '目录').split('/').some((part) => part.startsWith('.'))) throw new Error('不允许浏览隐藏目录');
    if (cursor !== undefined && (typeof cursor !== 'string' || cursor.includes('/') || cursor.includes('\\') || cursor.includes('\0'))) throw new Error('浏览游标无效');
    const absolute = directory ? resolveExisting(directory, true) : resolvedRoot;
    const entries = [];
    // 每次只枚举当前目录，包含空目录，不读取笔记正文或递归扫描知识库。
    const handle = fs.opendirSync(absolute);
    let entry;
    try {
      while ((entry = handle.readSync())) {
        if (entry.name.startsWith('.') || entry.name.includes('\\') || entry.isSymbolicLink() || (!entry.isDirectory() && !(entry.isFile() && entry.name.toLowerCase().endsWith('.md')))) continue;
        if (cursor !== undefined && entry.name <= cursor) continue;
        entries.push({ name: entry.name, path: directory ? `${directory}/${entry.name}` : entry.name, kind: entry.isDirectory() ? 'directory' : 'note' });
        entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
        if (entries.length > limit + 1) entries.pop();
      }
    } finally { handle.closeSync(); }
    const hasMore = entries.length > limit;
    const items = entries.slice(0, limit);
    return { directory, items, nextCursor: hasMore ? items.at(-1).name : null };
  }

  function search(query, { limit = 200, cursor } = {}) {
    if (typeof query !== 'string' || !query.trim() || query.length > 200) throw new Error('搜索内容必须是不超过 200 字符的非空字符串');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('搜索上限必须为 1 到 200');
    const needle = query.toLocaleLowerCase(); const results = []; let scanned = 0; let skipped = 0;
    if (cursor !== undefined) noteName(cursor);
    const names = list().filter((name) => cursor === undefined || name > cursor);
    let lastScanned;
    for (const name of names) {
      if (scanned + skipped >= limit) break;
      lastScanned = name;
      try {
        const note = read(name); scanned++;
        const matches = [];
        const lines = note.content.split(/\r?\n/);
        for (let index = 0; index < lines.length && matches.length < 5; index++) {
          const position = lines[index].toLocaleLowerCase().indexOf(needle);
          if (position < 0) continue;
          const start = Math.max(0, position - 80);
          matches.push({ line: `${start ? '…' : ''}${lines[index].slice(start, start + 320)}${lines[index].length > start + 320 ? '…' : ''}`, number: index + 1 });
        }
        if (matches.length) results.push({ path: note.path, revision: note.revision, matches });
      } catch { skipped++; }
    }
    const truncated = names.length > scanned + skipped;
    return { query, results, scanned, skipped, truncated, nextCursor: truncated ? lastScanned : null };
  }

  function recommendLocations({ title = '', project = '', keywords = [], limit = 10, scanLimit = 500, cursor } = {}) {
    if (typeof title !== 'string' || title.length > 200 || typeof project !== 'string' || project.length > 200 ||
        !Array.isArray(keywords) || keywords.length > 10 || keywords.some((word) => typeof word !== 'string' || word.length > 100) ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 20 || !Number.isSafeInteger(scanLimit) || scanLimit < 1 || scanLimit > 1000) {
      throw new Error('推荐条件无效');
    }
    const titleParts = title.trim().match(/[\p{L}\p{N}]+/gu) || [];
    const titleTerms = [title.trim(), ...titleParts.filter((value) => value.length >= 2)];
    for (const part of titleParts) {
      if (/^[\u3400-\u9fff]{3,}$/.test(part)) {
        for (let index = 0; index < part.length - 1 && titleTerms.length < 40; index++) titleTerms.push(part.slice(index, index + 2));
      }
    }
    const terms = [
      ...Array.from(new Set(titleTerms.filter(Boolean))).map((value) => ({ type: 'title', value, weight: value === title.trim() ? 3 : 1 })),
      { type: 'project', value: project.trim(), weight: 2 },
      ...keywords.map((value) => ({ type: 'keyword', value: value.trim(), weight: 1 })),
    ].filter((term) => term.value);
    if (!terms.length) throw new Error('至少提供一个推荐条件');
    const signature = JSON.stringify([resolvedRoot, title, project, keywords]);
    const now = Date.now();
    for (const [key, value] of recommendationCursors) if (value.expires <= now) recommendationCursors.delete(key);
    let state;
    if (cursor !== undefined) {
      if (typeof cursor !== 'string' || !(state = recommendationCursors.get(cursor)) || state.signature !== signature) throw new Error('推荐游标无效或已过期');
      recommendationCursors.delete(cursor);
    } else {
      const queue = [{ relative: '', depth: 0 }];
      const paths = [];
      let visited = 0; let skipped = 0; let truncated = false;
      while (queue.length && visited < MAX_RECOMMENDATION_ENTRIES) {
        const { relative, depth } = queue.shift();
        let directory;
        try { directory = fs.opendirSync(relative ? resolveExisting(relative, true) : resolvedRoot); }
        catch { skipped++; continue; }
        try {
          let entry;
          while (visited < MAX_RECOMMENDATION_ENTRIES && (entry = directory.readSync()) !== null) {
            visited++;
            if (entry.isSymbolicLink() || entry.name.startsWith('.') || entry.name.includes('\\') || entry.name.includes('\0')) continue;
            const candidatePath = relative ? `${relative}/${entry.name}` : entry.name;
            if (candidatePath.length > 1000) { skipped++; continue; }
            const isDirectory = entry.isDirectory();
            if (!isDirectory && !(entry.isFile() && entry.name.toLowerCase().endsWith('.md'))) continue;
            paths.push({ path: candidatePath, kind: isDirectory ? 'directory' : 'note' });
            if (isDirectory) {
              if (depth < 7) queue.push({ relative: candidatePath, depth: depth + 1 });
              else truncated = true;
            }
          }
          if (visited >= MAX_RECOMMENDATION_ENTRIES) truncated = true;
        } catch { skipped++; }
        finally { directory.closeSync(); }
      }
      paths.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
      state = { signature, paths, offset: 0, skipped, truncated, expires: now + RECOMMENDATION_TTL };
    }
    const candidates = [];
    const start = state.offset;
    while (state.offset < state.paths.length && state.offset - start < scanLimit && candidates.length < limit) {
      const entry = state.paths[state.offset++];
      const normalized = entry.path.toLocaleLowerCase();
      const matches = terms.filter((term) => normalized.includes(term.value.toLocaleLowerCase()));
      if (matches.length) candidates.push({ ...entry, score: matches.reduce((total, term) => total + term.weight, 0), reasons: matches.map(({ type, value }) => ({ type, value })) });
    }
    candidates.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    let nextCursor = null;
    if (state.offset < state.paths.length) {
      while (recommendationCursors.size >= MAX_RECOMMENDATION_CURSORS) recommendationCursors.delete(recommendationCursors.keys().next().value);
      nextCursor = crypto.randomUUID();
      recommendationCursors.set(nextCursor, state);
    }
    return { candidates, scanned: state.offset - start, skipped: state.skipped, truncated: state.truncated, nextCursor };
  }

  function validateAttachments(notePath, attachments) {
    const note = noteName(notePath);
    if (!Array.isArray(attachments) || attachments.length > 1000) throw new Error('附件路径列表无效');
    return attachments.map((attachment) => {
      if (typeof attachment !== 'string' || !attachment || attachment.includes('\\') || attachment.includes('\0') || path.posix.isAbsolute(attachment) || /^[a-z][a-z\d+.-]*:/i.test(attachment)) {
        throw new Error('附件必须使用知识库内的相对路径');
      }
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(note), attachment));
      relativePath(target, '附件路径');
      resolveExisting(target);
      return attachment;
    });
  }

  function inspectContentReferences(name, content) {
    const relative = noteName(name);
    if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_NOTE_BYTES) throw new Error('笔记内容无效或超过大小限制');
    const references = [];
    for (const block of markdown.parse(content, {})) {
      for (const token of block.children || []) {
        const kind = token.type === 'image' ? 'image' : token.type === 'link_open' ? 'link' : null;
        if (!kind) continue;
        if (references.length >= 1000) throw new Error('引用数量超过检查上限');
        const destination = token.attrGet(kind === 'image' ? 'src' : 'href') || '';
        let status; let resolvedPath;
        if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(destination)) status = 'external';
        else if (destination.startsWith('#')) status = 'fragment';
        else {
          try {
            const pathname = decodeURIComponent(destination.split(/[?#]/, 1)[0]);
            if (!pathname || pathname.includes('\\') || pathname.includes('\0') || path.posix.isAbsolute(pathname)) throw new Error('invalid');
            resolvedPath = path.posix.normalize(path.posix.join(path.posix.dirname(relative), pathname));
            relativePath(resolvedPath, '引用路径');
            resolveExisting(resolvedPath);
            status = 'available';
          } catch (error) {
            status = error.code === 'ENOENT' ? 'missing' : 'invalid';
            resolvedPath = undefined;
          }
        }
        references.push({ kind, destination, status, ...(resolvedPath ? { path: resolvedPath } : {}) });
      }
    }
    return { path: relative, revision: crypto.createHash('sha256').update(content).digest('hex'), references };
  }
  function inspectReferences(name) { const note = read(name); return inspectContentReferences(note.path, note.content); }

  function prepare({ path: name, content, attachments = [] }) {
    const relative = noteName(name);
    if (typeof content !== 'string' || !content.trim() || Buffer.byteLength(content) > MAX_NOTE_BYTES) throw new Error('笔记内容无效或超过大小限制');
    validateAttachments(relative, attachments);
    const parent = path.posix.dirname(relative);
    const parentDirectory = parent === '.' ? resolvedRoot : resolveExisting(parent, true);
    return { relative, parentDirectory };
  }

  function create({ path: name, content, confirmed, attachments = [] }) {
    if (confirmed !== true) throw new Error('创建笔记前必须明确确认');
    const { relative, parentDirectory } = prepare({ path: name, content, attachments });
    const file = path.join(parentDirectory, path.posix.basename(relative));
    const temporary = path.join(parentDirectory, `.codex-note-${crypto.randomUUID()}.tmp`);
    const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
    try {
      try { fs.writeFileSync(fd, content, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.linkSync(temporary, file);
    } finally {
      try { fs.unlinkSync(temporary); } catch {}
    }
    try {
      const directory = fs.openSync(parentDirectory, 'r');
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    } catch {
      throw new Error('笔记目录同步失败，写入结果需要核查');
    }
    return { path: relative, revision: crypto.createHash('sha256').update(content).digest('hex') };
  }

  return { list, browse, read, search, recommendLocations, create, prepare, validateAttachments, inspectReferences, inspectContentReferences };
}

module.exports = { createMarkdownStore };
