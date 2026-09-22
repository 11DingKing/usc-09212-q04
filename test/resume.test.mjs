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

test("中断后从安全检查点重试：失败记录保留且不可选择性删除", async () => {
  const app = await startApp();
  try {
    const { projectId } = await setupProject(app.base);
    await startRun(app.base, projectId, "run-1");

    const at = (s) => `2026-09-22T10:00:${String(s).padStart(2, "0")}Z`;
    const send = (event) => uploadEvent(app.base, projectId, "run-1", event);

    // 分段 1：到达检查点 -> 执行步骤 -> 发生失败 -> 中断
    assert.equal((await send(makeEvent("robot-secret-1", { eventId: "e-1", runId: "run-1", seq: 1, kind: "checkpoint", occurredAt: at(1), payload: { checkpointId: "cp-home" } }))).status, 201);
    assert.equal((await send(makeEvent("robot-secret-1", { eventId: "e-2", runId: "run-1", seq: 2, kind: "step", occurredAt: at(2), payload: { stepId: "pick", params: { speed: 1 }, result: "fail" } }))).status, 201);
    assert.equal((await send(makeEvent("robot-secret-1", { eventId: "e-3", runId: "run-1", seq: 3, kind: "failure", occurredAt: at(3), payload: { stepId: "pick", code: "GRIP_LOST" } }))).status, 201);

    const interrupted = await api(app.base, "POST", `/projects/${projectId}/runs/run-1/interrupt`, {
      token: TOKENS.lab,
      body: { reason: "安全光栅触发" },
    });
    assert.equal(interrupted.status, 200);

    // 中断状态下不能继续上传
    const blocked = await send(makeEvent("robot-secret-1", { eventId: "e-4", runId: "run-1", seq: 4, kind: "note", occurredAt: at(4), payload: { text: "x" } }));
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error.code, "run_not_running");

    // 不存在的检查点不能作为恢复点
    const missing = await api(app.base, "POST", `/projects/${projectId}/runs/run-1/resume`, {
      token: TOKENS.lab,
      body: { checkpointId: "cp-nowhere" },
    });
    assert.equal(missing.status, 404);

    // 从安全检查点重试：开启分段 2，检查点之后的事件被整体取代
    const resumed = await api(app.base, "POST", `/projects/${projectId}/runs/run-1/resume`, {
      token: TOKENS.lab,
      body: { checkpointId: "cp-home" },
    });
    assert.equal(resumed.status, 200);
    assert.equal(resumed.body.segment, 2);
    assert.equal(resumed.body.nextSeq, 1);
    assert.equal(resumed.body.supersededEvents, 2);

    // 分段 2 重新执行并成功
    assert.equal((await send(makeEvent("robot-secret-1", { eventId: "e-5", runId: "run-1", segment: 2, seq: 1, kind: "step", occurredAt: at(10), payload: { stepId: "pick", params: { speed: 1 }, result: "ok" } }))).status, 201);
    assert.equal((await send(makeEvent("robot-secret-1", { eventId: "e-6", runId: "run-1", segment: 2, seq: 2, kind: "sensor", occurredAt: at(11), payload: { metric: "cycle_time_s", value: 39 } }))).status, 201);
    await api(app.base, "POST", `/projects/${projectId}/runs/run-1/complete`, { token: TOKENS.lab });

    // 运行详情：被取代的事件仍然可见，只是被标记
    const run = await api(app.base, "GET", `/projects/${projectId}/runs/run-1`, { token: TOKENS.buyer });
    assert.equal(run.body.supersededEventCount, 2);
    const segment1 = run.body.segments.find((s) => s.segment === 1);
    assert.equal(segment1.events.length, 3);
    assert.deepEqual(segment1.events.map((e) => e.superseded), [false, true, true]);

    // 报告：结论基于有效事件链；被取代的失败单列，绝不消失
    const report = await api(app.base, "GET", `/projects/${projectId}/report`, { token: TOKENS.buyer });
    assert.deepEqual(report.body.failures, []);
    assert.deepEqual(report.body.supersededFailures.map((f) => f.failureEventId), ["e-3"]);
    const steps = report.body.conclusions.find((c) => c.conclusionId === "round-1:cr-steps");
    assert.equal(steps.verdict, "pass");

    // 审计日志中失败记录原样保留
    const audit = await api(app.base, "GET", `/projects/${projectId}/audit`, { token: TOKENS.buyer });
    const appended = audit.body.records.filter((r) => r.type === "run_event_appended");
    assert.ok(appended.some((r) => r.payload.event.eventId === "e-3"));

    // 不存在任何删除入口
    const deleted = await api(app.base, "DELETE", `/projects/${projectId}/runs/run-1/events/e-3`, { token: TOKENS.lab });
    assert.equal(deleted.status, 405);
  } finally {
    await app.close();
  }
});
