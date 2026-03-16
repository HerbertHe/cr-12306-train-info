import fs from "fs";
import path from "path";

import {
  queryTrainListByKeywordAndDate,
  queryTrainDetailByTrainNoAndDate,
} from "./services/train";
import {
  ITrain,
  ITrainStationResponseViaTrainNoAndDateList,
  ITrainStationResponseFirstViaTrainNoAndDate,
  ITrainStationResponseViaTrainNoAndDate,
} from "./services/train/model";

import {
  TaskScheduler,
  ensureProxyPool,
  getFailedQueueLength,
  retryFailedRequests,
} from "./utils";
import { PAGE_SIZE, TRAIN_CLASS_LIST } from "./constants";

class Spider {
  /**
   * 任务调度器
   * 最多同时执行 300 个任务
   */
  private taskScheduler = new TaskScheduler(300);

  /**
   * 车次列表
   */
  private trainList: Set<ITrain> = new Set();

  /**
   * 车次编号列表
   */
  private trainListFilteredByTrainNo: Set<ITrain> = new Set();

  /**
   * train_no -> 所有关联的 station_train_code（如 G100/G101），在 processTrainListData 中填充
   */
  private trainNoToStationCodes = new Map<string, string>();

  /**
   * 车次详情数组（车号 + 站点列表，车站名已去空格）
   */
  private trainDetailList: {
    train_no: string;
    station_train_codes: string;
    data: ITrainStationResponseViaTrainNoAndDateList;
  }[] = [];

  /**
   * 串行写入，避免并发写同一文件
   */
  private savePromise = Promise.resolve<void>(void 0);

  /**
   * 将当前车次列表写入文件（仅当某次请求返回少于 200 条时调用）
   * 写入路径与车次详情一致：dist/train_list_YYYYMMDD.json
   */
  private persistTrainList = () => {
    this.savePromise = this.savePromise.then(() => {
      const distDir = path.join(process.cwd(), "dist");
      if (!fs.existsSync(distDir)) fs.mkdirSync(distDir, { recursive: true });
      const date = this.getTargetDate();
      const jsonPath = path.join(distDir, `train_list_${date}.json`);
      fs.writeFileSync(
        jsonPath,
        JSON.stringify(Array.from(this.trainList), null, 2),
        "utf-8",
      );
    });
  };

  /**
   * 运行爬虫（主请求 + 失败请求按偏移分散重试，直到无失败或达最大轮数）
   */
  run = async () => {
    await ensureProxyPool();
    await this.fetchTrainList();
    const maxRetryRounds = 3;
    for (
      let round = 0;
      round < maxRetryRounds && getFailedQueueLength() > 0;
      round++
    ) {
      console.log(
        `[重试轮次 ${round + 1}/${maxRetryRounds}] 重试 ${getFailedQueueLength()} 个失败请求`,
      );
      await retryFailedRequests();
    }
    await this.savePromise;
    await this.processTrainListData();
    await this.fetchTrainDetails();
    await this.processTrainDetailData();
  };

  /**
   * 获取目标日期（当前日期 + 13 天），格式：YYYYMMDD
   */
  private getTargetDate = (): string => {
    const d = new Date();
    d.setDate(d.getDate() + 13);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}${m}${day}`;
  };

  /**
   * 获取所有车次列表
   * 遍历所有车次等级，每个车次等级遍历 0 - 9 的编号
   * 日期默认使用当前日期 + 13 天
   */
  private fetchTrainList = async () => {
    const startTime = process.hrtime();
    const promises: Promise<void>[] = [];
    const date = this.getTargetDate();

    for (const trainClass of TRAIN_CLASS_LIST) {
      for (let i = 1; i <= 9; i++) {
        promises.push(this.processTrainList(`${trainClass}${i}`, date));
      }
    }

    await Promise.all(promises);

    const endTime = process.hrtime(startTime);
    console.log(
      `获取车次列表完成, 耗时: ${endTime[0]}s ${endTime[1] / 1000000}ms`,
    );
  };

  /**
   * 去除始发站/终到站前后及中间所有空格
   */
  private normalizeStation = (s: string): string => s.replace(/\s+/g, "");

  /**
   * 车次详情 API 所需日期格式：20260316 -> 2026-03-16
   */
  private formatDateForDetail = (date: string): string =>
    `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;

  /**
   * 对车次详情站点列表中的车站名去空格（station_name，首项还有 start_station_name、end_station_name）
   */
  private normalizeDetailList = (
    list: ITrainStationResponseViaTrainNoAndDateList,
  ): ITrainStationResponseViaTrainNoAndDateList => {
    const [first, ...rest] = list;
    const normFirst: ITrainStationResponseFirstViaTrainNoAndDate = {
      ...first,
      station_name: this.normalizeStation(first.station_name),
      start_station_name: this.normalizeStation(first.start_station_name),
      end_station_name: this.normalizeStation(first.end_station_name),
    };
    const normRest: ITrainStationResponseViaTrainNoAndDate[] = rest.map(
      (item) => ({
        ...item,
        station_name: this.normalizeStation(item.station_name),
      }),
    );
    return [normFirst, ...normRest];
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

    const normalizedTrain = (t: ITrain): ITrain => ({
      ...t,
      from_station: this.normalizeStation(t.from_station),
      to_station: this.normalizeStation(t.to_station),
    });

    // 某次请求少于 200 条，视为该前缀数据完整，写入文件
    if (trainList.length < PAGE_SIZE) {
      console.log(`${prefix} 车次列表获取完成，数据小于 200，完整数据存入`);
      trainList.forEach((train) => {
        this.trainList.add(normalizedTrain(train));
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
      this.trainList.add(normalizedTrain(exactMatchTrain));
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
    const trainTypeOrder: string[] = ["G", "D", "C", "K", "Z", "T", "Y", "S"];
    const getTrainTypeRank = (code: string) => {
      const type = code.charAt(0).toUpperCase();
      const idx = trainTypeOrder.indexOf(
        type as (typeof trainTypeOrder)[number],
      );
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
      // 车号包含站点车次的作为记录，若无则取第一条
      const chosen =
        trains.find((t) => t.train_no.includes(t.station_train_code)) ??
        trains[0];
      const stationTrainCodes = [
        ...new Set(trains.map((t) => t.station_train_code)),
      ]
        .sort((a, b) => a.localeCompare(b, void 0, { numeric: true }))
        .join("/");
      tableRows.push({
        from_station: chosen.from_station,
        to_station: chosen.to_station,
        total_num: chosen.total_num,
        train_no: chosen.train_no,
        station_train_code: stationTrainCodes,
        first: chosen,
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
    this.trainNoToStationCodes.clear();
    tableRows.forEach((r) => {
      this.trainListFilteredByTrainNo.add(r.first);
      this.trainNoToStationCodes.set(r.train_no, r.station_train_code);
    });

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
    const date = this.getTargetDate();
    const mdPath = path.join(distDir, `train_list_${date}.md`);
    fs.writeFileSync(mdPath, md, "utf-8");
  };

  /**
   * 根据 trainListFilteredByTrainNo 获取车次详情并写入 trainDetailList（车站名已去空格）
   */
  private fetchTrainDetails = async () => {
    const list = Array.from(this.trainListFilteredByTrainNo);
    this.trainDetailList = [];
    const startTime = process.hrtime();
    for (const train of list) {
      const dateStr = this.formatDateForDetail(train.date);
      const rsp = await this.taskScheduler.add(() =>
        queryTrainDetailByTrainNoAndDate(train.train_no, dateStr),
      );
      const rawList =
        rsp.success && Array.isArray(rsp.data?.data)
          ? (rsp.data
              .data as unknown as ITrainStationResponseViaTrainNoAndDateList)
          : null;
      if (!rawList?.length) continue;
      this.trainDetailList.push({
        train_no: train.train_no,
        station_train_codes:
          this.trainNoToStationCodes.get(train.train_no) ??
          rawList[0].station_train_code,
        data: this.normalizeDetailList(rawList),
      });
    }
    const endTime = process.hrtime(startTime);
    console.log(
      `获取车次详情完成, 共 ${this.trainDetailList.length} 条, 耗时: ${endTime[0]}s ${endTime[1] / 1000000}ms`,
    );
  };

  /**
   * 从站点车次代码取车次等级（首字母），如 G123 -> G
   */
  private getTrainClass = (stationTrainCode: string): string =>
    (stationTrainCode || "").charAt(0).toUpperCase() || "OTHER";

  /**
   * 根据 trainDetailList 生成车次详情 markdown 表格到 dist/train_detail.md
   * 同时按车次等级（G、D、C 等）分别写入 train_detail_车次等级_日期.json / .md
   * 表格：序号、车号、站点车次、站点信息（同一车次合并为一行，格式 车站(到站时间 - 发车时间 - 运行时间 - 到达日)，多站用 / 分隔）
   */
  private processTrainDetailData = async () => {
    const trainTypeOrder = ["G", "D", "C", "K", "Z", "T", "Y", "S"] as const;
    const getTrainTypeRank = (code: string) => {
      const type = code.charAt(0).toUpperCase();
      const idx = trainTypeOrder.indexOf(
        type as (typeof trainTypeOrder)[number],
      );
      return idx >= 0 ? idx : trainTypeOrder.length;
    };

    type MergedDetailRow = {
      train_no: string;
      station_train_code: string;
      stationsCell: string;
      total_num: number;
    };

    const rows: MergedDetailRow[] = [];
    for (const { train_no: trainNo, station_train_codes, data: list } of this
      .trainDetailList) {
      const parts = list.map(
        (stop) =>
          `${stop.station_name}(${stop.arrive_time} - ${stop.start_time} - ${stop.running_time} - ${stop.arrive_day_str})`,
      );
      rows.push({
        train_no: trainNo,
        station_train_code: station_train_codes,
        stationsCell: parts.join(" / "),
        total_num: list.length,
      });
    }

    rows.sort((a, b) => {
      const rankA = getTrainTypeRank(a.station_train_code);
      const rankB = getTrainTypeRank(b.station_train_code);
      if (rankA !== rankB) return rankA - rankB;
      return a.station_train_code.localeCompare(b.station_train_code);
    });

    const header =
      "| 序号 | 车号(train_no) | 站点车次(station_train_code) | 站点(到站时间 - 发车时间 - 运行时间 - 到达日) | 站点数量(total_num) |";
    const sep = "| --- | --- | --- | --- | --- |";
    const body = rows
      .map(
        (r, i) =>
          `| ${i + 1} | ${r.train_no} | ${r.station_train_code} | ${r.stationsCell} | ${r.total_num} |`,
      )
      .join("\n");
    const md = ["# 车次详情表", "", header, sep, body, ""].join("\n");

    const distDir = path.join(process.cwd(), "dist");
    if (!fs.existsSync(distDir)) fs.mkdirSync(distDir, { recursive: true });
    const date = this.getTargetDate();

    // 总的车次详情：json + md
    fs.writeFileSync(
      path.join(distDir, `train_detail_${date}.md`),
      md,
      "utf-8",
    );
    fs.writeFileSync(
      path.join(distDir, `train_detail_${date}.json`),
      JSON.stringify(this.trainDetailList, null, 2),
      "utf-8",
    );

    // 按车次等级分组
    const detailByClass = new Map<
      string,
      {
        train_no: string;
        station_train_codes: string;
        data: ITrainStationResponseViaTrainNoAndDateList;
      }[]
    >();
    const rowsByClass = new Map<string, MergedDetailRow[]>();
    for (const item of this.trainDetailList) {
      const cls = this.getTrainClass(item.station_train_codes);
      const arr = detailByClass.get(cls) ?? [];
      arr.push(item);
      detailByClass.set(cls, arr);
    }
    for (const r of rows) {
      const cls = this.getTrainClass(r.station_train_code);
      const arr = rowsByClass.get(cls) ?? [];
      arr.push(r);
      rowsByClass.set(cls, arr);
    }

    // 各等级内按站点车次排序
    const sortedClassNames = [...detailByClass.keys()].sort((a, b) => {
      const rankA = getTrainTypeRank(a);
      const rankB = getTrainTypeRank(b);
      if (rankA !== rankB) return rankA - rankB;
      return a.localeCompare(b);
    });

    for (const trainClass of sortedClassNames) {
      const detailList = detailByClass.get(trainClass) ?? [];
      const classRows = rowsByClass.get(trainClass) ?? [];
      classRows.sort((a, b) =>
        a.station_train_code.localeCompare(b.station_train_code),
      );

      const classBody = classRows
        .map(
          (r, i) =>
            `| ${i + 1} | ${r.train_no} | ${r.station_train_code} | ${r.stationsCell} | ${r.total_num} |`,
        )
        .join("\n");
      const classMd = [
        `# 车次详情表（${trainClass}）`,
        "",
        header,
        sep,
        classBody,
        "",
      ].join("\n");

      const baseName = `train_detail_${trainClass}_${date}`;
      fs.writeFileSync(path.join(distDir, `${baseName}.md`), classMd, "utf-8");
      fs.writeFileSync(
        path.join(distDir, `${baseName}.json`),
        JSON.stringify(detailList, null, 2),
        "utf-8",
      );
    }
  };
}

new Spider().run();
