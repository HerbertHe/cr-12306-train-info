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
  sealPermanentlyFailed,
  getSuccessCount,
  getPermanentlyFailedUrls,
  request,
} from "./utils";
import { PAGE_SIZE, TRAIN_CLASS_LIST } from "./constants";

class Spider {
  /**
   * 任务调度器
   * 自适应并发，最大 6 个任务，最小 2 个任务，降低并发以避免被12306限流
   */
  private taskScheduler = new TaskScheduler(6, 2);

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

  private trainDetailTotal = 0;
  private trainDetailSuccessCount = 0;
  private trainDetailFailedTrainNos: string[] = [];

  /**
   * 本次运行使用的目标日期（YYYYMMDD），在 run 开始时确定，全程一致，避免跨天后报告日期与请求日期不一致
   */
  private targetDate = "";

  /** 失败请求最大重试轮数 */
  private static readonly MAX_RETRY_ROUNDS = 5;

  /**
   * 运行爬虫（主请求 + 失败请求按偏移分散重试，最多重试 MAX_RETRY_ROUNDS 轮）
    * 目标日期在入口处固定，避免请求过程中跨自然日后日期不一致（列表请求、输出文件名、报告均用此日期；详情请求以接口返回的 train.date 为准）。
    */
  run = async () => {
    try {
      this.targetDate = this.getTargetDate();
      await ensureProxyPool();
      await this.fetchTrainList();
      for (
        let round = 0;
        round < Spider.MAX_RETRY_ROUNDS && getFailedQueueLength() > 0;
        round++
      ) {
        console.log(
          `[重试轮次 ${round + 1}/${Spider.MAX_RETRY_ROUNDS}] 重试 ${getFailedQueueLength()} 个失败请求`,
        );
        await retryFailedRequests();
      }
      sealPermanentlyFailed();
    } finally {
      // 无论如何都保证生成dist目录和基础报告，即使前面出现异常
      console.log("开始生成输出文件...");
      await this.processTrainListData();
      if (this.trainListFilteredByTrainNo.size > 0) {
        await this.fetchTrainDetails();
        await this.processTrainDetailData();
      } else {
        console.log("没有获取到任何车次列表数据，跳过获取车次详情步骤");
        this.trainDetailTotal = 0;
        this.trainDetailSuccessCount = 0;
        this.trainDetailFailedTrainNos = [];
      }
      this.generateReadme();
      console.log("输出文件生成完成");
    }
  };

  /**
   * 使用任务调度器重试失败请求，保持和初始请求相同的并发策略
   */
  private retryFailedRequestsWithScheduler = async () => {
    // retryFailedRequests 会取出所有当前失败请求，使用调度器控制并发
    await retryFailedRequests(this.taskScheduler);
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
   * Fisher-Yates 洗牌算法
   */
  private shuffleArray = <T>(array: T[]): T[] => {
    const result = [...array];
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  };

  /**
   * 获取所有车次列表
   * 遍历所有车次等级，每个车次等级遍历打乱后的 1 - 9 编号
   * 日期默认使用当前日期 + 13 天
   */
  private fetchTrainList = async () => {
    const startTime = process.hrtime();
    const promises: Promise<void>[] = [];

    // 生成 1-9 数组并打乱顺序
    const numbers = this.shuffleArray(Array.from({ length: 9 }, (_, i) => i + 1));

    for (const trainClass of TRAIN_CLASS_LIST) {
      for (const i of numbers) {
        promises.push(this.processTrainList(`${trainClass}${i}`, this.targetDate));
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
  private processTrainList = async (prefix: string, date: string): Promise<void> => {
    console.log(`处理车次列表, ${prefix}`);
    const rsp = await queryTrainListByKeywordAndDate(prefix, date);

    // 请求失败直接返回，会在重试队列处理
    if (!rsp.success) {
      return;
    }

    const trainList = rsp.data ?? [];

    console.log(`${prefix} 车次列表获取完成, 数据: ${trainList.length}`);

    // 空响应直接确认真实空，不重试
    if (trainList.length === 0) {
      console.log(`${prefix} 返回空，确认无数据，不加入重试队列`);
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

    // 递归拆分任务，打乱顺序
    const subTasks: Promise<void>[] = [];
    const digits = this.shuffleArray(Array.from({ length: 10 }, (_, i) => i));
    for (const j of digits) {
      console.log(`递归拆分任务, ${prefix}${j}`);
      subTasks.push(this.processTrainList(`${prefix}${j}`, date));
    }
    await Promise.all(subTasks);
  };

  /**
   * 提取永久失败URL中的前缀信息，重新进行处理
   */
  private retryPermanentlyFailedTrainList = async () => {
    const failedUrls = getPermanentlyFailedUrls();
    const trainListPrefixes: string[] = [];

    // 从失败URL中提取 keyword 参数（仅提取 train_list 的搜索请求）
    for (const url of failedUrls) {
      const match = url.match(/keyword=([^&]+)&date=/);
      if (match && match[1]) {
        trainListPrefixes.push(match[1]);
      }
    }

    // 去重，避免重复重试同一个前缀
    const uniquePrefixes = [...new Set(trainListPrefixes)];

    if (uniquePrefixes.length === 0) {
      console.log("[重试] 没有需要重试的 train_list 请求");
      return;
    }

    console.log(`[重试] 发现 ${uniquePrefixes.length} 个唯一失败的 train_list 请求，开始重试`);

    // 使用任务调度器控制并发，保持和最初获取一致的并发数
    const promises = uniquePrefixes.map(prefix => 
      this.taskScheduler.add(async () => {
        return await this.processTrainList(prefix, this.targetDate);
      })
    );

    await Promise.all(promises);
    console.log(`[重试] 完成对 ${uniquePrefixes.length} 个失败 train_list 请求的重试`);
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
    const getTrainTypeRank = (code: string) => {
      const type = code.charAt(0).toUpperCase();
      const idx = TRAIN_CLASS_LIST.indexOf(type);
      return idx >= 0 ? idx : TRAIN_CLASS_LIST.length;
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
    const mdPath = path.join(distDir, `train_list_${this.targetDate}.md`);
    fs.writeFileSync(mdPath, md, "utf-8");
    const jsonPath = path.join(distDir, `train_list_${this.targetDate}.json`);
    fs.writeFileSync(
      jsonPath,
      JSON.stringify(Array.from(this.trainList), null, 2),
      "utf-8",
    );
  };

  /**
   * 根据 trainListFilteredByTrainNo 获取车次详情并写入 trainDetailList（车站名已去空格）
   * 通过调度器并发请求（最多 8 个同时进行），相比串行显著缩短耗时。
   */
  private fetchTrainDetails = async () => {
    const list = Array.from(this.trainListFilteredByTrainNo);
    this.trainDetailList = [];
    this.trainDetailTotal = list.length;
    this.trainDetailSuccessCount = 0;
    this.trainDetailFailedTrainNos = [];
    const startTime = process.hrtime();

    const results = await Promise.all(
      list.map((train) => {
        const dateStr = this.formatDateForDetail(train.date);
        return this.taskScheduler
          .add(() =>
            queryTrainDetailByTrainNoAndDate(train.train_no, dateStr),
          )
          .then((rsp) => ({ train, rsp }));
      }),
    );

    for (const { train, rsp } of results) {
      const rawList =
        rsp.success && Array.isArray(rsp.data?.data)
          ? (rsp.data
              .data as unknown as ITrainStationResponseViaTrainNoAndDateList)
          : null;
      if (!rawList?.length) {
        this.trainDetailFailedTrainNos.push(train.train_no);
        continue;
      }
      this.trainDetailSuccessCount++;
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
      `获取车次详情完成, 共 ${this.trainDetailSuccessCount}/${this.trainDetailTotal} 条, 失败 ${this.trainDetailFailedTrainNos.length} 条, 耗时: ${endTime[0]}s ${endTime[1] / 1000000}ms`,
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
    const getTrainTypeRank = (code: string) => {
      const type = code.charAt(0).toUpperCase();
      const idx = TRAIN_CLASS_LIST.indexOf(type);
      return idx >= 0 ? idx : TRAIN_CLASS_LIST.length;
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

    // 总的车次详情：json + md
    fs.writeFileSync(
      path.join(distDir, `train_detail_${this.targetDate}.md`),
      md,
      "utf-8",
    );
    fs.writeFileSync(
      path.join(distDir, `train_detail_${this.targetDate}.json`),
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

      const baseName = `train_detail_${trainClass}_${this.targetDate}`;
      fs.writeFileSync(path.join(distDir, `${baseName}.md`), classMd, "utf-8");
      fs.writeFileSync(
        path.join(distDir, `${baseName}.json`),
        JSON.stringify(detailList, null, 2),
        "utf-8",
      );
    }
  };
  /**
   * 生成 Jekyll 兼容的 README.md 和 summary.json 到 dist/
   * 报告中的日期以本次运行的目标日期 targetDate 为准（与列表请求、输出文件名一致）。
   */
  private generateReadme = () => {
    const formattedDate = `${this.targetDate.slice(0, 4)}-${this.targetDate.slice(4, 6)}-${this.targetDate.slice(6, 8)}`;
    const successCount = getSuccessCount();
    const failedUrls = getPermanentlyFailedUrls();
    const uniqueFailedUrls = [...new Set(failedUrls)];
    const totalRequests = successCount + failedUrls.length;

    const lines: string[] = [
      "---",
      `title: 车次数据采集报告`,
      `date: ${formattedDate}`,
      "layout: default",
      "---",
      "",
      `# 车次数据采集报告（${formattedDate}）`,
      "",
      "## 请求统计（不含代理验证）",
      "",
      "| 指标 | 数值 |",
      "| --- | --- |",
      `| 总请求数 | ${totalRequests} |`,
      `| 成功请求数 | ${successCount} |`,
      `| 最终失败数 | ${failedUrls.length} |`,
      `| 成功率 | ${totalRequests > 0 ? ((successCount / totalRequests) * 100).toFixed(2) : "0.00"}% |`,
      "",
      "## 车次详情获取统计",
      "",
      "| 指标 | 数值 |",
      "| --- | --- |",
      `| 待获取车次数 | ${this.trainDetailTotal} |`,
      `| 成功获取数 | ${this.trainDetailSuccessCount} |`,
      `| 失败数 | ${this.trainDetailFailedTrainNos.length} |`,
      `| 成功率 | ${this.trainDetailTotal > 0 ? ((this.trainDetailSuccessCount / this.trainDetailTotal) * 100).toFixed(2) : "0.00"}% |`,
      "",
    ];

    if (uniqueFailedUrls.length > 0) {
      lines.push(
        "## 最终失败的请求",
        "",
        "以下请求在所有重试轮次后仍未成功：",
        "",
        "| 序号 | 请求地址 |",
        "| --- | --- |",
      );
      for (let i = 0; i < uniqueFailedUrls.length; i++) {
        lines.push(`| ${i + 1} | ${uniqueFailedUrls[i]} |`);
      }
      lines.push("");
    } else {
      lines.push("## 最终失败的请求", "", "无失败请求，所有请求均已成功。", "");
    }

    const distDir = path.join(process.cwd(), "dist");
    if (!fs.existsSync(distDir)) fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(path.join(distDir, "README.md"), lines.join("\n"), "utf-8");

    const summary = {
      date: formattedDate,
      request: { total: totalRequests, success: successCount, failed: failedUrls.length },
      trainDetail: {
        total: this.trainDetailTotal,
        success: this.trainDetailSuccessCount,
        failed: this.trainDetailFailedTrainNos.length,
      },
    };
    fs.writeFileSync(
      path.join(distDir, "summary.json"),
      JSON.stringify(summary, null, 2),
      "utf-8",
    );
    console.log(
      `[README] 已生成 dist/README.md 和 dist/summary.json`,
    );
  };
}

new Spider().run();
