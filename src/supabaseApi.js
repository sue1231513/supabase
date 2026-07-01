import { logError, logInfo } from './logger.js';
 
const MANAGEMENT_API_BASE = 'https://api.supabase.com';
 
/**
 * 读取环境变量里的 Supabase PAT。
 * 因为 PAT 是账号级别的（不是组织级别的），只要 sue1231511 这个账号同时是
 * "sue1231511's" 和 "橘瓣插件" 两个组织的成员，一个 PAT 就能同时访问两边。
 */
function getPat() {
  const pat = process.env.SUPABASE_PAT;
  if (!pat) {
    const err = new Error(
      'SUPABASE_PAT 环境变量未配置。请在 Zeabur 的环境变量里添加 SUPABASE_PAT，值是 Supabase 后台 Account > Access Tokens 生成的 Personal Access Token。'
    );
    logError('supabaseApi.getPat', 'SUPABASE_PAT 缺失', err);
    throw err;
  }
  return pat;
}
 
/**
 * 调用 Supabase Management API 的通用封装。
 * @param {object} opts
 * @param {'GET'|'POST'|'DELETE'|'PATCH'|'PUT'} opts.method
 * @param {string} opts.path - 形如 /v1/projects
 * @param {object} [opts.query] - query 参数
 * @param {object} [opts.body] - JSON body，会自动 JSON.stringify
 * @param {boolean} [opts.allowEmptyResponse] - 204/空响应体时是否允许返回 null
 */
export async function callManagementApi({ method, path, query, body, allowEmptyResponse = false }) {
  const url = new URL(MANAGEMENT_API_BASE + path);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }
  }
 
  const pat = getPat();
  const headers = {
    Authorization: `Bearer ${pat}`,
  };
  let fetchBody;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    fetchBody = JSON.stringify(body);
  }
 
  try {
    logInfo('supabaseApi.callManagementApi', '发起请求', { method, path, query });
    const res = await fetch(url.toString(), {
      method,
      headers,
      body: fetchBody,
    });
 
    const rawText = await res.text();
    let parsed = null;
    if (rawText) {
      try {
        parsed = JSON.parse(rawText);
      } catch (parseError) {
        // 有些端点在异常情况下会返回非 JSON 文本（比如网关错误页）
        logError('supabaseApi.callManagementApi', 'Management API 返回内容不是合法 JSON', parseError, {
          method,
          path,
          status: res.status,
          rawTextSnippet: rawText.slice(0, 300),
        });
        if (!res.ok) {
          throw new Error(`Supabase Management API 请求失败 (HTTP ${res.status})：${rawText.slice(0, 500)}`);
        }
        parsed = rawText;
      }
    }
 
    if (!res.ok) {
      const message =
        (parsed && (parsed.message || parsed.error || parsed.msg)) || `HTTP ${res.status} ${res.statusText}`;
      const err = new Error(`Supabase Management API 请求失败: ${message}`);
      logError('supabaseApi.callManagementApi', 'Management API 返回错误状态', err, {
        method,
        path,
        status: res.status,
        responseBody: parsed,
      });
      throw err;
    }
 
    if (!rawText) {
      if (allowEmptyResponse) return null;
      return {};
    }
 
    return parsed;
  } catch (error) {
    if (error && error.message && error.message.startsWith('Supabase Management API 请求失败')) {
      // 已经在上面记录过日志和包装过了，直接往外抛
      throw error;
    }
    logError('supabaseApi.callManagementApi', '请求 Supabase Management API 时发生网络/未知异常', error, {
      method,
      path,
    });
    throw new Error(`调用 Supabase Management API 时发生异常: ${error.message}`);
  }
}
 
/**
 * 部署 Edge Function 用的 multipart/form-data 请求（跟普通 JSON 请求走不同的封装，
 * 因为 Management API 的 deploy 端点要求 multipart body）。
 */
export async function deployEdgeFunctionMultipart({ projectRef, slug, entrypointPath, name, files, bundleOnly }) {
  const pat = getPat();
  const url = new URL(`${MANAGEMENT_API_BASE}/v1/projects/${projectRef}/functions/deploy`);
  url.searchParams.set('slug', slug);
  if (bundleOnly) {
    url.searchParams.set('bundleOnly', '1');
  }
 
  const form = new FormData();
  form.append(
    'metadata',
    JSON.stringify({
      entrypoint_path: entrypointPath || 'index.ts',
      name: name || slug,
    })
  );
  for (const file of files) {
    const blob = new Blob([file.content], { type: 'text/typescript' });
    form.append('file', blob, file.name);
  }
 
  try {
    logInfo('supabaseApi.deployEdgeFunctionMultipart', '发起部署请求', { projectRef, slug, fileCount: files.length });
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: { Authorization: `Bearer ${pat}` },
      body: form,
    });
    const rawText = await res.text();
    let parsed = null;
    try {
      parsed = rawText ? JSON.parse(rawText) : {};
    } catch (parseError) {
      logError('supabaseApi.deployEdgeFunctionMultipart', '返回内容不是合法 JSON', parseError, {
        projectRef,
        slug,
        status: res.status,
        rawTextSnippet: rawText.slice(0, 300),
      });
      parsed = rawText;
    }
    if (!res.ok) {
      const message = (parsed && (parsed.message || parsed.error)) || `HTTP ${res.status}`;
      const err = new Error(`部署 Edge Function 失败: ${message}`);
      logError('supabaseApi.deployEdgeFunctionMultipart', '部署失败', err, { projectRef, slug, status: res.status });
      throw err;
    }
    return parsed;
  } catch (error) {
    if (error && error.message && error.message.startsWith('部署 Edge Function 失败')) {
      throw error;
    }
    logError('supabaseApi.deployEdgeFunctionMultipart', '部署时发生网络/未知异常', error, { projectRef, slug });
    throw new Error(`部署 Edge Function 时发生异常: ${error.message}`);
  }
}
 
export function deriveProjectPublicUrl(ref) {
  return `https://${ref}.supabase.co`;
}
