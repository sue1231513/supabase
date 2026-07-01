// 统一日志模块。所有 try-catch 捕获到异常后，必须调用这里的 logError，
// 禁止空 catch、禁止裸 console.log 打日志。
// 格式: [时间][级别][位置] 消息 | 关键变量 | 异常堆栈
 
function timestamp() {
  return new Date().toISOString();
}
 
function serializeContext(context) {
  if (!context || Object.keys(context).length === 0) return '';
  try {
    return JSON.stringify(context, (_key, value) => {
      // 防止把 PAT/密钥意外打进日志
      if (typeof value === 'string' && /^sbp_[a-zA-Z0-9]+/.test(value)) {
        return '[REDACTED_PAT]';
      }
      return value;
    });
  } catch (serializeError) {
    return `[无法序列化的 context: ${String(serializeError)}]`;
  }
}
 
export function logInfo(location, message, context = {}) {
  console.log(`[${timestamp()}][INFO][${location}] ${message} | ${serializeContext(context)}`);
}
 
export function logWarn(location, message, context = {}) {
  console.warn(`[${timestamp()}][WARN][${location}] ${message} | ${serializeContext(context)}`);
}
 
// error 必须传入捕获到的异常对象，用于打印堆栈
export function logError(location, message, error, context = {}) {
  const stack = error && error.stack ? error.stack : String(error);
  console.error(
    `[${timestamp()}][ERROR][${location}] ${message} | ${serializeContext(context)} | 异常堆栈: ${stack}`
  );
}
