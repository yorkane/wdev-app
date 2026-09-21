"use strict";

const DEFAULT_RELEASE_API_URL = "https://api.github.com/repos/RyensX/OpenCodex/releases/latest";

function createInitialLatestReleaseState() {
  return {
    checking: false,
    tagName: "",
    htmlUrl: "",
    available: false,
    lastCheckedAt: null,
    error: "",
  };
}

function markLatestReleaseChecking(previousState) {
  return {
    ...createInitialLatestReleaseState(),
    ...(previousState || {}),
    checking: true,
    error: "",
  };
}

function normalizeReleaseVersion(value) {
  // GitHub tag 常见格式是 v2.0.1；本地版本同样归一化后再做差异判断。
  return String(value || "")
    .trim()
    .replace(/^v/i, "");
}

function releaseVersionChanged(tagName, currentVersionLabel) {
  const remoteVersion = normalizeReleaseVersion(tagName);
  const currentVersion = normalizeReleaseVersion(currentVersionLabel);
  return !!remoteVersion && remoteVersion !== currentVersion;
}

function trustedReleaseUrl(value) {
  try {
    const url = new URL(String(value || ""));
    // 更新入口只允许 GitHub 上当前仓库的 release 页面，避免异常接口响应扩大外链范围。
    if (url.protocol !== "https:" || url.hostname !== "github.com") return "";
    if (!url.pathname.startsWith("/RyensX/OpenCodex/releases/")) return "";
    return url.toString();
  } catch {
    return "";
  }
}

function latestReleaseStateFromPayload(payload, currentVersionLabel) {
  const tagName = typeof payload.tag_name === "string" ? payload.tag_name.trim() : "";
  const htmlUrl = trustedReleaseUrl(payload.html_url);
  const available = releaseVersionChanged(tagName, currentVersionLabel) && !!htmlUrl;

  return {
    checking: false,
    tagName,
    // 只有确认有差异版本时才保存可打开链接，按钮隐藏时不会留下可点击目标。
    htmlUrl: available ? htmlUrl : "",
    available,
    lastCheckedAt: new Date().toISOString(),
    error: "",
  };
}

function latestReleaseErrorState(previousState, error) {
  return {
    ...createInitialLatestReleaseState(),
    ...(previousState || {}),
    checking: false,
    available: false,
    htmlUrl: "",
    lastCheckedAt: new Date().toISOString(),
    error: error instanceof Error ? error.message : String(error),
  };
}

async function fetchLatestReleaseState(options) {
  const currentVersionLabel = options && options.currentVersionLabel;
  const releaseApiUrl = (options && options.releaseApiUrl) || DEFAULT_RELEASE_API_URL;
  const fetchImpl = (options && options.fetchImpl) || globalThis.fetch;
  const previousState = options && options.previousState;

  try {
    if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");
    const response = await fetchImpl(releaseApiUrl, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": `OpenCodex Launcher ${currentVersionLabel || ""}`.trim(),
      },
    });
    if (!response.ok) throw new Error(`latest release failed: HTTP ${response.status}`);
    return latestReleaseStateFromPayload(await response.json(), currentVersionLabel);
  } catch (error) {
    return latestReleaseErrorState(previousState, error);
  }
}

module.exports = {
  createInitialLatestReleaseState,
  fetchLatestReleaseState,
  markLatestReleaseChecking,
};
