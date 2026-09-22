import crypto from "node:crypto";

export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function assertThat(condition, status, code, message, details) {
  if (!condition) {
    throw new HttpError(status, code, message, details);
  }
}

function sortValue(value) {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value !== null && typeof value === "object") {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortValue(value[key]);
    }
    return sorted;
  }
  return value;
}

// 规范化 JSON：键序稳定，用于哈希、签名与"同 body 幂等"比较。
export function canonicalJson(value) {
  return JSON.stringify(sortValue(value));
}

export function sha256hex(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

export function hmacSha256hex(secret, data) {
  return crypto.createHmac("sha256", secret).update(data).digest("hex");
}

export function safeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (!/^[0-9a-f]+$/i.test(a) || !/^[0-9a-f]+$/i.test(b)) return false;
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

export const COMPARATORS = new Set([">", ">=", "<", "<=", "==", "!="]);

export function compareValues(left, comparator, right) {
  switch (comparator) {
    case ">": return left > right;
    case ">=": return left >= right;
    case "<": return left < right;
    case "<=": return left <= right;
    case "==": return left === right;
    case "!=": return left !== right;
    default: throw new Error(`未知比较符: ${comparator}`);
  }
}

export function nowIso() {
  return new Date().toISOString();
}

export function isIsoDate(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

export function randomToken() {
  return crypto.randomBytes(24).toString("hex");
}

// 证据签名串：绑定事件标识、所属运行、分段、序号、事件时间与负载摘要。
// 重试上传同一事件会得到同一签名串；检查点重试开启新分段后签名域随之变化。
export function evidenceSigningString({ eventId, runId, segment, seq, occurredAt, payload }) {
  return [
    eventId,
    runId,
    String(segment),
    String(seq),
    occurredAt,
    sha256hex(canonicalJson(payload ?? {})),
  ].join("\n");
}
