import assert from "node:assert/strict";
import test from "node:test";
import {
  api,
  makeEvent,
  setupProject,
  startApp,
  startRun,
  TOKENS,
  uploadEvent,
} from "./helpers.mjs";

test("端到端验收流程：封存基线 -> 登记 -> 运行 -> 签名证据 -> 报告与快照复算", async () => {
  const app = await startApp();
  try {
    const { projectId, baselineHash } = await setupProject(app.base);

    // 基线封存后不可修改
    const reseal = await api(app.base, "PUT", `/projects/${projectId}/baseline`, {
      token: TOKENS.buyer,
      body: { siteConstraints: [], successCriteria: [] },
    });
    assert.equal(reseal.status, 409);
    assert.equal(reseal.body.error.code, "baseline_sealed");

    // 开启运行，自动进入第 1 轮
    const run = await startRun(app.base, projectId, "run-1");
    assert.equal(run.status, 201);
    assert.equal(run.body.roundNumber, 1);
    assert.equal(run.body.nextSeq, 1);

    // 上传带签名的步骤与传感结果
    const events = [
      { eventId: "e-1", seq: 1, kind: "checkpoint", occurredAt: "2026-09-22T10:00:00Z", payload: { checkpointId: "cp-home" } },
      { eventId: "e-2", seq: 2, kind: "step", occurredAt: "2026-09-22T10:00:05Z", payload: { stepId: "pick", params: { speed: 1 }, result: "ok" } },
      { eventId: "e-3", seq: 3, kind: "sensor", occurredAt: "2026-09-22T10:00:06Z", payload: { metric: "lighting_lux", value: 420 } },
      { eventId: "e-4", seq: 4, kind: "sensor", occurredAt: "2026-09-22T10:00:20Z", payload: { metric: "cycle_time_s", value: 38 } },
      { eventId: "e-5", seq: 5, kind: "step", occurredAt: "2026-09-22T10:00:25Z", payload: { stepId: "place", params: { speed: 1 }, result: "ok" } },
    ];
    for (const event of events) {
      const res = await uploadEvent(app.base, projectId, "run-1", makeEvent("robot-secret-1", { runId: "run-1", ...event }));
      assert.equal(res.status, 201, JSON.stringify(res.body));
    }

    const done = await api(app.base, "POST", `/projects/${projectId}/runs/run-1/complete`, { token: TOKENS.lab });
    assert.equal(done.status, 200);

    // 报告：结论可复算，携带证据标识
    const report = await api(app.base, "GET", `/projects/${projectId}/report`, { token: TOKENS.observer });
    assert.equal(report.status, 200);
    assert.equal(report.body.baselineHash, baselineHash);
    assert.match(report.body.contentHash, /^[0-9a-f]{64}$/);
    const cycle = report.body.conclusions.find((c) => c.conclusionId === "round-1:cr-cycle");
    const steps = report.body.conclusions.find((c) => c.conclusionId === "round-1:cr-steps");
    assert.equal(cycle.verdict, "pass");
    assert.equal(steps.verdict, "pass");
    assert.deepEqual(cycle.runs[0].evidenceIds, ["e-4"]);
    assert.deepEqual(steps.runs[0].evidenceIds, ["e-2", "e-5"]);
    assert.deepEqual(report.body.failures, []);

    // 买方生成报告快照，随后复算一致
    const snapshot = await api(app.base, "POST", `/projects/${projectId}/reports`, {
      token: TOKENS.buyer,
      body: { snapshotId: "snap-1" },
    });
    assert.equal(snapshot.status, 201);
    assert.equal(snapshot.body.contentHash, report.body.contentHash);

    const verify = await api(app.base, "GET", `/projects/${projectId}/reports/snap-1/verify`, { token: TOKENS.supplier });
    assert.equal(verify.status, 200);
    assert.equal(verify.body.matches, true);
    assert.deepEqual(verify.body.changedConclusions, []);

    // 争议处理：供应商对结论提出争议，买方结案
    const dispute = await api(app.base, "POST", `/projects/${projectId}/disputes`, {
      token: TOKENS.supplier,
      body: { disputeId: "d-1", subjectType: "conclusion", subjectId: "round-1:cr-cycle", claim: "现场计时起点不一致" },
    });
    assert.equal(dispute.status, 201);
    const resolved = await api(app.base, "POST", `/projects/${projectId}/disputes/d-1/resolve`, {
      token: TOKENS.buyer,
      body: { resolution: "以签名传感数据为准，维持原结论", outcome: "rejected" },
    });
    assert.equal(resolved.status, 200);
    assert.equal(resolved.body.status, "resolved");

    // 审计记录完整且不含密钥
    const audit = await api(app.base, "GET", `/projects/${projectId}/audit`, { token: TOKENS.observer });
    assert.equal(audit.status, 200);
    const types = audit.body.records.map((record) => record.type);
    assert.ok(types.includes("baseline_sealed"));
    assert.ok(types.includes("run_event_appended"));
    assert.ok(types.includes("dispute_resolved"));
    assert.ok(!JSON.stringify(audit.body).includes("robot-secret-1"));
  } finally {
    await app.close();
  }
});
