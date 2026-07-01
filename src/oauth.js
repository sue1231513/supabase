import crypto from 'node:crypto';
import { logInfo, logWarn } from './logger.js';

const clients = new Map();
const authCodes = new Map();
const accessTokens = new Map();
const refreshTokens = new Map();

const AUTH_CODE_TTL_MS = 5 * 60 * 1000;
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;
const REFRESH_TOKEN_TTL_MS = 60 * 60 * 24 * 365 * 1000;

function randomToken(prefix) {
  return `${prefix}_${crypto.randomBytes(32).toString('base64url')}`;
}

export function registerClient({ client_name, redirect_uris }) {
  if (!Array.isArray(redirect_uris) || redirect_uris.length === 0) {
    throw new Error('redirect_uris 不能为空');
  }
  const client_id = randomToken('client');
  const record = {
    client_id,
    client_name: client_name || 'unnamed-mcp-client',
    redirect_uris,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    created_at: Date.now(),
  };
  clients.set(client_id, record);
  logInfo('oauth.registerClient', '新客户端注册', { client_id, client_name: record.client_name });
  return record;
}

export function getClient(client_id) {
  return clients.get(client_id) || null;
}

export function createAuthCode({ client_id, redirect_uri, code_challenge, code_challenge_method, scope }) {
  const code = randomToken('code');
  authCodes.set(code, {
    client_id,
    redirect_uri,
    code_challenge,
    code_challenge_method,
    scope,
    expiresAt: Date.now() + AUTH_CODE_TTL_MS,
  });
  return code;
}

export function consumeAuthCode(code) {
  const record = authCodes.get(code);
  if (!record) return null;
  authCodes.delete(code);
  if (Date.now() > record.expiresAt) {
    logWarn('oauth.consumeAuthCode', '授权码已过期', { code });
    return null;
  }
  return record;
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

export function issueTokens() {
  const access_token = randomToken('at');
  const refresh_token = randomToken('rt');
  accessTokens.set(access_token, { expiresAt: Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000 });
  refreshTokens.set(refresh_token, { expiresAt: Date.now() + REFRESH_TOKEN_TTL_MS });
  return {
    access_token,
    refresh_token,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
  };
}

export function rotateRefreshToken(refresh_token) {
  const record = refreshTokens.get(refresh_token);
  if (!record) return null;
  if (Date.now() > record.expiresAt) {
    refreshTokens.delete(refresh_token);
    return null;
  }
  refreshTokens.delete(refresh_token);
  return issueTokens();
}

export function isAccessTokenValid(token) {
  const record = accessTokens.get(token);
  if (!record) return false;
  if (Date.now() > record.expiresAt) {
    accessTokens.delete(token);
    return false;
  }
  return true;
}
