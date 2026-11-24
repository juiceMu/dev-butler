const { createYuqueClient } = require('./src/yuque.cjs');
const { createKeychainTokenProvider } = require('./src/yuque-auth.cjs');

async function main() {
  const client = createYuqueClient({ tokenProvider: createKeychainTokenProvider() });
  const user = await client.getCurrentUser();
  if (!user || typeof user.login !== 'string' || !user.login) throw new Error('语雀身份响应缺少用户标识');
  console.log('语雀身份验证成功');
  const repositories = await client.listRepositories(user.login);
  if (!Array.isArray(repositories)) throw new Error('语雀知识库响应格式无效');
  console.log(`可列出个人知识库：${repositories.length} 个`);
  const repo = repositories.find((item) => typeof item.namespace === 'string');
  if (!repo) {
    console.log('未发现可检查的个人知识库，文档读取权限未验证');
    return;
  }
  const documents = await client.listDocuments(repo.namespace);
  if (!Array.isArray(documents)) throw new Error('语雀文档列表响应格式无效');
  console.log(`可列出一个知识库中的文档：${documents.length} 篇`);
  const doc = documents.find((item) => typeof item.slug === 'string');
  if (!doc) {
    console.log('该知识库没有可检查的文档，正文读取权限未验证');
    return;
  }
  await client.getDocument(repo.namespace, doc.slug);
  console.log('可读取一篇文档；未输出正文');
  console.log('未尝试写入，写入权限未验证');
}

main().catch((error) => {
  console.error(`验证失败：${error.message}`);
  process.exitCode = 1;
});
