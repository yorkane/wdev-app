"use strict";

// Drift report CLI.
//
//   node cli.js --check <extracted-app-asar-dir> [--json] [--signatures path]
//   node cli.js --dry-run <extracted-app-asar-dir> [--json]
//   node cli.js --reverse --dry-run <extracted-app-asar-dir> [--json]
//
// --check never writes. It answers one question per rule: is the structure this
// rule targets still where we expect it, and is the rule still able to do its
// job? The answer is BOUND, DRIFTED or REMOVED, and a DRIFTED rule prints the
// current source of the area with a caret at the failed anchor. That is the
// whole point: after 94 releases of drift the operator reads a few hundred bytes
// and decides, instead of grepping a bundle with 19k files.
//
// Exit codes:
//   0  every rule bound in every carrier
//   1  at least one rule drifted or was removed (also the apply-mode failure)
//   2  usage or environment error (bad directory, unreadable signature library)

const fs = require("node:fs");
const path = require("node:path");

const { BOUND, DRIFTED, REMOVED, formatReport, loadLibrary, patchTree, reverseTree } = require("./patch.js");

function usageLines() {
  return [
    "Usage:",
    "  node cli.js --check            <extracted-app-asar-dir> [--json] [--signatures <file>]",
    "  node cli.js --dry-run          <extracted-app-asar-dir> [--json] [--signatures <file>]",
    "  node cli.js --reverse --dry-run <extracted-app-asar-dir> [--json] [--signatures <file>]",
    "",
    "Modes:",
    "  --check    report BOUND / DRIFTED / REMOVED per rule, never write",
    "  --dry-run  same as --check, plus the edit counts that apply would perform",
    "  --reverse  plan the revert to upstream bytes (combine with --dry-run to avoid writing)",
    "",
    "Exit codes: 0 all rules bound, 1 drift or failure, 2 usage/environment error",
  ].join("\n");
}

function parseArgs(argv) {
  const options = { mode: null, reverse: false, dir: null, json: false, signaturesPath: null };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") options.mode = "check";
    else if (arg === "--dry-run") options.mode = options.mode === "reverse" ? "reverse-dry-run" : "dry-run";
    else if (arg === "--reverse") options.reverse = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--signatures") {
      options.signaturesPath = argv[index + 1];
      if (!options.signaturesPath) throw new Error("--signatures needs a path");
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg.startsWith("-")) {
      throw new Error("unknown option " + arg);
    } else {
      positional.push(arg);
    }
  }
  if (options.reverse) {
    options.mode = options.mode === "apply" || options.mode == null ? "reverse" : "reverse-dry-run";
  }
  if (options.mode == null) options.mode = "check";
  if (positional.length > 1) throw new Error("expected exactly one directory");
  options.dir = positional[0] ?? null;
  return options;
}

function assertTree(dir) {
  if (dir == null) throw new Error("no directory given");
  const resolved = path.resolve(dir);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error("not a directory: " + resolved);
  }
  const hasBuild = fs.existsSync(path.join(resolved, ".vite", "build"));
  const hasAssets = fs.existsSync(path.join(resolved, "webview", "assets"));
  if (!hasBuild && !hasAssets) {
    throw new Error(resolved + " has neither .vite/build nor webview/assets; pass an unpacked app.asar");
  }
  return resolved;
}

function excerptBlock(plan) {
  if (plan.excerpt == null) return [];
  const caretColumn = Math.max(0, Math.min(plan.excerpt.caretColumn ?? 0, 3600));
  const line = plan.excerpt.text.replace(/\r?\n/g, " ");
  return [
    "      region at offset " + plan.excerpt.offset + ":",
      "      " + line,
      "      " + " ".repeat(caretColumn + 6) + "^ anchor",
  ];
}

function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(error.message + "\n\n" + usageLines() + "\n");
    return 2;
  }
  if (options.help) {
    process.stdout.write(usageLines() + "\n");
    return 0;
  }

  let dir;
  let library;
  try {
    dir = assertTree(options.dir);
    library = loadLibrary(options.signaturesPath ? { signaturesPath: options.signaturesPath } : {});
  } catch (error) {
    process.stderr.write("durable-turns: " + error.message + "\n");
    return 2;
  }

  const reversing = options.mode === "reverse" || options.mode === "reverse-dry-run";
  const dryRun = options.mode !== "apply" && options.mode !== "reverse";
  const report = reversing
    ? reverseTree(dir, { library, mode: dryRun ? "dry-run" : "apply" })
    : patchTree(dir, { library, mode: dryRun ? options.mode : "apply" });

  if (options.json) {
    process.stdout.write(JSON.stringify({
      feature: "durable-turns",
      mode: options.mode,
      dir,
      carriers: report.carriers,
      plans: report.plans,
      failures: report.failures,
      notes: report.notes ?? [],
      ok: report.failures.length === 0,
    }, null, 2) + "\n");
  } else {
    process.stdout.write(formatReport(report) + "\n");
    // The summarised plans carry no excerpt; the failure record is what holds the
    // source, and printing it is the entire purpose of --check.
    for (const failure of report.failures) {
      for (const line of excerptBlock(failure)) process.stdout.write(line + "\n");
    }
    const counts = { [BOUND]: 0, [DRIFTED]: 0, [REMOVED]: 0 };
    for (const plan of report.plans) counts[plan.status] = (counts[plan.status] ?? 0) + 1;
    process.stdout.write("summary: BOUND=" + counts[BOUND] + " DRIFTED=" + counts[DRIFTED]
      + " REMOVED=" + counts[REMOVED] + " across " + report.carriers.length + " carrier(s)\n");
  }

  return report.failures.length === 0 ? 0 : 1;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { main, parseArgs };
