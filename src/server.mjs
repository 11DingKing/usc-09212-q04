import http from "node:http";
import path from "node:path";
import { AcceptanceDomain, DomainError } from "./domain.mjs";
import { FileEventStore, MemoryEventStore } from "./event-store.mjs";
import { authenticate, loadPrincipals } from "./auth.mjs";

const ROLE_RANK = { observer: 0, supplier: 1, buyer_admin: 2 };
const MAX_BODY_BYTES = 5 * 1024 * 1024;

export function createServer(options = {}) {
  const store = options.dataDir
    ? FileEventStore.open(path.join(options.dataDir, "events.jsonl"))
    : new MemoryEventStore();
  const domain = new AcceptanceDomain(store);
  const principals = options.principals ?? loadPrincipals();

  const routes = [];
  const route = (method, pattern, handler) => {
    const keys = [];
    const regex = new RegExp(
      `^${pattern.replace(/:[^/]+/g, (token) => {
        keys.push(token.slice(1));
        return "([^/]+)";
      })}$`,
    );
    routes.push({ method, regex, keys, handler });
  };

  const requirePrincipal = (ctx) => {
    if (!ctx.principal) throw new DomainError(401, "unauthenticated", "缺少有效凭证");
    return ctx.principal;
  };

  const requireRole = (ctx, projectId, minRole) => {
    const principal = requirePrincipal(ctx);
    const role = domain.roleOf(projectId, principal.principalId);
    if (!role || ROLE_RANK[role] < ROLE_RANK[minRole]) {
      throw new DomainError(403, "forbidden", "当前身份在该项目下权限不足");
    }
    return role;
  };

  route("GET", "/health", async () => ({ status: 200, body: { status: "ok" } }));

  route("POST", "/projects", async (ctx) => {
    const principal = requirePrincipal(ctx);
    const body = domain.createProject({
      ...ctx.body,
      buyerOrg: ctx.body.buyerOrg ?? principal.org,
      creator: principal.principalId,
    });
    return { status: 201, body };
  });

  route("GET", "/projects/:projectId", async (ctx) => {
    requireRole(ctx, ctx.params.projectId, "observer");
    return { status: 200, body: domain.projectView(domain.project(ctx.params.projectId)) };
  });

  route("POST", "/projects/:projectId/grants", async (ctx) => {
    requireRole(ctx, ctx.params.projectId, "buyer_admin");
    const body = domain.addGrant({
      projectId: ctx.params.projectId,
      ...ctx.body,
      grantedBy: ctx.principal.principalId,
    });
    return { status: 201, body };
  });

  route("POST", "/projects/:projectId/criteria/seal", async (ctx) => {
    requireRole(ctx, ctx.params.projectId, "buyer_admin");
    const body = domain.sealCriteria({
      projectId: ctx.params.projectId,
      ...ctx.body,
      sealedBy: ctx.principal.principalId,
    });
    return { status: 201, body };
  });

  route("POST", "/projects/:projectId/robots", async (ctx) => {
    requireRole(ctx, ctx.params.projectId, "supplier");
    const body = domain.registerRobot({
      projectId: ctx.params.projectId,
      ...ctx.body,
      supplierOrg: ctx.principal.org,
    });
    return { status: 201, body };
  });

  route("POST", "/projects/:projectId/scripts", async (ctx) => {
    requireRole(ctx, ctx.params.projectId, "buyer_admin");
    const body = domain.publishScript({ projectId: ctx.params.projectId, ...ctx.body });
    return { status: 201, body };
  });

  route("POST", "/projects/:projectId/reservations", async (ctx) => {
    requireRole(ctx, ctx.params.projectId, "supplier");
    const body = domain.createReservation({
      projectId: ctx.params.projectId,
      ...ctx.body,
      createdBy: ctx.principal.principalId,
    });
    return { status: 201, body };
  });

  route("POST", "/projects/:projectId/runs", async (ctx) => {
    requireRole(ctx, ctx.params.projectId, "supplier");
    const body = domain.startRun({ projectId: ctx.params.projectId, ...ctx.body });
    return { status: 201, body };
  });

  route("GET", "/projects/:projectId/runs/:runId", async (ctx) => {
    requireRole(ctx, ctx.params.projectId, "observer");
    const run = domain.getRun(ctx.params.projectId, ctx.params.runId);
    return { status: 200, body: domain.runView(run) };
  });

  route("POST", "/projects/:projectId/runs/:runId/records", async (ctx) => {
    requireRole(ctx, ctx.params.projectId, "supplier");
    const body = domain.uploadRecords({
      projectId: ctx.params.projectId,
      runId: ctx.params.runId,
      records: ctx.body.records,
    });
    return { status: 200, body };
  });

  route("POST", "/projects/:projectId/runs/:runId/interrupt", async (ctx) => {
    requireRole(ctx, ctx.params.projectId, "supplier");
    return { status: 200, body: domain.interruptRun({ projectId: ctx.params.projectId, runId: ctx.params.runId, ...ctx.body }) };
  });

  route("POST", "/projects/:projectId/runs/:runId/retry", async (ctx) => {
    requireRole(ctx, ctx.params.projectId, "supplier");
    const body = domain.retryRun({ projectId: ctx.params.projectId, runId: ctx.params.runId, ...ctx.body });
    return { status: 201, body };
  });

  route("POST", "/projects/:projectId/runs/:runId/complete", async (ctx) => {
    requireRole(ctx, ctx.params.projectId, "supplier");
    return { status: 200, body: domain.completeRun({ projectId: ctx.params.projectId, runId: ctx.params.runId }) };
  });

  route("POST", "/projects/:projectId/runs/:runId/abort", async (ctx) => {
    requireRole(ctx, ctx.params.projectId, "supplier");
    return { status: 200, body: domain.abortRun({ projectId: ctx.params.projectId, runId: ctx.params.runId, ...ctx.body }) };
  });

  route("POST", "/projects/:projectId/disputes", async (ctx) => {
    requireRole(ctx, ctx.params.projectId, "observer");
    const body = domain.openDispute({
      projectId: ctx.params.projectId,
      ...ctx.body,
      openedBy: ctx.principal.principalId,
    });
    return { status: 201, body };
  });

  route("GET", "/projects/:projectId/disputes", async (ctx) => {
    requireRole(ctx, ctx.params.projectId, "observer");
    return { status: 200, body: [...domain.project(ctx.params.projectId).disputes.values()] };
  });

  route("POST", "/projects/:projectId/disputes/:disputeId/resolve", async (ctx) => {
    requireRole(ctx, ctx.params.projectId, "buyer_admin");
    const body = domain.resolveDispute({
      projectId: ctx.params.projectId,
      disputeId: ctx.params.disputeId,
      resolution: ctx.body.resolution,
      resolvedBy: ctx.principal.principalId,
    });
    return { status: 200, body };
  });

  route("POST", "/projects/:projectId/report", async (ctx) => {
    requireRole(ctx, ctx.params.projectId, "buyer_admin");
    const body = domain.publishReport({ projectId: ctx.params.projectId, publishedBy: ctx.principal.principalId });
    return { status: 201, body };
  });

  route("GET", "/projects/:projectId/report", async (ctx) => {
    requireRole(ctx, ctx.params.projectId, "observer");
    return { status: 200, body: domain.latestReport(ctx.params.projectId) };
  });

  route("GET", "/projects/:projectId/report/verify", async (ctx) => {
    requireRole(ctx, ctx.params.projectId, "observer");
    return { status: 200, body: domain.verifyReport(ctx.params.projectId) };
  });

  const server = http.createServer(async (request, response) => {
    try {
      const { pathname } = new URL(request.url, "http://localhost");
      const matched = routes
        .filter((candidate) => candidate.method === request.method)
        .map((candidate) => {
          const match = candidate.regex.exec(pathname);
          if (!match) return null;
          const params = Object.fromEntries(
            candidate.keys.map((key, index) => [key, decodeURIComponent(match[index + 1])]),
          );
          return { handler: candidate.handler, params };
        })
        .find(Boolean);
      if (!matched) {
        send(response, 404, { error: { code: "not_found", message: "资源不存在" } });
        return;
      }
      const body = await readBody(request);
      const principal = authenticate(request, principals);
      const result = await matched.handler({ params: matched.params, body, principal, request });
      send(response, result.status, result.body);
    } catch (error) {
      if (error instanceof DomainError) {
        send(response, error.status, { error: { code: error.code, message: error.message } });
      } else if (error?.code === "invalid_json" || error?.code === "body_too_large") {
        send(response, error.code === "body_too_large" ? 413 : 400, {
          error: { code: error.code, message: error.message },
        });
      } else {
        send(response, 500, { error: { code: "internal", message: "服务内部错误" } });
      }
    }
  });

  server.domain = domain;
  server.eventStore = store;
  return server;
}

function send(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("请求体过大"), { code: "body_too_large" }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(Object.assign(new Error("请求体不是有效 JSON"), { code: "invalid_json" }));
      }
    });
    request.on("error", reject);
  });
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const dataDir = process.env.ACCEPTANCE_DATA_DIR ?? path.join(process.cwd(), "data");
  createServer({ dataDir }).listen(8000, "127.0.0.1");
}
