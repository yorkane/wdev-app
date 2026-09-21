// 稳定入口只负责转发到 runtime，避免 launcher / 打包脚本感知内部目录调整。
require("./runtime/main.cjs");
