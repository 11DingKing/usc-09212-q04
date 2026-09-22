import assert from "node:assert/strict";
import test from "node:test";
import { api, setupProject, startApp, startRun, TOKENS } from "./helpers.mjs";

test("设备或脚本变化自动生成新轮次", async () => {
  const app = await startApp();
  try {
    const { projectId } = await setupProject(app.base);

    // 固件 1.0.0 + 脚本 v1 -> 第 1 轮
    const run1 = await startRun(app.base, projectId, "run-1");
    assert.equal(run1.body.roundNumber, 1);

    // 供应商登记新固件 -> 下一次运行进入第 2 轮，第 1 轮被取代
    const firmware = await api(app.base, "POST", `/projects/${projectId}/robots/robot-1/firmware`, {
      token: TOKENS.supplier,
      body: { firmwareVersion: "1.0.1", deviceSecret: "robot-secret-1" },
    });
    assert.equal(firmware.status, 201);

    const run2 = await startRun(app.base, projectId, "run-2");
    assert.equal(run2.body.roundNumber, 2);
    assert.equal(run2.body.firmwareVersion, "1.0.1");

    // 组合未变 -> 复用第 2 轮
    const run3 = await startRun(app.base, projectId, "run-3");
    assert.equal(run3.body.roundNumber, 2);

    // 脚本内容变化（哈希变化）-> 第 3 轮
    const script = await api(app.base, "POST", `/projects/${projectId}/scripts`, {
      token: TOKENS.lab,
      body: {
        scriptId: "script-1",
        version: "v2",
        content: {
          steps: [
            { stepId: "pick", params: { speed: 2 } },
            { stepId: "place", params: { speed: 1 } },
          ],
          checkpoints: [{ checkpointId: "cp-home" }],
        },
      },
    });
    assert.equal(script.status, 201);

    const run4 = await startRun(app.base, projectId, "run-4");
    assert.equal(run4.body.roundNumber, 3);

    const rounds = await api(app.base, "GET", `/projects/${projectId}/rounds`, { token: TOKENS.observer });
    assert.equal(rounds.status, 200);
    assert.deepEqual(
      rounds.body.rounds.map((r) => [r.number, r.firmwareVersion, r.status]),
      [
        [1, "1.0.0", "superseded"],
        [2, "1.0.1", "superseded"],
        [3, "1.0.1", "open"],
      ],
    );
    assert.deepEqual(rounds.body.rounds[1].runIds, ["run-2", "run-3"]);
  } finally {
    await app.close();
  }
});
