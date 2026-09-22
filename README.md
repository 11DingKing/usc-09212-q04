# 机器人场景验收场

面向多机构协作的场景验收服务：采购团队为每个验收项目独立组织测试与争议处理，买方封存场地约束与成功判据，供应商登记机器人及固件版本，实验室在受控资源上执行测试运行并上传带签名的证据，最终报告可由任何一方复算。

运行 `npm test` 可检查基础行为，执行 `npm start` 可启动服务（默认 `127.0.0.1:8000`）。

## 运行配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8000` | 监听端口 |
| `DATA_DIR` | `./data` | 只追加事件日志（`events.jsonl`）所在目录 |
| `ADMIN_TOKEN` | `dev-admin-token` | 管理员令牌，生产环境必须覆盖 |

除身份令牌与设备密钥外无外部依赖；数据全部落盘于事件日志，服务重启后自动重放恢复。

## 核心流程

1. 管理员创建身份（`POST /identities`）、资源（`POST /resources`）与项目（`POST /projects`）。
2. 买方提交并封存基线（`PUT /projects/:id/baseline` + `POST .../baseline/seal`），封存后不可修改；买方按项目授予成员角色（buyer / supplier / lab / observer）。
3. 供应商登记机器人与固件（`POST /projects/:id/robots`、`POST .../robots/:rid/firmware`），实验室登记测试脚本（`POST /projects/:id/scripts`，内容寻址哈希）。
4. 实验室预约资源时段（`POST /projects/:id/bookings`，时段冲突返回 409），随后开启测试运行（`POST /projects/:id/runs`）。设备（机器人/固件）或脚本哈希变化会自动生成新轮次。
5. 运行中上传带签名的步骤与传感结果（`POST .../runs/:rid/events`），按事件标识幂等、按分段序号续传；中断（`interrupt`）后可从安全检查点重试（`resume`），被取代的事件保留可审计，不存在删除入口。
6. 任何项目成员可获取报告（`GET /projects/:id/report`）；买方可生成快照（`POST /projects/:id/reports`），之后随时复算比对（`GET .../reports/:sid/verify`）。争议由项目内角色发起、买方结案（`POST .../disputes`、`POST .../disputes/:did/resolve`）。

## 证据签名

事件签名 = `HMAC-SHA256(设备密钥, 签名串)`，签名串为事件标识、运行标识、分段号、序号、事件时间与负载规范哈希的逐行拼接（见 `src/util.mjs` 的 `evidenceSigningString`）。设备密钥随固件版本登记，服务端收到事件即校验，签名不合法一律拒绝。

## 失败归因

报告对每条失败事件确定性归因（算法版本见 `src/report.mjs`）：

- `environment_fault`（环境故障）：失败前窗口内传感数据违反买方封存的场地约束；
- `operator_deviation`（操作偏差）：步骤参数或顺序偏离登记脚本；
- `product_performance`（产品表现）：环境合规且操作符合脚本。

每条结论都携带 `ruleId` 与 `evidenceIds`，上传方自报的类别仅作对照，不影响复算结果。
