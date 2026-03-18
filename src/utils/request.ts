/// <reference path="../typing.d.ts" />

import fs from "fs";
import path from "path";

import { HttpsProxyAgent } from "https-proxy-agent";
import { sleep } from "./sleep";

/** 模拟 12306 官网浏览器请求头（与 kyfw.12306.cn / search.12306.cn 一致） */
const DEFAULT_HEADERS: HeadersInit = {
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
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
  "sec-ch-ua":
    '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"macOS"',
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
  /** 请求序号，用于按偏移分配代理；取代理时用 offset % pool.length，超过最大值则从头开始 */
  private requestCounter = 0;
  private failedQueue: Array<{ url: string; options: RequestInit }> = [];
  private successCount = 0;
  private permanentlyFailedUrls: string[] = [];

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
  } = {}) {
    this.proxyListUrl =
      options.proxyListUrl ??
      "https://raw.githubusercontent.com/hw630590/free-proxies/refs/heads/main/proxies/http/http.txt";
    this.validateUrl = options.validateUrl ?? "https://www.baidu.com";
    this.validateTimeoutMs = options.validateTimeoutMs ?? 8000;
    this.validateConcurrency = options.validateConcurrency ?? 15;
    this.localFilePath = options.localFilePath;
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
    const fetchOptions: RequestInit & { agent?: any } = {
      ...options,
      headers: mergedHeaders,
    };

    const agent = new HttpsProxyAgent(proxyUrl);
    (fetchOptions as any).agent = agent;

    const rsp = await fetch(url, fetchOptions);

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

    console.log("[返回值]", JSON.stringify(result, null, 2));
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

    const mergedHeaders = new Headers(DEFAULT_HEADERS);
    const customHeaders = new Headers(options?.headers);
    customHeaders.forEach((value, key) => mergedHeaders.set(key, value));

    const baseOffset = this.takeRequestOffset();
    const effectiveOffset = baseOffset % poolSize;
    let lastResult: API.IResponse<T> | null = null;

    console.log("[请求]", {
      url,
      method: options.method || "GET",
      proxyOffset: effectiveOffset,
      poolSize,
    });

    for (let i = 0; i < MAX_REQUEST_RETRIES; i++) {
      const proxyUrl = this.getProxyUrlByIndex(baseOffset + i);
      if (!proxyUrl) {
        console.log(
          `[请求] 第 ${i + 1}/${MAX_REQUEST_RETRIES} 次 无可用代理，跳过`,
        );
        lastResult = {
          code: 0,
          success: false,
          message: "无可用代理",
        } as API.IResponse<T>;
        await sleep(500, 1500);
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

        console.log(
          `请求未成功 (${i + 1}/${MAX_REQUEST_RETRIES}):`,
          result.message,
        );
      } catch (err) {
        console.log(
          `代理/请求异常 (${i + 1}/${MAX_REQUEST_RETRIES}):`,
          err instanceof Error ? err.message : String(err),
        );
        lastResult = {
          code: 0,
          success: false,
          message: err instanceof Error ? err.message : String(err),
        } as API.IResponse<T>;
      }

      if (i < MAX_REQUEST_RETRIES - 1) {
        await sleep(500, 1500);
      }
    }

    console.log("已达最大重试次数，记录到失败队列，稍后重试:", url);
    this.failedQueue.push({ url, options });
    return lastResult!;
  }

  /** 安全请求：随机休眠后发起请求，从代理池按偏移分散 */
  async safeRequest<T = any>(
    url: string,
    options: RequestInit = {},
  ): Promise<API.IResponse<T>> {
    await sleep(1_000, 3_000);
    return this.request<T>(url, options);
  }

  getFailedQueueLength(): number {
    return this.failedQueue.length;
  }

  /**
   * 将失败队列中的请求按偏移分散重新执行一次，并清空当前失败队列。
   */
  async retryFailedRequests(): Promise<API.IResponse<any>[]> {
    if (this.failedQueue.length === 0) return [];
    const todo = this.failedQueue.splice(0, this.failedQueue.length);
    console.log(
      `[重试] 开始重试 ${todo.length} 个失败请求（按代理池偏移分散）`,
    );
    const results: API.IResponse<any>[] = [];
    for (const { url, options } of todo) {
      await sleep(300, 800);
      const r = await this.request(url, options);
      results.push(r);
      if (r.success) console.log("[重试] 成功:", url);
      else console.log("[重试] 仍失败:", url);
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
