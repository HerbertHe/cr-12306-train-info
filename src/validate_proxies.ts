import fs from "fs";
import path from "path";

import { ProxyPoolManager } from "./utils";

async function main() {
  const manager = new ProxyPoolManager();
  const start = Date.now();
  const count = await manager.ensurePool();
  const proxies = manager.getPoolSnapshot();
  const durationMs = Date.now() - start;

  const filePath = path.join(process.cwd(), "proxies.txt");
  fs.writeFileSync(filePath, proxies.join("\n"), "utf-8");

  console.log(
    `[代理验证] 完成校验，写入本地文件: ${filePath}，可用代理数量: ${count}，耗时: ${durationMs} ms`,
  );
}

main().catch((err) => {
  console.error("[代理验证] 运行出错", err);
  process.exit(1);
});

