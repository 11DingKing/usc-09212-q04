import http from "node:http";
import path from "node:path";
import { Store } from "./store.mjs";
import {
  applyRecord,
  buildState,
  currentSegment,
  projectView,
  robotView,
  runView,
  scriptView,
} from "./state.mjs";
import { computeReport } from "./report.mjs";
import {
  HttpError,
  assertThat,
  canonicalJson,
  COMPARATORS,
  evidenceSigningString,
  hmacSha256hex,
  isIsoDate,
  nowIso,
  randomToken,
  safeEqualHex,
  sha256hex,
} from "./util.mjs";

const PROJECT_ROLES = new Set(["buyer", "supplier", "lab", "observer"]);
const EVENT_KINDS = new Set(["step", "sensor", "checkpoint", "failure", "note"]);
const AGGREGATIONS = new Set(["max", "min", "avg", "last", "sum"]);
const MAX_BODY_BYTES = 1_000_000;

function requireString(value, field) {
  assertThat(typeof value === "string" && value.length > 0, 400, "invalid_field", `字段 ${field} 必须是非空字符串`);
  return value;
}

function requireObject(value, field) {
  assertThat(value !== null && typeof value === "object" && !Array.isArray(value), 400, "invalid_field", `字段 ${field} 必须是对象`);
  return value;
}

function requireArray(value, field) {
  assertThat(Array.isArray(value), 400, "invalid_field", `字段 ${field} 必须是数组`);
  return value;
}

function validateConstraint(raw, index) {
  const field = `siteConstraints[${index}]`;
  const constraint = requireObject(raw, field);
  requireString(constraint.metric, `${field}.metric`);
  assertThat(COMPARATORS.has(constraint.comparator), 400, "invalid_field", `${field}.comparator 不合法`);
  assertThat(
    typeof constraint.threshold === "number" || typeof constraint.threshold === "string",
    400,
    "invalid_field",
    `${field}.threshold 必须是数字或字符串`,
  );
  return {
    constraintId: constraint.constraintId ?? `constraint-${index + 1}`,
    metric: constraint.metric,
    comparator: constraint.comparator,
    threshold: constraint.threshold,
  };
}

function validateCriterion(raw, index) {
  const field = `successCriteria[${index}]`;
  const criterion = requireObject(raw, field);
  requireString(criterion.criterionId, `${field}.criterionId`);
  requireString(criterion.metric, `${field}.metric`);
  assertThat(COMPARATORS.has(criterion.comparator), 400, "invalid_field", `${field}.comparator 不合法`);
  assertThat(
    typeof criterion.threshold === "number" || typeof criterion.threshold === "string",
    400,
    "invalid_field",
    `${field}.threshold 必须是数字或字符串`,
  );
  if (criterion.aggregation !== undefined) {
    assertThat(AGGREGATIONS.has(criterion.aggregation), 400, "invalid_field", `${field}.aggregation 不合法`);
  }
  return {
    criterionId: criterion.criterionId,
    metric: criterion.metric,
    comparator: criterion.comparator,
    threshold: criterion.threshold,
    aggregation: criterion.aggregation ?? "last",
  };
}

function validateBaseline(body) {
  const siteConstraints = requireArray(body.siteConstraints, "siteConstraints").map(validateConstraint);
  const successCriteria = requireArray(body.successCriteria, "successCriteria").map(validateCriterion);
  const ids = new Set(successCriteria.map((criterion) => criterion.criterionId));
  assertThat(ids.size === successCriteria.length, 400, "invalid_field", "successCriteria 中 criterionId 重复");
  let classificationWindowMs = null;
  if (body.classificationWindowMs !== undefined) {
    assertThat(
      Number.isInteger(body.classificationWindowMs) && body.classificationWindowMs > 0,
      400,
      "invalid_field",
      "classificationWindowMs 必须是正整数",
    );
    classificationWindowMs = body.classificationWindowMs;
  }
  return { siteConstraints, successCriteria, classificationWindowMs };
}

function validateScriptContent(content) {
  requireObject(content, "content");
  const steps = requireArray(content.steps, "content.steps");
  const seen = new Set();
  for (const [index, raw] of steps.entries()) {
    const step = requireObject(raw, `content.steps[${index}]`);
    requireString(step.stepId, `content.steps[${index}].stepId`);
    assertThat(!seen.has(step.stepId), 400, "invalid_field", `脚本步骤 ${step.stepId} 重复`);
    seen.add(step.stepId);
  }
  if (content.checkpoints !== undefined) {
    requireArray(content.checkpoints, "content.checkpoints");
    for (const [index, raw] of content.checkpoints.entries()) {
      requireString(requireObject(raw, `content.checkpoints[${index}]`).checkpointId, `content.checkpoints[${index}].checkpointId`);
    }
  }
  return content;
}

function validateEventPayload(kind, payload) {
  requireObject(payload, "payload");
  switch (kind) {
    case "step":
      requireString(payload.stepId, "payload.stepId");
      break;
    case "sensor":
      requireString(payload.metric, "payload.metric");
      assertThat(
        typeof payload.value === "number" || typeof payload.value === "string",
        400,
        "invalid_field",
        "payload.value 必须是数字或字符串",
      );
      break;
    case "checkpoint":
      requireString(payload.checkpointId, "payload.checkpointId");
      break;
    case "failure":
      if (payload.stepId !== undefined) requireString(payload.stepId, "payload.stepId");
      if (payload.category !== undefined) {
        assertThat(
          ["environment_fault", "operator_deviation", "product_performance"].includes(payload.category),
          400,
          "invalid_field",
          "payload.category 不合法",
        );
      }
      break;
    default:
      break;
  }
}

// 审计输出前脱敏：设备密钥与身份令牌永不外泄。
function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = key === "deviceSecret" || key === "token" ? "***" : redact(item);
    }
    return out;
  }
  return value;
}

function diffById(before, after, idField) {
  const beforeMap = new Map(before.map((item) => [item[idField], canonicalJson(item)]));
  const afterMap = new Map(after.map((item) => [item[idField], canonicalJson(item)]));
  const changed = [];
  for (const [id, serialized] of beforeMap) {
    if (afterMap.get(id) !== serialized) changed.push(id);
  }
  for (const id of afterMap.keys()) {
    if (!beforeMap.has(id)) changed.push(id);
  }
  return changed;
}

function compilePattern(pattern) {
  const parts = pattern.split("/").filter(Boolean);
  return (pathname) => {
    const segments = pathname.split("/").filter(Boolean);
    if (segments.length !== parts.length) return null;
    const params = {};
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      if (part.startsWith(":")) {
        params[part.slice(1)] = decodeURIComponent(segments[index]);
      } else if (part !== segments[index]) {
        return null;
      }
    }
    return params;
  };
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    assertThat(size <= MAX_BODY_BYTES, 413, "payload_too_large", "请求体过大");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid_json", "请求体不是合法 JSON");
  }
}

export function createServer(options = {}) {
  const adminToken = options.adminToken ?? process.env.ADMIN_TOKEN ?? "dev-admin-token";
  const persist = options.persist ?? true;
  const dataDir = options.dataDir ?? process.env.DATA_DIR ?? "./data";
  const store = Store.open(persist ? path.join(dataDir, "events.jsonl") : null);
  const state = buildState(store.records);

  function resolveIdentity(req) {
    const header = req.headers.authorization;
    if (!header) return null;
    const match = /^Bearer\s+(\S+)\s*$/.exec(header);
    assertThat(match, 401, "invalid_authorization", "Authorization 头格式不正确");
    const token = match[1];
    if (token === adminToken) {
      return { id: "admin", org: "operator", admin: true };
    }
    for (const identity of state.identities.values()) {
      if (identity.token === token) {
        return { id: identity.identityId, org: identity.org, admin: false };
      }
    }
    throw new HttpError(401, "invalid_token", "访问令牌无效");
  }

  function requireAuth(ctx) {
    assertThat(ctx.identity, 401, "unauthenticated", "需要访问令牌");
  }

  function requireAdmin(ctx) {
    requireAuth(ctx);
    assertThat(ctx.identity.admin, 403, "forbidden", "需要管理员权限");
  }

  function projectOf(ctx) {
    const project = state.projects.get(ctx.params.projectId);
    assertThat(project, 404, "project_not_found", "项目不存在");
    return project;
  }

  function roleOf(project, identity) {
    if (identity.admin) return "admin";
    return project.members.get(identity.id) ?? null;
  }

  // 观察员权限按项目隔离：非成员一律 404，不暴露项目是否存在。
  function requireMember(ctx, project) {
    const role = roleOf(project, ctx.identity);
    assertThat(role, 404, "project_not_found", "项目不存在或无权访问");
    return role;
  }

  function requireProjectRole(ctx, project, roles) {
    const role = requireMember(ctx, project);
    assertThat(role === "admin" || roles.includes(role), 403, "forbidden", "当前角色无权执行该操作", {
      role,
    });
    return role;
  }

  function appendRecord(ctx, type, payload) {
    const occurredAt = ctx.body.occurredAt;
    if (occurredAt !== undefined) {
      assertThat(isIsoDate(occurredAt), 400, "invalid_field", "occurredAt 必须是 ISO 时间");
    }
    const record = store.append({ type, actorId: ctx.identity.id, occurredAt: occurredAt ?? null, payload });
    applyRecord(state, record);
    return record;
  }

  function runOf(project, runId) {
    const run = project.runs.get(runId);
    assertThat(run, 404, "run_not_found", "测试运行不存在");
    return run;
  }

  const routes = [];
  const add = (method, pattern, handler) => {
    routes.push({ method, match: compilePattern(pattern), handler });
  };

  // ---------- 身份与资源（管理员） ----------

  add("POST", "/identities", (ctx) => {
    requireAdmin(ctx);
    const { identityId, displayName = null, org = null, token } = ctx.body;
    requireString(identityId, "identityId");
    const existing = state.identities.get(identityId);
    if (existing) {
      assertThat(!token || token === existing.token, 409, "identity_conflict", "身份标识已存在且令牌不一致");
      return { status: 200, body: { identityId, org: existing.org, displayName: existing.displayName, token: existing.token, duplicate: true } };
    }
    const finalToken = token ?? randomToken();
    appendRecord(ctx, "identity_created", { identityId, displayName, org, token: finalToken });
    return { status: 201, body: { identityId, org, displayName, token: finalToken } };
  });

  add("GET", "/identities", (ctx) => {
    requireAdmin(ctx);
    return {
      body: {
        identities: [...state.identities.values()].map((identity) => ({
          identityId: identity.identityId,
          displayName: identity.displayName,
          org: identity.org,
          createdAt: identity.createdAt,
        })),
      },
    };
  });

  add("POST", "/resources", (ctx) => {
    requireAdmin(ctx);
    const { resourceId, lab = null, description = null } = ctx.body;
    requireString(resourceId, "resourceId");
    const existing = state.resources.get(resourceId);
    if (existing) {
      assertThat(existing.lab === lab && existing.description === description, 409, "resource_conflict", "资源标识已存在且属性不一致");
      return { status: 200, body: { ...existing, duplicate: true } };
    }
    appendRecord(ctx, "resource_registered", { resourceId, lab, description });
    return { status: 201, body: state.resources.get(resourceId) };
  });

  add("GET", "/resources", (ctx) => {
    requireAuth(ctx);
    return { body: { resources: [...state.resources.values()] } };
  });

  add("GET", "/resources/:resourceId/bookings", (ctx) => {
    requireAuth(ctx);
    const resource = state.resources.get(ctx.params.resourceId);
    assertThat(resource, 404, "resource_not_found", "资源不存在");
    const bookings = [...state.bookings.values()]
      .filter((booking) => booking.resourceId === resource.resourceId)
      .map((booking) => ({ ...booking }));
    return { body: { resourceId: resource.resourceId, bookings } };
  });

  // ---------- 项目 ----------

  add("POST", "/projects", (ctx) => {
    requireAdmin(ctx);
    const { projectId, name, buyerIdentityId } = ctx.body;
    requireString(projectId, "projectId");
    requireString(name, "name");
    requireString(buyerIdentityId, "buyerIdentityId");
    const existing = state.projects.get(projectId);
    if (existing) {
      assertThat(
        existing.name === name && existing.buyerId === buyerIdentityId,
        409,
        "project_conflict",
        "项目标识已存在且属性不一致",
      );
      return { status: 200, body: { ...projectView(existing), duplicate: true } };
    }
    assertThat(state.identities.has(buyerIdentityId), 400, "unknown_identity", "买方身份不存在");
    appendRecord(ctx, "project_created", { projectId, name, buyerIdentityId });
    return { status: 201, body: projectView(state.projects.get(projectId)) };
  });

  add("GET", "/projects", (ctx) => {
    requireAuth(ctx);
    const projects = [...state.projects.values()]
      .filter((project) => ctx.identity.admin || project.members.has(ctx.identity.id))
      .map(projectView);
    return { body: { projects } };
  });

  add("GET", "/projects/:projectId", (ctx) => {
    requireAuth(ctx);
    const project = projectOf(ctx);
    requireMember(ctx, project);
    return { body: projectView(project) };
  });

  // ---------- 成员管理（买方） ----------

  add("GET", "/projects/:projectId/members", (ctx) => {
    requireAuth(ctx);
    const project = projectOf(ctx);
    requireMember(ctx, project);
    return {
      body: { members: [...project.members.entries()].map(([identityId, role]) => ({ identityId, role })) },
    };
  });

  add("POST", "/projects/:projectId/members", (ctx) => {
    requireAuth(ctx);
    const project = projectOf(ctx);
    requireProjectRole(ctx, project, ["buyer"]);
    const { identityId, role } = ctx.body;
    requireString(identityId, "identityId");
    assertThat(PROJECT_ROLES.has(role), 400, "invalid_field", "role 必须是 buyer/supplier/lab/observer");
    assertThat(state.identities.has(identityId), 400, "unknown_identity", "身份不存在");
    if (project.members.get(identityId) === role) {
      return { status: 200, body: { identityId, role, duplicate: true } };
    }
    appendRecord(ctx, "member_granted", { projectId: project.id, identityId, role });
    return { status: 201, body: { identityId, role } };
  });

  add("POST", "/projects/:projectId/members/:identityId/revoke", (ctx) => {
    requireAuth(ctx);
    const project = projectOf(ctx);
    requireProjectRole(ctx, project, ["buyer"]);
    const { identityId } = ctx.params;
    assertThat(identityId !== project.buyerId, 409, "cannot_revoke_buyer", "不能移除项目买方");
    assertThat(project.members.has(identityId), 404, "not_a_member", "该身份不是项目成员");
    appendRecord(ctx, "member_revoked", { projectId: project.id, identityId });
    return { body: { identityId, revoked: true } };
  });

  // ---------- 基线：场地约束 + 成功判据（买方封存） ----------

  add("PUT", "/projects/:projectId/baseline", (ctx) => {
    requireAuth(ctx);
    const project = projectOf(ctx);
    requireProjectRole(ctx, project, ["buyer"]);
    assertThat(!project.baselineSealed, 409, "baseline_sealed", "基线已封存，不可修改");
    const baseline = validateBaseline(ctx.body);
    appendRecord(ctx, "baseline_submitted", { projectId: project.id, baseline });
    return { body: { status: "draft", hash: sha256hex(canonicalJson(baseline)), ...baseline } };
  });

  add("POST", "/projects/:projectId/baseline/seal", (ctx) => {
    requireAuth(ctx);
    const project = projectOf(ctx);
    requireProjectRole(ctx, project, ["buyer"]);
    if (project.baselineSealed) {
      return {
        status: 200,
        body: { status: "sealed", hash: project.baselineSealed.hash, sealedAt: project.baselineSealed.sealedAt, duplicate: true },
      };
    }
    assertThat(project.baselineDraft, 409, "baseline_missing", "请先提交基线再封存");
    const { submittedAt, ...content } = project.baselineDraft;
    const hash = sha256hex(canonicalJson(content));
    const record = appendRecord(ctx, "baseline_sealed", { projectId: project.id, hash });
    return { body: { status: "sealed", hash, sealedAt: record.receivedAt } };
  });

  add("GET", "/projects/:projectId/baseline", (ctx) => {
    requireAuth(ctx);
    const project = projectOf(ctx);
    requireMember(ctx, project);
    return { body: { draft: project.baselineDraft, sealed: project.baselineSealed } };
  });

  // ---------- 机器人与固件（供应商登记） ----------

  add("POST", "/projects/:projectId/robots", (ctx) => {
    requireAuth(ctx);
    const project = projectOf(ctx);
    requireProjectRole(ctx, project, ["supplier"]);
    const { robotId, model, firmwareVersion, deviceSecret } = ctx.body;
    requireString(robotId, "robotId");
    requireString(model, "model");
    requireString(firmwareVersion, "firmwareVersion");
    requireString(deviceSecret, "deviceSecret");
    const existing = project.robots.get(robotId);
    if (existing) {
      assertThat(
        existing.model === model && existing.firmwares.has(firmwareVersion),
        409,
        "robot_conflict",
        "机器人已登记且型号或固件不一致",
      );
      return { status: 200, body: { ...robotView(existing), duplicate: true } };
    }
    appendRecord(ctx, "robot_registered", { projectId: project.id, robotId, model, firmwareVersion, deviceSecret });
    return { status: 201, body: robotView(project.robots.get(robotId)) };
  });

  add("POST", "/projects/:projectId/robots/:robotId/firmware", (ctx) => {
    requireAuth(ctx);
    const project = projectOf(ctx);
    requireProjectRole(ctx, project, ["supplier"]);
    const robot = project.robots.get(ctx.params.robotId);
    assertThat(robot, 404, "robot_not_found", "机器人未登记");
    const { firmwareVersion, deviceSecret } = ctx.body;
    requireString(firmwareVersion, "firmwareVersion");
    requireString(deviceSecret, "deviceSecret");
    const existing = robot.firmwares.get(firmwareVersion);
    if (existing) {
      assertThat(existing.deviceSecret === deviceSecret, 409, "firmware_conflict", "固件版本已登记且密钥不一致");
      return { status: 200, body: { ...robotView(robot), duplicate: true } };
    }
    appendRecord(ctx, "firmware_registered", { projectId: project.id, robotId: robot.robotId, firmwareVersion, deviceSecret });
    return { status: 201, body: robotView(robot) };
  });

  add("GET", "/projects/:projectId/robots", (ctx) => {
    requireAuth(ctx);
    const project = projectOf(ctx);
    requireMember(ctx, project);
    return { body: { robots: [...project.robots.values()].map(robotView) } };
  });

  // ---------- 测试脚本 ----------

  add("POST", "/projects/:projectId/scripts", (ctx) => {
    requireAuth(ctx);
    const project = projectOf(ctx);
    requireProjectRole(ctx, project, ["buyer", "lab"]);
    const { scriptId, version, content } = ctx.body;
    requireString(scriptId, "scriptId");
    requireString(version, "version");
    validateScriptContent(content);
    const hash = sha256hex(canonicalJson(content));
    const script = project.scripts.get(scriptId);
    if (script?.versions.has(hash)) {
      return { status: 200, body: { scriptId, version, hash, duplicate: true } };
    }
    appendRecord(ctx, "script_registered", { projectId: project.id, scriptId, version, hash, content });
    return { status: 201, body: { scriptId, version, hash } };
  });

  add("GET", "/projects/:projectId/scripts", (ctx) => {
    requireAuth(ctx);
    const project = projectOf(ctx);
    requireMember(ctx, project);
    return { body: { scripts: [...project.scripts.values()].map(scriptView) } };
  });

  // ---------- 资源预约（多实验室并发冲突检测） ----------

  add("POST", "/projects/:projectId/bookings", (ctx) => {
    requireAuth(ctx);
    const project = projectOf(ctx);
    requireProjectRole(ctx, project, ["lab"]);
    const { bookingId, resourceId, startsAt, endsAt, purpose = null } = ctx.body;
    requireString(bookingId, "bookingId");
    requireString(resourceId, "resourceId");
    assertThat(isIsoDate(startsAt), 400, "invalid_field", "startsAt 必须是 ISO 时间");
    assertThat(isIsoDate(endsAt), 400, "invalid_field", "endsAt 必须是 ISO 时间");
    assertThat(Date.parse(startsAt) < Date.parse(endsAt), 400, "invalid_field", "startsAt 必须早于 endsAt");
    assertThat(state.resources.has(resourceId), 404, "resource_not_found", "资源不存在");
    const existing = state.bookings.get(bookingId);
    if (existing) {
      const same =
        existing.projectId === project.id &&
        existing.resourceId === resourceId &&
        existing.startsAt === startsAt &&
        existing.endsAt === endsAt;
      assertThat(same, 409, "booking_conflict", "预约标识已存在且内容不一致");
      return { status: 200, body: { ...existing, duplicate: true } };
    }
    const conflicts = [...state.bookings.values()]
      .filter(
        (booking) =>
          booking.resourceId === resourceId &&
          booking.status === "active" &&
          Date.parse(startsAt) < Date.parse(booking.endsAt) &&
          Date.parse(booking.startsAt) < Date.parse(endsAt),
      )
      .map((booking) => booking.bookingId);
    assertThat(conflicts.length === 0, 409, "resource_conflict", "资源在该时段已被预约", { conflicts });
    appendRecord(ctx, "booking_created", { projectId: project.id, bookingId, resourceId, startsAt, endsAt, purpose });
    return { status: 201, body: { ...state.bookings.get(bookingId) } };
  });

  add("POST", "/projects/:projectId/bookings/:bookingId/cancel", (ctx) => {
    requireAuth(ctx);
    const project = projectOf(ctx);
    requireProjectRole(ctx, project, ["lab", "buyer"]);
    const booking = project.bookings.get(ctx.params.bookingId);
    assertThat(booking, 404, "booking_not_found", "预约不存在");
    if (booking.status === "cancelled") {
      return { status: 200, body: { bookingId: booking.bookingId, status: "cancelled", duplicate: true } };
    }
    appendRecord(ctx, "booking_cancelled", { projectId: project.id, bookingId: booking.bookingId, reason: ctx.body.reason ?? null });
    return { body: { bookingId: booking.bookingId, status: "cancelled" } };
  });

  add("GET", "/projects/:projectId/bookings", (ctx) => {
    requireAuth(ctx);
    const project = projectOf(ctx);
    requireMember(ctx, project);
    return { body: { bookings: [...project.bookings.values()].map((booking) => ({ ...booking })) } };
  });

  // ---------- 轮次与测试运行 ----------

  add("POST", "/projects/:projectId/runs", (ctx) => {
    requireAuth(ctx);
    const project = projectOf(ctx);
    requireProjectRole(ctx, project, ["lab"]);
    const { runId, robotId, scriptId, resourceId, bookingId } = ctx.body;
    requireString(runId, "runId");
    requireString(robotId, "robotId");
    requireString(scriptId, "scriptId");
    requireString(resourceId, "resourceId");
    requireString(bookingId, "bookingId");

    assertThat(project.baselineSealed, 409, "baseline_not_sealed", "买方封存基线后才能开始测试运行");
    const robot = project.robots.get(robotId);
    assertThat(robot, 404, "robot_not_found", "机器人未登记");
    const firmwareVersion = ctx.body.firmwareVersion ?? robot.currentFirmware;
    assertThat(robot.firmwares.has(firmwareVersion), 404, "firmware_not_found", "固件版本未登记");
    const script = project.scripts.get(scriptId);
    assertThat(script, 404, "script_not_found", "脚本未登记");
    const scriptHash = script.latestHash;

    const booking = project.bookings.get(bookingId);
    assertThat(booking, 404, "booking_not_found", "预约不存在");
    assertThat(booking.resourceId === resourceId, 409, "booking_invalid", "预约资源与运行资源不一致");
    assertThat(booking.status === "active", 409, "booking_invalid", "预约已取消");
    const now = Date.now();
    assertThat(
      Date.parse(booking.startsAt) <= now && now <= Date.parse(booking.endsAt),
      409,
      "booking_invalid",
      "当前时间不在预约时段内",
    );

    const existing = project.runs.get(runId);
    if (existing) {
      const same =
        existing.robotId === robotId &&
        existing.firmwareVersion === firmwareVersion &&
        existing.scriptId === scriptId &&
        existing.scriptHash === scriptHash &&
        existing.resourceId === resourceId &&
        existing.bookingId === bookingId;
      assertThat(same, 409, "run_conflict", "运行标识已存在且参数不一致");
      return { status: 200, body: { ...runView(existing, { includeEvents: false }), duplicate: true } };
    }

    // 轮次解析：设备（机器人/固件）或脚本哈希与进行中轮次一致则复用，否则开启新轮次。
    let round = project.rounds.find(
      (candidate) =>
        candidate.status === "open" &&
        candidate.robotId === robotId &&
        candidate.firmwareVersion === firmwareVersion &&
        candidate.scriptHash === scriptHash,
    );
    if (!round) {
      const superseded = project.rounds
        .filter((candidate) => candidate.status === "open" && candidate.robotId === robotId)
        .map((candidate) => candidate.number);
      const roundNumber = project.rounds.length + 1;
      appendRecord(ctx, "round_opened", {
        projectId: project.id,
        roundNumber,
        robotId,
        firmwareVersion,
        scriptHash,
        scriptId,
        supersededRounds: superseded,
      });
      round = project.rounds[roundNumber - 1];
    }

    appendRecord(ctx, "run_started", {
      projectId: project.id,
      runId,
      roundNumber: round.number,
      robotId,
      firmwareVersion,
      scriptHash,
      scriptId,
      resourceId,
      bookingId,
    });
    const run = project.runs.get(runId);
    return { status: 201, body: { ...runView(run, { includeEvents: false }), nextSeq: 1 } };
  });

  add("GET", "/projects/:projectId/runs", (ctx) => {
    requireAuth(ctx);
    const project = projectOf(ctx);
    requireMember(ctx, project);
    return { body: { runs: [...project.runs.values()].map((run) => runView(run, { includeEvents: false })) } };
  });

  add("GET", "/projects/:projectId/runs/:runId", (ctx) => {
    requireAuth(ctx);
    const project = projectOf(ctx);
    requireMember(ctx, project);
    return { body: runView(runOf(project, ctx.params.runId)) };
  });

  add("GET", "/projects/:projectId/runs/:runId/upload-status", (ctx) => {
    requireAuth(ctx);
    const project = projectOf(ctx);
    requireMember(ctx, project);
    const run = runOf(project, ctx.params.runId);
    const segment = currentSegment(run);
    return {
      body: {
        runId: run.runId,
        status: run.status,
        currentSegment: segment.n,
        nextSeq: segment.events.length + 1,
        segments: run.segments.map((item) => ({
          segment: item.n,
          receivedEvents: item.events.length,
          cutAtSeq: item.cutAtSeq,
        })),
      },
    };
  });

  // 证据上传：带签名的步骤与传感结果。按事件标识幂等，按分段内序号续传，
  // 服务重启后客户端可凭 upload-status 从中断处继续上传。
  add("POST", "/projects/:projectId/runs/:runId/events", (ctx) => {
    requireAuth(ctx);
    const project = projectOf(ctx);
    requireProjectRole(ctx, project, ["lab"]);
    const run = runOf(project, ctx.params.runId);
    const { eventId, seq, kind, occurredAt, payload, signature } = ctx.body;
    requireString(eventId, "eventId");
    requireString(kind, "kind");
    assertThat(EVENT_KINDS.has(kind), 400, "invalid_field", "kind 必须是 step/sensor/checkpoint/failure/note");
    assertThat(Number.isInteger(seq) && seq > 0, 400, "invalid_field", "seq 必须是正整数");
    assertThat(isIsoDate(occurredAt), 400, "invalid_field", "occurredAt 必须是 ISO 时间");
    validateEventPayload(kind, payload);
    requireString(signature, "signature");

    if (run.eventIds.has(eventId)) {
      const segment = currentSegment(run);
      return {
        status: 200,
        body: { eventId, duplicate: true, runId: run.runId, currentSegment: segment.n, nextSeq: segment.events.length + 1 },
      };
    }
    assertThat(run.status === "running", 409, "run_not_running", "运行不在进行中，不能上传事件", {
      status: run.status,
    });
    const segment = currentSegment(run);
    const expectedSeq = segment.events.length + 1;
    assertThat(seq === expectedSeq, 409, "seq_gap", "事件序号不连续", { expectedSeq });

    const robot = project.robots.get(run.robotId);
    const firmware = robot?.firmwares.get(run.firmwareVersion);
    assertThat(firmware, 409, "firmware_not_registered", "运行对应的固件未登记");
    const expected = hmacSha256hex(
      firmware.deviceSecret,
      evidenceSigningString({ eventId, runId: run.runId, segment: segment.n, seq, occurredAt, payload }),
    );
    assertThat(safeEqualHex(expected, signature), 400, "invalid_signature", "证据签名校验失败");

    const event = {
      eventId,
      runId: run.runId,
      segment: segment.n,
      seq,
      kind,
      occurredAt,
      receivedAt: nowIso(),
      payload,
      signature,
    };
    appendRecord(ctx, "run_event_appended", { projectId: project.id, runId: run.runId, segment: segment.n, event });
    return { status: 201, body: { eventId, segment: segment.n, seq, nextSeq: seq + 1, appended: true } };
  });

  add("POST", "/projects/:projectId/runs/:runId/interrupt", (ctx) => {
    requireAuth(ctx);
    const project = projectOf(ctx);
    requireProjectRole(ctx, project, ["lab"]);
    const run = runOf(project, ctx.params.runId);
    if (run.status === "interrupted") {
      return { status: 200, body: { runId: run.runId, status: "interrupted", duplicate: true } };
    }
    assertThat(run.status === "running", 409, "run_not_running", "只有进行中的运行可以中断", { status: run.status });
    appendRecord(ctx, "run_interrupted", { projectId: project.id, runId: run.runId, reason: ctx.body.reason ?? null });
    return { body: { runId: run.runId, status: "interrupted" } };
  });

  // 从安全检查点重试：截断当前分段并开启新分段。
  // 被截断的事件保留在日志与运行详情中，不存在任何按事件删除的入口。
  add("POST", "/projects/:projectId/runs/:runId/resume", (ctx) => {
    requireAuth(ctx);
    const project = projectOf(ctx);
    requireProjectRole(ctx, project, ["lab"]);
    const run = runOf(project, ctx.params.runId);
    const { checkpointId } = ctx.body;
    requireString(checkpointId, "checkpointId");
    assertThat(run.status === "interrupted", 409, "run_not_interrupted", "运行未处于中断状态", {
      status: run.status,
    });
    const segment = currentSegment(run);
    const checkpoint = segment.events.find(
      (event) => event.kind === "checkpoint" && event.payload.checkpointId === checkpointId,
    );
    assertThat(checkpoint, 404, "checkpoint_not_found", "指定的安全检查点不存在");
    const supersededEvents = segment.events.filter((event) => event.seq > checkpoint.seq).length;
    appendRecord(ctx, "run_resumed", {
      projectId: project.id,
      runId: run.runId,
      fromSegment: segment.n,
      checkpointId,
      checkpointSeq: checkpoint.seq,
      newSegment: segment.n + 1,
    });
    return {
      body: { runId: run.runId, segment: segment.n + 1, nextSeq: 1, supersededEvents },
    };
  });

  add("POST", "/projects/:projectId/runs/:runId/complete", (ctx) => {
    requireAuth(ctx);
    const project = projectOf(ctx);
    requireProjectRole(ctx, project, ["lab"]);
    const run = runOf(project, ctx.params.runId);
    if (run.status === "completed") {
      return { status: 200, body: { runId: run.runId, status: "completed", duplicate: true } };
    }
    appendRecord(ctx, "run_completed", { projectId: project.id, runId: run.runId });
    return { body: { runId: run.runId, status: "completed" } };
  });

  add("GET", "/projects/:projectId/rounds", (ctx) => {
    requireAuth(ctx);
    const project = projectOf(ctx);
    requireMember(ctx, project);
    return {
      body: {
        rounds: project.rounds.map((round) => ({
          number: round.number,
          robotId: round.robotId,
          firmwareVersion: round.firmwareVersion,
          scriptHash: round.scriptHash,
          scriptId: round.scriptId,
          status: round.status,
          openedAt: round.openedAt,
          runIds: [...round.runIds],
        })),
      },
    };
  });

  // ---------- 争议处理 ----------

  add("POST", "/projects/:projectId/disputes", (ctx) => {
    requireAuth(ctx);
    const project = projectOf(ctx);
    requireProjectRole(ctx, project, ["buyer", "supplier", "lab"]);
    const { disputeId, subjectType, subjectId, claim } = ctx.body;
    requireString(disputeId, "disputeId");
    requireString(subjectType, "subjectType");
    requireString(subjectId, "subjectId");
    requireString(claim, "claim");
    const existing = project.disputes.get(disputeId);
    if (existing) {
      const same =
        existing.subjectType === subjectType && existing.subjectId === subjectId && existing.claim === claim;
      assertThat(same, 409, "dispute_conflict", "争议标识已存在且内容不一致");
      return { status: 200, body: { ...existing, duplicate: true } };
    }
    appendRecord(ctx, "dispute_opened", { projectId: project.id, disputeId, subjectType, subjectId, claim });
    return { status: 201, body: project.disputes.get(disputeId) };
  });

  add("POST", "/projects/:projectId/disputes/:disputeId/resolve", (ctx) => {
    requireAuth(ctx);
    const project = projectOf(ctx);
    requireProjectRole(ctx, project, ["buyer"]);
    const dispute = project.disputes.get(ctx.params.disputeId);
    assertThat(dispute, 404, "dispute_not_found", "争议不存在");
    const { resolution, outcome = null } = ctx.body;
    requireString(resolution, "resolution");
    if (dispute.status === "resolved") {
      assertThat(
        dispute.resolution === resolution,
        409,
        "dispute_resolved",
        "争议已结案且结论不一致",
      );
      return { status: 200, body: { ...dispute, duplicate: true } };
    }
    appendRecord(ctx, "dispute_resolved", { projectId: project.id, disputeId: dispute.disputeId, resolution, outcome });
    return { body: project.disputes.get(dispute.disputeId) };
  });

  add("GET", "/projects/:projectId/disputes", (ctx) => {
    requireAuth(ctx);
    const project = projectOf(ctx);
    requireMember(ctx, project);
    return { body: { disputes: [...project.disputes.values()] } };
  });

  // ---------- 报告与复算 ----------

  add("GET", "/projects/:projectId/report", (ctx) => {
    requireAuth(ctx);
    const project = projectOf(ctx);
    requireMember(ctx, project);
    return { body: computeReport(project) };
  });

  add("POST", "/projects/:projectId/reports", (ctx) => {
    requireAuth(ctx);
    const project = projectOf(ctx);
    requireProjectRole(ctx, project, ["buyer"]);
    const { snapshotId } = ctx.body;
    requireString(snapshotId, "snapshotId");
    assertThat(!project.reportSnapshots.has(snapshotId), 409, "snapshot_exists", "报告快照标识已存在");
    const report = computeReport(project);
    appendRecord(ctx, "report_snapshot_created", {
      projectId: project.id,
      snapshotId,
      contentHash: report.contentHash,
      report,
    });
    return { status: 201, body: { snapshotId, contentHash: report.contentHash, generatedAt: report.generatedAt } };
  });

  add("GET", "/projects/:projectId/reports", (ctx) => {
    requireAuth(ctx);
    const project = projectOf(ctx);
    requireMember(ctx, project);
    return {
      body: {
        snapshots: [...project.reportSnapshots.values()].map((snapshot) => ({
          snapshotId: snapshot.snapshotId,
          contentHash: snapshot.contentHash,
          generatedAt: snapshot.generatedAt,
          generatedBy: snapshot.generatedBy,
        })),
      },
    };
  });

  add("GET", "/projects/:projectId/reports/:snapshotId", (ctx) => {
    requireAuth(ctx);
    const project = projectOf(ctx);
    requireMember(ctx, project);
    const snapshot = project.reportSnapshots.get(ctx.params.snapshotId);
    assertThat(snapshot, 404, "snapshot_not_found", "报告快照不存在");
    return { body: snapshot.report };
  });

  // 复算：用当前证据重新计算，与快照逐条比对结论与失败归因。
  add("GET", "/projects/:projectId/reports/:snapshotId/verify", (ctx) => {
    requireAuth(ctx);
    const project = projectOf(ctx);
    requireMember(ctx, project);
    const snapshot = project.reportSnapshots.get(ctx.params.snapshotId);
    assertThat(snapshot, 404, "snapshot_not_found", "报告快照不存在");
    const current = computeReport(project);
    return {
      body: {
        snapshotId: snapshot.snapshotId,
        matches: snapshot.contentHash === current.contentHash,
        storedHash: snapshot.contentHash,
        currentHash: current.contentHash,
        changedConclusions: diffById(snapshot.report.conclusions, current.conclusions, "conclusionId"),
        changedFailures: diffById(snapshot.report.failures, current.failures, "failureEventId"),
      },
    };
  });

  // ---------- 审计 ----------

  add("GET", "/projects/:projectId/audit", (ctx) => {
    requireAuth(ctx);
    const project = projectOf(ctx);
    requireMember(ctx, project);
    const records = state.records
      .filter((record) => record.payload?.projectId === project.id)
      .map((record) => redact(record));
    return { body: { records } };
  });

  const server = http.createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    try {
      const { pathname } = new URL(req.url, "http://localhost");
      if (pathname === "/health" && req.method === "GET") {
        return send(200, { status: "ok" });
      }
      const identity = resolveIdentity(req);
      let methodMismatch = false;
      for (const route of routes) {
        const params = route.match(pathname);
        if (!params) continue;
        if (route.method !== req.method) {
          methodMismatch = true;
          continue;
        }
        const body = req.method === "GET" ? {} : await readJsonBody(req);
        const ctx = { req, params, body, identity };
        const result = (await route.handler(ctx)) ?? {};
        return send(result.status ?? 200, result.body ?? {});
      }
      // 本服务不提供任何删除/局部修改入口：记录只追加。
      if (methodMismatch || req.method === "DELETE" || req.method === "PATCH") {
        throw new HttpError(405, "method_not_allowed", "该方法不被允许：记录只追加，不支持修改或删除");
      }
      throw new HttpError(404, "not_found", "资源不存在");
    } catch (error) {
      if (error instanceof HttpError) {
        return send(error.status, { error: { code: error.code, message: error.message, details: error.details ?? null } });
      }
      console.error(error);
      return send(500, { error: { code: "internal_error", message: "服务内部错误" } });
    }
  });

  server.context = { state, store };
  return server;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const port = Number(process.env.PORT ?? 8000);
  createServer().listen(port, "127.0.0.1", () => {
    console.log(`机器人场景验收场服务已启动: http://127.0.0.1:${port}`);
  });
}
