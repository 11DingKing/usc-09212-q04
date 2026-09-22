import assert from "node:assert/strict";
import { createServer } from "../src/server.mjs";
import { evidenceSigningString, hmacSha256hex } from "../src/util.mjs";

export const ADMIN_TOKEN = "test-admin-token";

export const TOKENS = {
  admin: ADMIN_TOKEN,
  buyer: "token-buyer-1",
  supplier: "token-supplier-1",
  lab: "token-lab-1",
  observer: "token-observer-1",
};

export const ROBOT_SECRET = "robot-secret-1";

export async function startApp(options = {}) {
  const server = createServer({ persist: false, adminToken: ADMIN_TOKEN, ...options });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    server,
    base,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

export async function api(base, method, path, { token, body } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await response.json();
  } catch {
    // 无响应体
  }
  return { status: response.status, body: json };
}

export function signEvent(secret, { eventId, runId, segment, seq, occurredAt, payload }) {
  return hmacSha256hex(secret, evidenceSigningString({ eventId, runId, segment, seq, occurredAt, payload }));
}

// 构造一条带签名的证据事件请求体（runId/segment 参与签名但不放在请求体里）。
export function makeEvent(secret, { eventId, runId, segment = 1, seq, kind, occurredAt, payload }) {
  return {
    eventId,
    seq,
    kind,
    occurredAt,
    payload,
    signature: signEvent(secret, { eventId, runId, segment, seq, occurredAt, payload }),
  };
}

export async function uploadEvent(base, projectId, runId, event, { secret = ROBOT_SECRET, token = TOKENS.lab } = {}) {
  return api(base, "POST", `/projects/${projectId}/runs/${runId}/events`, { token, body: event });
}

export const BASELINE = {
  siteConstraints: [{ metric: "lighting_lux", comparator: ">=", threshold: 300 }],
  successCriteria: [
    { criterionId: "cr-cycle", metric: "cycle_time_s", comparator: "<=", threshold: 45, aggregation: "max" },
    { criterionId: "cr-steps", metric: "step_ok_rate", comparator: ">=", threshold: 0.9 },
  ],
};

export const SCRIPT_V1 = {
  steps: [
    { stepId: "pick", params: { speed: 1 } },
    { stepId: "place", params: { speed: 1 } },
  ],
  checkpoints: [{ checkpointId: "cp-home" }],
};

export function bookingWindow(hours = 1) {
  const now = Date.now();
  return {
    startsAt: new Date(now - hours * 3_600_000).toISOString(),
    endsAt: new Date(now + hours * 3_600_000).toISOString(),
  };
}

// 搭建一个可立即开跑的项目：身份、项目、成员、封存基线、机器人、脚本、资源与预约。
export async function setupProject(base, { projectId = "p1" } = {}) {
  for (const [identityId, org] of [
    ["buyer-1", "buyer-co"],
    ["supplier-1", "supplier-co"],
    ["lab-1", "lab-co"],
    ["observer-1", "observer-co"],
  ]) {
    const res = await api(base, "POST", "/identities", {
      token: TOKENS.admin,
      body: { identityId, org, token: `token-${identityId}` },
    });
    assert.equal(res.status, 201);
  }

  let res = await api(base, "POST", "/projects", {
    token: TOKENS.admin,
    body: { projectId, name: `项目 ${projectId}`, buyerIdentityId: "buyer-1" },
  });
  assert.equal(res.status, 201);

  for (const [identityId, role] of [
    ["supplier-1", "supplier"],
    ["lab-1", "lab"],
    ["observer-1", "observer"],
  ]) {
    res = await api(base, "POST", `/projects/${projectId}/members`, {
      token: TOKENS.buyer,
      body: { identityId, role },
    });
    assert.equal(res.status, 201);
  }

  res = await api(base, "PUT", `/projects/${projectId}/baseline`, { token: TOKENS.buyer, body: BASELINE });
  assert.equal(res.status, 200);
  res = await api(base, "POST", `/projects/${projectId}/baseline/seal`, { token: TOKENS.buyer });
  assert.equal(res.status, 200);
  const baselineHash = res.body.hash;
  assert.match(baselineHash, /^[0-9a-f]{64}$/);

  res = await api(base, "POST", `/projects/${projectId}/robots`, {
    token: TOKENS.supplier,
    body: { robotId: "robot-1", model: "ARM-X", firmwareVersion: "1.0.0", deviceSecret: ROBOT_SECRET },
  });
  assert.equal(res.status, 201);

  res = await api(base, "POST", `/projects/${projectId}/scripts`, {
    token: TOKENS.lab,
    body: { scriptId: "script-1", version: "v1", content: SCRIPT_V1 },
  });
  assert.equal(res.status, 201);
  const scriptHash = res.body.hash;

  res = await api(base, "POST", "/resources", {
    token: TOKENS.admin,
    body: { resourceId: "cell-1", lab: "lab-sh" },
  });
  assert.equal(res.status, 201);

  res = await api(base, "POST", `/projects/${projectId}/bookings`, {
    token: TOKENS.lab,
    body: { bookingId: "b-1", resourceId: "cell-1", ...bookingWindow(1) },
  });
  assert.equal(res.status, 201);

  return { projectId, baselineHash, scriptHash };
}

export async function startRun(base, projectId, runId, overrides = {}) {
  return api(base, "POST", `/projects/${projectId}/runs`, {
    token: TOKENS.lab,
    body: { runId, robotId: "robot-1", scriptId: "script-1", resourceId: "cell-1", bookingId: "b-1", ...overrides },
  });
}
