"use strict";

const fs = require("fs");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..");
const packageJsonPath = path.join(projectRoot, "package.json");
const appVersionPath = path.join(projectRoot, "shared", "app-version.cjs");
const checkOnly = process.argv.includes("--check");

function readPackageVersion() {
  const packageInfo = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  const version = typeof packageInfo.version === "string" ? packageInfo.version.trim() : "";
  if (!version) {
    throw new Error("package.json version must be a non-empty string");
  }
  return version;
}

function appVersionSource(version) {
  const quotedVersion = JSON.stringify(version);
  // 这个文件是运行时静态版本源，launcher 和认证页都从这里读取，避免运行时解析 package.json。
  return `"use strict";

// 此文件由 pnpm run sync:version 生成；请修改 package.json version 后重新同步。
const OPENCODEX_VERSION = ${quotedVersion};
const OPENCODEX_VERSION_LABEL = \`v\${OPENCODEX_VERSION}\`;

module.exports = {
  OPENCODEX_VERSION,
  OPENCODEX_VERSION_LABEL,
};
`;
}

function main() {
  const version = readPackageVersion();
  const nextSource = appVersionSource(version);
  const currentSource = fs.existsSync(appVersionPath) ? fs.readFileSync(appVersionPath, "utf8") : "";

  if (currentSource === nextSource) {
    console.log(`shared/app-version.cjs is already synced to ${version}`);
    return;
  }

  if (checkOnly) {
    throw new Error(`shared/app-version.cjs is not synced to package.json version ${version}`);
  }

  // 只有内容变化时才写文件，避免无意义刷新时间戳。
  fs.writeFileSync(appVersionPath, nextSource, "utf8");
  console.log(`Synced shared/app-version.cjs to ${version}`);
}

main();
