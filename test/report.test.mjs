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

const at = (minute, second = 0) =>
  `2026-09-22T10:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}Z`;

async function runWithEvents(app, projectId, runId, events) {
  const run = await startRun(app.base, projectId, runId);
  assert.equal(run.status, 201);
  for (const event of events) {
    const res = await uploadEvent(app.base, projectId, runId, makeEvent("robot-secret-1", { runId, ...event }));
    assert.equal(res.status, 201, JSON.stringify(res.body));
  }
  await api(app.base, "POST", `/projects/${projectId}/runs/${runId}/complete`, { token: TOKENS.lab });
}

test("报告复算：失败归因区分环境故障、操作偏差与产品表现", async () => {
  const app = await startApp();
  try {
    const { projectId } = await setupProject(app.base);

    // run-a：失败前光照低于封存约束 -> 环境故障
    await runWithEvents(app, projectId, "run-a", [
      { eventId: "a-1", seq: 1, kind: "sensor", occurredAt: at(0), payload: { metric: "lighting_lux", value: 250 } },
      { eventId: "a-2", seq: 2, kind: "failure", occurredAt: at(0, 30), payload: { code: "VISION_LOST", category: "product_performance" } },
    ]);

    // run-b：步骤参数偏离登记脚本 -> 操作偏差
    await runWithEvents(app, projectId, "run-b", [
      { eventId: "b-1", seq: 1, kind: "sensor", occurredAt: at(5), payload: { metric: "lighting_lux", value: 500 } },
      { eventId: "b-2", seq: 2, kind: "step", occurredAt: at(5, 5), payload: { stepId: "pick", params: { speed: 9 }, result: "fail" } },
      { eventId: "b-3", seq: 3, kind: "failure", occurredAt: at(5, 6), payload: { stepId: "pick", code: "COLLISION" } },
    ]);

    // run-c：环境合规、操作符合脚本 -> 产品表现
    await runWithEvents(app, projectId, "run-c", [
      { eventId: "c-1", seq: 1, kind: "sensor", occurredAt: at(10), payload: { metric: "lighting_lux", value: 400 } },
      { eventId: "c-2", seq: 2, kind: "step", occurredAt: at(10, 5), payload: { stepId: "pick", params: { speed: 1 }, result: "ok" } },
      { eventId: "c-3", seq: 3, kind: "failure", occurredAt: at(10, 6), payload: { stepId: "place", code: "FORCE_LIMIT" } },
    ]);

    // run-d：违规传感出现在失败之后 -> 不算环境故障
    await runWithEvents(app, projectId, "run-d", [
      { eventId: "d-1", seq: 1, kind: "failure", occurredAt: at(15), payload: { code: "ESTOP" } },
      { eventId: "d-2", seq: 2, kind: "sensor", occurredAt: at(15, 10), payload: { metric: "lighting_lux", value: 100 } },
    ]);

    const report = await api(app.base, "GET", `/projects/${projectId}/report`, { token: TOKENS.buyer });
    assert.equal(report.status, 200);
    const byId = new Map(report.body.failures.map((f) => [f.failureEventId, f]));

    assert.equal(byId.get("a-2").classification, "environment_fault");
    assert.equal(byId.get("a-2").ruleId, "env-constraint-violation");
    assert.deepEqual(byId.get("a-2").evidenceIds, ["a-1"]);
    // 上传方自报的类别不影响复算结论，但保留对照
    assert.equal(byId.get("a-2").assertedCategory, "product_performance");

    assert.equal(byId.get("b-3").classification, "operator_deviation");
    assert.equal(byId.get("b-3").ruleId, "script-param-mismatch");
    assert.deepEqual(byId.get("b-3").evidenceIds, ["b-2"]);

    assert.equal(byId.get("c-3").classification, "product_performance");
    assert.equal(byId.get("c-3").ruleId, "no-external-cause");

    assert.equal(byId.get("d-1").classification, "product_performance");

    // 环境违规单独列出，便于买方评估场地质量
    assert.ok(report.body.environmentViolations.some((v) => v.eventId === "a-1"));

    // 快照后追加证据 -> 复算能检出结论变化
    const snapshot = await api(app.base, "POST", `/projects/${projectId}/reports`, {
      token: TOKENS.buyer,
      body: { snapshotId: "snap-1" },
    });
    assert.equal(snapshot.status, 201);

    await runWithEvents(app, projectId, "run-e", [
      { eventId: "e-1", seq: 1, kind: "sensor", occurredAt: at(20), payload: { metric: "cycle_time_s", value: 60 } },
    ]);

    const verify = await api(app.base, "GET", `/projects/${projectId}/reports/snap-1/verify`, { token: TOKENS.buyer });
    assert.equal(verify.status, 200);
    assert.equal(verify.body.matches, false);
    assert.ok(verify.body.changedConclusions.includes("round-1:cr-cycle"));

    // 未追加证据前复算一致（快照是对同一批证据的确定性复算）
    const snapshot2 = await api(app.base, "POST", `/projects/${projectId}/reports`, {
      token: TOKENS.buyer,
      body: { snapshotId: "snap-2" },
    });
    const verify2 = await api(app.base, "GET", `/projects/${projectId}/reports/snap-2/verify`, { token: TOKENS.buyer });
    assert.equal(verify2.body.matches, true);
    assert.notEqual(snapshot2.body.contentHash, null);
  } finally {
    await app.close();
  }
});
