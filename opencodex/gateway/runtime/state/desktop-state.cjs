const fs = require("fs");
const path = require("path");
const { CODEX_HOME } = require("../core/config.cjs");

// 官方 Desktop 把 Electron UI 状态放在 CODEX_HOME 下；OpenCodex 只读取它来生成首屏快照。
const DESKTOP_GLOBAL_STATE_PATH = path.join(CODEX_HOME, ".codex-global-state.json");
const DESKTOP_GLOBAL_STATE_BACKUP_PATH = `${DESKTOP_GLOBAL_STATE_PATH}.bak`;
const DESKTOP_PERSISTED_ATOMS_KEY = "electron-persisted-atom-state";
const COMPOSER_PERMISSION_MODE_VISIBILITY_KEY = "composer-permission-mode-visibility";
const DEFAULT_COMPOSER_PERMISSION_MODE_VISIBILITY = {
  "guardian-approvals": true,
  "full-access": true,
};

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readJsonObject(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function loadDesktopGlobalState() {
  // 官方会同时维护主文件和 .bak；主文件损坏时按官方思路读取备份，避免首屏状态直接丢失。
  return readJsonObject(DESKTOP_GLOBAL_STATE_PATH) || readJsonObject(DESKTOP_GLOBAL_STATE_BACKUP_PATH) || {};
}

function normalizePromptHistoryForRenderer(value) {
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string");
  if (!isPlainObject(value)) return [];
  if (Array.isArray(value.global)) return value.global.filter((item) => typeof item === "string");
  if (Array.isArray(value["new-conversation"])) {
    return value["new-conversation"].filter((item) => typeof item === "string");
  }
  return [];
}

function normalizePersistedAtomForRenderer(key, value) {
  // 这两个兼容转换沿用旧 gateway 逻辑，保证官方 renderer 拿到的是自己期望的形态。
  if (key === "prompt-history") return normalizePromptHistoryForRenderer(value);
  if (key === COMPOSER_PERMISSION_MODE_VISIBILITY_KEY) {
    return {
      ...DEFAULT_COMPOSER_PERMISSION_MODE_VISIBILITY,
      ...(isPlainObject(value) ? value : {}),
    };
  }
  return value;
}

function desktopPersistedAtoms() {
  const atoms = loadDesktopGlobalState()[DESKTOP_PERSISTED_ATOMS_KEY];
  return isPlainObject(atoms) ? atoms : {};
}

function persistedAtomSnapshotForRenderer() {
  return Object.fromEntries(
    Object.entries(desktopPersistedAtoms()).map(([key, value]) => [key, normalizePersistedAtomForRenderer(key, value)])
  );
}

module.exports = {
  DESKTOP_GLOBAL_STATE_PATH,
  DESKTOP_PERSISTED_ATOMS_KEY,
  persistedAtomSnapshotForRenderer,
};
