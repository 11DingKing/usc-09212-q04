import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { nowIso } from "./util.mjs";

// 只追加（append-only）的事件日志。
// 所有审计记录以 JSONL 顺序写入磁盘；服务重启后按序重放即可重建内存投影，
// 任何记录都不会被覆盖或删除（对应领域约定"审计记录不得以覆盖方式修改"）。
export class Store {
  constructor(file) {
    this.file = file ?? null;
    this.records = [];
  }

  static open(file) {
    const store = new Store(file);
    if (store.file && fs.existsSync(store.file)) {
      const lines = fs.readFileSync(store.file, "utf8").split("\n").filter((line) => line.length > 0);
      for (const line of lines) {
        store.records.push(JSON.parse(line));
      }
    }
    return store;
  }

  // record: { type, actorId, occurredAt?, payload }
  // 服务端补充 recordId 与 receivedAt（接收时间），与调用方提供的 occurredAt（事件时间）分离。
  append(record) {
    const full = { ...record, recordId: crypto.randomUUID(), receivedAt: nowIso() };
    if (this.file) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, `${JSON.stringify(full)}\n`);
    }
    this.records.push(full);
    return full;
  }
}
