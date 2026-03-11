# cr-12306-train-info

从国铁 12306 搜索接口拉取车次列表并落盘为 JSON。

## 功能

- 按车次等级（G/D/C/K/Z/T/Y/S）与数字前缀递归查询，覆盖所有车次
- 并发限制 6 个请求，结果去重后写入 `dist/data/trainList.json`
- 单次返回少于 200 条视为该前缀已完整，立即持久化

## 环境与运行

- Node.js + TypeScript（tsx）
- 安装：`npm install`
- 运行：`npm run dev`

## 说明

- 查询日期在 `src/index.ts` 中写死（如 `20260316`），可按需修改
- 需可访问 12306 搜索接口；如需代理可配置 `https-proxy-agent`
