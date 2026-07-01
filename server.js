import 'dotenv/config';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerAllTools } from './src/tools.js';
import { logError, logInfo, logWarn } from './src/logger.js';
import {
  registerClient,
  getClient,
  createAuthCode,
  consumeAuthCode,
  verifyPkceOrThrow,
  issueTokens,
  rotateRefreshToken,
  isAccessTokenValid,
} from './src/oauth.js';
import { renderAuthorizePage } from './src/authorizePage.js';

const PORT = process.env.PORT || 3000;
const PROXY_SECRET = process.env.MCP_PROXY_SECRET;

function getBaseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

function createServer() {
  const server = new McpServer(
    { name: 'supabase-multi-org-mcp', version: '1.0.0' },
    { capabilities: {} }
  );
  registerAllTools(server);
  return server;
}

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'supabase-multi-org-mcp' });
});

app.get('/.well-known/oauth-authorization-server', (req, res) => {
  const base = getBaseUrl(req);
  res.json({
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
  });
});

app.get('/.well-known/oauth-protected-resource', (req, res) => {
  const base = getBaseUrl(req);
  res.json({
    resource: `${base}/mcp`,
    authorization_servers: [base],
  });
});

app.post('/register', (req, res) => {
  try {
    const { client_name, redirect_uris } = req.body || {};
    const client = registerClient({ client_name, redirect_uris });
    res.status(201).json({
      client_id: client.client_id,
      client_name: client.client_name,
      redirect_uris: client.redirect_uris,
      grant_types: client.grant_types,
      response_types: client.response_types,
      token_endpoint_auth_method: client.token_endpoint_auth_method,
    });
  } catch (error) {
    logError('server./register', '客户端注册失败', error, { body: req.body });
    res.status(400).json({ error: 'invalid_client_metadata', error_description: error.message });
  }
});

app.get('/authorize', (req, res) => {
  const { response_type, client_id, redirect_uri, code_challenge, code_challenge_method, state, scope } = req.query;

  if (response_type !== 'code') {
    return res.status(400).send('只支持 response_type=code');
  }
  const client = getClient(client_id);
  if (!client) {
    return res.status(400).send('未知的 client_id,请先完成动态客户端注册');
  }
  if (!client.redirect_uris.includes(redirect_uri)) {
    return res.status(400).send('redirect_uri 和注册时的不一致');
  }
  if (!code_challenge || code_challenge_method !== 'S256') {
    return res.status(400).send('缺少 PKCE 参数,或 code_challenge_method 不是 S256');
  }

  res.type('html').send(
    renderAuthorizePage({
      oauthParams: { response_type, client_id, redirect_uri, code_challenge, code_challenge_method, state, scope },
    })
  );
});

app.post('/authorize', (req, res) => {
  const { response_type, client_id, redirect_uri, code_challenge, code_challenge_method, state, scope, key } =
    req.body || {};

  if (!PROXY_SECRET) {
    logWarn('server.post./authorize', 'MCP_PROXY_SECRET 未配置,拒绝所有授权请求,请先在环境变量里配置');
    return res
      .type('html')
      .status(500)
      .send(
        renderAuthorizePage({
          oauthParams: { response_type, client_id, redirect_uri, code_challenge, code_challenge_method, state, scope },
          errorMessage: '服务器还没配置 MCP_PROXY_SECRET,无法完成授权,请先去 Zeabur 环境变量里配置。',
        })
      );
  }

  if (key !== PROXY_SECRET) {
    logWarn('server.post./authorize', '密钥不对,拒绝授权', { client_id });
    return res.type('html').status(401).send(
      renderAuthorizePage({
        oauthParams: { response_type, client_id, redirect_uri, code_challenge, code_challenge_method, state, scope },
        errorMessage: '密钥不对,请重新输入。',
      })
    );
  }

  const client = getClient(client_id);
  if (!client || !client.redirect_uris.includes(redirect_uri)) {
    return res.status(400).send('client_id 或 redirect_uri 无效');
  }

  try {
    const code = createAuthCode({ client_id, redirect_uri, code_challenge, code_challenge_method, scope });
    const redirectUrl = new URL(redirect_uri);
    redirectUrl.searchParams.set('code', code);
    if (state) redirectUrl.searchParams.set('state', state);
    logInfo('server.post./authorize', '授权成功,重定向回客户端', { client_id });
    res.redirect(redirectUrl.toString());
  } catch (error) {
    logError('server.post./authorize', '生成授权码失败', error, { client_id });
    res.status(500).send('服务器内部错误');
  }
});

app.post('/token', (req, res) => {
  const { grant_type } = req.body || {};
  try {
    if (grant_type === 'authorization_code') {
      const { code, redirect_uri, client_id, code_verifier } = req.body;
      const record = consumeAuthCode(code);
      if (!record) {
        return res.status(400).json({ error: 'invalid_grant', error_description: '授权码无效或已过期' });
      }
      if (record.client_id !== client_id || record.redirect_uri !== redirect_uri) {
        return res.status(400).json({ error: 'invalid_grant', error_description: 'client_id 或 redirect_uri 不匹配' });
      }
      verifyPkceOrThrow(code_verifier, record.code_challenge, record.code_challenge_method);
      const tokens = issueTokens();
      logInfo('server.post./token', '颁发新令牌', { client_id, grant_type });
      return res.json(tokens);
    }

    if (grant_type === 'refresh_token') {
      const { refresh_token } = req.body;
      const tokens = rotateRefreshToken(refresh_token);
      if (!tokens) {
        return res.status(400).json({ error: 'invalid_grant', error_description: 'refresh_token 无效或已过期' });
      }
      logInfo('server.post./token', '刷新令牌成功', { grant_type });
      return res.json(tokens);
    }

    return res
      .status(400)
      .json({ error: 'unsupported_grant_type', error_description: `不支持的 grant_type: ${grant_type}` });
  } catch (error) {
    logError('server.post./token', '颁发令牌失败', error, { grant_type });
    return res.status(400).json({ error: 'invalid_grant', error_description: error.message });
  }
});

function checkAuth(req, res) {
  if (!PROXY_SECRET) {
    logWarn('server.checkAuth', 'MCP_PROXY_SECRET 未配置,当前处于无鉴权状态,任何人拿到 URL 都能操作你的 Supabase');
    return true;
  }

  const authHeader = req.headers.authorization || '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : null;

  // 方式一:claude.ai 走完整 OAuth 流程拿到的动态令牌
  if (bearerToken && isAccessTokenValid(bearerToken)) {
    return true;
  }

  // 方式二:不支持 OAuth、但支持自定义请求头的客户端(比如 RikkaHub 之类),
  // 直接把 MCP_PROXY_SECRET 原文放进 Authorization: Bearer 头里,不用走 OAuth 握手,
  // 也不用把密钥暴露在 URL 里。
  if (bearerToken && bearerToken === PROXY_SECRET) {
    return true;
  }

  logWarn('server.checkAuth', '鉴权失败,拒绝请求', { hasBearer: Boolean(bearerToken) });
  res.status(401).json({
    jsonrpc: '2.0',
    error: {
      code: -32001,
      message:
        '鉴权失败:请在请求头里带 Authorization: Bearer <你的密钥>,或者通过 claude.ai 的 OAuth 授权流程获取令牌。URL 本身不再接受密钥参数。',
    },
    id: null,
  });
  return false;
}

app.post('/mcp', async (req, res) => {
  if (!checkAuth(req, res)) return;

  let server;
  let transport;
  try {
    server = createServer();
    transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    logError('server./mcp', '处理 MCP 请求失败', error, { hasBody: Boolean(req.body) });
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: '服务器内部错误' },
        id: null,
      });
    }
  } finally {
    res.on('close', () => {
      try {
        transport && transport.close();
        server && server.close();
      } catch (closeError) {
        logError('server./mcp', '关闭 transport/server 时出错', closeError);
      }
    });
  }
});

app.get('/mcp', (_req, res) => {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed, 这个服务是无状态的,只接受 POST。' },
    id: null,
  });
});

app.delete('/mcp', (_req, res) => {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed。' },
    id: null,
  });
});

app.listen(PORT, () => {
  logInfo('server.listen', `supabase-multi-org-mcp 已启动,监听端口 ${PORT}`);
  if (!process.env.SUPABASE_PAT) {
    logWarn('server.listen', 'SUPABASE_PAT 还没配置,所有工具调用现在都会失败,记得去 Zeabur 环境变量里加上');
  }
  if (!PROXY_SECRET) {
    logWarn('server.listen', 'MCP_PROXY_SECRET 还没配置,授权端点现在会拒绝所有人,记得尽快配置');
  }
  if (!process.env.PUBLIC_BASE_URL) {
    logWarn(
      'server.listen',
      'PUBLIC_BASE_URL 没配置,OAuth 元数据会尝试从请求头拼 URL,不完全可靠,建议显式配置成 Zeabur 分配的域名,例如 https://xxx.zeabur.app'
    );
  }
});

process.on('SIGINT', () => {
  logInfo('server.shutdown', '收到 SIGINT,正在关闭');
  process.exit(0);
});

process.on('SIGTERM', () => {
  logInfo('server.shutdown', '收到 SIGTERM,正在关闭');
  process.exit(0);
});
