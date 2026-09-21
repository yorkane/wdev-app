const fs = require("fs");
const path = require("path");

function withPhysicalAsarAccess(read) {
  /**
   * Electron 会把任意 *.asar 路径挂成虚拟目录。runner 准备阶段要读写物理 app.asar，
   * 所以文件探测必须临时关闭 asar 虚拟化；普通 Node 环境下这个开关也兼容。
   */
  const previousNoAsar = process.noAsar;
  process.noAsar = true;
  try {
    return read();
  } finally {
    process.noAsar = previousNoAsar;
  }
}

function realpathSafe(filePath) {
  try {
    return withPhysicalAsarAccess(() =>
      fs.realpathSync.native ? fs.realpathSync.native(filePath) : fs.realpathSync(filePath)
    );
  } catch {
    return path.resolve(filePath);
  }
}

function statSummary(filePath) {
  try {
    const stat = withPhysicalAsarAccess(() => fs.statSync(filePath));
    return {
      exists: true,
      isFile: stat.isFile(),
      isDirectory: stat.isDirectory(),
      isSymbolicLink: stat.isSymbolicLink(),
      size: stat.size,
      mode: `0${(stat.mode & 0o777).toString(8)}`,
      realpath: realpathSafe(filePath),
    };
  } catch (error) {
    return {
      exists: false,
      isFile: false,
      isDirectory: false,
      isSymbolicLink: false,
      errorCode: error && error.code ? String(error.code) : "",
      errorMessage: error instanceof Error ? error.message : String(error || ""),
      realpath: realpathSafe(filePath),
    };
  }
}

function isFile(filePath) {
  try {
    return withPhysicalAsarAccess(() => fs.statSync(filePath).isFile());
  } catch {
    return false;
  }
}

function isDirectory(filePath) {
  try {
    return withPhysicalAsarAccess(() => fs.statSync(filePath).isDirectory());
  } catch {
    return false;
  }
}

function uniqueNonEmpty(values) {
  return Array.from(new Set(values.filter((value) => typeof value === "string" && value.trim()).map(String)));
}

function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function fileFingerprint(filePath) {
  try {
    const stat = withPhysicalAsarAccess(() => fs.statSync(filePath));
    return {
      path: realpathSafe(filePath),
      size: stat.size,
      mtimeMs: Math.trunc(stat.mtimeMs),
    };
  } catch {
    return null;
  }
}

module.exports = {
  withPhysicalAsarAccess,
  realpathSafe,
  statSummary,
  isFile,
  isDirectory,
  uniqueNonEmpty,
  readJsonIfPresent,
  writeJson,
  fileFingerprint,
};
