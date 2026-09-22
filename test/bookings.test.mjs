import assert from "node:assert/strict";
import test from "node:test";
import { api, bookingWindow, setupProject, startApp, startRun, TOKENS } from "./helpers.mjs";

test("多实验室并发使用资源：预约冲突检测与取消释放", async () => {
  const app = await startApp();
  try {
    const { projectId } = await setupProject(app.base);
    const window = bookingWindow(1);

    // 同一资源时段重叠 -> 409，并返回冲突预约
    const conflict = await api(app.base, "POST", `/projects/${projectId}/bookings`, {
      token: TOKENS.lab,
      body: { bookingId: "b-2", resourceId: "cell-1", ...window },
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, "resource_conflict");
    assert.deepEqual(conflict.body.error.details.conflicts, ["b-1"]);

    // 不同资源不冲突
    await api(app.base, "POST", "/resources", { token: TOKENS.admin, body: { resourceId: "cell-2", lab: "lab-bj" } });
    const other = await api(app.base, "POST", `/projects/${projectId}/bookings`, {
      token: TOKENS.lab,
      body: { bookingId: "b-3", resourceId: "cell-2", ...window },
    });
    assert.equal(other.status, 201);

    // 不在预约时段内的运行被拒绝
    const past = {
      startsAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
      endsAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    };
    await api(app.base, "POST", `/projects/${projectId}/bookings`, {
      token: TOKENS.lab,
      body: { bookingId: "b-past", resourceId: "cell-2", ...past },
    });
    const stale = await startRun(app.base, projectId, "run-stale", { resourceId: "cell-2", bookingId: "b-past" });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, "booking_invalid");

    // 取消后同一时段可重新预约
    const cancel = await api(app.base, "POST", `/projects/${projectId}/bookings/b-1/cancel`, { token: TOKENS.lab });
    assert.equal(cancel.status, 200);
    const rebooked = await api(app.base, "POST", `/projects/${projectId}/bookings`, {
      token: TOKENS.lab,
      body: { bookingId: "b-4", resourceId: "cell-1", ...window },
    });
    assert.equal(rebooked.status, 201);

    // 已取消的预约不能用于开跑
    const cancelled = await startRun(app.base, projectId, "run-x", { bookingId: "b-1" });
    assert.equal(cancelled.status, 409);
  } finally {
    await app.close();
  }
});
