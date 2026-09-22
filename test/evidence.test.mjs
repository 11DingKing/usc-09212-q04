import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  api,
  makeEvent,
  setupProject,
  signEvent,
  startApp,
  startRun,
  TOKENS,
  uploadEvent,
} from "./helpers.mjs";

test("证据上传：签名校验、幂等重传与序号连续性", async () => {
  const app = await startApp();
  try {
    const { projectId } = await setupProject(app.base);
    await startRun(app.base, projectId, "run-1");

    // 签名错误
    const bad = makeEvent("wrong-secret", {
      eventId: "e-1", runId: "run-1", seq: 1, kind: "checkpoint",
      occurredAt: "2026-09-22T10:00:00Z", payload: { checkpointId: "cp-home" },
    });
    const rejected = await uploadEvent(app.base, projectId, "run-1", bad);
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.error.code, "invalid_signature");

    // 签名后篡改负载
    const tampered = makeEvent("robot-secret-1", {
      eventId: "e-1", runId: "run-1", seq: 1, kind: "checkpoint",
      occurredAt: "2026-09-22T10:00:00Z", payload: { checkpointId: "cp-home" },
    });
    tampered.payload = { checkpointId: "cp-other" };
    const tamperedRes = await uploadEvent(app.base, projectId, "run-1", tampered);
    assert.equal(tamperedRes.status, 400);
    assert.equal(tamperedRes.body.error.code, "invalid_signature");

    // 序号跳跃被拒绝并提示期望序号
    const gap = makeEvent("robot-secret-1", {
      eventId: "e-9", runId: "run-1", seq: 9, kind: "note",
      occurredAt: "2026-09-22T10:00:00Z", payload: { text: "跳号" },
    });
    const gapRes = await uploadEvent(app.base, projectId, "run-1", gap);
    assert.equal(gapRes.status, 409);
    assert.equal(gapRes.body.error.code, "seq_gap");
    assert.equal(gapRes.body.error.details.expectedSeq, 1);

    // 正常上传后重传同一事件：幂等返回，不重复入账
    const event = makeEvent("robot-secret-1", {
      eventId: "e-1", runId: "run-1", seq: 1, kind: "checkpoint",
      occurredAt: "2026-09-22T10:00:00Z", payload: { checkpointId: "cp-home" },
    });
    const first = await uploadEvent(app.base, projectId, "run-1", event);
    assert.equal(first.status, 201);
    const retry = await uploadEvent(app.base, projectId, "run-1", event);
    assert.equal(retry.status, 200);
    assert.equal(retry.body.duplicate, true);

    const run = await api(app.base, "GET", `/projects/${projectId}/runs/run-1`, { token: TOKENS.lab });
    assert.equal(run.body.effectiveEventCount, 1);
  } finally {
    await app.close();
  }
});

test("服务恢复后可继续上传：重启重放日志，按 upload-status 续传", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "acceptance-"));
  const app1 = await startApp({ persist: true, dataDir });
  let runId;
  let projectId;
  try {
    ({ projectId } = await setupProject(app1.base));
    runId = "run-1";
    await startRun(app1.base, projectId, runId);
    for (const [seq, eventId] of [[1, "e-1"], [2, "e-2"]]) {
      const res = await uploadEvent(
        app1.base,
        projectId,
        runId,
        makeEvent("robot-secret-1", {
          eventId, runId, seq, kind: "sensor",
          occurredAt: `2026-09-22T10:00:0${seq}Z`, payload: { metric: "cycle_time_s", value: 40 },
        }),
      );
      assert.equal(res.status, 201);
    }
  } finally {
    await app1.close();
  }

  // 模拟服务重启：同一数据目录重放日志
  const app2 = await startApp({ persist: true, dataDir });
  try {
    const status = await api(app2.base, "GET", `/projects/${projectId}/runs/${runId}/upload-status`, { token: TOKENS.lab });
    assert.equal(status.status, 200);
    assert.equal(status.body.nextSeq, 3);
    assert.equal(status.body.currentSegment, 1);

    // 客户端从中断处继续上传
    const resumed = await uploadEvent(
      app2.base,
      projectId,
      runId,
      makeEvent("robot-secret-1", {
        eventId: "e-3", runId, seq: 3, kind: "sensor",
        occurredAt: "2026-09-22T10:00:03Z", payload: { metric: "cycle_time_s", value: 41 },
      }),
    );
    assert.equal(resumed.status, 201);

    // 重启前已收到的事件重传仍为幂等
    const replayed = await uploadEvent(
      app2.base,
      projectId,
      runId,
      makeEvent("robot-secret-1", {
        eventId: "e-2", runId, seq: 2, kind: "sensor",
        occurredAt: "2026-09-22T10:00:02Z", payload: { metric: "cycle_time_s", value: 40 },
      }),
    );
    assert.equal(replayed.status, 200);
    assert.equal(replayed.body.duplicate, true);

    const run = await api(app2.base, "GET", `/projects/${projectId}/runs/${runId}`, { token: TOKENS.lab });
    assert.equal(run.body.effectiveEventCount, 3);
  } finally {
    await app2.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
