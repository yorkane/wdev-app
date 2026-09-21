const fs = require("fs");
const path = require("path");
const asar = require("@electron/asar");
const { gatewayRunnerMainSource } = require("./runner-source.cjs");

async function writeGatewayAsar({ runnerResourcesDir, workDir }) {
  const sourceDir = path.join(workDir, "app-src");
  const appDir = path.join(runnerResourcesDir, "app");
  const asarPath = path.join(runnerResourcesDir, "app.asar");
  /**
   * 各平台统一使用 resources/app.asar 作为 OpenCodex runner 入口。
   * Windows 官方 runtime 开启了 ASAR integrity，目录 app 无法作为入口；这里清掉历史目录形态，避免加载歧义。
   */
  fs.rmSync(appDir, { recursive: true, force: true });
  fs.rmSync(sourceDir, { recursive: true, force: true });
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(
    path.join(sourceDir, "package.json"),
    `${JSON.stringify({ name: "opencodex-gateway-runner", main: "main.cjs" }, null, 2)}\n`,
    "utf8"
  );
  fs.writeFileSync(path.join(sourceDir, "main.cjs"), gatewayRunnerMainSource(), "utf8");
  await asar.createPackage(sourceDir, asarPath);
  return asarPath;
}

module.exports = {
  writeGatewayAsar,
};
