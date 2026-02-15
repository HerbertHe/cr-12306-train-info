/**
 * 车次信息
 */
export interface ITrain {
  /**
   * 日期
   */
  date: string;
  /**
   * 始发站
   */
  from_station: string;
  /**
   * 车次代码
   */
  station_train_code: string;
  /**
   * 终点站
   */
  to_station: string;
  /**
   * 总站点数量
   */
  total_num: string;
  /**
   * 车次编号
   */
  train_no: string;
}

/**
 * 车次信息 - 站点信息
 */
export interface ITrainStationResponseViaTrainNoAndDate {
  /**
   * 当日到达字符串（当日到达，次日到达）
   */
  arrive_day_str: string;
  /**
   * 到达时间 hh:mm
   */
  arrive_time: string;
  /**
   * 车次代码
   */
  station_train_code: string;
  /**
   * 车站名称
   */
  station_name: string;
  /**
   * 到达日期差（0，1）
   * 表示是不是当天到达
   */
  arrive_day_diff: string;
  /**
   * （没啥用，默认值为[]）
   */
  OT: [];
  /**
   * 出发时间 hh:mm
   */
  start_time: string;
  /**
   * （没啥用，默认值为--）
   */
  wz_num: string;
  /**
   * 车站序列号
   */
  station_no: string;
  /**
   * 运行时间
   * 相对始发偏移时间 hh:mm
   */
  running_time: string;
}

/**
 * 车次信息 - 始发站
 */
export interface ITrainStationResponseFirstViaTrainNoAndDate extends Omit<
  ITrainStationResponseViaTrainNoAndDate,
  "OT"
> {
  /**
   * 始发站名称
   */
  start_station_name: string;

  /**
   * 终点站名称
   */
  end_station_name: string;

  /**
   * 是否是始发站 Y
   */
  is_start: string;

  /**
   * 服务类型
   */
  service_type: string;

  /**
   * 车辆等级名称
   */
  train_class_name: string;
}

/**
 * 车次信息 - 站点信息列表
 */
export type ITrainStationResponseViaTrainNoAndDateList = [
  ITrainStationResponseFirstViaTrainNoAndDate,
  ...ITrainStationResponseViaTrainNoAndDate[],
];
