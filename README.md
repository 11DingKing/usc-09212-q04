# 机器人场景验收场

面向多机构协作的场景验收服务：具身机器人从展台进入工业上下料、巡检和清洁现场后，买方与供应商在独立组织的验收项目下完成测试、争议处理与报告复算。

## 核心能力

- **判据封存**：买方封存场地约束与成功判据，版本化并带哈希承诺，封存后不可修改，重新封存产生新版本。
- **机器人登记**：供应商登记机器人及固件版本，重复登记递增登记版本，历史保留。
- **轮次管理**：测试运行按「机器人固件 + 脚本版本 + 判据版本」计算配置指纹，设备或脚本变化自动开启新轮次。
- **签名采集**：每次运行下发签名密钥，步骤结果与传感数据须携带 HMAC 签名方可入库。
- **断点重试**：中断的运行只能从已通过的安全检查点重试；历史尝试与失败记录全部保留，不得挑选性删除。
- **资源互斥**：实验室资源按时段预约，同一资源时段重叠即冲突；运行中的资源不被重复占用。
- **权限隔离**：项目级授权（买方管理 / 供应商 / 观察员），观察员仅对被授权项目只读。
- **断点续传**：全部状态变化追加写入事件日志（fsync 落盘），服务重启后重放恢复；记录按 recordId 幂等去重，客户端可安全重传。
- **报告复算**：报告是事件日志的纯函数，每项结论附证据记录编号；发布后可重新计算并比对内容哈希，失败归因清楚区分环境故障、操作偏差与产品表现。
- **争议处理**：项目成员可针对记录或结论发起争议，买方管理员处理结案，全程留痕。

## 运行

```bash
npm test          # 运行测试
npm start         # 启动服务（默认 127.0.0.1:8000，数据写入 ./data）
```

环境变量：

- `ACCEPTANCE_DATA_DIR`：事件日志目录（默认 `./data`）。
- `ACCEPTANCE_PRINCIPALS`：身份主体配置（JSON 数组，含 `principalId` / `org` / `token`）。未配置时使用仅供本地开发的内置主体（见 `src/auth.mjs`），生产环境必须显式配置。

## API 概览

所有 `/projects` 接口需要 `Authorization: Bearer <token>`。

| 方法 | 路径 | 角色 | 说明 |
| --- | --- | --- | --- |
| POST | `/projects` | 任意身份 | 创建项目，创建者成为买方管理员 |
| POST | `/projects/:id/grants` | 买方管理员 | 项目级授权 |
| POST | `/projects/:id/criteria/seal` | 买方管理员 | 封存场地约束与成功判据 |
| POST | `/projects/:id/robots` | 供应商 | 登记机器人与固件版本 |
| POST | `/projects/:id/scripts` | 买方管理员 | 发布场景脚本（版本递增） |
| POST | `/projects/:id/reservations` | 供应商 | 预约实验室资源（时段互斥） |
| POST | `/projects/:id/runs` | 供应商 | 开始测试运行（返回签名密钥） |
| POST | `/projects/:id/runs/:runId/records` | 供应商 | 批量上传签名记录（幂等） |
| POST | `/projects/:id/runs/:runId/interrupt` | 供应商 | 中断运行 |
| POST | `/projects/:id/runs/:runId/retry` | 供应商 | 从安全检查点重试 |
| POST | `/projects/:id/runs/:runId/complete` `/abort` | 供应商 | 完成 / 中止运行 |
| POST | `/projects/:id/disputes` | 项目成员 | 发起争议 |
| POST | `/projects/:id/disputes/:disputeId/resolve` | 买方管理员 | 处理争议 |
| POST | `/projects/:id/report` | 买方管理员 | 计算并发布报告 |
| GET | `/projects/:id/report` | 项目成员 | 查看最新报告 |
| GET | `/projects/:id/report/verify` | 项目成员 | 复算并比对报告内容哈希 |
| GET | `/projects/:id`、`/runs/:runId`、`/disputes` | 项目成员 | 只读视图 |

## 记录签名

上传记录（步骤结果 / 传感数据）须携带 `signature` 字段：对记录除签名外的全部字段做确定性序列化（键排序的 JSON），以运行创建时下发的 `uploadKey` 计算 HMAC-SHA256。失败记录必须携带 `faultClass`（`environment_fault` / `operational_deviation` / `product_performance`）。
