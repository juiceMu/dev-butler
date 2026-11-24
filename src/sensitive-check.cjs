function detectSensitive(content) {
  if (typeof content !== 'string') throw new TypeError('内容无效');
  const found = [];
  if (/-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/.test(content)) found.push('私钥');
  if (/\bBearer\s+[A-Za-z0-9._~+\/-]{12,}={0,2}/i.test(content)) found.push('Bearer 凭据');
  if (/\b(?:api[_-]?key|access[_-]?token|secret[_-]?key|password|passwd)\b["']?\s*[:=]\s*["']?[^\s"'`,;]{8,}/i.test(content)) found.push('密码或访问密钥');
  return found;
}

module.exports = { detectSensitive };
