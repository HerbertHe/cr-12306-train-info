# cr-12306-train-info

从国铁 12306 搜索接口拉取车次列表与车次详情，并落盘为 JSON / Markdown。

## 功能

- **车次列表抓取**：按车次等级（G/D/C/K/Z/T/Y/S）与数字前缀递归查询覆盖所有车次，单次返回少于 200 条视为该前缀已完整并立即持久化
- **并发控制**：通过任务调度器 `TaskScheduler` 限制最多同时执行 **300** 个请求，避免压垮本机或被接口限流
- **失败重试**：请求失败会进入失败队列，在主抓取结束后按偏移分散重试，最多重试 3 轮
- **车次列表输出**（去重后按车号聚合、按车次类型排序）：
  - 车次列表 JSON：`dist/train_list_YYYYMMDD.json`
  - 车次列表 Markdown：`dist/train_list_YYYYMMDD.md`
- **车次详情抓取与输出**（按去重后的车号逐个请求、站点名自动去空格）：
  - 车次详情 JSON：`dist/train_detail_YYYYMMDD.json`
  - 车次详情 Markdown：`dist/train_detail_YYYYMMDD.md`

## 环境与运行

- Node.js + TypeScript（使用 `tsx` 直接运行 TS）
- 安装依赖：`npm install`
- 运行爬虫：`npm run dev`

## 说明

- **查询日期**：默认为「当前日期 + 13 天」，格式为 `YYYYMMDD`
  - 日期用于调用 12306 接口
  - 同时会拼接到输出文件名中（如 `train_list_20260318.json`）
- **并发与任务调度**：
  - 所有对 12306 的请求都通过 `TaskScheduler` 统一调度
  - 当前默认并发上限为 300，如需调整可修改 `src/index.ts` 中的 `new TaskScheduler(300)`
- **代理与网络**：
  - 支持通过 `HttpsProxyAgent` 使用代理，代理池逻辑在 `src/utils/request.ts` 中
  - 需可访问 12306 搜索接口；在受限网络环境下建议配置可用的 HTTP 代理

## 免责声明

本项目仅供学习交流使用，请勿用于任何商业或非法用途。  
使用本项目时须遵守国家及地区的相关法律法规以及 12306 等网站的使用条款，由此产生的一切后果由使用者自行承担。
