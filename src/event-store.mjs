import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import path from "node:path";

// 仅追加的事件存储。审计记录不得以覆盖方式修改：
// 所有状态变化先落盘（fsync）再应用，重启后按序重放恢复状态。

export class MemoryEventStore {
  constructor() {
    this.events = [];
  }

  append(event) {
    this.events.push(event);
  }

  close() {}
}

export class FileEventStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.events = [];
    this.fd = null;
  }

  static open(filePath) {
    const store = new FileEventStore(filePath);
    if (existsSync(filePath)) {
      for (const line of readFileSync(filePath, "utf8").split("\n")) {
        if (line.trim()) store.events.push(JSON.parse(line));
      }
    } else {
      mkdirSync(path.dirname(filePath), { recursive: true });
    }
    store.fd = openSync(filePath, "a");
    return store;
  }

  append(event) {
    writeSync(this.fd, `${JSON.stringify(event)}\n`);
    fsyncSync(this.fd);
    this.events.push(event);
  }

  close() {
    if (this.fd !== null) {
      closeSync(this.fd);
      this.fd = null;
    }
  }
}
