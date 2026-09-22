import assert from "node:assert/strict";
import test from "node:test";
import { sign } from "../src/crypto.mjs";
import { AcceptanceDomain } from "../src/domain.mjs";
import { MemoryEventStore } from "../src/event-store.mjs";

const STEPS = [
  { stepId: "s1", name: "就位", safetyCheckpoint: true },
  { stepId: "s2", name: "抓取", safetyCheckpoint: false },
  { stepId: "s3", name: "放置", safetyCheckpoint: true },
];

const CRITERIA = [
  { criteriaId: "c-place", description: "放置步骤最终通过", rule: { type: "step_pass", stepId: "s3" } },
  {
    criteriaId: "c-force",
    description: "抓取力不超上限",
    rule: { type: "sensor_threshold", sensor: "grip_force_n", comparator: "<=", value: 150 },
  },
];

function setup() {
  const domain = new AcceptanceDomain(new MemoryEventStore());
  domain.createProject({ projectId: "p1", name: "上下料验收", buyerOrg: "buyer-org", creator: "buyer-1" });
  domain.sealCriteria({
    projectId: "p1",
    siteConstraints: { floorFriction: ">=0.6", temperatureC: [10, 40] },
    successCriteria: CRITERIA,
    sealedBy: "buyer-1",
  });
  domain.registerRobot({ projectId: "p1", robotId: "robot-a", supplierOrg: "supplier-org", model: "ARM-7", firmwareVersion: "1.0.0" });
  domain.publishScript({ projectId: "p1", scriptId: "script-load", version: 1, steps: STEPS });
  domain.createReservation({
    projectId: "p1",
    reservationId: "res-1",
    labId: "lab-1",
    resourceId: "cell-1",
    start: "2026-09-22T08:00:00Z",
    end: "2026-09-22T12:00:00Z",
    createdBy: "supplier-1",
  });
  return domain;
}

function signedRecord(uploadKey, record) {
  return { ...record, signature: sign(uploadKey, record) };
}

function stepResult(uploadKey, runId, attemptId, recordId, stepId, outcome, faultClass = null) {
  return signedRecord(uploadKey, {
    recordId,
    type: "step_result",
    runId,
    attemptId,
    stepId,
    outcome,
    faultClass,
    eventTime: "2026-09-22T09:00:00Z",
  });
}

function sensorReading(uploadKey, runId, attemptId, recordId, name, value, stepId) {
  return signedRecord(uploadKey, {
    recordId,
    type: "sensor",
    runId,
    attemptId,
    name,
    value,
    unit: "n",
    stepId,
    eventTime: "2026-09-22T09:00:00Z",
  });
}

test("设备或脚本变化会生成新轮次", () => {
  const domain = setup();
  const first = domain.startRun({ projectId: "p1", runId: "run-1", robotId: "robot-a", scriptId: "script-load", reservationId: "res-1" });
  assert.equal(first.roundId, "p1-round-1");

  // 配置未变：同一轮次
  domain.completeRun({ projectId: "p1", runId: "run-1" });
  const second = domain.startRun({ projectId: "p1", runId: "run-2", robotId: "robot-a", scriptId: "script-load", reservationId: "res-1" });
  assert.equal(second.roundId, "p1-round-1");

  // 固件升级：新轮次
  domain.registerRobot({ projectId: "p1", robotId: "robot-a", supplierOrg: "supplier-org", model: "ARM-7", firmwareVersion: "1.1.0" });
  domain.completeRun({ projectId: "p1", runId: "run-2" });
  const third = domain.startRun({ projectId: "p1", runId: "run-3", robotId: "robot-a", scriptId: "script-load", reservationId: "res-1" });
  assert.equal(third.roundId, "p1-round-2");
  const round2 = domain.project("p1").rounds.at(-1);
  assert.equal(round2.snapshot.robot.firmwareVersion, "1.1.0");

  // 脚本版本变化：新轮次
  domain.publishScript({ projectId: "p1", scriptId: "script-load", version: 2, steps: STEPS });
  domain.completeRun({ projectId: "p1", runId: "run-3" });
  const fourth = domain.startRun({ projectId: "p1", runId: "run-4", robotId: "robot-a", scriptId: "script-load", reservationId: "res-1" });
  assert.equal(fourth.roundId, "p1-round-3");

  // 判据重新封存：新轮次
  domain.sealCriteria({
    projectId: "p1",
    siteConstraints: { floorFriction: ">=0.7", temperatureC: [10, 40] },
    successCriteria: CRITERIA,
    sealedBy: "buyer-1",
  });
  domain.completeRun({ projectId: "p1", runId: "run-4" });
  const fifth = domain.startRun({ projectId: "p1", runId: "run-5", robotId: "robot-a", scriptId: "script-load", reservationId: "res-1" });
  assert.equal(fifth.roundId, "p1-round-4");
  assert.equal(domain.project("p1").criteria.at(-1).version, 2);
});

test("中断只能从已通过的安全检查点重试", () => {
  const domain = setup();
  const run = domain.startRun({ projectId: "p1", runId: "run-1", robotId: "robot-a", scriptId: "script-load", reservationId: "res-1" });
  domain.uploadRecords({
    projectId: "p1",
    runId: "run-1",
    records: [stepResult(run.uploadKey, "run-1", run.attemptId, "r1", "s1", "pass")],
  });
  domain.interruptRun({ projectId: "p1", runId: "run-1", reason: "安全门触发" });

  // 非检查点步骤：拒绝
  assert.throws(() => domain.retryRun({ projectId: "p1", runId: "run-1", fromStepId: "s2" }), /不是安全检查点/);
  // 尚未通过的检查点：拒绝
  assert.throws(() => domain.retryRun({ projectId: "p1", runId: "run-1", fromStepId: "s3" }), /尚未通过/);

  const retry = domain.retryRun({ projectId: "p1", runId: "run-1", fromStepId: "s1" });
  assert.equal(retry.attemptId, "run-1/attempt-2");
  assert.deepEqual(retry.startedFrom, { type: "checkpoint", stepId: "s1" });
  assert.equal(domain.getRun("p1", "run-1").status, "running");

  // 运行中的运行不能再重试
  assert.throws(() => domain.retryRun({ projectId: "p1", runId: "run-1", fromStepId: "s1" }), /仅中断状态/);
});

test("重试不得挑选性删除失败记录", () => {
  const domain = setup();
  const run = domain.startRun({ projectId: "p1", runId: "run-1", robotId: "robot-a", scriptId: "script-load", reservationId: "res-1" });
  domain.uploadRecords({
    projectId: "p1",
    runId: "run-1",
    records: [
      stepResult(run.uploadKey, "run-1", run.attemptId, "r1", "s1", "pass"),
      stepResult(run.uploadKey, "run-1", run.attemptId, "r2", "s2", "fail", "product_performance"),
    ],
  });
  domain.interruptRun({ projectId: "p1", runId: "run-1" });
  const retry = domain.retryRun({ projectId: "p1", runId: "run-1", fromStepId: "s1" });
  domain.uploadRecords({
    projectId: "p1",
    runId: "run-1",
    records: [stepResult(run.uploadKey, "run-1", retry.attemptId, "r3", "s2", "pass")],
  });

  const records = [...domain.getRun("p1", "run-1").records.values()];
  assert.equal(records.length, 3);
  assert.ok(records.some((record) => record.recordId === "r2" && record.outcome === "fail"));

  const report = domain.publishReport({ projectId: "p1", publishedBy: "buyer-1" });
  const step2 = report.content.runs[0].steps.find((step) => step.stepId === "s2");
  assert.equal(step2.finalOutcome, "pass");
  assert.equal(step2.executions, 2);
  assert.deepEqual(
    step2.failures.map((failure) => failure.recordId),
    ["r2"],
  );
  assert.equal(report.content.totals.checkpointRetries, 1);
});

test("实验室资源预约避免并发冲突", () => {
  const domain = setup();
  // 时段重叠、同一资源：冲突
  assert.throws(
    () =>
      domain.createReservation({
        projectId: "p1",
        reservationId: "res-2",
        labId: "lab-2",
        resourceId: "cell-1",
        start: "2026-09-22T10:00:00Z",
        end: "2026-09-22T14:00:00Z",
        createdBy: "supplier-1",
      }),
    /已被预约/,
  );
  // 首尾相接：允许
  domain.createReservation({
    projectId: "p1",
    reservationId: "res-3",
    labId: "lab-2",
    resourceId: "cell-1",
    start: "2026-09-22T12:00:00Z",
    end: "2026-09-22T16:00:00Z",
    createdBy: "supplier-1",
  });
  // 同时段不同资源：允许
  domain.createReservation({
    projectId: "p1",
    reservationId: "res-4",
    labId: "lab-2",
    resourceId: "cell-2",
    start: "2026-09-22T08:00:00Z",
    end: "2026-09-22T12:00:00Z",
    createdBy: "supplier-1",
  });
  // 同一资源上有运行进行中：新运行拒绝（res-3 同样占用 cell-1）
  domain.startRun({ projectId: "p1", runId: "run-1", robotId: "robot-a", scriptId: "script-load", reservationId: "res-1" });
  assert.throws(
    () => domain.startRun({ projectId: "p1", runId: "run-2", robotId: "robot-a", scriptId: "script-load", reservationId: "res-3" }),
    (error) => error.code === "resource_in_use",
  );
});

test("记录上传签名校验与幂等续传", () => {
  const domain = setup();
  const run = domain.startRun({ projectId: "p1", runId: "run-1", robotId: "robot-a", scriptId: "script-load", reservationId: "res-1" });
  const record = stepResult(run.uploadKey, "run-1", run.attemptId, "r1", "s1", "pass");

  const first = domain.uploadRecords({ projectId: "p1", runId: "run-1", records: [record] });
  assert.deepEqual(first.results, [{ recordId: "r1", status: "recorded" }]);

  // 服务恢复后客户端重传同一批：幂等去重
  const retry = domain.uploadRecords({ projectId: "p1", runId: "run-1", records: [record] });
  assert.deepEqual(retry.results, [{ recordId: "r1", status: "duplicate" }]);
  assert.equal(domain.getRun("p1", "run-1").records.size, 1);

  // 同一 recordId 不同内容：冲突
  const tampered = stepResult(run.uploadKey, "run-1", run.attemptId, "r1", "s1", "fail", "operational_deviation");
  assert.throws(
    () => domain.uploadRecords({ projectId: "p1", runId: "run-1", records: [tampered] }),
    (error) => error.code === "record_conflict",
  );

  // 签名无效：拒绝
  assert.throws(
    () => domain.uploadRecords({ projectId: "p1", runId: "run-1", records: [{ ...record, recordId: "r9", signature: "bad" }] }),
    (error) => error.code === "invalid_signature",
  );

  // 失败记录必须归类
  assert.throws(
    () =>
      domain.uploadRecords({
        projectId: "p1",
        runId: "run-1",
        records: [stepResult(run.uploadKey, "run-1", run.attemptId, "r10", "s2", "fail")],
      }),
    (error) => error.code === "invalid_fault_class",
  );
});

test("报告可复算并区分环境故障、操作偏差与产品表现", () => {
  const domain = setup();
  const run = domain.startRun({ projectId: "p1", runId: "run-1", robotId: "robot-a", scriptId: "script-load", reservationId: "res-1" });
  domain.uploadRecords({
    projectId: "p1",
    runId: "run-1",
    records: [
      stepResult(run.uploadKey, "run-1", run.attemptId, "r1", "s1", "pass"),
      stepResult(run.uploadKey, "run-1", run.attemptId, "r2", "s2", "fail", "environment_fault"),
      sensorReading(run.uploadKey, "run-1", run.attemptId, "m1", "grip_force_n", 120, "s2"),
    ],
  });
  domain.interruptRun({ projectId: "p1", runId: "run-1" });
  const retry = domain.retryRun({ projectId: "p1", runId: "run-1", fromStepId: "s1" });
  domain.uploadRecords({
    projectId: "p1",
    runId: "run-1",
    records: [
      stepResult(run.uploadKey, "run-1", retry.attemptId, "r3", "s2", "pass"),
      stepResult(run.uploadKey, "run-1", retry.attemptId, "r4", "s3", "pass"),
      sensorReading(run.uploadKey, "run-1", retry.attemptId, "m2", "grip_force_n", 130, "s2"),
    ],
  });
  domain.completeRun({ projectId: "p1", runId: "run-1" });

  // 第二个运行制造另外两类失败
  domain.createReservation({
    projectId: "p1",
    reservationId: "res-2",
    labId: "lab-1",
    resourceId: "cell-2",
    start: "2026-09-22T08:00:00Z",
    end: "2026-09-22T12:00:00Z",
    createdBy: "supplier-1",
  });
  const run2 = domain.startRun({ projectId: "p1", runId: "run-2", robotId: "robot-a", scriptId: "script-load", reservationId: "res-2" });
  domain.uploadRecords({
    projectId: "p1",
    runId: "run-2",
    records: [
      stepResult(run2.uploadKey, "run-2", run2.attemptId, "r5", "s1", "fail", "operational_deviation"),
      stepResult(run2.uploadKey, "run-2", run2.attemptId, "r6", "s2", "fail", "product_performance"),
    ],
  });
  domain.abortRun({ projectId: "p1", runId: "run-2" });

  const report = domain.publishReport({ projectId: "p1", publishedBy: "buyer-1" });
  const { classifications, conclusions } = report.content;
  assert.deepEqual(classifications.environment_fault.map((f) => f.recordId), ["r2"]);
  assert.deepEqual(classifications.operational_deviation.map((f) => f.recordId), ["r5"]);
  assert.deepEqual(classifications.product_performance.map((f) => f.recordId), ["r6"]);

  const place = conclusions.find((c) => c.criteriaId === "c-place");
  assert.equal(place.overall, "met");
  assert.deepEqual(place.perRun.find((r) => r.runId === "run-1").evidenceRecordIds, ["r4"]);
  const force = conclusions.find((c) => c.criteriaId === "c-force");
  assert.equal(force.overall, "met");
  assert.deepEqual(force.perRun.find((r) => r.runId === "run-1").evidenceRecordIds, ["m1", "m2"]);

  // 复算一致；数据变化后复算不一致（报告过期可被检出）
  assert.equal(domain.verifyReport("p1").match, true);
  domain.registerRobot({ projectId: "p1", robotId: "robot-a", supplierOrg: "supplier-org", model: "ARM-7", firmwareVersion: "2.0.0" });
  domain.createReservation({
    projectId: "p1",
    reservationId: "res-3",
    labId: "lab-1",
    resourceId: "cell-1",
    start: "2026-09-23T08:00:00Z",
    end: "2026-09-23T12:00:00Z",
    createdBy: "supplier-1",
  });
  domain.startRun({ projectId: "p1", runId: "run-3", robotId: "robot-a", scriptId: "script-load", reservationId: "res-3" });
  assert.equal(domain.verifyReport("p1").match, false);
});

test("争议处理全程留痕", () => {
  const domain = setup();
  domain.openDispute({
    projectId: "p1",
    disputeId: "d1",
    subject: { kind: "record", refs: ["r2"] },
    statement: "供应商认为该失败由场地光照引起",
    openedBy: "supplier-1",
  });
  const resolved = domain.resolveDispute({ projectId: "p1", disputeId: "d1", resolution: "复核传感数据后维持环境故障归类", resolvedBy: "buyer-1" });
  assert.equal(resolved.status, "resolved");
  assert.throws(() => domain.resolveDispute({ projectId: "p1", disputeId: "d1", resolution: "重复处理", resolvedBy: "buyer-1" }), /已处理完毕/);
});
