/**
 * OAuth 2.1 (PKCE) 授权服务器逻辑 —— 持久化存储在 Supabase「晏安的数据库」
 * (project ref: segsimuoukrovxrgbjfw)，表名 mcp_oauth_store，service='supabase-mcp'。
 *
 * 与 sue1231511/zeabur-mcp 仓库共用同一张表：service 字段区分归属服务，
 * record_type 字段区分记录种类 (client / auth_code / access_token / refresh_token)。
 *
 * 原内存态实现 (Map 存 client/auth_code/token) 在 Zeabur 每次重新部署或容器重启后
 * 会被清空，导致 Claude 端缓存的旧 access_token 全部失效、鉴权返回 401——这是
 * 本次改造要修的问题，详见 2026-07-02 的排查记录。
 *
 * 安全说明：这张表已开启 RLS 且未配置任何 policy，只有 service_role key 能穿透
 * RLS 访问，anon/publishable key 完全读不到，因此这里必须用 service_role key
 * (OAUTH_STORE_SUPABASE_SERVICE_ROLE_KEY)，不能用 anon key。
 */
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { logInfo, logWarn, logError } from './logger.js';

const SERVICE_NAME = 'supabase-mcp';
const TABLE_NAME = 'mcp_oauth_store';

const AUTH_CODE_TTL_SECONDS = 5 * 60;
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 天
const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 365; // 1 年

const SUPABASE_URL = (process.env.OAUTH_STORE_SUPABASE_URL || '').trim();
const SUPABASE_SERVICE_ROLE_KEY = (process.env.OAUTH_STORE_SUPABASE_SERVICE_ROLE_KEY || '').trim();

let _client = null;

function getStoreClient() {
  if (_client) return _client;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    const err = new Error(
      'OAUTH_STORE_SUPABASE_URL / OAUTH_STORE_SUPABASE_SERVICE_ROLE_KEY 未配置，OAuth 持久化存储不可用，请在 Zeabur 环境变量里配置'
    );
    logError('oauth.getStoreClient', '初始化失败', err);
    throw err;
  }
  try {
    _client = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    logInfo('oauth.getStoreClient', 'Supabase 客户端初始化成功');
    return _client;
  } catch (error) {
    logError('oauth.getStoreClient', '创建 Supabase 客户端异常', error);
    throw error;
  }
}

function randomToken(prefix) {
  return `${prefix}_${crypto.randomBytes(32).toString('base64url')}`;
}

function futureIso(seconds) {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

export async function registerClient({ client_name, redirect_uris }) {
  if (!Array.isArray(redirect_uris) || redirect_uris.length === 0) {
    throw new Error('redirect_uris 不能为空');
  }
  const client_id = randomToken('client');
  const client_name_final = client_name || 'unnamed-mcp-client';
  const record = {
    client_id,
    client_name: client_name_final,
    redirect_uris,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    created_at: Date.now(),
  };
  try {
    const supabase = getStoreClient();
    const { error } = await supabase.from(TABLE_NAME).insert({
      service: SERVICE_NAME,
      record_type: 'client',
      key: client_id,
      client_id,
      client_name: client_name_final,
      redirect_uris,
    });
    if (error) throw error;
    logInfo('oauth.registerClient', '新客户端注册', { client_id, client_name: client_name_final });
    return record;
  } catch (error) {
    logError('oauth.registerClient', '写入 Supabase 失败', error, { client_name, redirect_uris });
    throw error;
  }
}

export async function getClient(client_id) {
  // 查询失败（数据库异常）时往上抛出，不吞掉——调用方需要区分
  // "client_id 确实不存在" 和 "存储层出故障了" 这两种不同情况。
  try {
    const supabase = getStoreClient();
    const { data, error } = await supabase
      .from(TABLE_NAME)
      .select('client_id, client_name, redirect_uris')
      .eq('service', SERVICE_NAME)
      .eq('record_type', 'client')
      .eq('key', client_id)
      .limit(1);
    if (error) throw error;
    if (!data || data.length === 0) return null;
    const row = data[0];
    return {
      client_id: row.client_id,
      client_name: row.client_name,
      redirect_uris: row.redirect_uris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    };
  } catch (error) {
    logError('oauth.getClient', '查询 Supabase 失败', error, { client_id });
    throw error;
  }
}

export async function createAuthCode({ client_id, redirect_uri, code_challenge, code_challenge_method, scope }) {
  const code = randomToken('code');
  try {
    const supabase = getStoreClient();
    const { error } = await supabase.from(TABLE_NAME).insert({
      service: SERVICE_NAME,
      record_type: 'auth_code',
      key: code,
      client_id,
      redirect_uri,
      code_challenge,
      code_challenge_method,
      scope,
      expires_at: futureIso(AUTH_CODE_TTL_SECONDS),
    });
    if (error) throw error;
    return code;
  } catch (error) {
    logError('oauth.createAuthCode', '写入 Supabase 失败', error, { client_id, redirect_uri });
    throw error;
  }
}

export async function consumeAuthCode(code) {
  // 原子消费：直接 DELETE 并链 .select() 让 PostgREST 把被删除的行随响应带回来，
  // 避免"先 SELECT 再 DELETE"两步操作之间的竞态窗口。
  // 注意：DELETE 默认 Prefer: return=minimal，不加 .select() 拿不到任何数据，
  // 这是这次实现里容易漏掉的一点，务必保留 .select()。
  try {
    const supabase = getStoreClient();
    const { data, error } = await supabase
      .from(TABLE_NAME)
      .delete()
      .eq('service', SERVICE_NAME)
      .eq('record_type', 'auth_code')
      .eq('key', code)
      .select();
    if (error) throw error;
    if (!data || data.length === 0) return null;
    const row = data[0];
    if (Date.now() > new Date(row.expires_at).getTime()) {
      logWarn('oauth.consumeAuthCode', '授权码已过期', { code });
      return null;
    }
    return {
      client_id: row.client_id,
      redirect_uri: row.redirect_uri,
      code_challenge: row.code_challenge,
      code_challenge_method: row.code_challenge_method,
      scope: row.scope,
    };
  } catch (error) {
    logError('oauth.consumeAuthCode', '操作 Supabase 失败', error, { code });
    throw error;
  }
}

function verifyPkce(codeVerifier, codeChallenge, method) {
  if (method !== 'S256') return false;
  const computed = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  return computed === codeChallenge;
}

export function verifyPkceOrThrow(codeVerifier, codeChallenge, method) {
  if (!verifyPkce(codeVerifier, codeChallenge, method)) {
    throw new Error('PKCE 校验失败: code_verifier 和 code_challenge 对不上');
  }
}

export async function issueTokens() {
  const access_token = randomToken('at');
  const refresh_token = randomToken('rt');
  try {
    const supabase = getStoreClient();
    const { error } = await supabase.from(TABLE_NAME).insert([
      {
        service: SERVICE_NAME,
        record_type: 'access_token',
        key: access_token,
        expires_at: futureIso(ACCESS_TOKEN_TTL_SECONDS),
      },
      {
        service: SERVICE_NAME,
        record_type: 'refresh_token',
        key: refresh_token,
        expires_at: futureIso(REFRESH_TOKEN_TTL_SECONDS),
      },
    ]);
    if (error) throw error;
    return {
      access_token,
      refresh_token,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
    };
  } catch (error) {
    logError('oauth.issueTokens', '写入 Supabase 失败', error);
    throw error;
  }
}

export async function rotateRefreshToken(refresh_token) {
  try {
    const supabase = getStoreClient();
    const { data, error } = await supabase
      .from(TABLE_NAME)
      .delete()
      .eq('service', SERVICE_NAME)
      .eq('record_type', 'refresh_token')
      .eq('key', refresh_token)
      .select();
    if (error) throw error;
    if (!data || data.length === 0) return null;
    const row = data[0];
    if (Date.now() > new Date(row.expires_at).getTime()) {
      return null;
    }
    return await issueTokens();
  } catch (error) {
    logError('oauth.rotateRefreshToken', '操作 Supabase 失败', error, { refresh_token });
    throw error;
  }
}

export async function isAccessTokenValid(token) {
  // 鉴权高频路径：fail-closed，任何异常（含 Supabase 暂时不可用）一律按
  // "无效" 处理，拒绝比放行安全；但异常必须完整记录日志，方便和
  // "token 确实无效/过期" 这种正常业务情况区分开，不能真的把异常吞掉不留痕迹。
  try {
    const supabase = getStoreClient();
    const { data, error } = await supabase
      .from(TABLE_NAME)
      .select('expires_at')
      .eq('service', SERVICE_NAME)
      .eq('record_type', 'access_token')
      .eq('key', token)
      .limit(1);
    if (error) throw error;
    if (!data || data.length === 0) return false;
    if (Date.now() > new Date(data[0].expires_at).getTime()) return false;
    return true;
  } catch (error) {
    logError('oauth.isAccessTokenValid', '查询 Supabase 异常，按无效处理', error);
    return false;
  }
}
