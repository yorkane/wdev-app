// 诊断日志工具集中在这里，保证 gateway 各模块输出的时间戳和脱敏规则一致。
function diagnosticTimestamp() {
  return new Date().toISOString();
}

function shortId(value) {
  const text = typeof value === "string" ? value : "";
  if (!text) return "";
  if (text.length <= 16) return text;
  return `${text.slice(0, 8)}...${text.slice(-4)}`;
}

function redactUrlLikeString(value) {
  const text = String(value);
  try {
    const parsed = new URL(text, "http://opencodex.local");
    // URL 里可能携带登录 token，日志只保留定位慢请求所需的路径和普通 query 形状。
    for (const key of ["token", "auth", "authorization", "code", "access_token", "refresh_token"]) {
      if (parsed.searchParams.has(key)) parsed.searchParams.set(key, "[redacted]");
    }
    if (text.startsWith("http://") || text.startsWith("https://") || text.startsWith("ws://") || text.startsWith("wss://")) {
      return parsed.toString();
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return text.replace(/([?&](?:token|auth|authorization|code|access_token|refresh_token)=)[^&]+/gi, "$1[redacted]");
  }
}

function sanitizeDiagnosticValue(key, value) {
  if (value == null) return value;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? Math.round(value) : undefined;
  if (typeof value === "string") {
    const sanitized = /url|href/i.test(key) ? redactUrlLikeString(value) : value;
    return sanitized.length > 320 ? `${sanitized.slice(0, 320)}...` : sanitized;
  }
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === "object") {
    try {
      const json = JSON.stringify(value);
      return json.length > 320 ? `${json.slice(0, 320)}...` : json;
    } catch {
      return "[unserializable]";
    }
  }
  return String(value);
}

function sanitizeDiagnosticDetails(details) {
  if (!details || typeof details !== "object" || Array.isArray(details)) return {};
  const result = {};
  for (const [key, value] of Object.entries(details)) {
    const sanitized = sanitizeDiagnosticValue(key, value);
    if (sanitized !== undefined) result[key] = sanitized;
  }
  return result;
}

function diagnosticLine(scope, event, details) {
  const safeDetails = sanitizeDiagnosticDetails(details);
  const suffix = Object.keys(safeDetails).length > 0 ? ` ${JSON.stringify(safeDetails)}` : "";
  return `[${diagnosticTimestamp()}] [${scope}] ${event}${suffix}`;
}

function diagnosticLog(scope, event, details) {
  console.log(diagnosticLine(scope, event, details));
}

function diagnosticWarn(scope, event, details) {
  console.warn(diagnosticLine(scope, event, details));
}

function diagnosticError(scope, event, details) {
  console.error(diagnosticLine(scope, event, details));
}

module.exports = {
  diagnosticError,
  diagnosticLog,
  diagnosticTimestamp,
  diagnosticWarn,
  sanitizeDiagnosticValue,
  shortId,
};
