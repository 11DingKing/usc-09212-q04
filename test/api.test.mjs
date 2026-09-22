import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { sign } from "../src/crypto.mjs";
import { createServer } from "../src/server.mjs";

const BUYER = { token: "dev-buyer-token" };
const SUPPLIER = { token: "dev-supplier-token" };
const OBSERVER = { token: "dev-observer-token" };
const OUTSIDER = { token: "dev-observer-2-token" };

async function api(server, method, pathname, { token, body } = {}) {
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
  server.eventStore.close();
}

function signedRecord(uploadKey, record) {
  return { ...record, signature: sign(uploadKey, record) };
}

const STEPS = [
  { stepId: "s1", name: "就位", safetyCheckpoint: true },
  { stepId: "s2", name: "抓取", safetyCheckpoint: false },
  { stepId: "s3", name: "放置", safetyCheckpoint: true },
];

async function setupProject(server) {
  assert.equal(
    (await api(server, "POST", "/projects", { ...BUYER, body: { projectId: "p1", name: "巡检验收" } })).status,
    201,
  );
  await api(server, "POST", "/projects/p1/grants", { ...BUYER, body: { principalId: "supplier-1", role: "supplier" } });
  await api(server, "POST", "/projects/p1/grants", { ...BUYER, body: { principalId: "observer-1", role: "observer" } });
  await api(server, "POST", "/projects/p1/criteria/seal", {
    ...BUYER,
    body: {
      siteConstraints: { floorFriction: ">=0.6" },
      successCriteria: [{ criteriaId: "c-place", rule: { type: "step_pass", stepId: "s3" } }],
    },
  });
  await api(server, "POST", "/projects/p1/robots", {
    ...SUPPLIER,
    body: { robotId: "robot-a", model: "ARM-7", firmwareVersion: "1.0.0" },
  });
  await api(server, "POST", "/projects/p1/scripts", { ...BUYER, body: { scriptId: "script-load", version: 1, steps: STEPS } });
  await api(server, "POST", "/projects/p1/reservations", {
    ...SUPPLIER,
    body: {
      reservationId: "res-1",
      labId: "lab-1",
      resourceId: "cell-1",
      start: "2026-09-22T08:00:00Z",
      end: "2026-09-22T12:00:00Z",
    },
  });
}

test("端到端：封存、登记、签名采集、断点重试、报告复算", async () => {
  const server = await listen(createServer());
  try {
    await setupProject(server);

    const run = await api(server, "POST", "/projects/p1/runs", {
      ...SUPPLIER,
      body: { runId: "run-1", robotId: "robot-a", scriptId: "script-load", reservationId: "res-1" },
    });
    assert.equal(run.status, 201);
    const { uploadKey, attemptId } = run.body;

    const batch1 = [
      signedRecord(uploadKey, { recordId: "r1", type: "step_result", runId: "run-1", attemptId, stepId: "s1", outcome: "pass", eventTime: "2026-09-22T09:00:00Z" }),
      signedRecord(uploadKey, { recordId: "r2", type: "step_result", runId: "run-1", attemptId, stepId: "s2", outcome: "fail", faultClass: "environment_fault", eventTime: "2026-09-22T09:01:00Z" }),
    ];
    assert.equal((await api(server, "POST", "/projects/p1/runs/run-1/records", { ...SUPPLIER, body: { records: batch1 } })).status, 200);

    await api(server, "POST", "/projects/p1/runs/run-1/interrupt", { ...SUPPLIER, body: { reason: "安全门触发" } });
    const retry = await api(server, "POST", "/projects/p1/runs/run-1/retry", { ...SUPPLIER, body: { fromStepId: "s1" } });
    assert.equal(retry.status, 201);
    const attempt2 = retry.body.attemptId;

    const batch2 = [
      signedRecord(uploadKey, { recordId: "r3", type: "step_result", runId: "run-1", attemptId: attempt2, stepId: "s2", outcome: "pass", eventTime: "2026-09-22T09:10:00Z" }),
      signedRecord(uploadKey, { recordId: "r4", type: "step_result", runId: "run-1", attemptId: attempt2, stepId: "s3", outcome: "pass", eventTime: "2026-09-22T09:11:00Z" }),
    ];
    await api(server, "POST", "/projects/p1/runs/run-1/records", { ...SUPPLIER, body: { records: batch2 } });
    await api(server, "POST", "/projects/p1/runs/run-1/complete", { ...SUPPLIER });

    const report = await api(server, "POST", "/projects/p1/report", { ...BUYER });
    assert.equal(report.status, 201);
    assert.equal(report.body.content.classifications.environment_fault.length, 1);
    assert.equal(report.body.content.conclusions.find((c) => c.criteriaId === "c-place").overall, "met");

    const verify = await api(server, "GET", "/projects/p1/report/verify", { ...OBSERVER });
    assert.equal(verify.body.match, true);

    // 失败记录仍完整保留
    const detail = await api(server, "GET", "/projects/p1/runs/run-1", { ...OBSERVER });
    assert.ok(detail.body.records.some((record) => record.recordId === "r2" && record.outcome === "fail"));
    assert.equal(detail.body.attempts.length, 2);
  } finally {
    await close(server);
  }
});

test("观察员权限按项目隔离", async () => {
  const server = await listen(createServer());
  try {
    await setupProject(server);
    // 买方再建一个未授权给 observer-1 的项目
    await api(server, "POST", "/projects", { ...BUYER, body: { projectId: "p2", name: "清洁验收" } });

    // 已授权项目：只读可用
    assert.equal((await api(server, "GET", "/projects/p1", { ...OBSERVER })).status, 200);
    // 未授权项目：拒绝
    assert.equal((await api(server, "GET", "/projects/p2", { ...OBSERVER })).status, 403);
    // 完全无关的观察员：两个项目都不可见
    assert.equal((await api(server, "GET", "/projects/p1", { ...OUTSIDER })).status, 403);
    // 观察员只读：写操作拒绝
    assert.equal(
      (await api(server, "POST", "/projects/p1/reservations", { ...OBSERVER, body: { reservationId: "res-x", labId: "lab-1", resourceId: "cell-9", start: "2026-09-23T08:00:00Z", end: "2026-09-23T09:00:00Z" } })).status,
      403,
    );
    // 供应商不能封存判据
    assert.equal(
      (await api(server, "POST", "/projects/p1/criteria/seal", { ...SUPPLIER, body: { siteConstraints: {}, successCriteria: [{ criteriaId: "c", rule: { type: "step_pass", stepId: "s1" } }] } })).status,
      403,
    );
    // 无凭证：拒绝
    assert.equal((await api(server, "GET", "/projects/p1")).status, 401);
  } finally {
    await close(server);
  }
});

test("服务恢复后继续上传，重传幂等", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "acceptance-"));
  let server;
  try {
    server = await listen(createServer({ dataDir: dir }));
    await setupProject(server);
    const run = await api(server, "POST", "/projects/p1/runs", {
      ...SUPPLIER,
      body: { runId: "run-1", robotId: "robot-a", scriptId: "script-load", reservationId: "res-1" },
    });
    const { uploadKey, attemptId } = run.body;
    const record1 = signedRecord(uploadKey, { recordId: "r1", type: "step_result", runId: "run-1", attemptId, stepId: "s1", outcome: "pass", eventTime: "2026-09-22T09:00:00Z" });
    await api(server, "POST", "/projects/p1/runs/run-1/records", { ...SUPPLIER, body: { records: [record1] } });
    await close(server);

    // 模拟服务重启：从同一数据目录恢复
    server = await listen(createServer({ dataDir: dir }));
    const project = await api(server, "GET", "/projects/p1", { ...OBSERVER });
    assert.equal(project.status, 200);
    assert.equal(project.body.runs[0].records, 1);

    // 客户端重传已确认记录 + 补传新记录
    const record2 = signedRecord(uploadKey, { recordId: "r2", type: "step_result", runId: "run-1", attemptId, stepId: "s2", outcome: "pass", eventTime: "2026-09-22T09:05:00Z" });
    const resumed = await api(server, "POST", "/projects/p1/runs/run-1/records", { ...SUPPLIER, body: { records: [record1, record2] } });
    assert.deepEqual(resumed.body.results, [
      { recordId: "r1", status: "duplicate" },
      { recordId: "r2", status: "recorded" },
    ]);
    const detail = await api(server, "GET", "/projects/p1/runs/run-1", { ...OBSERVER });
    assert.equal(detail.body.records.length, 2);
  } finally {
    if (server) await close(server);
    await rm(dir, { recursive: true, force: true });
  }
});
