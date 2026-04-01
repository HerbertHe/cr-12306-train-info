interface ITask<T> {
  task: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: any) => void;
}

/**
 * 任务调度器
 * - 支持最大并发限制
 * - 动态调整并发数：成功率高时增加并发，失败率高时减少并发
 * - 任务启动随机延迟，避免请求规则化被检测
 * @param maxConcurrent 最大并发数
 * @param minConcurrent 最小并发数
 * @returns 
 */
export class TaskScheduler {
  private queue: Array<ITask<any>> = [];
  private maxConcurrent: number;
  private minConcurrent: number;
  private currentConcurrent: number;
  private running: number = 0;
  private successCount: number = 0;
  private totalCount: number = 0;

  // 随机延迟范围（毫秒）
  private static readonly MIN_DELAY_MS = 200;
  private static readonly MAX_DELAY_MS = 800;

  constructor(maxConcurrent: number, minConcurrent: number = 2) {
    this.maxConcurrent = maxConcurrent;
    this.minConcurrent = minConcurrent;
    this.currentConcurrent = maxConcurrent;
    this.running = 0;
    this.queue = [];
  }

  /**
   * 获取随机延迟时间
   */
  private getRandomDelay(): number {
    return Math.floor(
      TaskScheduler.MIN_DELAY_MS +
      Math.random() * (TaskScheduler.MAX_DELAY_MS - TaskScheduler.MIN_DELAY_MS)
    );
  }

  /**
   * 根据成功率调整并发数
   * - 成功率 > 95%：尝试增加并发
   * - 成功率 < 80%：减少并发
   * - 中间保持不变
   */
  private adjustConcurrency(): void {
    if (this.totalCount < 20) return; // 样本太少不调整

    const successRate = this.successCount / this.totalCount;
    
    if (successRate > 0.95 && this.currentConcurrent < this.maxConcurrent) {
      this.currentConcurrent++;
      console.log(`[调度器] 成功率 ${(successRate * 100).toFixed(1)}%，增加并发至 ${this.currentConcurrent}`);
    } else if (successRate < 0.8 && this.currentConcurrent > this.minConcurrent) {
      this.currentConcurrent--;
      console.log(`[调度器] 成功率 ${(successRate * 100).toFixed(1)}%，降低并发至 ${this.currentConcurrent}`);
    }
  }

  add<T>(task: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject } as ITask<T>);
      this.run();
    });
  }

  run() {
    if (this.running >= this.currentConcurrent || this.queue.length === 0) {
      return;
    }

    const { task, resolve, reject } = this.queue.shift() as ITask<any>;
    this.running++;
    this.totalCount++;

    // 随机延迟后执行任务，避免请求时间太规则
    const delay = this.getRandomDelay();
    setTimeout(() => {
      task()
        .then(result => {
          this.successCount++;
          resolve(result);
        })
        .catch(reject)
        .finally(() => {
          this.running--;
          // 每次任务完成后调整并发
          this.adjustConcurrency();
          this.run();
        });
    }, delay);
  }

  /** 获取当前并发数 */
  getCurrentConcurrent(): number {
    return this.currentConcurrent;
  }
}
