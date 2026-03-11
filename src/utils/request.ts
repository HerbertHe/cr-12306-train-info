/// <reference path="../typing.d.ts" />

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

/** 免费代理池配置（使用 GitHub 免费 http 代理列表，完全免费、无需注册） */
const PROXY_LIST_URL =
  "https://raw.githubusercontent.com/hw630590/free-proxies/refs/heads/main/proxies/http/http.txt";

// 简单内存代理池
let proxyPool: string[] = [];
let proxyIndex = -1;

// 从 GitHub 拉取一批免费代理，格式为 ip:port，每行一个
const loadProxyPool = async (): Promise<void> => {
  try {
    const rsp = await fetch(PROXY_LIST_URL);
    if (!rsp.ok) return;
    const text = await rsp.text();
    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && l.includes(":"));

    if (lines.length) {
      proxyPool = lines;
      proxyIndex = -1;
    }
  } catch {
    // 忽略代理池加载错误，后续重试会再次拉取
  }
};

const getNextProxyUrl = async (): Promise<string | null> => {
  if (!proxyPool.length) {
    await loadProxyPool();
    if (!proxyPool.length) return null;
  }

  proxyIndex = (proxyIndex + 1) % proxyPool.length;
  const ipPort = proxyPool[proxyIndex]; // 形如 "ip:port"
  return `http://${ipPort}`;
};

/** 单次请求（仅通过代理），失败抛错或返回非 success 结果 */
const doOneRequest = async <T = any>(
  url: string,
  mergedHeaders: Headers,
  options: RequestInit,
  proxyUrl: string,
): Promise<API.IResponse<T>> => {
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
};

/** 代理/请求最大重试次数（全部使用代理，无直连） */
const MAX_REQUEST_RETRIES = 5;

/**
 * 请求（全部走代理，失败则换代理重试，直到成功或用尽次数）
 * @param url 请求地址
 * @param options 请求选项（headers 会与浏览器默认头合并，传入的优先）
 * @returns 响应（成功或最后一次失败结果）
 */
export const request = async <T = any>(
  url: string,
  options: RequestInit = {},
): Promise<API.IResponse<T>> => {
  const mergedHeaders = new Headers(DEFAULT_HEADERS);
  const customHeaders = new Headers(options?.headers);
  customHeaders.forEach((value, key) => mergedHeaders.set(key, value));

  let lastResult: API.IResponse<T> | null = null;

  console.log("[请求]", { url, method: options.method || "GET" });

  for (let i = 0; i < MAX_REQUEST_RETRIES; i++) {
    const proxyUrl = await getNextProxyUrl();

    if (!proxyUrl) {
      console.log(`[请求] 第 ${i + 1}/${MAX_REQUEST_RETRIES} 次 无可用代理，跳过`);
      lastResult = {
        code: 0,
        success: false,
        message: "无可用代理",
      } as API.IResponse<T>;
      await sleep(500, 1500);
      continue;
    }

    console.log(`[请求] 第 ${i + 1}/${MAX_REQUEST_RETRIES} 次`, { url, proxy: proxyUrl });

    try {
      const result = await doOneRequest<T>(
        url,
        mergedHeaders,
        options,
        proxyUrl,
      );
      lastResult = result;

      if (result.success) {
        console.log("请求成功:", url);
        return result;
      }

      console.log(`请求未成功 (${i + 1}/${MAX_REQUEST_RETRIES}):`, result.message);
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

  console.log("已达最大重试次数，返回最后一次结果:", url);
  return lastResult!;
};

/**
 * 安全爬虫
 * @param url
 * @param options
 * @returns
 */
export const safeRequest = async <T = any>(
  url: string,
  options: RequestInit = {},
) => {
  // 安全休眠
  await sleep(1000, 5000);

  // 请求
  return await request<T>(url, options);
};
