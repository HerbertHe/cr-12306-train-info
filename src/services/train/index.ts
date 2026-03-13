import { ITrain, ITrainStationResponseViaTrainNoAndDateList } from "./model";

import { request } from "../../utils";

/**
 * 查询车次列表
 * @param keyword 车次关键字
 * @param date 日期 20260316
 * @returns
 */
export const queryTrainListByKeywordAndDate = async (
  keyword: string,
  date: string,
) => {
  return request<ITrain[]>(
    `https://search.12306.cn/search/v1/train/search?keyword=${keyword}&date=${date}`,
    {
      method: "GET",
    },
  );
};

/**
 * 查询车次详情
 * @param trainNo 车次编号
 * @param date 日期 2026-02-15
 * @returns
 */
export const queryTrainDetailByTrainNoAndDate = (
  trainNo: string,
  date: string,
) => {
  return request<{
    data: ITrainStationResponseViaTrainNoAndDateList;
  }>(
    `https://kyfw.12306.cn/otn/queryTrainInfo/query?leftTicketDTO.train_no=${trainNo}&leftTicketDTO.train_date=${date}&rand_code=`,
    {
      method: "GET",
    },
  );
};
