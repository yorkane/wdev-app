const electron = require("electron");
const { diagnosticLog, diagnosticWarn } = require("../core/diagnostics.cjs");

let installed = false;
let silentQuitReason = "";

function markGatewaySilentQuit(reason) {
  silentQuitReason = String(reason || "gateway_quit");
}

function messageBoxOptionsFromArgs(args) {
  const values = Array.from(args || []);
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  }
  return null;
}

function normalizeLabel(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function isQuitButton(label) {
  const value = normalizeLabel(label);
  return value === "quit" || value === "quit codex" || value === "退出" || value === "退出 codex";
}

function isCancelButton(label) {
  const value = normalizeLabel(label);
  return value === "cancel" || value === "取消";
}

function quitButtonIndex(options) {
  const buttons = Array.isArray(options && options.buttons) ? options.buttons : [];
  return buttons.findIndex(isQuitButton);
}

function hasCancelButton(options) {
  const buttons = Array.isArray(options && options.buttons) ? options.buttons : [];
  return buttons.some(isCancelButton);
}

function looksLikeQuitTitle(value) {
  const text = normalizeLabel(value);
  return /^quit(?:\s+.+)?\?$/.test(text) || /^退出(?:\s*.+)?[?？]?$/.test(text);
}

function isOfficialQuitConfirmation(options) {
  if (!options || typeof options !== "object") return false;
  if (quitButtonIndex(options) < 0 || !hasCancelButton(options)) return false;

  /**
   * 官方退出确认目前是 showMessageBoxSync({ buttons: ["Quit", "Cancel"], title/message: "Quit Codex?" })。
   * 这里要求标题或消息长得像退出确认，避免误伤错误弹窗、更新弹窗或 Rosetta 兼容提示。
   */
  return looksLikeQuitTitle(options.title) || looksLikeQuitTitle(options.message);
}

function autoQuitResponse(options) {
  const index = quitButtonIndex(options);
  return index >= 0 ? index : 0;
}

function logSuppressedQuitDialog(options, apiName, response) {
  diagnosticWarn("gateway-quit", "official_quit_confirmation_suppressed", {
    apiName,
    response,
    reason: silentQuitReason || "matched_official_quit_dialog",
    title: String((options && options.title) || ""),
    message: String((options && options.message) || ""),
  });
}

function installGatewayQuitConfirmationSuppressor() {
  if (installed) return { installed: true };
  installed = true;

  const dialog = electron.dialog;
  if (!dialog) {
    diagnosticLog("gateway-quit", "dialog_unavailable");
    return { installed: false };
  }

  if (typeof dialog.showMessageBoxSync === "function" && !dialog.showMessageBoxSync.__opencodexQuitSuppressorPatched) {
    const originalShowMessageBoxSync = dialog.showMessageBoxSync.bind(dialog);
    const patchedShowMessageBoxSync = (...args) => {
      const options = messageBoxOptionsFromArgs(args);
      if (isOfficialQuitConfirmation(options)) {
        const response = autoQuitResponse(options);
        logSuppressedQuitDialog(options, "showMessageBoxSync", response);
        return response;
      }
      return originalShowMessageBoxSync(...args);
    };
    patchedShowMessageBoxSync.__opencodexQuitSuppressorPatched = true;
    dialog.showMessageBoxSync = patchedShowMessageBoxSync;
  }

  if (typeof dialog.showMessageBox === "function" && !dialog.showMessageBox.__opencodexQuitSuppressorPatched) {
    const originalShowMessageBox = dialog.showMessageBox.bind(dialog);
    const patchedShowMessageBox = async (...args) => {
      const options = messageBoxOptionsFromArgs(args);
      if (isOfficialQuitConfirmation(options)) {
        const response = autoQuitResponse(options);
        logSuppressedQuitDialog(options, "showMessageBox", response);
        return { response, checkboxChecked: false };
      }
      return originalShowMessageBox(...args);
    };
    patchedShowMessageBox.__opencodexQuitSuppressorPatched = true;
    dialog.showMessageBox = patchedShowMessageBox;
  }

  diagnosticLog("gateway-quit", "quit_confirmation_suppressor_installed");
  return { installed: true };
}

module.exports = {
  installGatewayQuitConfirmationSuppressor,
  markGatewaySilentQuit,
};
