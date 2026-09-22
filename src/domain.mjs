import { hashValue, newKey, verifySignature } from "./crypto.mjs";
import { computeReport } from "./report.mjs";

export const FAULT_CLASSES = ["environment_fault", "operational_deviation", "product_performance"];
export const PROJECT_ROLES = ["buyer_admin", "supplier", "observer"];
export const COMPARATORS = ["<", "<=", ">", ">=", "=="];

export class DomainError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "DomainError";
    this.status = status;
    this.code = code;
  }
}

function fail(status, code, message) {
  throw new DomainError(status, code, message);
}

const now = () => new Date().toISOString();

function requireFields(source, fields) {
  for (const field of fields) {
    const value = source?.[field];
    if (value === undefined || value === null || value === "") {
      fail(400, "missing_field", `缺少字段: ${field}`);
    }
  }
}

function parseTime(value, field) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    fail(400, "invalid_time", `字段 ${field} 不是有效的 ISO 时间`);
  }
  return Date.parse(value);
}

function validateSteps(steps) {
  if (!Array.isArray(steps) || steps.length === 0) fail(400, "invalid_steps", "脚本步骤不能为空");
  const seen = new Set();
  for (const step of steps) {
    if (!step?.stepId) fail(400, "invalid_steps", "步骤缺少 stepId");
    if (seen.has(step.stepId)) fail(400, "invalid_steps", `步骤重复: ${step.stepId}`);
    seen.add(step.stepId);
  }
}

function validateCriteria(successCriteria) {
  if (!Array.isArray(successCriteria) || successCriteria.length === 0) {
    fail(400, "invalid_criteria", "成功判据不能为空");
  }
  const seen = new Set();
  for (const criterion of successCriteria) {
    if (!criterion?.criteriaId) fail(400, "invalid_criteria", "判据缺少 criteriaId");
    if (seen.has(criterion.criteriaId)) fail(400, "invalid_criteria", `判据重复: ${criterion.criteriaId}`);
    seen.add(criterion.criteriaId);
    const rule = criterion.rule;
    if (!rule || (rule.type !== "step_pass" && rule.type !== "sensor_threshold")) {
      fail(400, "invalid_criteria", `判据 ${criterion.criteriaId} 的规则类型无效`);
    }
    if (rule.type === "step_pass" && !rule.stepId) {
      fail(400, "invalid_criteria", `判据 ${criterion.criteriaId} 缺少 stepId`);
    }
    if (
      rule.type === "sensor_threshold" &&
      (!rule.sensor || !COMPARATORS.includes(rule.comparator) || typeof rule.value !== "number")
    ) {
      fail(400, "invalid_criteria", `判据 ${criterion.criteriaId} 的传感阈值规则不完整`);
    }
  }
}

export class AcceptanceDomain {
  constructor(store) {
    this.store = store;
    this.projects = new Map();
    for (const event of store.events) this.apply(event);
  }

  commit(event) {
    this.store.append(event);
    this.apply(event);
  }

  project(projectId) {
    const project = this.projects.get(projectId);
    if (!project) fail(404, "project_not_found", `项目不存在: ${projectId}`);
    return project;
  }

  getRun(projectId, runId) {
    const run = this.project(projectId).runs.get(runId);
    if (!run) fail(404, "run_not_found", `测试运行不存在: ${runId}`);
    return run;
  }

  roleOf(projectId, principalId) {
    return this.projects.get(projectId)?.grants.get(principalId) ?? null;
  }

  apply(event) {
    const project = event.projectId ? this.projects.get(event.projectId) : null;
    switch (event.type) {
      case "project_created":
        this.projects.set(event.projectId, {
          projectId: event.projectId,
          name: event.name,
          buyerOrg: event.buyerOrg,
          createdBy: event.creator,
          createdAt: event.receiveTime,
          criteria: [],
          robots: new Map(),
          scripts: new Map(),
          rounds: [],
          currentFingerprint: null,
          reservations: new Map(),
          runs: new Map(),
          disputes: new Map(),
          grants: new Map(),
          reports: [],
        });
        break;
      case "grant_added":
        project.grants.set(event.principalId, event.role);
        break;
      case "criteria_sealed":
        project.criteria.push({
          version: event.version,
          siteConstraints: event.siteConstraints,
          successCriteria: event.successCriteria,
          hash: event.hash,
          sealedBy: event.sealedBy,
          sealedAt: event.receiveTime,
        });
        break;
      case "robot_registered":
        project.robots.set(event.robotId, {
          robotId: event.robotId,
          supplierOrg: event.supplierOrg,
          model: event.model,
          firmwareVersion: event.firmwareVersion,
          version: event.version,
          registeredAt: event.receiveTime,
        });
        break;
      case "script_published": {
        if (!project.scripts.has(event.scriptId)) {
          project.scripts.set(event.scriptId, { scriptId: event.scriptId, versions: new Map() });
        }
        project.scripts
          .get(event.scriptId)
          .versions.set(event.version, { steps: event.steps, publishedAt: event.receiveTime });
        break;
      }
      case "reservation_created":
        project.reservations.set(event.reservationId, {
          reservationId: event.reservationId,
          labId: event.labId,
          resourceId: event.resourceId,
          start: event.start,
          end: event.end,
          createdBy: event.createdBy,
        });
        break;
      case "round_opened":
        project.rounds.push({
          roundId: event.roundId,
          index: event.index,
          fingerprint: event.fingerprint,
          snapshot: event.snapshot,
          openedAt: event.receiveTime,
        });
        project.currentFingerprint = event.fingerprint;
        break;
      case "run_started":
        project.runs.set(event.runId, {
          runId: event.runId,
          roundId: event.roundId,
          robotId: event.robotId,
          robotVersion: event.robotVersion,
          firmwareVersion: event.firmwareVersion,
          scriptId: event.scriptId,
          scriptVersion: event.scriptVersion,
          reservationId: event.reservationId,
          labId: event.labId,
          resourceId: event.resourceId,
          uploadKey: event.uploadKey,
          status: "running",
          attempts: [],
          records: new Map(),
          startedAt: event.receiveTime,
        });
        break;
      case "attempt_started": {
        const run = project.runs.get(event.runId);
        run.attempts.push({
          attemptId: event.attemptId,
          index: event.index,
          startedFrom: event.startedFrom,
          status: "open",
          startedAt: event.receiveTime,
        });
        break;
      }
      case "records_recorded": {
        const run = project.runs.get(event.runId);
        for (const record of event.records) run.records.set(record.recordId, record);
        break;
      }
      case "run_interrupted":
      case "run_completed":
      case "run_aborted": {
        const run = project.runs.get(event.runId);
        run.status = { run_interrupted: "interrupted", run_completed: "completed", run_aborted: "aborted" }[event.type];
        const current = run.attempts.at(-1);
        if (current && current.status === "open") {
          current.status = "closed";
          current.endedAt = event.receiveTime;
        }
        if (event.type === "run_interrupted") run.interruptReason = event.reason ?? null;
        break;
      }
      case "run_resumed":
        project.runs.get(event.runId).status = "running";
        break;
      case "dispute_opened":
        project.disputes.set(event.disputeId, {
          disputeId: event.disputeId,
          subject: event.subject,
          statement: event.statement,
          openedBy: event.openedBy,
          openedAt: event.receiveTime,
          status: "open",
          resolution: null,
          resolvedBy: null,
          resolvedAt: null,
        });
        break;
      case "dispute_resolved": {
        const dispute = project.disputes.get(event.disputeId);
        dispute.status = "resolved";
        dispute.resolution = event.resolution;
        dispute.resolvedBy = event.resolvedBy;
        dispute.resolvedAt = event.receiveTime;
        break;
      }
      case "report_published":
        project.reports.push({
          reportId: event.reportId,
          contentHash: event.contentHash,
          content: event.content,
          publishedBy: event.publishedBy,
          publishedAt: event.receiveTime,
        });
        break;
      default:
        break; // 未知事件类型忽略，保证前向兼容
    }
  }

  // ---- 项目与授权 ----

  createProject({ projectId, name, buyerOrg, creator }) {
    requireFields({ projectId, name, buyerOrg }, ["projectId", "name", "buyerOrg"]);
    if (this.projects.has(projectId)) fail(409, "project_exists", `项目已存在: ${projectId}`);
    this.commit({ type: "project_created", projectId, name, buyerOrg, creator, receiveTime: now() });
    this.commit({
      type: "grant_added",
      projectId,
      principalId: creator,
      role: "buyer_admin",
      grantedBy: creator,
      receiveTime: now(),
    });
    return this.projectView(this.project(projectId));
  }

  addGrant({ projectId, principalId, role, grantedBy }) {
    this.project(projectId);
    requireFields({ principalId, role }, ["principalId", "role"]);
    if (!PROJECT_ROLES.includes(role)) fail(400, "invalid_role", `无效角色: ${role}`);
    this.commit({ type: "grant_added", projectId, principalId, role, grantedBy, receiveTime: now() });
    return { projectId, principalId, role };
  }

  // ---- 买方：封存场地约束与成功判据（版本化、哈希承诺、不可改） ----

  sealCriteria({ projectId, siteConstraints, successCriteria, sealedBy }) {
    const project = this.project(projectId);
    if (!siteConstraints || typeof siteConstraints !== "object" || Array.isArray(siteConstraints)) {
      fail(400, "invalid_constraints", "场地约束必须为对象");
    }
    validateCriteria(successCriteria);
    const version = project.criteria.length + 1;
    const hash = hashValue({ projectId, version, siteConstraints, successCriteria });
    this.commit({
      type: "criteria_sealed",
      projectId,
      version,
      siteConstraints,
      successCriteria,
      hash,
      sealedBy,
      receiveTime: now(),
    });
    return { projectId, version, hash };
  }

  // ---- 供应商：登记机器人与固件版本（重复登记递增版本） ----

  registerRobot({ projectId, robotId, supplierOrg, model, firmwareVersion }) {
    const project = this.project(projectId);
    requireFields({ robotId, model, firmwareVersion }, ["robotId", "model", "firmwareVersion"]);
    const existing = project.robots.get(robotId);
    if (existing && existing.model === model && existing.firmwareVersion === firmwareVersion) {
      fail(409, "robot_unchanged", "机器人登记信息未变化");
    }
    const version = existing ? existing.version + 1 : 1;
    this.commit({
      type: "robot_registered",
      projectId,
      robotId,
      supplierOrg,
      model,
      firmwareVersion,
      version,
      receiveTime: now(),
    });
    return project.robots.get(robotId);
  }

  // ---- 场景脚本（版本只增不减） ----

  publishScript({ projectId, scriptId, version, steps }) {
    const project = this.project(projectId);
    requireFields({ scriptId }, ["scriptId"]);
    if (!Number.isInteger(version) || version < 1) fail(400, "invalid_version", "脚本版本必须为正整数");
    validateSteps(steps);
    const script = project.scripts.get(scriptId);
    const latest = script ? Math.max(...script.versions.keys()) : 0;
    if (version <= latest) fail(409, "version_not_advanced", `脚本版本必须大于当前版本 ${latest}`);
    this.commit({ type: "script_published", projectId, scriptId, version, steps, receiveTime: now() });
    return { scriptId, version };
  }

  // ---- 实验室资源预约：同一资源时段互斥 ----

  createReservation({ projectId, reservationId, labId, resourceId, start, end, createdBy }) {
    const project = this.project(projectId);
    requireFields({ reservationId, labId, resourceId, start, end }, [
      "reservationId",
      "labId",
      "resourceId",
      "start",
      "end",
    ]);
    if (project.reservations.has(reservationId)) {
      fail(409, "reservation_exists", `预约已存在: ${reservationId}`);
    }
    const startMs = parseTime(start, "start");
    const endMs = parseTime(end, "end");
    if (endMs <= startMs) fail(400, "invalid_window", "结束时间必须晚于开始时间");
    for (const other of project.reservations.values()) {
      if (
        other.resourceId === resourceId &&
        Date.parse(other.start) < endMs &&
        startMs < Date.parse(other.end)
      ) {
        fail(409, "resource_conflict", `资源 ${resourceId} 在该时段已被预约 (${other.reservationId})`);
      }
    }
    this.commit({
      type: "reservation_created",
      projectId,
      reservationId,
      labId,
      resourceId,
      start,
      end,
      createdBy,
      receiveTime: now(),
    });
    return project.reservations.get(reservationId);
  }

  // ---- 测试运行：设备/脚本/判据指纹变化时自动开启新轮次 ----

  startRun({ projectId, runId, robotId, scriptId, reservationId }) {
    const project = this.project(projectId);
    requireFields({ runId, robotId, scriptId, reservationId }, ["runId", "robotId", "scriptId", "reservationId"]);
    if (project.runs.has(runId)) fail(409, "run_exists", `测试运行已存在: ${runId}`);
    if (project.criteria.length === 0) fail(409, "criteria_not_sealed", "请先封存场地约束与成功判据");
    const robot = project.robots.get(robotId);
    if (!robot) fail(404, "robot_not_found", `机器人未登记: ${robotId}`);
    const script = project.scripts.get(scriptId);
    if (!script || script.versions.size === 0) fail(404, "script_not_found", `场景脚本不存在: ${scriptId}`);
    const scriptVersion = Math.max(...script.versions.keys());
    const reservation = project.reservations.get(reservationId);
    if (!reservation) fail(404, "reservation_not_found", `预约不存在: ${reservationId}`);
    for (const other of project.runs.values()) {
      if (other.status === "running" && other.resourceId === reservation.resourceId) {
        fail(409, "resource_in_use", `资源 ${reservation.resourceId} 正被运行 ${other.runId} 占用`);
      }
    }

    const criteria = project.criteria.at(-1);
    const snapshot = {
      robot: { robotId, version: robot.version, firmwareVersion: robot.firmwareVersion },
      script: { scriptId, version: scriptVersion },
      criteriaVersion: criteria.version,
      criteriaHash: criteria.hash,
    };
    const fingerprint = hashValue(snapshot);
    if (project.currentFingerprint !== fingerprint) {
      this.commit({
        type: "round_opened",
        projectId,
        roundId: `${projectId}-round-${project.rounds.length + 1}`,
        index: project.rounds.length + 1,
        fingerprint,
        snapshot,
        receiveTime: now(),
      });
    }
    const round = project.rounds.at(-1);
    const uploadKey = newKey();
    this.commit({
      type: "run_started",
      projectId,
      runId,
      roundId: round.roundId,
      robotId,
      robotVersion: robot.version,
      firmwareVersion: robot.firmwareVersion,
      scriptId,
      scriptVersion,
      reservationId,
      labId: reservation.labId,
      resourceId: reservation.resourceId,
      uploadKey,
      receiveTime: now(),
    });
    const attemptId = `${runId}/attempt-1`;
    this.commit({
      type: "attempt_started",
      projectId,
      runId,
      attemptId,
      index: 1,
      startedFrom: { type: "start" },
      receiveTime: now(),
    });
    return { runId, roundId: round.roundId, roundIndex: round.index, attemptId, uploadKey };
  }

  // ---- 记录采集：签名校验 + recordId 幂等（服务恢复后可安全续传） ----

  uploadRecords({ projectId, runId, records }) {
    const project = this.project(projectId);
    const run = this.getRun(projectId, runId);
    if (run.status !== "running") fail(409, "run_not_running", `运行状态为 ${run.status}，无法上传记录`);
    if (!Array.isArray(records) || records.length === 0) fail(400, "empty_batch", "记录批次为空");
    const attempt = run.attempts.at(-1);
    const results = [];
    const accepted = [];
    const seen = new Set();
    for (const record of records) {
      requireFields(record, ["recordId", "type", "attemptId", "eventTime", "signature"]);
      if (seen.has(record.recordId)) fail(409, "duplicate_in_batch", `批次内记录重复: ${record.recordId}`);
      seen.add(record.recordId);
      if (record.attemptId !== attempt.attemptId) {
        fail(409, "stale_attempt", `记录指向非当前尝试: ${record.attemptId}`);
      }
      parseTime(record.eventTime, "eventTime");
      const { signature, ...content } = record;
      if (!verifySignature(run.uploadKey, content, signature)) {
        fail(403, "invalid_signature", `记录 ${record.recordId} 签名校验失败`);
      }
      const existing = run.records.get(record.recordId);
      if (existing) {
        if (existing.signature !== signature) {
          fail(409, "record_conflict", `记录 ${record.recordId} 已存在且内容不同`);
        }
        results.push({ recordId: record.recordId, status: "duplicate" });
        continue;
      }
      this.validateRecord(project, run, record);
      accepted.push({ ...record, receiveTime: now() });
      results.push({ recordId: record.recordId, status: "recorded" });
    }
    if (accepted.length > 0) {
      this.commit({ type: "records_recorded", projectId, runId, records: accepted, receiveTime: now() });
    }
    return { runId, results };
  }

  validateRecord(project, run, record) {
    const script = project.scripts.get(run.scriptId).versions.get(run.scriptVersion);
    if (record.type === "step_result") {
      requireFields(record, ["stepId", "outcome"]);
      if (!script.steps.some((step) => step.stepId === record.stepId)) {
        fail(400, "unknown_step", `步骤不存在于脚本中: ${record.stepId}`);
      }
      if (!["pass", "fail"].includes(record.outcome)) fail(400, "invalid_outcome", "步骤结果必须为 pass 或 fail");
      if (record.outcome === "fail") {
        if (!FAULT_CLASSES.includes(record.faultClass)) {
          fail(400, "invalid_fault_class", "失败记录必须归类为 environment_fault / operational_deviation / product_performance");
        }
      } else if (record.faultClass !== undefined && record.faultClass !== null) {
        fail(400, "unexpected_fault_class", "通过记录不得携带故障分类");
      }
    } else if (record.type === "sensor") {
      requireFields(record, ["name", "value"]);
      if (typeof record.value !== "number") fail(400, "invalid_value", "传感值必须为数值");
      if (record.stepId !== undefined && !script.steps.some((step) => step.stepId === record.stepId)) {
        fail(400, "unknown_step", `步骤不存在于脚本中: ${record.stepId}`);
      }
    } else {
      fail(400, "unknown_record_type", `未知记录类型: ${record.type}`);
    }
  }

  // ---- 中断与检查点重试：历史尝试与失败记录全部保留 ----

  interruptRun({ projectId, runId, reason }) {
    const run = this.getRun(projectId, runId);
    if (run.status !== "running") fail(409, "run_not_running", `运行状态为 ${run.status}，无法中断`);
    this.commit({ type: "run_interrupted", projectId, runId, reason: reason ?? null, receiveTime: now() });
    return this.runView(run);
  }

  retryRun({ projectId, runId, fromStepId }) {
    const project = this.project(projectId);
    const run = this.getRun(projectId, runId);
    if (run.status !== "interrupted") fail(409, "run_not_interrupted", "仅中断状态的运行可以重试");
    requireFields({ fromStepId }, ["fromStepId"]);
    const script = project.scripts.get(run.scriptId).versions.get(run.scriptVersion);
    const step = script.steps.find((candidate) => candidate.stepId === fromStepId);
    if (!step) fail(404, "step_not_found", `步骤不存在于脚本中: ${fromStepId}`);
    if (!step.safetyCheckpoint) fail(409, "not_a_checkpoint", `步骤 ${fromStepId} 不是安全检查点`);
    const checkpointPassed = [...run.records.values()].some(
      (record) => record.type === "step_result" && record.stepId === fromStepId && record.outcome === "pass",
    );
    if (!checkpointPassed) {
      fail(409, "checkpoint_not_reached", `安全检查点 ${fromStepId} 尚未通过，不能从此处重试`);
    }
    const index = run.attempts.length + 1;
    const attemptId = `${runId}/attempt-${index}`;
    this.commit({
      type: "attempt_started",
      projectId,
      runId,
      attemptId,
      index,
      startedFrom: { type: "checkpoint", stepId: fromStepId },
      receiveTime: now(),
    });
    this.commit({ type: "run_resumed", projectId, runId, receiveTime: now() });
    return { runId, attemptId, index, startedFrom: { type: "checkpoint", stepId: fromStepId } };
  }

  completeRun({ projectId, runId }) {
    const run = this.getRun(projectId, runId);
    if (run.status !== "running") fail(409, "run_not_running", `运行状态为 ${run.status}，无法完成`);
    this.commit({ type: "run_completed", projectId, runId, receiveTime: now() });
    return this.runView(run);
  }

  abortRun({ projectId, runId, reason }) {
    const run = this.getRun(projectId, runId);
    if (run.status !== "running" && run.status !== "interrupted") {
      fail(409, "run_not_active", `运行状态为 ${run.status}，无法中止`);
    }
    this.commit({ type: "run_aborted", projectId, runId, reason: reason ?? null, receiveTime: now() });
    return this.runView(run);
  }

  // ---- 争议处理 ----

  openDispute({ projectId, disputeId, subject, statement, openedBy }) {
    const project = this.project(projectId);
    requireFields({ disputeId, statement }, ["disputeId", "statement"]);
    if (project.disputes.has(disputeId)) fail(409, "dispute_exists", `争议已存在: ${disputeId}`);
    this.commit({
      type: "dispute_opened",
      projectId,
      disputeId,
      subject: subject ?? { kind: "other", refs: [] },
      statement,
      openedBy,
      receiveTime: now(),
    });
    return project.disputes.get(disputeId);
  }

  resolveDispute({ projectId, disputeId, resolution, resolvedBy }) {
    const project = this.project(projectId);
    requireFields({ resolution }, ["resolution"]);
    const dispute = project.disputes.get(disputeId);
    if (!dispute) fail(404, "dispute_not_found", `争议不存在: ${disputeId}`);
    if (dispute.status !== "open") fail(409, "dispute_closed", "争议已处理完毕");
    this.commit({ type: "dispute_resolved", projectId, disputeId, resolution, resolvedBy, receiveTime: now() });
    return dispute;
  }

  // ---- 报告：发布时可复算，发布后可用内容哈希校验 ----

  publishReport({ projectId, publishedBy }) {
    const project = this.project(projectId);
    const content = computeReport(project);
    const contentHash = hashValue(content);
    const reportId = `${projectId}-report-${project.reports.length + 1}`;
    this.commit({
      type: "report_published",
      projectId,
      reportId,
      contentHash,
      content,
      publishedBy,
      receiveTime: now(),
    });
    return project.reports.at(-1);
  }

  latestReport(projectId) {
    const report = this.project(projectId).reports.at(-1);
    if (!report) fail(404, "report_not_found", "尚未发布报告");
    return report;
  }

  verifyReport(projectId) {
    const project = this.project(projectId);
    const report = this.latestReport(projectId);
    const recomputedHash = hashValue(computeReport(project));
    return {
      reportId: report.reportId,
      contentHash: report.contentHash,
      recomputedHash,
      match: recomputedHash === report.contentHash,
    };
  }

  // ---- 只读视图 ----

  projectView(project) {
    return {
      projectId: project.projectId,
      name: project.name,
      buyerOrg: project.buyerOrg,
      createdBy: project.createdBy,
      createdAt: project.createdAt,
      criteria: project.criteria.map((criteria) => ({
        version: criteria.version,
        hash: criteria.hash,
        sealedBy: criteria.sealedBy,
        sealedAt: criteria.sealedAt,
        siteConstraints: criteria.siteConstraints,
        successCriteria: criteria.successCriteria,
      })),
      robots: [...project.robots.values()],
      scripts: [...project.scripts.values()].map((script) => ({
        scriptId: script.scriptId,
        versions: [...script.versions.keys()],
      })),
      rounds: project.rounds,
      reservations: [...project.reservations.values()],
      runs: [...project.runs.values()].map((run) => ({
        runId: run.runId,
        roundId: run.roundId,
        status: run.status,
        robotId: run.robotId,
        firmwareVersion: run.firmwareVersion,
        scriptId: run.scriptId,
        scriptVersion: run.scriptVersion,
        labId: run.labId,
        resourceId: run.resourceId,
        attempts: run.attempts.length,
        records: run.records.size,
      })),
      disputes: [...project.disputes.values()],
      reports: project.reports.map((report) => ({
        reportId: report.reportId,
        contentHash: report.contentHash,
        publishedBy: report.publishedBy,
        publishedAt: report.publishedAt,
      })),
    };
  }

  runView(run) {
    const { uploadKey, ...view } = run;
    return { ...view, records: [...run.records.values()] };
  }
}
