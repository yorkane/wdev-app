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

test("getSiteConfig memoizes for the process and can be reset", () => {
  const first = getSiteConfig();
  assert.equal(getSiteConfig(), first);
});
