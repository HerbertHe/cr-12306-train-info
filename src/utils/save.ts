import fs from "fs";
import path from "path";

const saveDirPath = path.join(process.cwd(), "dist", "data");

/**
 * 保存数据
 * @param data 数据
 * @param fileName 文件名
 */
export const saveData = <T>(data: T, fileName: string) => {
  if (!fs.existsSync(saveDirPath)) {
    fs.mkdirSync(saveDirPath, { recursive: true });
  }
  
  const filePath = path.join(saveDirPath, fileName);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
};
