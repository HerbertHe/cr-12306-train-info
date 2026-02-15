/**
 * 车站信息
 */
export interface IStationInfo {
  /**
   * @+拼音
   */
  at_pinyin: string;
  /**
   * 名称
   */
  name: string;
  /**
   * 车站代码
   */
  tele_code: string;
  /**
   * 拼音
   */
  pinyin: string;
  /**
   * 拼音缩写
   */
  pinyin_short: string;
  /**
   * 车站索引（计数用的）
   */
  idx: number;
  /**
   * 区号
   */
  area_code: number;
  /**
   * 所属地级市名称
   */
  city: string;
}
