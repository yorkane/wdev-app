function logLine(logger, message) {
  if (typeof logger === "function") logger(`[launcher] ${message}\n`);
}

function logJsonLine(logger, message, value) {
  if (typeof logger !== "function") return;
  let json = "";
  try {
    json = JSON.stringify(value);
  } catch {
    json = String(value || "");
  }
  logLine(logger, `${message} ${json}`);
}

module.exports = {
  logLine,
  logJsonLine,
};
