/// <reference path="../typing.d.ts" />

import fs from "fs";
import path from "path";

import { HttpsProxyAgent } from "https-proxy-agent";

import {
  REQUEST_RETRY_DELAY_MAX,
  REQUEST_RETRY_DELAY_MIN,
  RETRY_BATCH_DELAY_MAX,
  RETRY_BATCH_DELAY_MIN,
  RETRY_BATCH_SIZE,
  SAFE_REQUEST_DELAY_MAX,
  SAFE_REQUEST_DELAY_MIN,
} from "../constants";
import { sleep } from "./sleep";

/** 常见的 User-Agent 列表，随机选择降低被拦截概率 */
const USER_AGENTS = [
  // Chrome macOS
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
  // Chrome Windows
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
  // Chrome Linux
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
  // Firefox macOS
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:135.0) Gecko/20100101 Firefox/135.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:136.0) Gecko/20100101 Firefox/136.0",
  // Firefox Windows
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:135.0) Gecko/20100101 Firefox/135.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:136.0) Gecko/20100101 Firefox/136.0",
  // Edge
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 Edg/146.0.0.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 Edg/146.0.0.0",
  // Safari
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Safari/605.1.15",
];

/** 获取随机 User-Agent */
const getRandomUserAgent = (): string => {
  const index = Math.floor(Math.random() * USER_AGENTS.length);
  return USER_AGENTS[index];
};

/** 构建随机化请求头 */
const buildRandomHeaders = (customHeaders: Headers = new Headers()): Headers => {
  const merged = new Headers({
    Accept: "*/*",
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "Accept-Language":
      "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7,ja-JP;q=0.6,ja;q=0.5,zh-TW;q=0.4,ar-XB;q=0.3,ar;q=0.2",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    Origin: "https://kyfw.12306.cn",
    Pragma: "no-cache",
    Referer: "https://kyfw.12306.cn/",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-site",
    "sec-ch-ua-mobile": "?0",
  });

  const userAgent = getRandomUserAgent();
  merged.set("User-Agent", userAgent);

  // 根据浏览器类型设置正确的 sec-ch-ua 头部
  if (userAgent.includes('Chrome')) {
    const chromeVersion = userAgent.match(/Chrome\/(\d+)/)?.[1] || "145";
    merged.set("sec-ch-ua", `"Not:A-Brand";v="99", "Google Chrome";v="${chromeVersion}", "Chromium";v="${chromeVersion}"`);
  } else if (userAgent.includes('Edg')) {
    const edgeVersion = userAgent.match(/Edg\/(\d+)/)?.[1] || "146";
    merged.set("sec-ch-ua", `"Not:A-Brand";v="99", "Microsoft Edge";v="${edgeVersion}", "Chromium";v="${edgeVersion}"`);
  } else {
    // Firefox/Safari 不需要 Chrome 特有的头部
    merged.delete('sec-ch-ua');
    merged.delete('sec-ch-ua-mobile');
    merged.delete('sec-ch-ua-platform');
  }

  // 只有 Chrome 内核才添加平台信息
  if (userAgent.includes('Chrome') || userAgent.includes('Edg')) {
    let platform = '"macOS"';
    if (userAgent.includes('Windows')) platform = '"Windows"';
    if (userAgent.includes('Linux')) platform = '"Linux"';
    merged.set("sec-ch-ua-platform", platform);
  }

  // 合并用户自定义请求头
  customHeaders.forEach((value, key) => merged.set(key, value));

  return merged;
};

/** 代理/请求最大重试次数 */
const MAX_REQUEST_RETRIES = 5;

/**
 * 代理池与请求封装：拉取与校验代理、按偏移分散请求、失败入队与重试。
 * 偏移量超过代理池大小时自动从头开始使用（取模）。
 */
export class ProxyPoolManager {
  private readonly proxyListUrl: string;
  private readonly validateUrl: string;
  private readonly validateTimeoutMs: number;
  private readonly validateConcurrency: number;
  private readonly localFilePath?: string;

  private pool: string[] = [];
  /** 请求序号，用于按偏移分散请求；取代理时用 offset % pool.length，超过最大值则从头开始 */
  private requestCounter = 0;
  private failedQueue: Array<{ url: string; options: RequestInit }> = [];
  private successCount = 0;
  private permanentlyFailedUrls: string[] = [];
  /** 是否允许直连（不使用代理），当代理池为空时 */
  private allowDirectConnection = true;

  // 根据日期进行偏移计算已注释，每次从 0 开始
  // /**
  //  * 根据当前日期计算每日起始偏移，使每天从代理池的不同位置开始。
  //  * 步长 15731 是接近每日请求量(~15000)的质数，与代理池大小互质，
  //  * 保证连续多天运行后能均匀覆盖整个代理池。
  //  * @param poolSize 代理池大小，用于取模使偏移落在池范围内
  //  */
  // private static computeDailyOffset(poolSize: number): number {
  //   const now = new Date();
  //   const epoch = new Date(now.getFullYear(), 0, 1);
  //   const daysSinceEpoch = Math.floor(
  //     (now.getTime() - epoch.getTime()) / (24 * 60 * 60 * 1000),
  //   );
  //   const DAILY_STEP = 15731;
  //   return (daysSinceEpoch * DAILY_STEP) % poolSize;
  // }

  constructor(options: {
    proxyListUrl?: string;
    validateUrl?: string;
    validateTimeoutMs?: number;
    validateConcurrency?: number;
    localFilePath?: string;
    allowDirectConnection?: boolean;
  } = {}) {
    this.proxyListUrl =
      options.proxyListUrl ??
      "https://raw.githubusercontent.com/hw630590/free-proxies/refs/heads/main/proxies/http/http.txt";
    this.validateUrl = options.validateUrl ?? "https://www.baidu.com";
    this.validateTimeoutMs = options.validateTimeoutMs ?? 8000;
    this.validateConcurrency = options.validateConcurrency ?? 15;
    this.localFilePath = options.localFilePath;
    this.allowDirectConnection = options.allowDirectConnection ?? true;
  }

  /** 校验单个代理是否可用 */
  private async validateProxy(proxyUrl: string): Promise<boolean> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.validateTimeoutMs);
    try {
      const agent = new HttpsProxyAgent(proxyUrl);
      const rsp = await fetch(this.validateUrl, {
        method: "GET",
        // @ts-ignore agent 用于 Node fetch
        agent,
        signal: controller.signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        },
      });
      if (rsp.ok) {
        return true;
      }
      return false;
    } catch (e) {
      return false;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async validateProxyList(ipPortList: string[]): Promise<string[]> {
    const results: string[] = [];
    let i = 0;
    while (i < ipPortList.length) {
      const batch = ipPortList.slice(i, i + this.validateConcurrency);
      i += this.validateConcurrency;
      const settled = await Promise.allSettled(
        batch.map(async (ipPort) => {
          const ok = await this.validateProxy(`http://${ipPort}`);
          return { ipPort, ok };
        }),
      );
      for (const s of settled) {
        if (s.status === "fulfilled" && s.value.ok) {
          results.push(s.value.ipPort);
        }
      }
    }
    return results;
  }

  /** 拉取代理列表：优先从本地文件读取；若未配置本地文件，则从远端拉取并用校验地址过滤不可用代理 */
  async loadPool(): Promise<void> {
    try {
      // 优先从本地文件加载（运行爬虫时只读取已验证结果，不再重复校验）
      if (this.localFilePath) {
        const filePath = path.isAbsolute(this.localFilePath)
          ? this.localFilePath
          : path.join(process.cwd(), this.localFilePath);
        if (!fs.existsSync(filePath)) {
          console.log(`[代理池] 本地代理文件不存在: ${filePath}`);
          return;
        }
        const text = fs.readFileSync(filePath, "utf-8");
        const lines = text
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l && l.includes(":"));
        this.pool = lines;
        // 每次从 0 开始，不再按日期计算起始偏移：this.requestCounter = ProxyPoolManager.computeDailyOffset(this.pool.length);
        console.log(
          `[代理池] 从本地文件加载 ${this.pool.length} 个代理, 起始偏移: ${this.requestCounter}, 文件: ${filePath}`,
        );
        return;
      }

      // 未配置本地文件时，从远端拉取并进行校验（用于单独的代理验证脚本）
      const rsp = await fetch(this.proxyListUrl);
      if (!rsp.ok) return;
      const text = await rsp.text();
      const lines = text
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && l.includes(":"));

      if (lines.length) {
        const start = Date.now();
        const valid = await this.validateProxyList(lines);
        this.pool = valid;
        // 每次从 0 开始，不再按日期计算起始偏移：if (this.pool.length > 0) { this.requestCounter = ProxyPoolManager.computeDailyOffset(this.pool.length); }
        const durationMs = Date.now() - start;
        const successCount = this.pool.length;
        const failCount = lines.length - successCount;
        console.log(
          `[代理池] 校验统计 => 成功: ${successCount} 个, 失败: ${failCount} 个, 起始偏移: ${this.requestCounter}, 耗时: ${durationMs} ms`,
        );
      }
    } catch {
      // 忽略代理池加载错误，后续重试会再次拉取
    }
  }

  /** 确保代理池已加载，返回当前池大小 */
  async ensurePool(): Promise<number> {
    if (!this.pool.length) await this.loadPool();
    return this.pool.length;
  }

  /**
   * 按索引取代理。索引超过池大小时取模，从头开始使用代理池。
   */
  getProxyUrlByIndex(index: number): string | null {
    if (!this.pool.length) return null;
    const normalizedIndex = index % this.pool.length;
    const ipPort = this.pool[normalizedIndex];
    return ipPort ? `http://${ipPort}` : null;
  }

  /**
   * 从代理池中移除失败的代理，保持代理池质量
   */
  removeFailedProxies(proxyUrls: string[]): void {
    if (proxyUrls.length === 0) return;

    // 提取 IP:PORT 部分
    const failedIpPorts = proxyUrls.map(url => {
      // 移除 http:// 前缀
      return url.replace(/^http:\/\//, '');
    });

    const originalSize = this.pool.length;
    this.pool = this.pool.filter(ipPort => !failedIpPorts.includes(ipPort));
    const removedCount = originalSize - this.pool.length;

    if (removedCount > 0) {
      console.log(`[代理池] 移除 ${removedCount} 个失败代理，当前池大小: ${this.pool.length}`);
    }
  }

  /** 获取当前代理池大小 */
  getPoolSize(): number {
    return this.pool.length;
  }

  /** 获取当前代理池快照（仅返回 IP:PORT 字符串，不带协议） */
  getPoolSnapshot(): string[] {
    return [...this.pool];
  }

  /**
   * 为本次请求分配偏移（用于分散到不同代理）；取代理时会用该偏移对池大小取模。
   * 每次递增 MAX_REQUEST_RETRIES，为每个请求预留独占的重试代理位，避免相邻请求共用同一批代理。
   */
  takeRequestOffset(): number {
    const offset = this.requestCounter;
    this.requestCounter += MAX_REQUEST_RETRIES;
    return offset;
  }

  private async doOneRequest<T = any>(
    url: string,
    mergedHeaders: Headers,
    options: RequestInit,
    proxyUrl: string,
  ): Promise<API.IResponse<T>> {
    const controller = new AbortController();
    // 设置 15 秒超时，避免慢速代理长时间等待
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    const fetchOptions: RequestInit & { agent?: any; signal: AbortSignal } = {
      ...options,
      headers: mergedHeaders,
      signal: controller.signal,
    };

    const agent = new HttpsProxyAgent(proxyUrl);
    (fetchOptions as any).agent = agent;

    let rsp;
    try {
      rsp = await fetch(url, fetchOptions);
    } catch (err) {
      clearTimeout(timeoutId);
      throw err;
    }
    clearTimeout(timeoutId);

    let result: API.IResponse<T>;
    try {
      if (!rsp.ok) {
        result = {
          code: rsp.status,
          success: false,
          message: rsp.statusText,
        } as API.IResponse<T>;
      } else {
        const data = await rsp.json();
        result = {
          code: rsp.status,
          success: true,
          data: data?.data as T,
          message: data?.message || rsp.statusText,
        } as API.IResponse<T>;
      }
    } catch {
      const data = await rsp.text().catch(() => "");
      result = {
        code: rsp.status,
        success: false,
        data: data as string,
        message: rsp.statusText,
      } as API.IResponse<T>;
     }

     return result;
   }

  /**
   * 请求：按请求序号从代理池偏移取代理（偏移超过池大小时从头开始），失败则换下一个代理重试。
   * 用尽重试仍失败时加入失败队列，可后续通过 retryFailedRequests() 重新执行。
   * 依赖在程序开始时已调用 ensurePool() 加载代理池，此处不再发起加载请求。
   */
  async request<T = any>(
    url: string,
    options: RequestInit = {},
  ): Promise<API.IResponse<T>> {
    const poolSize = this.pool.length;
    if (!poolSize) {
      const fail: API.IResponse<T> = {
        code: 0,
        success: false,
        message: "无可用代理",
      } as API.IResponse<T>;
      this.failedQueue.push({ url, options });
      return fail;
    }

     // 构建随机化请求头
     const customHeaders = new Headers(options?.headers);
     const mergedHeaders = buildRandomHeaders(customHeaders);

     const baseOffset = this.takeRequestOffset();
    const effectiveOffset = baseOffset % poolSize;
    let lastResult: API.IResponse<T> | null = null;

    console.log("[请求]", {
      url,
      method: options.method || "GET",
      proxyOffset: effectiveOffset,
      poolSize,
    });

    let failedProxies: string[] = [];
    // 根据当前代理池大小调整最大重试次数，避免重复使用相同代理
    const maxRetries = Math.min(MAX_REQUEST_RETRIES, this.pool.length);
    for (let i = 0; i < maxRetries; i++) {
      const proxyUrl = this.getProxyUrlByIndex(baseOffset + i);
      if (!proxyUrl) {
        console.log(
          `[请求] 第 ${i + 1}/${maxRetries} 次 无可用代理，跳过`,
        );
        lastResult = {
          code: 0,
          success: false,
          message: "无可用代理",
        } as API.IResponse<T>;
        // 无可用代理也当作代理错误处理
        if (proxyUrl) failedProxies.push(proxyUrl);
        await sleep(REQUEST_RETRY_DELAY_MIN, REQUEST_RETRY_DELAY_MAX);
        continue;
      }

      console.log(`[请求] 第 ${i + 1}/${MAX_REQUEST_RETRIES} 次`, {
        url,
        proxy: proxyUrl,
      });

      try {
        const result = await this.doOneRequest<T>(
          url,
          mergedHeaders,
          options,
          proxyUrl,
        );
        lastResult = result;

        if (result.success) {
          this.successCount++;
          console.log("请求成功:", url);
          return result;
        }

        // 只有当响应不正确时（非 200，但代理能连上）不移除代理
        // 只有连接/超时/网络错误，才认为是代理失效
        console.log(
          `请求未成功 (${i + 1}/${MAX_REQUEST_RETRIES}):`,
          result.message,
        );
      } catch (err) {
        // 连接异常/超时 → 代理失效，需要移除
        failedProxies.push(proxyUrl);
        console.log(
          `代理/网络异常 (${i + 1}/${MAX_REQUEST_RETRIES}):`,
          err instanceof Error ? err.message : String(err),
        );
        lastResult = {
          code: 0,
          success: false,
          message: err instanceof Error ? err.message : String(err),
        } as API.IResponse<T>;
      }

      if (i < MAX_REQUEST_RETRIES - 1) {
        await sleep(REQUEST_RETRY_DELAY_MIN, REQUEST_RETRY_DELAY_MAX);
      }
    }

    // 只移除连接失败/超时的代理，保留能连接但返回错误的代理
    this.removeFailedProxies(failedProxies);

    console.log(`已达最大重试次数(${maxRetries})，记录到失败队列，稍后重试:`, url);
    this.failedQueue.push({ url, options });
    return lastResult!;
  }

  /** 安全请求：按配置随机休眠后发起请求，从代理池按偏移分散 */
  async safeRequest<T = any>(
    url: string,
    options: RequestInit = {},
  ): Promise<API.IResponse<T>> {
    await sleep(SAFE_REQUEST_DELAY_MIN, SAFE_REQUEST_DELAY_MAX);
    return this.request<T>(url, options);
  }

  getFailedQueueLength(): number {
    return this.failedQueue.length;
  }

  /**
   * 重试失败队列中的请求
   * 如果提供了任务调度器，使用调度器控制并发（保持和初始请求相同的并发策略）
   */
  async retryFailedRequests(scheduler?: TaskScheduler): Promise<API.IResponse<any>[]> {
    if (this.failedQueue.length === 0) return [];
    const todo = this.failedQueue.splice(0, this.failedQueue.length);
    console.log(
      `[重试] 开始重试 ${todo.length} 个失败请求${scheduler ? '，使用任务调度器' : `（每批 ${RETRY_BATCH_SIZE} 个并发）`}`,
    );

    if (scheduler) {
      // 使用任务调度器，获得自适应并发和随机延迟，和初始请求保持一致
      const promises = todo.map(({ url, options }) => 
        scheduler.add(() => this.request(url, options))
          .then(result => {
            if (result.success) console.log("[重试] 成功:", url);
            else console.log("[重试] 仍失败:", url);
            return result;
          })
      );
      return Promise.all(promises);
    }

    // 传统批量并发方式（兼容）
    const results: API.IResponse<any>[] = [];
    for (let i = 0; i < todo.length; i += RETRY_BATCH_SIZE) {
      const batch = todo.slice(i, i + RETRY_BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(({ url, options }) => this.request(url, options)),
      );
      for (let j = 0; j < batch.length; j++) {
        results.push(batchResults[j]);
        if (batchResults[j].success)
          console.log("[重试] 成功:", batch[j].url);
        else console.log("[重试] 仍失败:", batch[j].url);
      }
      if (i + RETRY_BATCH_SIZE < todo.length) {
        await sleep(RETRY_BATCH_DELAY_MIN, RETRY_BATCH_DELAY_MAX);
      }
    }
    return results;
  }

  /**
   * 将当前失败队列中的所有 URL 标记为最终失败（在所有重试轮次结束后调用）。
   */
  sealPermanentlyFailed(): void {
    for (const { url } of this.failedQueue) {
      this.permanentlyFailedUrls.push(url);
    }
  }

  getSuccessCount(): number {
    return this.successCount;
  }

  getPermanentlyFailedUrls(): string[] {
    return [...this.permanentlyFailedUrls];
  }
}

const defaultProxyPool = new ProxyPoolManager({
  // 运行爬虫时仅使用已验证的本地代理文件，不再重复远程校验
  localFilePath: "proxies.txt",
});

/** 在程序开始时调用一次，加载并校验代理池，后续 request 不再发起加载请求 */
export const ensureProxyPool = (): Promise<number> =>
  defaultProxyPool.ensurePool();

export const request = defaultProxyPool.request.bind(defaultProxyPool);
export const safeRequest = defaultProxyPool.safeRequest.bind(defaultProxyPool);
export const getFailedQueueLength =
  defaultProxyPool.getFailedQueueLength.bind(defaultProxyPool);
export const retryFailedRequests =
  defaultProxyPool.retryFailedRequests.bind(defaultProxyPool);

export const getProxyPoolSnapshot =
  defaultProxyPool.getPoolSnapshot.bind(defaultProxyPool);
export const sealPermanentlyFailed =
  defaultProxyPool.sealPermanentlyFailed.bind(defaultProxyPool);
export const getSuccessCount =
  defaultProxyPool.getSuccessCount.bind(defaultProxyPool);
export const getPermanentlyFailedUrls =
  defaultProxyPool.getPermanentlyFailedUrls.bind(defaultProxyPool);
