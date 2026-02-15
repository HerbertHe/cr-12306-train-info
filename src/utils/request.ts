/// <reference path="../typing.d.ts" />

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

/**
 * 请求
 * @param url 请求地址
 * @param options 请求选项（headers 会与浏览器默认头合并，传入的优先）
 * @returns 响应
 */
export const request = async <T = any>(
  url: string,
  options: RequestInit = {},
): Promise<API.IResponse<T>> => {
  const mergedHeaders = new Headers(DEFAULT_HEADERS);
  const customHeaders = new Headers(options?.headers);
  customHeaders.forEach((value, key) => mergedHeaders.set(key, value));

  const rsp = await fetch(url, {
    ...options,
    headers: mergedHeaders,
  });

  console.log("url:", url);
  console.log("rsp:", rsp);

  try {
    if (!rsp.ok) {
      console.log("请求失败:", rsp);
      return {
        code: rsp.status,
        success: false,
        message: rsp.statusText,
      } as API.IResponse<T>;
    }

    const data = await rsp.json();
    
    console.log("请求数据:", data);

    return {
      code: rsp.status,
      success: true,
      data: data?.data as T,
      message: data?.message || rsp.statusText,
    } as API.IResponse<T>;
  } catch (error) {
    try {
      const data = await rsp.text();
      return {
        code: rsp.status,
        success: false,
        data: data as string,
        message: rsp.statusText,
      } as API.IResponse<T>;
    } catch (error) {
      return {
        code: rsp.status,
        success: false,
        message: rsp.statusText,
      } as API.IResponse<T>;
    }
  }
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
