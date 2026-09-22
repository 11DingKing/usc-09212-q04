// 报告是事件日志的纯函数：同一项目状态下重算结果逐字节一致，
// 因此发布后可用内容哈希校验“每项结论均可复算”。

const COMPARE = {
  "<": (a, b) => a < b,
  "<=": (a, b) => a <= b,
  ">": (a, b) => a > b,
  ">=": (a, b) => a >= b,
  "==": (a, b) => a === b,
};

export function computeReport(project) {
  const criteria = project.criteria.at(-1) ?? null;
  const runs = [...project.runs.values()];

  // 失败记录永不删除：归因汇总覆盖所有轮次、所有尝试中的失败。
  const classifications = { environment_fault: [], operational_deviation: [], product_performance: [] };
  let stepResults = 0;
  let sensorReadings = 0;
  for (const run of runs) {
    for (const record of run.records.values()) {
      if (record.type === "step_result") {
        stepResults += 1;
        if (record.outcome === "fail") {
          classifications[record.faultClass].push({
            runId: run.runId,
            attemptId: record.attemptId,
            stepId: record.stepId,
            recordId: record.recordId,
            eventTime: record.eventTime,
          });
        }
      } else if (record.type === "sensor") {
        sensorReadings += 1;
      }
    }
  }

  return {
    projectId: project.projectId,
    criteriaVersion: criteria?.version ?? null,
    criteriaHash: criteria?.hash ?? null,
    siteConstraints: criteria?.siteConstraints ?? null,
    rounds: project.rounds.map((round) => ({
      roundId: round.roundId,
      index: round.index,
      fingerprint: round.fingerprint,
      snapshot: round.snapshot,
      runs: runs.filter((run) => run.roundId === round.roundId).map((run) => run.runId),
    })),
    runs: runs.map((run) => summarizeRun(project, run)),
    conclusions: (criteria?.successCriteria ?? []).map((criterion) => evaluateCriterion(runs, criterion)),
    classifications,
    totals: {
      runs: runs.length,
      completedRuns: runs.filter((run) => run.status === "completed").length,
      stepResults,
      sensorReadings,
      failures: Object.values(classifications).reduce((sum, list) => sum + list.length, 0),
      checkpointRetries: runs.reduce(
        (sum, run) => sum + run.attempts.filter((attempt) => attempt.startedFrom.type === "checkpoint").length,
        0,
      ),
    },
  };
}

function summarizeRun(project, run) {
  const script = project.scripts.get(run.scriptId)?.versions.get(run.scriptVersion);
  const records = [...run.records.values()];
  const steps = (script?.steps ?? []).map((step) => {
    const results = records.filter((record) => record.type === "step_result" && record.stepId === step.stepId);
    const final = results.at(-1) ?? null;
    return {
      stepId: step.stepId,
      safetyCheckpoint: Boolean(step.safetyCheckpoint),
      finalOutcome: final?.outcome ?? "not_executed",
      finalRecordId: final?.recordId ?? null,
      executions: results.length,
      failures: results
        .filter((record) => record.outcome === "fail")
        .map((record) => ({
          recordId: record.recordId,
          attemptId: record.attemptId,
          faultClass: record.faultClass,
          eventTime: record.eventTime,
        })),
    };
  });
  return {
    runId: run.runId,
    roundId: run.roundId,
    status: run.status,
    robotId: run.robotId,
    firmwareVersion: run.firmwareVersion,
    scriptId: run.scriptId,
    scriptVersion: run.scriptVersion,
    labId: run.labId,
    resourceId: run.resourceId,
    attempts: run.attempts.map((attempt) => ({
      attemptId: attempt.attemptId,
      index: attempt.index,
      startedFrom: attempt.startedFrom,
      status: attempt.status,
    })),
    steps,
  };
}

function evaluateCriterion(runs, criterion) {
  const perRun = runs.map((run) => evaluateCriterionForRun(run, criterion.rule));
  const completed = perRun.filter((_, index) => runs[index].status === "completed");
  return {
    criteriaId: criterion.criteriaId,
    description: criterion.description ?? null,
    rule: criterion.rule,
    overall: completed.length > 0 && completed.every((result) => result.met) ? "met" : "unmet",
    perRun,
  };
}

function evaluateCriterionForRun(run, rule) {
  const records = [...run.records.values()];
  if (rule.type === "step_pass") {
    const results = records.filter((record) => record.type === "step_result" && record.stepId === rule.stepId);
    const final = results.at(-1);
    return { runId: run.runId, met: final?.outcome === "pass", evidenceRecordIds: final ? [final.recordId] : [] };
  }
  if (rule.type === "sensor_threshold") {
    const readings = records.filter(
      (record) =>
        record.type === "sensor" &&
        record.name === rule.sensor &&
        (rule.stepId === undefined || record.stepId === rule.stepId),
    );
    const compare = COMPARE[rule.comparator];
    const met = readings.length > 0 && readings.every((record) => compare(record.value, rule.value));
    return { runId: run.runId, met, evidenceRecordIds: readings.map((record) => record.recordId) };
  }
  return { runId: run.runId, met: false, evidenceRecordIds: [] };
}
