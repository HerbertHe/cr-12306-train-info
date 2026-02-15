/**
 * 睡眠随机时间
 * @param min 最小睡眠时间，单位：毫秒
 * @param max 最大睡眠时间，单位：毫秒
 * @returns Promise
 */
export const sleep = (min: number, max: number) => {
  const ms = Math.floor(Math.random() * (max - min + 1) + min);
  return new Promise((resolve) => setTimeout(resolve, ms));
};
