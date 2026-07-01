export function renderAuthorizePage({ oauthParams, errorMessage }) {
  const hiddenFields = Object.entries(oauthParams)
    .map(([key, value]) => `<input type="hidden" name="${key}" value="${escapeHtml(value || '')}" />`)
    .join('\n    ');

  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8" />
<title>授权 supabase-multi-org-mcp</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f5f5f0; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
  .card { background: white; border-radius: 12px; padding: 32px; max-width: 380px; width: 90%; box-shadow: 0 2px 12px rgba(0,0,0,0.08); }
  h1 { font-size: 18px; margin: 0 0 8px; }
  p { font-size: 14px; color: #666; margin: 0 0 20px; }
  input[type="password"] { width: 100%; padding: 10px 12px; border: 1px solid #ddd; border-radius: 8px; font-size: 14px; box-sizing: border-box; margin-bottom: 12px; }
  button { width: 100%; padding: 10px; border: none; border-radius: 8px; background: #d97757; color: white; font-size: 14px; cursor: pointer; }
  button:hover { background: #c56a4d; }
  .error { color: #c0392b; font-size: 13px; margin-bottom: 12px; }
</style>
</head>
<body>
  <div class="card">
    <h1>授权访问 Supabase 多组织 MCP</h1>
    <p>输入访问密钥(MCP_PROXY_SECRET)以完成授权。</p>
    ${errorMessage ? `<div class="error">${escapeHtml(errorMessage)}</div>` : ''}
    <form method="POST" action="/authorize">
    ${hiddenFields}
      <input type="password" name="key" placeholder="访问密钥" autofocus required />
      <button type="submit">授权</button>
    </form>
  </div>
</body>
</html>`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
