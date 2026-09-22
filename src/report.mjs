import { canonicalJson, compareValues, nowIso, sha256hex } from "./util.mjs";
import { effectiveEvents } from "./state.mjs";

// 报告算法版本：分类与判定的任何规则变更都必须提升版本号，
// 以便复算历史报告时能解释结论差异。
export const ALGORITHM_VERSION = "1.0.0";

export const DEFAULT_CLASSIFICATION_WINDOW_MS = 120_000;

function aggregate(values, aggregation) {
  switch (aggregation) {
    case "max": return Math.max(...values);
    case "min": return Math.min(...values);
    case "sum": return values.reduce((sum, value) => sum + value, 0);
    case "avg": return values.reduce((sum, value) => sum + value, 0) / values.length;
    case "last": return values[values.length - 1];
    default: throw new Error(`未知聚合方式: ${aggregation}`);
  }
}

// 依据有效事件链评估单条成功判据，返回判定、实测值与所依据的证据事件标识。
export function evaluateCriterion(criterion, events) {
  const metric = criterion.metric;

  if (metric === "step_ok_rate") {
    const steps = events.filter(
      (event) => event.kind === "step" && (event.payload.result === "ok" || event.payload.result === "fail"),
    );
    if (steps.length === 0) {
      return { verdict: "no_data", measured: null, evidenceIds: [] };
    }
    const ok = steps.filter((step) => step.payload.result === "ok").length;
    const measured = ok / steps.length;
    return {
      verdict: compareValues(measured, criterion.comparator, criterion.threshold) ? "pass" : "fail",
      measured,
      evidenceIds: steps.map((step) => step.eventId),
    };
  }

  const samples = events
    .filter((event) => event.kind === "sensor" && event.payload.metric === metric)
    .map((event) => ({ value: event.payload.value, eventId: event.eventId }));
  if (samples.length === 0) {
    return { verdict: "no_data", measured: null, evidenceIds: [] };
  }
  const measured = aggregate(samples.map((sample) => sample.value), criterion.aggregation ?? "last");
  return {
    verdict: compareValues(measured, criterion.comparator, criterion.threshold) ? "pass" : "fail",
    measured,
    evidenceIds: samples.map((sample) => sample.eventId),
  };
}

function sensorViolationsBefore(events, constraints, occurredAt, windowMs) {
  const at = Date.parse(occurredAt);
  const evidenceIds = [];
  for (const constraint of constraints) {
    for (const event of events) {
      if (event.kind !== "sensor" || event.payload.metric !== constraint.metric) continue;
      const eventAt = Date.parse(event.occurredAt);
      if (eventAt > at || eventAt < at - windowMs) continue;
      if (!compareValues(event.payload.value, constraint.comparator, constraint.threshold)) {
        evidenceIds.push(event.eventId);
      }
    }
  }
  return [...new Set(evidenceIds)];
}

function operatorDeviation(events, scriptContent, failedStepId) {
  const scriptSteps = scriptContent?.steps ?? [];
  if (scriptSteps.length === 0) return null;

  // 规则一：失败步骤的实际参数与脚本登记参数不一致。
  if (failedStepId) {
    const definition = scriptSteps.find((step) => step.stepId === failedStepId);
    const actual = events.find((event) => event.kind === "step" && event.payload.stepId === failedStepId);
    if (definition && actual) {
      const expectedParams = canonicalJson(definition.params ?? {});
      const actualParams = canonicalJson(actual.payload.params ?? {});
      if (expectedParams !== actualParams) {
        return {
          classification: "operator_deviation",
          ruleId: "script-param-mismatch",
          evidenceIds: [actual.eventId],
        };
      }
    }
  }

  // 规则二：执行步骤出现脚本未登记的步骤，或执行顺序与脚本顺序冲突。
  const order = scriptSteps.map((step) => step.stepId);
  let lastIndex = -1;
  for (const event of events) {
    if (event.kind !== "step") continue;
    const index = order.indexOf(event.payload.stepId);
    if (index === -1) {
      return { classification: "operator_deviation", ruleId: "script-unknown-step", evidenceIds: [event.eventId] };
    }
    if (index < lastIndex) {
      return { classification: "operator_deviation", ruleId: "script-order-violation", evidenceIds: [event.eventId] };
    }
    lastIndex = index;
  }
  return null;
}

// 失败归因（纯函数，可复算）：
// 1. 失败前窗口内传感数据违反买方封存的场地约束 -> environment_fault（环境故障）
// 2. 步骤参数或顺序偏离登记脚本 -> operator_deviation（操作偏差）
// 3. 环境合规且操作符合脚本 -> product_performance（产品表现）
export function classifyFailure(failure, events, baseline, scriptContent) {
  const windowMs = baseline?.classificationWindowMs ?? DEFAULT_CLASSIFICATION_WINDOW_MS;
  const constraints = baseline?.siteConstraints ?? [];

  const envEvidence = sensorViolationsBefore(events, constraints, failure.occurredAt, windowMs);
  if (envEvidence.length > 0) {
    return { classification: "environment_fault", ruleId: "env-constraint-violation", evidenceIds: envEvidence };
  }

  const deviation = operatorDeviation(events, scriptContent, failure.payload?.stepId ?? null);
  if (deviation) {
    return deviation;
  }

  return { classification: "product_performance", ruleId: "no-external-cause", evidenceIds: [] };
}

// 由投影中的全部有效证据确定性地计算报告。
// 每条结论都携带 evidenceIds 与规则标识，任何一方都能据此复算。
export function computeReport(project) {
  const baseline = project.baselineSealed ?? null;
  const criteria = baseline?.successCriteria ?? [];
  const constraints = baseline?.siteConstraints ?? [];

  const rounds = [];
  const runs = [];
  const conclusions = [];
  const failures = [];
  const supersededFailures = [];
  const environmentViolations = [];

  for (const round of project.rounds) {
    const perCriterion = new Map(criteria.map((criterion) => [criterion.criterionId, []]));

    for (const runId of round.runIds) {
      const run = project.runs.get(runId);
      if (!run) continue;
      const events = effectiveEvents(run);
      const script = project.scripts.get(run.scriptId);
      const scriptContent = script?.versions.get(run.scriptHash)?.content ?? null;

      const runConclusions = criteria.map((criterion) => {
        const result = evaluateCriterion(criterion, events);
        perCriterion.get(criterion.criterionId)?.push({
          runId,
          verdict: result.verdict,
          measured: result.measured,
          evidenceIds: result.evidenceIds,
        });
        return { criterionId: criterion.criterionId, ...result };
      });

      for (const event of events) {
        if (event.kind !== "failure") continue;
        const classified = classifyFailure(event, events, baseline, scriptContent);
        failures.push({
          failureEventId: event.eventId,
          runId,
          roundNumber: round.number,
          occurredAt: event.occurredAt,
          assertedCategory: event.payload?.category ?? null,
          ...classified,
        });
      }

      for (const segment of run.segments) {
        if (segment.cutAtSeq == null) continue;
        for (const event of segment.events) {
          if (event.seq > segment.cutAtSeq && event.kind === "failure") {
            supersededFailures.push({
              failureEventId: event.eventId,
              runId,
              segment: segment.n,
              occurredAt: event.occurredAt,
              reason: "superseded_by_checkpoint_resume",
            });
          }
        }
      }

      for (const event of events) {
        if (event.kind !== "sensor") continue;
        for (const constraint of constraints) {
          if (
            event.payload.metric === constraint.metric &&
            !compareValues(event.payload.value, constraint.comparator, constraint.threshold)
          ) {
            environmentViolations.push({
              eventId: event.eventId,
              runId,
              metric: constraint.metric,
              value: event.payload.value,
              constraint,
            });
          }
        }
      }

      runs.push({
        runId,
        roundNumber: round.number,
        status: run.status,
        robotId: run.robotId,
        firmwareVersion: run.firmwareVersion,
        scriptHash: run.scriptHash,
        effectiveEventCount: events.length,
        supersededEventCount: run.segments.reduce(
          (count, segment) => count + segment.events.filter((event) => segment.cutAtSeq != null && event.seq > segment.cutAtSeq).length,
          0,
        ),
        conclusions: runConclusions,
      });
    }

    for (const criterion of criteria) {
      const runResults = perCriterion.get(criterion.criterionId) ?? [];
      const verdicts = runResults.map((result) => result.verdict).filter((verdict) => verdict !== "no_data");
      const verdict =
        verdicts.length === 0 ? "no_data" : verdicts.every((item) => item === "pass") ? "pass" : "fail";
      conclusions.push({
        conclusionId: `round-${round.number}:${criterion.criterionId}`,
        roundNumber: round.number,
        criterionId: criterion.criterionId,
        verdict,
        runs: runResults,
      });
    }

    rounds.push({
      roundNumber: round.number,
      robotId: round.robotId,
      firmwareVersion: round.firmwareVersion,
      scriptHash: round.scriptHash,
      status: round.status,
      runCount: round.runIds.length,
    });
  }

  const disputes = [...project.disputes.values()];
  const core = {
    algorithmVersion: ALGORITHM_VERSION,
    projectId: project.id,
    baselineHash: baseline?.hash ?? null,
    classificationWindowMs: baseline?.classificationWindowMs ?? DEFAULT_CLASSIFICATION_WINDOW_MS,
    rounds,
    runs,
    conclusions,
    failures,
    supersededFailures,
    environmentViolations,
    disputes: {
      open: disputes.filter((dispute) => dispute.status === "open").map((dispute) => dispute.disputeId),
      resolved: disputes.filter((dispute) => dispute.status === "resolved").length,
    },
  };
  // contentHash 覆盖除生成时间外的全部内容：复算同一批证据必得同一哈希。
  return { ...core, generatedAt: nowIso(), contentHash: sha256hex(canonicalJson(core)) };
}
