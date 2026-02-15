interface ITask<T> {
  task: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: any) => void;
}

/**
 * 任务调度器
 * @param maxConcurrent 最大并发数
 * @returns 
 */
export class TaskScheduler {
  private queue: Array<ITask<any>> = [];
  private maxConcurrent: number;
  private running: number = 0;

  constructor(maxConcurrent: number) {
    this.maxConcurrent = maxConcurrent;
    this.running = 0;
    this.queue = [];
  }

  add<T>(task: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject } as ITask<T>);
      this.run();
    });
  }

  run() {
    if (this.running >= this.maxConcurrent || this.queue.length === 0) {
      return;
    }

    const { task, resolve, reject } = this.queue.shift() as ITask<any>;
    this.running++;

    task()
      .then(resolve)
      .catch(reject)
      .finally(() => {
        this.running--;
        this.run();
      });
  }
}
