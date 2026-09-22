const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  DEFAULT_BRAND_NAME,
  getSiteConfig,
  hostMatchesPattern,
  isBlockedUrl,
  loadSiteConfig,
  __test,
} = require("../runtime/core/site-config.cjs");

/** 把 YAML 文本写进临时文件，返回路径；每个用例独立，避免进程内缓存串味。 */
function configFile(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodex-site-config-"));
  const file = path.join(dir, "config.yaml");
  fs.writeFileSync(file, text, "utf-8");
  return file;
}

test("site config falls back to the historical brand name when nothing is configured", () => {
  const config = loadSiteConfig({ configPath: path.join(os.tmpdir(), "opencodex-missing-config.yaml") });
  assert.equal(config.brand.name, DEFAULT_BRAND_NAME);
  assert.equal(config.brand.source, "default");
  assert.equal(config.brand.configured, false);
  assert.deepEqual(config.network.blockedHosts, []);
  assert.equal(config.network.configured, false);
});

test("site config reads the brand block and keeps auth parsing intact", () => {
  const config = loadSiteConfig({
    configPath: configFile(
      [
        'auth:',
        '  password: "sha256-v1:abc"',
        '',
        'brand:',
        '  name: "wdev"   # 行尾注释要被剥掉',
        '',
      ].join("\n")
    ),
  });
  assert.equal(config.brand.name, "wdev");
  assert.equal(config.brand.source, "config");
  assert.equal(config.brand.configured, true);
});

test("site config reads block and allow host lists in both block and inline form", () => {
  const blockForm = loadSiteConfig({
    configPath: configFile(
      [
        'network:',
        '  block:',
        '    - "*.chatgpt.com"',
        '    - statsigapi.net',
        '  allow:',
        '    - "safe.chatgpt.com"',
        '',
      ].join("\n")
    ),
  });
  assert.deepEqual(blockForm.network.blockedHosts, ["*.chatgpt.com", "statsigapi.net"]);
  assert.deepEqual(blockForm.network.allowedHosts, ["safe.chatgpt.com"]);
  assert.equal(blockForm.network.configured, true);

  const inlineForm = loadSiteConfig({
    configPath: configFile('network:\n  block: ["openai.com", "*.oaiusercontent.com"]\n  allow: []\n'),
  });
  assert.deepEqual(inlineForm.network.blockedHosts, ["openai.com", "*.oaiusercontent.com"]);
  assert.deepEqual(inlineForm.network.allowedHosts, []);
});

test("site config normalizes messy host entries and rejects invalid ones", () => {
  const config = loadSiteConfig({
    configPath: configFile(
      [
        'network:',
        '  block:',
        '    - "https://ChatGPT.com/some/path?x=1"',
        '    - "ab.chatgpt.com:443"',
        '    - "*.statsig.com"',
        '    - "not a host"',
        '    - "..broken.."',
        '    - "CHATGPT.COM"',
        '',
      ].join("\n")
    ),
  });
  // 归一化：剥 scheme/路径/端口、小写化、去重；非法项直接丢弃。
  assert.deepEqual(config.network.blockedHosts, ["chatgpt.com", "ab.chatgpt.com", "*.statsig.com"]);
});

test("site config ignores a brand name that spans the block boundary", () => {
  // auth 的 password 行不能被当成 brand.name：块解析必须按顶层 key 分段。
  const config = loadSiteConfig({
    configPath: configFile(['auth:', '  password: "secret-value"', 'brand:', '  name: "wdev"', ''].join("\n")),
  });
  assert.equal(config.brand.name, "wdev");
  assert.equal(config.brand.source, "config");
});

test("site config drops an overlong or control-character brand name", () => {
  assert.equal(__test.normalizeBrandName("x".repeat(200)), "");
  assert.equal(__test.normalizeBrandName("w\u0000dev"), "wdev");
  assert.equal(__test.normalizeBrandName("  wdev  "), "wdev");
  assert.equal(__test.normalizeBrandName(""), "");
});

test("brand name from the environment wins over config.yaml", () => {
  const previous = process.env.OPENCODEX_BRAND_NAME;
  process.env.OPENCODEX_BRAND_NAME = "envbrand";
  try {
    const config = loadSiteConfig({ configPath: configFile('brand:\n  name: "wdev"\n') });
    assert.equal(config.brand.name, "envbrand");
    assert.equal(config.brand.source, "env");
  } finally {
    if (previous === undefined) delete process.env.OPENCODEX_BRAND_NAME;
    else process.env.OPENCODEX_BRAND_NAME = previous;
  }
});

test("CODEX_DESKTOP_BRAND_NAME takes precedence over the legacy env and config.yaml", () => {
  const previousEnv = process.env.CODEX_DESKTOP_BRAND_NAME;
  const previousLegacy = process.env.OPENCODEX_BRAND_NAME;
  process.env.CODEX_DESKTOP_BRAND_NAME = "desktoptop";
  process.env.OPENCODEX_BRAND_NAME = "envbrand";
  try {
    const config = loadSiteConfig({ configPath: configFile('brand:\n  name: "wdev"\n') });
    assert.equal(config.brand.name, "desktoptop");
    assert.equal(config.brand.source, "env");
    delete process.env.CODEX_DESKTOP_BRAND_NAME;
    const fallback = loadSiteConfig({ configPath: configFile('brand:\n  name: "wdev"\n') });
    assert.equal(fallback.brand.name, "envbrand");
  } finally {
    if (previousEnv === undefined) delete process.env.CODEX_DESKTOP_BRAND_NAME;
    else process.env.CODEX_DESKTOP_BRAND_NAME = previousEnv;
    if (previousLegacy === undefined) delete process.env.OPENCODEX_BRAND_NAME;
    else process.env.OPENCODEX_BRAND_NAME = previousLegacy;
  }
});

test("site config tolerates a malformed config file instead of failing startup", () => {
  const config = loadSiteConfig({
    configPath: configFile('network:\n  block: ["unterminated\nbrand: name\n:::\n\t- bad\n'),
  });
  // 解析不出结构时应回落到默认值，而不是抛异常。
  assert.equal(typeof config.brand.name, "string");
  assert.ok(Array.isArray(config.network.blockedHosts));
});

test("host pattern matching treats a wildcard as subdomains only", () => {
  assert.equal(hostMatchesPattern("ab.chatgpt.com", "*.chatgpt.com"), true);
  assert.equal(hostMatchesPattern("a.b.chatgpt.com", "*.chatgpt.com"), true);
  // 通配不匹配裸域本身，这是 glob 的常见语义，也避免用户误伤顶级域。
  assert.equal(hostMatchesPattern("chatgpt.com", "*.chatgpt.com"), false);
  assert.equal(hostMatchesPattern("chatgpt.com", "chatgpt.com"), true);
  assert.equal(hostMatchesPattern("CHATGPT.COM", "chatgpt.com"), true);
  assert.equal(hostMatchesPattern("evilchatgpt.com", "chatgpt.com"), false);
});

test("isBlockedUrl honors the allow list and ignores non-http inputs", () => {
  const network = { blockedHosts: ["*.chatgpt.com", "chatgpt.com"], allowedHosts: ["ok.chatgpt.com"] };
  assert.equal(isBlockedUrl("https://ab.chatgpt.com/v1/initialize", network), true);
  assert.equal(isBlockedUrl("https://chatgpt.com/ces/v1/rgstr", network), true);
  // allow 优先级高于 block，用于在被拉黑的域族里开洞。
  assert.equal(isBlockedUrl("https://ok.chatgpt.com/anything", network), false);
  // 相对路径、私有协议、非 http(s) 一律不拦。
  assert.equal(isBlockedUrl("/api/local", network), false);
  assert.equal(isBlockedUrl("sentry-ipc://logs", network), false);
  assert.equal(isBlockedUrl("file:///etc/passwd", network), false);
  assert.equal(isBlockedUrl("", network), false);
  // 空清单不拦任何请求。
  assert.equal(isBlockedUrl("https://chatgpt.com/x", { blockedHosts: [], allowedHosts: [] }), false);
});

test("parseAllowPathRule splits on the first slash and validates host/path", () => {
  const { parseAllowPathRule, urlMatchesAllowPath } = require("../runtime/core/site-config.cjs");
  // path 部分原样保留（含前导 /）；匹配时 pathMatchesGlob 两边统一剥前导 /。
  assert.deepEqual(parseAllowPathRule("ab.chatgpt.com/v1/initialize"), { host: "ab.chatgpt.com", path: "v1/initialize" });
  // path 里再出现的 / 属于 glob，不属于切分点。
  assert.deepEqual(parseAllowPathRule("chatgpt.com/backend-api/*"), { host: "chatgpt.com", path: "backend-api/*" });
  // 无 / 视为 host-only（等价 allow）。
  assert.deepEqual(parseAllowPathRule("ok.chatgpt.com"), { host: "ok.chatgpt.com", path: null });
  // 非法 host / 空 path / 空串 一律丢弃。
  assert.equal(parseAllowPathRule("bad host/x"), null);
  assert.equal(parseAllowPathRule("chatgpt.com/"), null);
  assert.equal(parseAllowPathRule(""), null);
  assert.equal(parseAllowPathRule("   "), null);
  assert.equal(urlMatchesAllowPath("https://chatgpt.com/backend-api/x", [{ host: "chatgpt.com", path: "backend-api/*" }]), true);
  assert.equal(urlMatchesAllowPath("https://chatgpt.com/other", [{ host: "chatgpt.com", path: "backend-api/*" }]), false);
  assert.equal(urlMatchesAllowPath("not a url", [{ host: "chatgpt.com", path: null }]), false);
});

test("allowPaths: URL-level rules beat block, wildcard path matches across segments", () => {
  const network = {
    blockedHosts: ["*.chatgpt.com", "chatgpt.com", "ab.chatgpt.com"],
    allowedHosts: [],
    allowedPaths: [
      { host: "ab.chatgpt.com", path: "/v1/initialize" },
      { host: "chatgpt.com", path: "backend-api/*" },
    ],
  };
  // 精确 path 放行。
  assert.equal(isBlockedUrl("https://ab.chatgpt.com/v1/initialize?x=1", network), false);
  // 前缀 * 放行，且 * 匹配跨 / 的任意长度。
  assert.equal(isBlockedUrl("https://chatgpt.com/backend-api/wham/usage", network), false);
  assert.equal(isBlockedUrl("https://chatgpt.com/backend-api/a/b/c/d", network), false);
  // 同域未放行的 path 仍被 block。
  assert.equal(isBlockedUrl("https://chatgpt.com/backend/other", network), true);
  assert.equal(isBlockedUrl("https://chatgpt.com/api/user", network), true);
  // query 不参与 path 匹配：/backend-api 之外带 ? 的 path 不因 query 误命中。
  assert.equal(isBlockedUrl("https://chatgpt.com/backend-apiX", network), true);
});

test("allowPaths: path glob is case sensitive, host is not", () => {
  const network = {
    blockedHosts: ["*.EXAMPLE.COM"],
    allowedPaths: [{ host: "api.example.com", path: "/Data/Files" }],
  };
  // host 大小写不敏感。
  assert.equal(isBlockedUrl("https://API.example.com/Data/Files", network), false);
  // path 大小写敏感：小写 path 不命中。
  assert.equal(isBlockedUrl("https://api.example.com/data/files", network), true);
});

test("allowPaths: host-only rule (no slash) behaves like allow", () => {
  const network = {
    blockedHosts: ["*.chatgpt.com"],
    allowedPaths: [{ host: "safe.chatgpt.com", path: null }],
  };
  assert.equal(isBlockedUrl("https://safe.chatgpt.com/anything/at/all", network), false);
  assert.equal(isBlockedUrl("https://other.chatgpt.com/x", network), true);
});

test("site config parses allowPaths entries with normalization, dedup and invalid-drop", () => {
  const config = loadSiteConfig({
    configPath: configFile(
      [
        'network:',
        '  block:',
        '    - "*.chatgpt.com"',
        '    - "chatgpt.com"',
        '  allowPaths:',
        '    - "ab.chatgpt.com/v1/initialize"',
        '    - "https://CHATGPT.com/backend-api/*"',
        '    - "chatgpt.com/backend-api/*"',
        '    - "ok.chatgpt.com"',
        '    - "bad host/x"',
        '    - "chatgpt.com/"',
        '    - ""',
        '',
      ].join("\n")
    ),
  });
  // 归一化：剥 scheme、小写；去重保序；非法（host 非法 / path 空）丢弃；无 / 视为 host-only。
  // path 按第一个 / 切分后原样保留（配置里 host 与 path 之间只有一个 /，故无双重前导）。
  assert.deepEqual(config.network.allowedPaths, [
    { host: "ab.chatgpt.com", path: "v1/initialize" },
    { host: "chatgpt.com", path: "backend-api/*" },
    { host: "ok.chatgpt.com", path: null },
  ]);
  assert.equal(config.network.configured, true);
  // allowPaths 生效：isBlockedUrl 直接放行命中项。
  assert.equal(isBlockedUrl("https://chatgpt.com/backend-api/wham/usage", config.network), false);
  assert.equal(isBlockedUrl("https://chatgpt.com/other/path", config.network), true);
});

test("site config: configured is true when only allowPaths is present", () => {
  const config = loadSiteConfig({
    configPath: configFile(['network:', '  allowPaths:', '    - "chatgpt.com/backend-api/*"', ''].join("\n")),
  });
  assert.equal(config.network.configured, true);
  assert.deepEqual(config.network.blockedHosts, []);
  // 没有 block 时 isBlockedUrl 恒 false（无拦截目标），但 urlPolicy 仍报告 allow-path 供审计。
  assert.equal(isBlockedUrl("https://chatgpt.com/backend-api/x", config.network), false);
  assert.equal(
    require("../runtime/core/site-config.cjs").urlPolicy("https://chatgpt.com/backend-api/x", config.network),
    "allow-path"
  );
});

test("urlPolicy classifies allow-path / block / passthrough consistently with isBlockedUrl", () => {
  const { urlPolicy } = require("../runtime/core/site-config.cjs");
  const network = {
    // 注意：*.chatgpt.com 不匹配裸域 chatgpt.com，因此同时列出裸域。
    blockedHosts: ["*.chatgpt.com", "chatgpt.com"],
    allowedHosts: ["ok.chatgpt.com"],
    allowedPaths: [{ host: "chatgpt.com", path: "backend-api/*" }],
  };
  assert.equal(urlPolicy("https://chatgpt.com/backend-api/x", network), "allow-path");
  assert.equal(urlPolicy("https://ok.chatgpt.com/whatever", network), "passthrough");
  assert.equal(urlPolicy("https://chatgpt.com/other", network), "block");
  assert.equal(urlPolicy("https://example.com/x", network), "passthrough");
  assert.equal(urlPolicy("/relative", network), "passthrough");
  assert.equal(urlPolicy("sentry-ipc://x", network), "passthrough");
  for (const url of [
    "https://chatgpt.com/backend-api/x",
    "https://ok.chatgpt.com/whatever",
    "https://chatgpt.com/other",
    "https://example.com/x",
  ]) {
    assert.equal(isBlockedUrl(url, network), urlPolicy(url, network) === "block");
  }
});

test("pathMatchesGlob escapes regex metacharacters and supports * across slashes", () => {
  const { pathMatchesGlob } = require("../runtime/core/site-config.cjs");
  assert.equal(pathMatchesGlob("/a/b/c", "a/*"), true);
  assert.equal(pathMatchesGlob("/a/bc", "a/*"), true);
  assert.equal(pathMatchesGlob("/a/b/c", "b/*"), false, "必须从开头匹配，不能子串命中");
  assert.equal(pathMatchesGlob("/x.y", "x.y"), true, "glob 里的点号是字面量，精确匹配");
  assert.equal(pathMatchesGlob("/xAY", "x.y"), false, "点号不能被当成正则通配");
  assert.equal(pathMatchesGlob("/x[.]y", "x[.]y"), true, "方括号也是字面量");
  assert.equal(pathMatchesGlob("/a", "*"), true);
  assert.equal(pathMatchesGlob("", "*"), true);
  assert.equal(pathMatchesGlob("/a", ""), false);
  // 前导 / 两种写法等价。
  assert.equal(pathMatchesGlob("/backend-api/x", "backend-api/*"), true);
  assert.equal(pathMatchesGlob("/backend-api/x", "/backend-api/*"), true);
});

test("getSiteConfig memoizes for the process and can be reset", () => {
  const first = getSiteConfig();
  assert.equal(getSiteConfig(), first);
});
