import { queryTrainListByKeywordAndDate } from "./services/train";
import { ITrain } from "./services/train/model";

import { saveData, TaskScheduler } from "./utils";
import { PAGE_SIZE, TRAIN_CLASS_LIST } from "./constants";

class Spider {
  /**
   * 任务调度器
   * 最多同时执行 6 个任务
   */
  private taskScheduler = new TaskScheduler(6);

  /**
   * 车次列表
   */
  private trainList: Set<ITrain> = new Set();

  /**
   * 运行爬虫
   */
  run = async () => {
    await this.fetchTrainList();
    saveData(Array.from(this.trainList), "trainList.json");
  };

  /**
   * 获取所有车次列表
   * 遍历所有车次等级，每个车次等级遍历 0 - 9 的编号
   */
  private fetchTrainList = async () => {
    const startTime = process.hrtime();
    const promises: Promise<void>[] = [];

    for (const trainClass of TRAIN_CLASS_LIST) {
      for (let i = 1; i <= 9; i++) {
        console.log(`获取车次列表, ${trainClass}${i}`);
        promises.push(this.processTrainList(`${trainClass}${i}`, "20260217"));
      }
    }

    await Promise.all(promises);

    const endTime = process.hrtime(startTime);
    console.log(`获取车次列表完成, 耗时: ${endTime[0]}s ${endTime[1] / 1000000}ms`);
  };

  /**
   * 车次列表获取处理
   * @param prefix 前缀
   */
  private processTrainList = async (prefix: string, date: string) => {
    console.log(`处理车次列表, ${prefix}`);
    const rsp = await this.taskScheduler.add(async () => {
      return await queryTrainListByKeywordAndDate(prefix, date);
    });

    // 请求失败
    if (!rsp.success) {
      return;
    }

    const trainList = rsp.data ?? [];

    console.log(`${prefix} 车次列表获取完成, 数据: ${trainList.length}`);

    if (trainList.length === 0) {
      return;
    }

    // 数据小于 200，完整数据
    if (trainList.length < PAGE_SIZE) {
      console.log(`${prefix} 车次列表获取完成，数据小于 200，完整数据存入`);
      trainList.forEach((train) => {
        this.trainList.add(train);
      });

      return;
    }

    // 数据大于等于 200 条，保存精确匹配项目，子任务分页查询
    const exactMatchTrain = trainList.find(
      (t) => t.station_train_code === prefix,
    );

    if (exactMatchTrain) {
      console.log(`存入精确匹配项目, ${prefix}`);
      this.trainList.add(exactMatchTrain);
    }

    // 递归拆分任务
    const subTasks: Promise<void>[] = [];
    for (let j = 0; j <= 9; j++) {
      console.log(`递归拆分任务, ${prefix}${j}`);
      subTasks.push(this.processTrainList(`${prefix}${j}`, date));
    }
    await Promise.all(subTasks);
  };
}

new Spider().run();
