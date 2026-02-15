import { request } from "../../utils";

import { IStationInfo } from "./model";

/**
 * 获取车站名称
 */
export const getStationNames = async (): Promise<IStationInfo[]> => {
  const htmlContentRsp = await request<string>("https://www.12306.cn/index/", {
    method: "GET",
  });

  const htmlContentData = htmlContentRsp.data;

  // 提取最新的 js 地址连接
  // <script src="./script/core/common/station_name_new_v10107.js"></script>
  const jsFiles =
    htmlContentData?.matchAll(/<script src="([^"]+)"/) ??
    ([] as RegExpMatchArray[]);

  // 提取最新的 station_name 文件
  const lastestStationNameJsFile = [...jsFiles].find((file) =>
    file[0].match(/station_name.*\.js$/),
  );

  const jsFileContentRsp = await request<string>(
    `https://www.12306.cn/index/${lastestStationNameJsFile?.[0].replace("./", "")}`,
    {
      method: "GET",
    },
  );

  // 处理编码内容
  const jsFileContentData = jsFileContentRsp.data;

  const dataContent = jsFileContentData?.match(/=\s*([^'"]+)/)?.[1];

  // 解析数据
  const datas = dataContent?.split("|||")?.map((d) => {
    const [
      at_pinyin,
      name,
      tele_code,
      pinyin,
      pinyin_short,
      idx,
      area_code,
      city,
    ] = d.split("|");
    return {
      at_pinyin,
      name,
      tele_code,
      pinyin,
      pinyin_short,
      idx: parseInt(idx),
      area_code: parseInt(area_code),
      city,
    } satisfies IStationInfo;
  });

  return datas ?? [];
};
