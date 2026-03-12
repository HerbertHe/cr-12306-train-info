import fs from "fs";
import path from "path";

import { queryTrainListByKeywordAndDate } from "./services/train";
import { ITrain } from "./services/train/model";

import { saveData, TaskScheduler, ensureProxyPool, getFailedQueueLength, retryFailedRequests } from "./utils";
import { PAGE_SIZE, TRAIN_CLASS_LIST } from "./constants";

class Spider {
  /**
   * 任务调度器
   * 最多同时执行 100 个任务
   */
  private taskScheduler = new TaskScheduler(100);

  /**
   * 车次列表
   */
  private trainList: Set<ITrain> = new Set();

  /**
   * 车次编号列表
   */
  private trainListFilteredByTrainNo: Set<ITrain> = new Set();

  /**
   * 串行写入，避免并发写同一文件
   */
  private savePromise = Promise.resolve<void>(void 0);

  /**
   * 将当前车次列表写入文件（仅当某次请求返回少于 200 条时调用）
   */
  private persistTrainList = () => {
    this.savePromise = this.savePromise.then(() =>
      saveData(Array.from(this.trainList), "trainList.json"),
    );
  };

  /**
   * 从 dist/data/trainList.json 加载车次列表（用于本地测试）
   */
  private loadTrainListFromDist = (): boolean => {
    const dataPath = path.join(process.cwd(), "dist", "data", "trainList.json");
    if (!fs.existsSync(dataPath)) {
      return false;
    }
    const raw = fs.readFileSync(dataPath, "utf-8");
    const data = JSON.parse(raw) as ITrain[];
    this.trainList.clear();
    data.forEach((t) => this.trainList.add(t));
    console.log(`已从 dist 加载车次列表, 共 ${this.trainList.size} 条`);
    return true;
  };

  /**
   * 运行爬虫（主请求 + 失败请求按偏移分散重试，直到无失败或达最大轮数）
   * 若环境变量 USE_DIST_DATA=1 则使用 dist/data/trainList.json 本地数据仅执行 processTrainListData
   */
  run = async () => {
    if (process.env.USE_DIST_DATA === "1") {
      if (!this.loadTrainListFromDist()) {
        console.error("dist/data/trainList.json 不存在，无法使用本地数据测试");
        return;
      }
      await this.processTrainListData();
      return;
    }
    await ensureProxyPool();
    await this.fetchTrainList();
    const maxRetryRounds = 3;
    for (let round = 0; round < maxRetryRounds && getFailedQueueLength() > 0; round++) {
      console.log(`[重试轮次 ${round + 1}/${maxRetryRounds}] 重试 ${getFailedQueueLength()} 个失败请求`);
      await retryFailedRequests();
    }
    await this.savePromise;
    await this.processTrainListData();
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
        promises.push(this.processTrainList(`${trainClass}${i}`, "20260316"));
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

    // 某次请求少于 200 条，视为该前缀数据完整，写入文件
    if (trainList.length < PAGE_SIZE) {
      console.log(`${prefix} 车次列表获取完成，数据小于 200，完整数据存入`);
      trainList.forEach((train) => {
        this.trainList.add(train);
      });
      this.persistTrainList();
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

  /**
   * 处理车次列表数据：按 train_no 分组，合并站点车次，生成 markdown 表格到 dist/train_list.md，并填充 trainListFilteredByTrainNo（同车号只保留第一项）
   */
  private processTrainListData = async () => {
    const list = Array.from(this.trainList);

    // 按 train_no 分组
    const byTrainNo = new Map<string, ITrain[]>();
    for (const t of list) {
      const arr = byTrainNo.get(t.train_no) ?? [];
      arr.push(t);
      byTrainNo.set(t.train_no, arr);
    }

    // 同车号只取第一项；构建表格行（站点车次用 / 合并）
    const trainTypeOrder = ["G", "D", "C", "K", "Z", "T", "Y", "S"] as const;
    const getTrainTypeRank = (code: string) => {
      const type = code.charAt(0).toUpperCase();
      const idx = trainTypeOrder.indexOf(type);
      return idx >= 0 ? idx : trainTypeOrder.length;
    };

    const tableRows: {
      from_station: string;
      to_station: string;
      total_num: string;
      train_no: string;
      station_train_code: string;
      first: ITrain;
    }[] = [];

    for (const [, trains] of byTrainNo) {
      const first = trains[0];
      const stationTrainCodes = [...new Set(trains.map((t) => t.station_train_code))]
        .sort()
        .join("/");
      tableRows.push({
        from_station: first.from_station,
        to_station: first.to_station,
        total_num: first.total_num,
        train_no: first.train_no,
        station_train_code: stationTrainCodes,
        first,
      });
    }

    // 按车次类型 G, D, C, K, Z, T, Y, S 排序（以 station_train_code 首字母为准）
    tableRows.sort((a, b) => {
      const rankA = getTrainTypeRank(a.station_train_code);
      const rankB = getTrainTypeRank(b.station_train_code);
      if (rankA !== rankB) return rankA - rankB;
      return a.station_train_code.localeCompare(b.station_train_code);
    });

    this.trainListFilteredByTrainNo.clear();
    tableRows.forEach((r) => this.trainListFilteredByTrainNo.add(r.first));

    // 生成 markdown 表格并写入 dist/train_list.md
    // 表头为中文，括号中带原始变量名，首列为序号，车号和站点车次紧随其后
    const header =
      "| 序号 | 车号(train_no) | 站点车次(station_train_code) | 始发站(from_station) | 终到站(to_station) | 站点数量(total_num) |";
    const sep = "| --- | --- | --- | --- | --- | --- |";
    const rows = tableRows
      .map(
        (r, index) =>
          `| ${index + 1} | ${r.train_no} | ${r.station_train_code} | ${r.from_station} | ${r.to_station} | ${r.total_num} |`,
      )
      .join("\n");
    const md = ["# 车次信息表", "", header, sep, rows, ""].join("\n");

    const distDir = path.join(process.cwd(), "dist");
    if (!fs.existsSync(distDir)) {
      fs.mkdirSync(distDir, { recursive: true });
    }
    const mdPath = path.join(distDir, "train_list.md");
    fs.writeFileSync(mdPath, md, "utf-8");
  };
}

new Spider().run();
