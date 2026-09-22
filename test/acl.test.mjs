import assert from "node:assert/strict";
import test from "node:test";
import { api, setupProject, startApp, TOKENS } from "./helpers.mjs";

test("观察员权限按项目隔离，角色越权被拒绝", async () => {
  const app = await startApp();
  try {
    const { projectId } = await setupProject(app.base);
    // 第二个项目：observer-1 不是成员
    await api(app.base, "POST", "/projects", {
      token: TOKENS.admin,
      body: { projectId: "p2", name: "另一个项目", buyerIdentityId: "buyer-1" },
    });

    // 未认证与无效令牌
    assert.equal((await api(app.base, "GET", `/projects/${projectId}`)).status, 401);
    assert.equal((await api(app.base, "GET", `/projects/${projectId}`, { token: "nope" })).status, 401);

    // 观察员可读本项目
    assert.equal((await api(app.base, "GET", `/projects/${projectId}`, { token: TOKENS.observer })).status, 200);
    assert.equal((await api(app.base, "GET", `/projects/${projectId}/report`, { token: TOKENS.observer })).status, 200);
    assert.equal((await api(app.base, "GET", `/projects/${projectId}/audit`, { token: TOKENS.observer })).status, 200);

    // 观察员只读：任何写操作被拒绝
    const write = await api(app.base, "POST", `/projects/${projectId}/disputes`, {
      token: TOKENS.observer,
      body: { disputeId: "d-x", subjectType: "run", subjectId: "run-1", claim: "质疑" },
    });
    assert.equal(write.status, 403);
    const seal = await api(app.base, "POST", `/projects/${projectId}/baseline/seal`, { token: TOKENS.observer });
    assert.equal(seal.status, 403);

    // 观察员看不到其他项目（不暴露存在性），项目列表也只含本项目
    assert.equal((await api(app.base, "GET", "/projects/p2", { token: TOKENS.observer })).status, 404);
    const list = await api(app.base, "GET", "/projects", { token: TOKENS.observer });
    assert.deepEqual(list.body.projects.map((p) => p.projectId), [projectId]);

    // 角色边界：供应商不能封存基线，实验室不能管理成员
    const putBaseline = await api(app.base, "PUT", `/projects/${projectId}/baseline`, {
      token: TOKENS.supplier,
      body: { siteConstraints: [], successCriteria: [] },
    });
    assert.equal(putBaseline.status, 403);
    const grant = await api(app.base, "POST", `/projects/${projectId}/members`, {
      token: TOKENS.lab,
      body: { identityId: "observer-1", role: "lab" },
    });
    assert.equal(grant.status, 403);

    // 非成员身份访问 -> 404
    await api(app.base, "POST", "/identities", {
      token: TOKENS.admin,
      body: { identityId: "stranger", token: "token-stranger" },
    });
    assert.equal((await api(app.base, "GET", `/projects/${projectId}`, { token: "token-stranger" })).status, 404);
  } finally {
    await app.close();
  }
});
