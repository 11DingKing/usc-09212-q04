import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// 确定性 JSON 序列化：对象键排序，保证同一内容哈希稳定。
export function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

export function hashValue(value) {
  return sha256(canonical(value));
}

export function newKey() {
  return randomBytes(32).toString("hex");
}

export function sign(key, value) {
  return createHmac("sha256", key).update(canonical(value)).digest("hex");
}

export function verifySignature(key, value, signature) {
  const expected = Buffer.from(sign(key, value), "utf8");
  const actual = Buffer.from(String(signature ?? ""), "utf8");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
