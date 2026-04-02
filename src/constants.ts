export const TRAIN_CLASS_LIST = ["G", "D", "C", "K", "Z", "T", "Y", "S"];

export const PAGE_SIZE = 200;

/** 安全请求：每次请求前随机休眠范围 [min, max] ms，可调低以提速、调高以避检测 */
export const SAFE_REQUEST_DELAY_MIN = 2000;
export const SAFE_REQUEST_DELAY_MAX = 5000;

/** 单次请求内换代理重试时的休眠范围 [min, max] ms */
export const REQUEST_RETRY_DELAY_MIN = 300;
export const REQUEST_RETRY_DELAY_MAX = 1000;

/** 失败重试轮内：每批并发数，批与批之间再休眠 */
export const RETRY_BATCH_SIZE = 4;
export const RETRY_BATCH_DELAY_MIN = 200;
export const RETRY_BATCH_DELAY_MAX = 500;
