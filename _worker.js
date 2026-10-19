/**
 * 云笔记 (Cloud Notes) - Cloudflare Worker
 * ------------------------------------------------------------------
 * 登录: 通过环境变量控制 (AUTH_USER / AUTH_PASS / AUTH_PASS_HASH)
 * 数据: Cloudflare KV (binding: NOTES_KV)
 *   note:<id>       -> 笔记 JSON {id,title,content,tags,createdAt,updatedAt}
 *   session:<token> -> 会话 JSON {username,createdAt} (带 TTL, 到期自动过期)
 * 前端: 由 Workers Static Assets 提供 (public/), 本文件只处理 /api/*
 */

const NOTE_PREFIX = 'note:';
const SESSION_PREFIX = 'session:';
const SESSION_COOKIE = 'cfn_session';

const MAX_CONTENT = 1000000;        // 单篇笔记最大字符数 (KV 单键上限 25MiB)
const MAX_TITLE = 200;
const MAX_TAGS = 10;
const TAG_MAX_LEN = 20;
const DEFAULT_TTL_HOURS = 168;      // 会话默认 7 天
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// 登录频率限制(尽力而为, 基于单个 isolate 的内存)
const loginAttempts = new Map();
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;

const APP_HTML = "<!DOCTYPE html>\n<html lang=\"zh-CN\" data-theme=\"light\">\n<head>\n  <meta charset=\"UTF-8\">\n  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0, viewport-fit=cover\">\n  <meta name=\"theme-color\" content=\"#3b6ef5\">\n  <meta name=\"apple-mobile-web-app-capable\" content=\"yes\">\n  <title>云笔记</title>\n  <meta name=\"description\" content=\"运行在 Cloudflare Workers 上的个人云笔记, 数据存储于 Cloudflare KV\">\n  <link rel=\"icon\" href=\"/favicon.svg\" type=\"image/svg+xml\">\n  <link rel=\"stylesheet\" href=\"/style.css?v=2\">\n  <script>\n    /* 首屏前确定主题, 避免闪烁 */\n    (function () {\n      try {\n        var t = localStorage.getItem('cfn-theme');\n        document.documentElement.dataset.theme = (t === 'dark' || t === 'light') ? t : 'light';\n      } catch (e) {\n        document.documentElement.dataset.theme = 'light';\n      }\n    })();\n  </script>\n</head>\n<body>\n\n  <!-- ================= SVG 图标库 ================= -->\n  <svg xmlns=\"http://www.w3.org/2000/svg\" style=\"display:none\" aria-hidden=\"true\">\n    <symbol id=\"i-note\" viewBox=\"0 0 24 24\">\n      <rect x=\"4\" y=\"3\" width=\"16\" height=\"18\" rx=\"2.5\"/>\n      <path d=\"M8.5 8.5h7M8.5 12.5h7M8.5 16.5h4\"/>\n    </symbol>\n    <symbol id=\"i-user\" viewBox=\"0 0 24 24\">\n      <circle cx=\"12\" cy=\"8\" r=\"3.8\"/>\n      <path d=\"M4.5 20.5c0-3.7 3.4-5.8 7.5-5.8s7.5 2.1 7.5 5.8\"/>\n    </symbol>\n    <symbol id=\"i-lock\" viewBox=\"0 0 24 24\">\n      <rect x=\"5\" y=\"10.5\" width=\"14\" height=\"9.5\" rx=\"2.5\"/>\n      <path d=\"M8.2 10.5V7.8a3.8 3.8 0 0 1 7.6 0v2.7\"/>\n    </symbol>\n    <symbol id=\"i-eye\" viewBox=\"0 0 24 24\">\n      <path d=\"M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12Z\"/>\n      <circle cx=\"12\" cy=\"12\" r=\"3\"/>\n    </symbol>\n    <symbol id=\"i-eye-off\" viewBox=\"0 0 24 24\">\n      <path d=\"M4 4l16 16\"/>\n      <path d=\"M10.3 6.1A9.7 9.7 0 0 1 12 5.8c6 0 9.5 6.2 9.5 6.2a17.4 17.4 0 0 1-3.4 4.3\"/>\n      <path d=\"M6.7 8.1A17 17 0 0 0 2.5 12S6 18.2 12 18.2c1.3 0 2.5-.3 3.6-.8\"/>\n      <path d=\"M9.9 10.1a3 3 0 0 0 4.1 4.2\"/>\n    </symbol>\n    <symbol id=\"i-sun\" viewBox=\"0 0 24 24\">\n      <circle cx=\"12\" cy=\"12\" r=\"4\"/>\n      <path d=\"M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4\"/>\n    </symbol>\n    <symbol id=\"i-moon\" viewBox=\"0 0 24 24\">\n      <path d=\"M20.6 13.2A8.6 8.6 0 1 1 10.8 3.4a6.6 6.6 0 0 0 9.8 9.8Z\"/>\n    </symbol>\n    <symbol id=\"i-search\" viewBox=\"0 0 24 24\">\n      <circle cx=\"11\" cy=\"11\" r=\"6.5\"/>\n      <path d=\"M20 20l-4.5-4.5\"/>\n    </symbol>\n    <symbol id=\"i-plus\" viewBox=\"0 0 24 24\">\n      <path d=\"M12 5.5v13M5.5 12h13\"/>\n    </symbol>\n    <symbol id=\"i-download\" viewBox=\"0 0 24 24\">\n      <path d=\"M12 3.5v11.5\"/>\n      <path d=\"M7.5 10.5 12 15l4.5-4.5\"/>\n      <path d=\"M4.5 19.5h15\"/>\n    </symbol>\n    <symbol id=\"i-logout\" viewBox=\"0 0 24 24\">\n      <path d=\"M9.5 20.5H6a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2h3.5\"/>\n      <path d=\"M15.5 7 20 12l-4.5 5\"/>\n      <path d=\"M20 12H9.5\"/>\n    </symbol>\n    <symbol id=\"i-trash\" viewBox=\"0 0 24 24\">\n      <path d=\"M4.5 6.5h15\"/>\n      <path d=\"M9.5 6.5V5a1.5 1.5 0 0 1 1.5-1.5h2A1.5 1.5 0 0 1 14.5 5v1.5\"/>\n      <path d=\"M6.5 6.5 7.5 19a1.5 1.5 0 0 0 1.5 1.4h6a1.5 1.5 0 0 0 1.5-1.4l1-12.5\"/>\n      <path d=\"M10 10.5v6M14 10.5v6\"/>\n    </symbol>\n    <symbol id=\"i-tag\" viewBox=\"0 0 24 24\">\n      <path d=\"M20.4 13.3 12.7 21a1.8 1.8 0 0 1-2.5 0L3 13.8V4.8A1.8 1.8 0 0 1 4.8 3h9l6.6 6.6a1.8 1.8 0 0 1 0 2.5Z\"/>\n      <circle cx=\"8\" cy=\"8\" r=\"1.5\"/>\n    </symbol>\n    <symbol id=\"i-back\" viewBox=\"0 0 24 24\">\n      <path d=\"M15 5.5 8.5 12l6.5 6.5\"/>\n    </symbol>\n    <symbol id=\"i-edit\" viewBox=\"0 0 24 24\">\n      <path d=\"M12 20.5h8.5\"/>\n      <path d=\"M16.2 3.9a2 2 0 0 1 2.9 2.9L7.6 18.3 3.5 19.6l1.3-4.1L16.2 3.9Z\"/>\n    </symbol>\n    <symbol id=\"i-check\" viewBox=\"0 0 24 24\">\n      <path d=\"M4.5 12.5 10 18 19.5 6.5\"/>\n    </symbol>\n  </svg>\n\n  <!-- ================= 登录视图 ================= -->\n  <div id=\"login-view\" class=\"login-view\">\n    <div class=\"login-bg\" aria-hidden=\"true\">\n      <span class=\"blob blob-1\"></span>\n      <span class=\"blob blob-2\"></span>\n      <span class=\"blob blob-3\"></span>\n    </div>\n    <form id=\"login-form\" class=\"login-card\" autocomplete=\"on\">\n      <div class=\"login-logo\">\n        <svg class=\"icon\" aria-hidden=\"true\"><use href=\"#i-note\"/></svg>\n      </div>\n      <h1>云笔记</h1>\n      <p class=\"login-sub\">Cloud Notes · 数据存储于 Cloudflare KV</p>\n\n      <label for=\"login-username\">用户名</label>\n      <div class=\"input-wrap\">\n        <svg class=\"icon input-icon\" aria-hidden=\"true\"><use href=\"#i-user\"/></svg>\n        <input id=\"login-username\" name=\"username\" type=\"text\" autocomplete=\"username\" placeholder=\"请输入用户名\" required>\n      </div>\n\n      <label for=\"login-password\">密码</label>\n      <div class=\"input-wrap\">\n        <svg class=\"icon input-icon\" aria-hidden=\"true\"><use href=\"#i-lock\"/></svg>\n        <input id=\"login-password\" name=\"password\" type=\"password\" autocomplete=\"current-password\" placeholder=\"请输入密码\" required>\n        <button type=\"button\" id=\"toggle-password\" class=\"toggle-pwd\" aria-label=\"显示密码\" title=\"显示 / 隐藏密码\">\n          <svg class=\"icon icon-eye\" aria-hidden=\"true\"><use href=\"#i-eye\"/></svg>\n          <svg class=\"icon icon-eye-off\" aria-hidden=\"true\"><use href=\"#i-eye-off\"/></svg>\n        </button>\n      </div>\n\n      <div id=\"login-error\" class=\"form-error\"></div>\n      <button id=\"login-btn\" type=\"submit\" class=\"btn-primary btn-block\">登 录</button>\n      <p class=\"login-tip\">默认用户名 <b>admin</b> · 密码由服务端环境变量配置 · <b>v1.6</b></p>\n    </form>\n  </div>\n\n  <!-- ================= 主界面 ================= -->\n  <div id=\"app-view\" class=\"app-view hidden\">\n    <aside class=\"sidebar\">\n      <div class=\"sidebar-header\">\n        <div class=\"brand-mark\">\n          <svg class=\"icon\" aria-hidden=\"true\"><use href=\"#i-note\"/></svg>\n        </div>\n        <div class=\"brand-text\">\n          <b>云笔记</b>\n          <small>共 <span id=\"notes-count\">0</span> 篇 · Cloudflare KV</small>\n        </div>\n        <button id=\"theme-toggle\" class=\"icon-button theme-toggle\" type=\"button\" title=\"切换深色 / 浅色主题\">\n          <svg class=\"icon icon-moon\" aria-hidden=\"true\"><use href=\"#i-moon\"/></svg>\n          <svg class=\"icon icon-sun\" aria-hidden=\"true\"><use href=\"#i-sun\"/></svg>\n        </button>\n      </div>\n\n      <div class=\"sidebar-new\">\n        <button id=\"new-note-btn\" class=\"btn-primary btn-new\" type=\"button\">\n          <svg class=\"icon\" aria-hidden=\"true\"><use href=\"#i-plus\"/></svg>新建笔记\n        </button>\n      </div>\n\n      <div class=\"search-box\">\n        <div class=\"search-wrap\">\n          <svg class=\"icon\" aria-hidden=\"true\"><use href=\"#i-search\"/></svg>\n          <input id=\"search-input\" type=\"search\" placeholder=\"搜索标题 / 内容 / 标签…\">\n        </div>\n      </div>\n\n      <ul id=\"notes-list\" class=\"notes-list\"></ul>\n\n      <div class=\"sidebar-footer\">\n        <span id=\"user-badge\" class=\"user-badge\">\n          <svg class=\"icon\" aria-hidden=\"true\"><use href=\"#i-user\"/></svg>\n          <span id=\"user-name\"></span>\n        </span>\n        <span class=\"app-version\" title=\"当前版本\">v1.6</span>\n        <span class=\"footer-actions\">\n          <button id=\"export-btn\" class=\"icon-button\" type=\"button\" title=\"导出全部笔记为 Markdown (.md)\">\n            <svg class=\"icon\" aria-hidden=\"true\"><use href=\"#i-download\"/></svg>\n          </button>\n          <button id=\"logout-btn\" class=\"icon-button\" type=\"button\" title=\"退出登录\">\n            <svg class=\"icon\" aria-hidden=\"true\"><use href=\"#i-logout\"/></svg>\n          </button>\n        </span>\n      </div>\n    </aside>\n\n    <main class=\"editor-pane\">\n      <div id=\"empty-state\" class=\"empty-state\">\n        <div class=\"empty-art\">\n          <svg class=\"icon\" aria-hidden=\"true\"><use href=\"#i-note\"/></svg>\n        </div>\n        <h2>开始记录吧</h2>\n        <p>从左侧选择一篇笔记, 或点击「新建笔记」</p>\n        <div class=\"hint-chips\">\n          <span class=\"hint-chip\"><svg class=\"icon\" aria-hidden=\"true\"><use href=\"#i-edit\"/></svg>Markdown 语法</span>\n          <span class=\"hint-chip\"><svg class=\"icon\" aria-hidden=\"true\"><use href=\"#i-check\"/></svg>自动保存</span>\n          <span class=\"hint-chip\">Ctrl / ⌘ + S 立即保存</span>\n          <span class=\"hint-chip\">导出为 .md 文件</span>\n        </div>\n      </div>\n\n      <div id=\"editor-wrap\" class=\"editor-wrap hidden\">\n        <div class=\"editor-toolbar\">\n          <button id=\"back-btn\" class=\"icon-btn mobile-only\" type=\"button\" title=\"返回列表\">\n            <svg class=\"icon\" aria-hidden=\"true\"><use href=\"#i-back\"/></svg>\n          </button>\n          <input id=\"note-title\" type=\"text\" placeholder=\"无标题笔记\" maxlength=\"200\">\n          <div class=\"toolbar-actions\">\n            <span id=\"save-status\" class=\"save-status\">\n              <i class=\"dot\"></i><span id=\"save-status-text\"></span>\n            </span>\n            <button id=\"save-note-btn\" class=\"btn-ghost\" type=\"button\" title=\"下载当前笔记为 Markdown (.md)\">\n              <svg class=\"icon\" aria-hidden=\"true\"><use href=\"#i-download\"/></svg><span class=\"btn-label\">导出</span>\n            </button>\n            <button id=\"delete-note-btn\" class=\"btn-danger-ghost\" type=\"button\">\n              <svg class=\"icon\" aria-hidden=\"true\"><use href=\"#i-trash\"/></svg><span class=\"btn-label\">删除</span>\n            </button>\n          </div>\n        </div>\n\n        <div class=\"tags-row\">\n          <svg class=\"icon\" aria-hidden=\"true\"><use href=\"#i-tag\"/></svg>\n          <input id=\"note-tags\" type=\"text\" placeholder=\"添加标签, 用逗号分隔 (如: 工作, 灵感)\">\n        </div>\n\n        <div id=\"format-toolbar\" class=\"format-toolbar\" role=\"toolbar\" aria-label=\"Markdown 格式工具栏\">\n          <button type=\"button\" data-fmt=\"bold\" title=\"加粗 (Ctrl+B)\" class=\"fmt-b\">B</button>\n          <button type=\"button\" data-fmt=\"italic\" title=\"斜体 (Ctrl+I)\" class=\"fmt-i\">I</button>\n          <button type=\"button\" data-fmt=\"strike\" title=\"删除线\" class=\"fmt-s\">S</button>\n          <button type=\"button\" data-fmt=\"code\" title=\"行内代码\" class=\"fmt-code\">&lt;/&gt;</button>\n          <span class=\"fmt-sep\"></span>\n          <button type=\"button\" data-fmt=\"h1\" title=\"一级标题\">H1</button>\n          <button type=\"button\" data-fmt=\"h2\" title=\"二级标题\">H2</button>\n          <button type=\"button\" data-fmt=\"h3\" title=\"三级标题\">H3</button>\n          <span class=\"fmt-sep\"></span>\n          <button type=\"button\" data-fmt=\"ul\" title=\"无序列表\">•</button>\n          <button type=\"button\" data-fmt=\"ol\" title=\"有序列表\">1.</button>\n          <button type=\"button\" data-fmt=\"quote\" title=\"引用\">❝</button>\n          <button type=\"button\" data-fmt=\"codeblock\" title=\"代码块\">{ }</button>\n          <span class=\"fmt-sep\"></span>\n          <button type=\"button\" data-fmt=\"link\" title=\"插入链接 (Ctrl+K)\">链接</button>\n          <button type=\"button\" data-fmt=\"image\" title=\"插入图片\">图片</button>\n          <button type=\"button\" data-fmt=\"table\" title=\"插入表格\">表格</button>\n          <button type=\"button\" data-fmt=\"hr\" title=\"插入分割线\">—</button>\n        </div>\n\n        <div class=\"editor-body\">\n          <div id=\"note-content\" contenteditable=\"true\" spellcheck=\"false\" data-ph=\"开始书写… 支持 Markdown 语法, 内容会自动保存\"></div>\n        </div>\n\n        <div class=\"editor-statusbar\">\n          <span id=\"note-meta\"></span>\n          <span id=\"word-count\"></span>\n        </div>\n      </div>\n    </main>\n  </div>\n\n  <div id=\"toast\" class=\"toast\"></div>\n\n  <script src=\"/app.js?v=2\"></script>\n</body>\n</html>\n";
const APP_CSS = "/* ============================================================\n   云笔记 - 样式\n   主题: 默认浅色, 支持深色 (html[data-theme=\"dark\"])\n   ============================================================ */\n\n/* ---------- 主题变量 ---------- */\n:root, [data-theme=\"light\"] {\n  color-scheme: light;\n  --bg: #f3f4f7;\n  --bg-grad-1: #e9eefc;\n  --bg-grad-2: #f3f4f7;\n  --bg-grad-3: #fbeedb;\n  --panel: #ffffff;\n  --panel-2: #f5f6f9;\n  --border: #e5e8ef;\n  --border-strong: #d4d9e3;\n  --text: #1b2130;\n  --text-2: #454d61;\n  --muted: #7d8698;\n  --faint: #a6afc0;\n  --accent: #3b6ef5;\n  --accent-strong: #2f57d8;\n  --accent-soft: #edf2fe;\n  --accent-border: #ccd9fb;\n  --accent-shadow: rgba(59, 110, 245, .30);\n  --accent-2: #8b5cf6;\n  --danger: #d92d20;\n  --danger-soft: #fef3f2;\n  --danger-border: #fecdca;\n  --ok: #079455;\n  --warn: #dc9b04;\n  --shadow-sm: 0 1px 2px rgba(17, 24, 39, .06);\n  --shadow-md: 0 4px 16px rgba(17, 24, 39, .08);\n  --shadow-lg: 0 18px 48px rgba(17, 24, 39, .14);\n  --code-bg: #f2f4f8;\n  --quote-bg: #f6f8ff;\n  --selection: rgba(59, 110, 245, .16);\n  --glass: rgba(255, 255, 255, .78);\n  --toast-bg: #1b2130;\n  --toast-fg: #f7f8fa;\n  --blob-1: rgba(99, 102, 241, .32);\n  --blob-2: rgba(59, 130, 246, .26);\n  --blob-3: rgba(245, 183, 76, .24);\n}\n\n[data-theme=\"dark\"] {\n  color-scheme: dark;\n  --bg: #0e1117;\n  --bg-grad-1: #141b30;\n  --bg-grad-2: #0e1117;\n  --bg-grad-3: #211a33;\n  --panel: #151923;\n  --panel-2: #1b2130;\n  --border: #252c3b;\n  --border-strong: #333b4d;\n  --text: #e8ebf2;\n  --text-2: #b3bac9;\n  --muted: #8590a3;\n  --faint: #5b6478;\n  --accent: #6f92ff;\n  --accent-strong: #5a80f0;\n  --accent-soft: rgba(111, 146, 255, .13);\n  --accent-border: rgba(111, 146, 255, .32);\n  --accent-shadow: rgba(111, 146, 255, .28);\n  --accent-2: #a78bfa;\n  --danger: #f05252;\n  --danger-soft: rgba(240, 82, 82, .12);\n  --danger-border: rgba(240, 82, 82, .35);\n  --ok: #3ecf8e;\n  --warn: #f5c14b;\n  --shadow-sm: 0 1px 2px rgba(0, 0, 0, .35);\n  --shadow-md: 0 4px 18px rgba(0, 0, 0, .4);\n  --shadow-lg: 0 18px 52px rgba(0, 0, 0, .55);\n  --code-bg: #1c2130;\n  --quote-bg: rgba(111, 146, 255, .07);\n  --selection: rgba(111, 146, 255, .3);\n  --glass: rgba(21, 25, 35, .78);\n  --toast-bg: #e8ebf2;\n  --toast-fg: #151923;\n  --blob-1: rgba(99, 102, 241, .24);\n  --blob-2: rgba(56, 130, 246, .18);\n  --blob-3: rgba(200, 150, 50, .12);\n}\n\n/* ---------- 基础 ---------- */\n* { box-sizing: border-box; }\nhtml, body { height: 100%; }\n\nbody {\n  margin: 0;\n  font-family: -apple-system, BlinkMacSystemFont, \"Segoe UI\", \"PingFang SC\",\n    \"Hiragino Sans GB\", \"Microsoft YaHei\", sans-serif;\n  background: var(--bg);\n  color: var(--text);\n  font-size: 15px;\n  -webkit-font-smoothing: antialiased;\n  text-rendering: optimizeLegibility;\n  transition: background-color .3s ease, color .3s ease;\n}\n\n::selection { background: var(--selection); }\n:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }\n.hidden { display: none !important; }\n\n/* ---------- 图标 ---------- */\n.icon {\n  width: 18px; height: 18px; flex: none;\n  fill: none; stroke: currentColor;\n  stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round;\n}\n\n/* ---------- 滚动条 ---------- */\n::-webkit-scrollbar { width: 9px; height: 9px; }\n::-webkit-scrollbar-thumb {\n  background: var(--border-strong); border-radius: 8px;\n  border: 2px solid transparent; background-clip: content-box;\n}\n::-webkit-scrollbar-thumb:hover { background: var(--faint); border: 2px solid transparent; background-clip: content-box; }\n::-webkit-scrollbar-track { background: transparent; }\n\n/* ============================================================\n   登录视图\n   ============================================================ */\n.login-view {\n  min-height: 100vh;\n  display: grid; place-items: center;\n  position: relative; overflow: hidden;\n  background: linear-gradient(155deg, var(--bg-grad-1), var(--bg-grad-2) 55%, var(--bg-grad-3));\n  padding: 24px;\n}\n\n.login-bg { position: absolute; inset: 0; filter: blur(72px); pointer-events: none; }\n.blob { position: absolute; border-radius: 50%; animation: float 15s ease-in-out infinite; }\n.blob-1 { width: 430px; height: 430px; background: var(--blob-1); top: -130px; left: -110px; }\n.blob-2 { width: 390px; height: 390px; background: var(--blob-2); bottom: -150px; right: -90px; animation-delay: -5s; }\n.blob-3 { width: 300px; height: 300px; background: var(--blob-3); top: 38%; left: 62%; animation-delay: -10s; }\n\n@keyframes float {\n  0%, 100% { transform: translate(0, 0) scale(1); }\n  33% { transform: translate(42px, -32px) scale(1.08); }\n  66% { transform: translate(-32px, 26px) scale(.94); }\n}\n\n.login-card {\n  position: relative;\n  width: 100%; max-width: 400px;\n  background: var(--glass);\n  backdrop-filter: blur(20px) saturate(1.5);\n  -webkit-backdrop-filter: blur(20px) saturate(1.5);\n  border: 1px solid var(--border);\n  border-radius: 22px;\n  box-shadow: var(--shadow-lg);\n  padding: 42px 36px 26px;\n  animation: fadeUp .55s cubic-bezier(.2, .7, .3, 1);\n}\n\n@keyframes fadeUp {\n  from { opacity: 0; transform: translateY(16px); }\n  to { opacity: 1; transform: none; }\n}\n\n@keyframes shake {\n  10%, 90% { transform: translateX(-2px); }\n  20%, 80% { transform: translateX(4px); }\n  30%, 50%, 70% { transform: translateX(-7px); }\n  40%, 60% { transform: translateX(7px); }\n}\n.login-card.shake { animation: shake .5s; }\n\n.login-logo {\n  width: 60px; height: 60px; margin: 0 auto 16px;\n  border-radius: 18px; display: grid; place-items: center;\n  background: linear-gradient(135deg, var(--accent), var(--accent-2));\n  color: #fff;\n  box-shadow: 0 10px 26px var(--accent-shadow);\n}\n.login-logo .icon { width: 30px; height: 30px; }\n\n.login-card h1 { margin: 0; text-align: center; font-size: 24px; letter-spacing: 1px; }\n.login-sub { margin: 7px 0 28px; text-align: center; color: var(--muted); font-size: 13px; }\n\n.login-card label {\n  display: block; font-size: 13px; font-weight: 500;\n  color: var(--text-2); margin: 0 0 7px 2px;\n}\n\n.input-wrap { position: relative; margin-bottom: 18px; }\n.input-wrap .input-icon {\n  position: absolute; left: 13px; top: 50%; transform: translateY(-50%);\n  width: 17px; height: 17px; color: var(--faint); pointer-events: none;\n}\n.input-wrap input {\n  width: 100%; padding: 11px 42px;\n  border: 1px solid var(--border); border-radius: 12px;\n  font-size: 14.5px; background: var(--panel); color: var(--text);\n  transition: border-color .16s, box-shadow .16s;\n}\n.input-wrap input::placeholder { color: var(--faint); }\n.input-wrap input:focus {\n  outline: none; border-color: var(--accent);\n  box-shadow: 0 0 0 4px var(--accent-soft);\n}\n\n.toggle-pwd {\n  position: absolute; right: 6px; top: 50%; transform: translateY(-50%);\n  border: none; background: none; padding: 7px;\n  border-radius: 9px; color: var(--faint); cursor: pointer;\n  display: grid; place-items: center;\n  transition: color .15s, background .15s;\n}\n.toggle-pwd:hover { color: var(--text-2); background: var(--panel-2); }\n.toggle-pwd .icon-eye-off { display: none; }\n.toggle-pwd.revealed .icon-eye { display: none; }\n.toggle-pwd.revealed .icon-eye-off { display: block; }\n\n.form-error {\n  color: var(--danger); font-size: 13px;\n  min-height: 20px; margin-bottom: 10px; padding-left: 2px;\n}\n\n.login-tip { font-size: 12px; color: var(--faint); text-align: center; margin: 20px 0 0; }\n.login-tip b { color: var(--muted); font-weight: 600; }\n\n/* ============================================================\n   按钮\n   ============================================================ */\n.btn-primary {\n  border: none; border-radius: 11px; cursor: pointer;\n  background: linear-gradient(135deg, var(--accent), var(--accent-strong));\n  color: #fff; font-size: 14px;\n  box-shadow: 0 6px 16px var(--accent-shadow);\n  transition: transform .15s, box-shadow .15s, filter .15s;\n}\n.btn-primary:hover { filter: brightness(1.07); transform: translateY(-1px); box-shadow: 0 10px 24px var(--accent-shadow); }\n.btn-primary:active { transform: translateY(0); box-shadow: 0 4px 12px var(--accent-shadow); }\n.btn-primary:disabled { opacity: .6; cursor: default; transform: none; }\n\n.btn-block { width: 100%; padding: 12px; font-size: 15px; letter-spacing: 2px; }\n\n.icon-button {\n  width: 34px; height: 34px; flex: none;\n  display: grid; place-items: center;\n  border: 1px solid var(--border); border-radius: 10px;\n  background: var(--panel-2); color: var(--text-2);\n  cursor: pointer; transition: color .15s, border-color .15s, background .15s;\n}\n.icon-button:hover { color: var(--accent); border-color: var(--accent-border); background: var(--accent-soft); }\n\n.btn-danger-ghost {\n  display: inline-flex; align-items: center; gap: 6px;\n  background: transparent; border: 1px solid var(--border); color: var(--danger);\n  padding: 6px 12px; border-radius: 9px; font-size: 13px; cursor: pointer;\n  transition: background .15s, border-color .15s;\n}\n.btn-danger-ghost:hover { background: var(--danger-soft); border-color: var(--danger-border); }\n.btn-danger-ghost .icon { width: 15px; height: 15px; }\n\n.btn-ghost {\n  display: inline-flex; align-items: center; gap: 6px;\n  background: transparent; border: 1px solid var(--border); color: var(--text-2);\n  padding: 6px 12px; border-radius: 9px; font-size: 13px; cursor: pointer;\n  transition: background .15s, border-color .15s, color .15s;\n}\n.btn-ghost:hover { background: var(--accent-soft); border-color: var(--accent-border); color: var(--accent); }\n.btn-ghost .icon { width: 15px; height: 15px; }\n\n.icon-btn {\n  border: none; background: transparent; cursor: pointer;\n  color: var(--muted); padding: 6px; border-radius: 9px;\n  display: grid; place-items: center;\n}\n.icon-btn:hover { background: var(--panel-2); color: var(--text); }\n\n/* ============================================================\n   主界面布局\n   ============================================================ */\n.app-view { display: flex; height: 100vh; overflow: hidden; }\n\n/* ---------- 侧边栏 ---------- */\n.sidebar {\n  width: 306px; flex-shrink: 0;\n  background: var(--panel);\n  border-right: 1px solid var(--border);\n  display: flex; flex-direction: column;\n  transition: background-color .3s ease, border-color .3s ease, transform .22s ease;\n}\n\n.sidebar-header {\n  display: flex; align-items: center; gap: 11px;\n  padding: 16px 16px 14px;\n}\n.brand-mark {\n  width: 36px; height: 36px; flex: none;\n  border-radius: 11px; display: grid; place-items: center;\n  background: linear-gradient(135deg, var(--accent), var(--accent-2));\n  color: #fff; box-shadow: 0 5px 14px var(--accent-shadow);\n}\n.brand-mark .icon { width: 19px; height: 19px; }\n.brand-text { display: flex; flex-direction: column; line-height: 1.25; min-width: 0; }\n.brand-text b { font-size: 15.5px; letter-spacing: .5px; }\n.brand-text small { font-size: 11px; color: var(--muted); white-space: nowrap; }\n.theme-toggle { margin-left: auto; }\n\n.sidebar-new { padding: 2px 14px 10px; }\n.btn-new {\n  width: 100%; display: inline-flex; align-items: center;\n  justify-content: center; gap: 7px; padding: 10px;\n  font-size: 14px; font-weight: 500;\n}\n.btn-new .icon { width: 16px; height: 16px; }\n\n.search-box { padding: 0 14px 10px; }\n.search-wrap { position: relative; }\n.search-wrap .icon {\n  position: absolute; left: 12px; top: 50%; transform: translateY(-50%);\n  width: 16px; height: 16px; color: var(--faint); pointer-events: none;\n}\n.search-wrap input {\n  width: 100%; padding: 9px 12px 9px 36px;\n  border: 1px solid var(--border); border-radius: 10px;\n  background: var(--panel-2); font-size: 13.5px; color: var(--text);\n  transition: border-color .16s, box-shadow .16s, background .16s;\n}\n.search-wrap input::placeholder { color: var(--faint); }\n.search-wrap input:focus {\n  outline: none; border-color: var(--accent); background: var(--panel);\n  box-shadow: 0 0 0 4px var(--accent-soft);\n}\n\n/* ---------- 笔记列表 ---------- */\n.notes-list { flex: 1; overflow-y: auto; margin: 0; padding: 4px 10px 10px; list-style: none; }\n\n.note-item {\n  position: relative;\n  padding: 11px 12px 11px 15px;\n  border-radius: 12px; cursor: pointer;\n  border: 1px solid transparent; margin-bottom: 2px;\n  transition: background .15s, border-color .15s;\n}\n.note-item:hover { background: var(--panel-2); }\n.note-item.active { background: var(--accent-soft); border-color: var(--accent-border); }\n.note-item.active::before {\n  content: \"\"; position: absolute; left: 5px; top: 13px; bottom: 13px;\n  width: 3px; border-radius: 3px; background: var(--accent);\n}\n.note-item-title {\n  font-weight: 600; font-size: 14px; color: var(--text);\n  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;\n}\n.note-item-snippet {\n  color: var(--muted); font-size: 12.5px; margin-top: 3px; line-height: 1.5;\n  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;\n  overflow: hidden; min-height: 2em;\n}\n.note-item-meta { color: var(--faint); font-size: 11.5px; margin-top: 6px; }\n.note-item-tags { margin-top: 7px; display: flex; gap: 4px; flex-wrap: wrap; }\n.tag-chip {\n  background: var(--panel-2); border: 1px solid var(--border);\n  color: var(--muted); font-size: 11px; padding: 1px 8px; border-radius: 999px;\n}\n.list-empty { color: var(--faint); text-align: center; padding: 44px 12px; font-size: 13px; line-height: 1.7; }\n\n.sidebar-footer {\n  display: flex; align-items: center; justify-content: space-between; gap: 8px;\n  padding: 11px 14px; border-top: 1px solid var(--border);\n}\n.user-badge {\n  display: inline-flex; align-items: center; gap: 7px;\n  font-size: 13px; color: var(--text-2); font-weight: 500;\n  min-width: 0; overflow: hidden;\n}\n.user-badge .icon { width: 15px; height: 15px; color: var(--faint); }\n.user-badge #user-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n.footer-actions { display: inline-flex; gap: 7px; flex: none; }\n.app-version {\n  flex: none; font-size: 11px; color: var(--faint);\n  background: var(--panel-2); border: 1px solid var(--border);\n  padding: 2px 7px; border-radius: 999px; white-space: nowrap;\n}\n\n/* ============================================================\n   编辑区 (纸卡片)\n   ============================================================ */\n.editor-pane {\n  flex: 1; min-width: 0;\n  display: flex; flex-direction: column;\n  background: var(--bg);\n}\n\n.empty-state {\n  flex: 1; display: flex; flex-direction: column;\n  align-items: center; justify-content: center;\n  color: var(--muted); gap: 4px; padding: 24px; text-align: center;\n}\n.empty-art {\n  width: 88px; height: 88px; margin-bottom: 20px;\n  border-radius: 26px; display: grid; place-items: center;\n  background: var(--accent-soft); color: var(--accent);\n  border: 1px solid var(--accent-border);\n}\n.empty-art .icon { width: 40px; height: 40px; stroke-width: 1.4; }\n.empty-state h2 { margin: 0; font-size: 18px; color: var(--text-2); font-weight: 600; }\n.empty-state p { margin: 6px 0 0; font-size: 13.5px; }\n.hint-chips { margin-top: 22px; display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; }\n.hint-chip {\n  display: inline-flex; align-items: center; gap: 5px;\n  background: var(--panel); border: 1px solid var(--border);\n  color: var(--muted); font-size: 12px; padding: 5px 12px; border-radius: 999px;\n}\n.hint-chip .icon { width: 13px; height: 13px; }\n\n.editor-wrap {\n  flex: 1; min-height: 0;\n  display: flex; flex-direction: column;\n  margin: 16px; overflow: hidden;\n  background: var(--panel);\n  border: 1px solid var(--border);\n  border-radius: 18px;\n  box-shadow: var(--shadow-md);\n  animation: fadeUp .3s cubic-bezier(.2, .7, .3, 1);\n}\n\n.editor-toolbar {\n  display: flex; align-items: center; gap: 10px;\n  padding: 14px 16px 10px;\n  border-bottom: 1px solid var(--border);\n}\n#note-title {\n  flex: 1; min-width: 0;\n  border: none; outline: none; background: transparent;\n  font-size: 21px; font-weight: 700; letter-spacing: .3px;\n  color: var(--text); padding: 4px 2px;\n}\n#note-title::placeholder { color: var(--faint); font-weight: 600; }\n.toolbar-actions { display: flex; align-items: center; gap: 9px; flex: none; }\n\n/* 保存状态指示 */\n.save-status { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); white-space: nowrap; }\n.save-status .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--faint); flex: none; transition: background .2s; }\n.save-status.is-saved .dot { background: var(--ok); }\n.save-status.is-dirty .dot { background: var(--warn); }\n.save-status.is-saving .dot { background: var(--accent); animation: pulse 1s ease-in-out infinite; }\n.save-status.is-error .dot { background: var(--danger); }\n@keyframes pulse { 50% { opacity: .25; } }\n\n/* 标签行 */\n.tags-row {\n  display: flex; align-items: center; gap: 9px;\n  padding: 4px 18px 10px;\n  border-bottom: 1px solid var(--border);\n}\n.tags-row .icon { width: 15px; height: 15px; color: var(--faint); flex: none; }\n#note-tags {\n  flex: 1; min-width: 0;\n  border: none; outline: none; background: transparent;\n  font-size: 13px; color: var(--text-2); padding: 4px 0;\n}\n#note-tags::placeholder { color: var(--faint); }\n\n/* ---------- Markdown 格式工具栏 ---------- */\n.format-toolbar {\n  display: flex; align-items: center; gap: 2px;\n  padding: 7px 14px;\n  border-bottom: 1px solid var(--border);\n  background: var(--panel);\n  overflow-x: auto; overflow-y: hidden;\n  scrollbar-width: none; -webkit-overflow-scrolling: touch;\n}\n.format-toolbar::-webkit-scrollbar { display: none; }\n.format-toolbar .fmt-sep {\n  flex: none; width: 1px; height: 18px;\n  background: var(--border); margin: 0 6px;\n}\n.format-toolbar button {\n  flex: none;\n  min-width: 30px; height: 30px; padding: 0 9px;\n  display: inline-flex; align-items: center; justify-content: center;\n  border: 1px solid transparent; border-radius: 8px;\n  background: transparent; color: var(--text-2);\n  font-size: 13px; font-family: inherit; line-height: 1; cursor: pointer;\n  transition: background .15s, color .15s, border-color .15s;\n}\n.format-toolbar button:hover {\n  background: var(--accent-soft); color: var(--accent); border-color: var(--accent-border);\n}\n.format-toolbar button:active { transform: translateY(1px); }\n.format-toolbar .fmt-b { font-weight: 800; }\n.format-toolbar .fmt-i { font-style: italic; font-family: Georgia, \"Times New Roman\", serif; }\n.format-toolbar .fmt-s { text-decoration: line-through; }\n.format-toolbar .fmt-code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; }\n\n/* 正文 */\n.editor-body { flex: 1; min-height: 0; }\n#note-content {\n  display: block; width: 100%; height: 100%;\n  border: none; outline: none; resize: none;\n  padding: 20px max(28px, calc(50% - 420px));\n  font-size: 15.5px; line-height: 1.85;\n  font-family: inherit; background: transparent; color: var(--text);\n  caret-color: var(--accent);\n}\n#note-content:empty::before { content: attr(data-ph); color: var(--faint); pointer-events: none; }\n\n#note-content {\n  height: 100%; overflow-y: auto;\n  padding: 20px max(30px, calc(50% - 420px));\n  font-size: 15.5px; line-height: 1.85;\n}\n\n/* 状态栏 */\n.editor-statusbar {\n  display: flex; justify-content: space-between; align-items: center; gap: 12px;\n  padding: 9px 18px;\n  border-top: 1px solid var(--border);\n  background: var(--panel-2);\n  font-size: 12px; color: var(--muted);\n}\n.editor-statusbar span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n\n/* ============================================================\n   Markdown 预览样式\n   ============================================================ */\n#note-content h1, #note-content h2, #note-content h3,\n#note-content h4, #note-content h5, #note-content h6 {\n  margin: 1.15em 0 .5em; line-height: 1.35; font-weight: 700;\n}\n#note-content h1 { font-size: 1.65em; padding-bottom: .35em; border-bottom: 1px solid var(--border); }\n#note-content h2 { font-size: 1.42em; padding-bottom: .3em; border-bottom: 1px solid var(--border); }\n#note-content h3 { font-size: 1.22em; }\n#note-content h4 { font-size: 1.06em; }\n#note-content h5, #note-content h6 { font-size: 1em; color: var(--text-2); }\n#note-content p { margin: .65em 0; }\n#note-content a { color: var(--accent); text-decoration-color: var(--accent-border); text-underline-offset: 3px; }\n#note-content a:hover { text-decoration-color: var(--accent); }\n#note-content strong { color: var(--text); }\n#note-content del { color: var(--muted); }\n\n#note-content code {\n  background: var(--code-bg); border: 1px solid var(--border);\n  padding: 1.5px 6px; border-radius: 6px;\n  font-size: .88em; font-family: ui-monospace, SFMono-Regular, Consolas, \"Courier New\", monospace;\n}\n#note-content pre {\n  background: var(--code-bg); border: 1px solid var(--border);\n  padding: 14px 16px; border-radius: 12px; overflow-x: auto;\n  margin: .8em 0;\n}\n#note-content pre code { background: none; border: none; padding: 0; font-size: 13.5px; line-height: 1.7; }\n\n#note-content blockquote {\n  margin: .7em 0; padding: 6px 16px;\n  border-left: 3px solid var(--accent);\n  background: var(--quote-bg);\n  border-radius: 0 10px 10px 0;\n  color: var(--text-2);\n}\n#note-content blockquote p { margin: .3em 0; }\n\n#note-content ul, #note-content ol { padding-left: 1.5em; margin: .55em 0; }\n#note-content li { margin: .25em 0; }\n#note-content li::marker { color: var(--accent); }\n#note-content img { max-width: 100%; border-radius: 10px; border: 1px solid var(--border); }\n#note-content hr { border: none; border-top: 1px solid var(--border); margin: 1.4em 0; }\n#note-content table {\n  border-collapse: collapse; margin: .8em 0; max-width: 100%;\n  display: block; overflow-x: auto; font-size: .95em;\n}\n#note-content th, #note-content td {\n  border: 1px solid var(--border-strong); padding: 7px 12px;\n  text-align: left; vertical-align: top; min-width: 64px;\n}\n#note-content th { background: var(--panel-2); font-weight: 600; color: var(--text); }\n\n/* ============================================================\n   Toast\n   ============================================================ */\n.toast {\n  position: fixed; left: 50%; bottom: 30px; z-index: 100;\n  transform: translateX(-50%) translateY(18px);\n  background: var(--toast-bg); color: var(--toast-fg);\n  padding: 10px 20px; border-radius: 999px;\n  font-size: 13.5px; opacity: 0; pointer-events: none;\n  transition: opacity .25s, transform .25s;\n  box-shadow: var(--shadow-lg);\n  max-width: 82vw;\n}\n.toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }\n.toast.error { background: var(--danger); color: #fff; }\n\n/* ============================================================\n   移动端 / 触屏适配\n   ============================================================ */\n.mobile-only { display: none !important; }\n\n@media (max-width: 860px) {\n  .sidebar { width: 280px; }\n  #note-content { padding: 18px max(20px, calc(50% - 380px)); }\n}\n\n@media (max-width: 760px) {\n  .sidebar {\n    position: fixed; top: 0; bottom: 0; left: 0;\n    width: min(88vw, 340px); z-index: 30;\n    box-shadow: 0 0 48px rgba(16, 24, 39, .18);\n  }\n  .app-view.show-editor .sidebar { transform: translateX(-104%); }\n  .mobile-only { display: inline-flex !important; }\n\n  .editor-wrap {\n    margin: 0; border: none; border-radius: 0; box-shadow: none;\n  }\n  .editor-toolbar {\n    flex-wrap: wrap; row-gap: 6px;\n    padding: 8px 10px 6px; gap: 6px;\n  }\n  #note-title { flex: 1 1 120px; font-size: 18px; }\n  .toolbar-actions { gap: 6px; margin-left: auto; }\n  .save-status { display: none; }\n  .btn-ghost, .btn-danger-ghost { padding: 6px 10px; }\n  .toolbar-actions .btn-label { display: none; }\n\n  .tags-row { padding: 2px 12px 8px; }\n  #note-tags { font-size: 16px; }\n\n  .format-toolbar { padding: 6px 10px; }\n  .format-toolbar button { min-width: 32px; height: 32px; padding: 0 9px; }\n\n  #note-content { padding: 14px 16px; font-size: 16px; line-height: 1.8; }\n  .editor-statusbar { padding: 8px 14px calc(8px + env(safe-area-inset-bottom)); }\n\n  .empty-state { padding: 22px 18px; }\n  .empty-art { width: 72px; height: 72px; margin-bottom: 16px; border-radius: 20px; }\n  .empty-art .icon { width: 32px; height: 32px; }\n  .hint-chips { margin-top: 18px; }\n\n  .notes-list { -webkit-overflow-scrolling: touch; }\n  .note-item { padding: 12px 12px 12px 15px; }\n\n  .login-view { padding: 16px; align-content: center; }\n  .login-card { padding: 32px 22px 20px; border-radius: 18px; }\n  .toast { bottom: calc(20px + env(safe-area-inset-bottom)); }\n}\n\n@media (max-width: 400px) {\n  .btn-ghost, .btn-danger-ghost { padding: 6px 8px; }\n  .format-toolbar button { min-width: 30px; padding: 0 7px; }\n}\n\n/* ---------- 减少动态效果 ---------- */\n@media (prefers-reduced-motion: reduce) {\n  *, *::before, *::after {\n    animation-duration: .001s !important;\n    animation-iteration-count: 1 !important;\n    transition-duration: .001s !important;\n  }\n}\n";
const APP_JS = "'use strict';\n\n/* ==================== 状态 ==================== */\nconst state = {\n  notes: [],      // 笔记列表(元数据)\n  current: null,  // 当前打开的笔记(完整)\n  query: '',\n  dirty: false    // 有未保存修改\n};\n\n/* ==================== DOM ==================== */\nconst $ = (id) => document.getElementById(id);\nconst el = {\n  loginView: $('login-view'),\n  loginForm: $('login-form'),\n  loginUsername: $('login-username'),\n  loginPassword: $('login-password'),\n  togglePwd: $('toggle-password'),\n  loginError: $('login-error'),\n  loginBtn: $('login-btn'),\n  appView: $('app-view'),\n  themeToggle: $('theme-toggle'),\n  newNoteBtn: $('new-note-btn'),\n  searchInput: $('search-input'),\n  notesList: $('notes-list'),\n  notesCount: $('notes-count'),\n  userBadge: $('user-badge'),\n  userName: $('user-name'),\n  logoutBtn: $('logout-btn'),\n  exportBtn: $('export-btn'),\n  emptyState: $('empty-state'),\n  editorWrap: $('editor-wrap'),\n  backBtn: $('back-btn'),\n  title: $('note-title'),\n  tags: $('note-tags'),\n  content: $('note-content'),\n  saveStatus: $('save-status'),\n  saveText: $('save-status-text'),\n  deleteBtn: $('delete-note-btn'),\n  saveNoteBtn: $('save-note-btn'),\n  formatToolbar: $('format-toolbar'),\n  noteMeta: $('note-meta'),\n  wordCount: $('word-count'),\n  toast: $('toast')\n};\n\n/* ==================== 工具 ==================== */\nfunction pad2(n) { return (n < 10 ? '0' : '') + n; }\n\nfunction formatTime(ts) {\n  const d = new Date(ts);\n  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +\n    ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());\n}\n\nfunction relTime(ts) {\n  const diff = Date.now() - ts;\n  if (diff < 60 * 1000) return '刚刚';\n  if (diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + ' 分钟前';\n  if (diff < 24 * 60 * 60 * 1000) return Math.floor(diff / 3600000) + ' 小时前';\n  if (diff < 7 * 24 * 60 * 60 * 1000) return Math.floor(diff / 86400000) + ' 天前';\n  return formatTime(ts).slice(0, 10);\n}\n\nfunction setDocTitle(t) {\n  document.title = t ? t + ' - 云笔记' : '云笔记';\n}\n\nlet toastTimer = null;\nfunction toast(msg, type) {\n  el.toast.textContent = msg;\n  el.toast.className = 'toast show' + (type ? ' ' + type : '');\n  clearTimeout(toastTimer);\n  toastTimer = setTimeout(() => { el.toast.className = 'toast'; }, 2600);\n}\n\nfunction parseTags(s) {\n  const out = [];\n  String(s || '').split(/[,，]/).forEach((t) => {\n    t = t.trim().slice(0, 20);\n    if (t && out.indexOf(t) === -1 && out.length < 10) out.push(t);\n  });\n  return out;\n}\n\nfunction makeSnippet(content) {\n  return String(content || '')\n    .replace(/```[\\s\\S]*?```/g, ' ')\n    .replace(/[#>*`_~|[\\]()]/g, ' ')\n    .replace(/\\s+/g, ' ')\n    .trim()\n    .slice(0, 100);\n}\n\n/* ==================== Markdown 渲染(轻量) ==================== */\nfunction escapeHtml(s) {\n  return String(s)\n    .replace(/&/g, '&amp;')\n    .replace(/</g, '&lt;')\n    .replace(/>/g, '&gt;')\n    .replace(/\"/g, '&quot;');\n}\n\nfunction renderInline(s) {\n  s = escapeHtml(s);\n  s = s.replace(/`([^`\\n]+)`/g, (m, code) => '<code>' + code + '</code>');\n  s = s.replace(/!\\[([^\\]]*)\\]\\(([^)\\s]+)\\)/g,\n    (m, alt, src) => '<img src=\"' + src + '\" alt=\"' + alt + '\" loading=\"lazy\">');\n  s = s.replace(/\\[([^\\]]+)\\]\\(([^)\\s]+)\\)/g,\n    (m, text, href) => '<a href=\"' + href + '\" target=\"_blank\" rel=\"noopener noreferrer\">' + text + '</a>');\n  s = s.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');\n  s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');\n  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');\n  s = s.replace(/(^|[^*\\w])\\*([^*\\n]+)\\*(?!\\*)/g, '$1<em>$2</em>');\n  s = s.replace(/(^|[^_\\w])_([^_\\n]+)_(?!_)/g, '$1<em>$2</em>');\n  return s;\n}\n\nfunction renderMarkdown(src, codeBlocks) {\n  codeBlocks = codeBlocks || [];\n  src = String(src || '').replace(/\\r\\n/g, '\\n');\n\n  // 先提取代码块, 用占位符保护, 避免被行内规则破坏\n  src = src.replace(/```[^\\n]*\\n[\\s\\S]*?```/g, (m) => {\n    const code = m.replace(/^```[^\\n]*\\n/, '').replace(/```$/, '');\n    codeBlocks.push('<pre><code>' + escapeHtml(code) + '</code></pre>');\n    return '\\u0000CB' + (codeBlocks.length - 1) + '\\u0000';\n  });\n\n  const lines = src.split('\\n');\n  let html = '';\n  let para = [];\n\n  const flushPara = () => {\n    if (para.length) {\n      html += '<p>' + para.map(renderInline).join('<br>') + '</p>';\n      para = [];\n    }\n  };\n\n  for (let i = 0; i < lines.length; i++) {\n    const line = lines[i];\n    let m;\n\n    const cb = line.match(/^\\u0000CB(\\d+)\\u0000$/);\n    if (cb) { flushPara(); html += codeBlocks[Number(cb[1])]; continue; }\n\n    m = line.match(/^(#{1,6})\\s+(.*)$/);\n    if (m) {\n      flushPara();\n      const lvl = m[1].length;\n      html += '<h' + lvl + '>' + renderInline(m[2]) + '</h' + lvl + '>';\n      continue;\n    }\n\n    if (/^\\s*(-{3,}|\\*{3,}|_{3,})\\s*$/.test(line)) { flushPara(); html += '<hr>'; continue; }\n\n    if (/^\\s*\\|.*\\|\\s*$/.test(line)) {\n      flushPara();\n      const tbl = [];\n      while (i < lines.length && /^\\s*\\|.*\\|\\s*$/.test(lines[i])) { tbl.push(lines[i]); i++; }\n      i--;\n      html += renderTable(tbl);\n      continue;\n    }\n\n    if (/^\\s*>\\s?/.test(line)) {\n      flushPara();\n      const quote = [];\n      while (i < lines.length && /^\\s*>\\s?/.test(lines[i])) {\n        quote.push(lines[i].replace(/^\\s*>\\s?/, ''));\n        i++;\n      }\n      i--;\n      html += '<blockquote>' + renderMarkdown(quote.join('\\n'), codeBlocks) + '</blockquote>';\n      continue;\n    }\n\n    if (/^\\s*[-*+]\\s+/.test(line)) {\n      flushPara();\n      const items = [];\n      while (i < lines.length && /^\\s*[-*+]\\s+/.test(lines[i])) {\n        items.push('<li>' + renderInline(lines[i].replace(/^\\s*[-*+]\\s+/, '')) + '</li>');\n        i++;\n      }\n      i--;\n      html += '<ul>' + items.join('') + '</ul>';\n      continue;\n    }\n\n    if (/^\\s*\\d+[.)]\\s+/.test(line)) {\n      flushPara();\n      const items = [];\n      while (i < lines.length && /^\\s*\\d+[.)]\\s+/.test(lines[i])) {\n        items.push('<li>' + renderInline(lines[i].replace(/^\\s*\\d+[.)]\\s+/, '')) + '</li>');\n        i++;\n      }\n      i--;\n      html += '<ol>' + items.join('') + '</ol>';\n      continue;\n    }\n\n    if (/^\\s*$/.test(line)) { flushPara(); continue; }\n\n    para.push(line);\n  }\n  flushPara();\n  return html;\n}\n\nfunction splitCells(row) {\n  const s = String(row).trim().replace(/^\\||\\|$/g, '');\n  const out = [];\n  let cur = '';\n  for (let i = 0; i < s.length; i++) {\n    if (s.charAt(i) === '\\\\' && s.charAt(i + 1) === '|') { cur += '|'; i++; continue; }\n    if (s.charAt(i) === '|') { out.push(cur); cur = ''; continue; }\n    cur += s.charAt(i);\n  }\n  out.push(cur);\n  return out.map((c) => c.trim().replace(/[ \\t]+/g, ' '));\n}\n\nfunction renderTable(rows) {\n  const data = [];\n  for (let i = 0; i < rows.length; i++) {\n    const cells = splitCells(rows[i]);\n    if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;\n    data.push(cells);\n  }\n  if (!data.length) return '';\n  const head = data[0];\n  let h = '<table><thead><tr>';\n  for (let c = 0; c < head.length; c++) h += '<th>' + (renderInline(head[c]) || '<br>') + '</th>';\n  h += '</tr></thead><tbody>';\n  for (let r = 1; r < data.length; r++) {\n    h += '<tr>';\n    for (let c = 0; c < head.length; c++) {\n      const v = data[r][c] === undefined ? '' : data[r][c];\n      h += '<td>' + (renderInline(v) || '<br>') + '</td>';\n    }\n    h += '</tr>';\n  }\n  return h + '</tbody></table>';\n}\n\n/* ==================== API ==================== */\nfunction api(path, options) {\n  const opts = Object.assign({}, options || {}, { credentials: 'same-origin' });\n  opts.headers = Object.assign({ 'Content-Type': 'application/json' }, (options && options.headers) || {});\n  return fetch(path, opts).then((res) =>\n    res.json().catch(() => ({})).then((data) => {\n      if (!res.ok) {\n        const err = new Error(data.error || ('请求失败 (' + res.status + ')'));\n        err.status = res.status;\n        if (res.status === 401 && path !== '/api/login') {\n          showLoginView('登录已过期, 请重新登录');\n        }\n        throw err;\n      }\n      return data;\n    })\n  );\n}\n\nfunction showLoginView(msg) {\n  state.notes = [];\n  state.current = null;\n  state.dirty = false;\n  el.appView.classList.add('hidden');\n  el.loginView.classList.remove('hidden');\n  el.loginBtn.disabled = false;\n  el.loginBtn.textContent = '登 录';\n  el.loginError.textContent = msg || '';\n  setDocTitle('');\n}\n\nfunction showAppView() {\n  el.loginView.classList.add('hidden');\n  el.appView.classList.remove('hidden');\n  el.loginError.textContent = '';\n}\n\n/* ==================== 主题(深色 / 浅色) ==================== */\nfunction currentTheme() {\n  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';\n}\n\nfunction applyTheme(t) {\n  document.documentElement.dataset.theme = t;\n  try { localStorage.setItem('cfn-theme', t); } catch (e) { /* 忽略 */ }\n}\n\nel.themeToggle.addEventListener('click', () => {\n  applyTheme(currentTheme() === 'dark' ? 'light' : 'dark');\n});\n\n/* ==================== 登录 / 登出 ==================== */\nfunction shakeLoginCard() {\n  el.loginForm.classList.remove('shake');\n  void el.loginForm.offsetWidth; // 重启动画\n  el.loginForm.classList.add('shake');\n}\n\nel.togglePwd.addEventListener('click', () => {\n  const revealing = el.loginPassword.type === 'password';\n  el.loginPassword.type = revealing ? 'text' : 'password';\n  el.togglePwd.classList.toggle('revealed', revealing);\n  el.togglePwd.setAttribute('aria-label', revealing ? '隐藏密码' : '显示密码');\n  el.loginPassword.focus();\n});\n\nel.loginForm.addEventListener('submit', (e) => {\n  e.preventDefault();\n  el.loginError.textContent = '';\n  el.loginBtn.disabled = true;\n  el.loginBtn.textContent = '登录中…';\n  api('/api/login', {\n    method: 'POST',\n    body: JSON.stringify({\n      username: el.loginUsername.value.trim(),\n      password: el.loginPassword.value\n    })\n  }).then((data) => {\n    el.loginPassword.value = '';\n    el.togglePwd.classList.remove('revealed');\n    el.loginPassword.type = 'password';\n    return bootApp(data.username);\n  }).catch((err) => {\n    el.loginError.textContent = err.message;\n    el.loginBtn.disabled = false;\n    el.loginBtn.textContent = '登 录';\n    shakeLoginCard();\n  });\n});\n\nel.logoutBtn.addEventListener('click', () => {\n  const done = state.dirty ? saveCurrent() : Promise.resolve();\n  done.then(() => api('/api/logout', { method: 'POST' }))\n    .catch(() => {})\n    .then(() => {\n      showLoginView('');\n      setDocTitle('');\n      toast('已退出登录');\n    });\n});\n\n/* ==================== 笔记 ==================== */\nfunction bootApp(username) {\n  showAppView();\n  el.userName.textContent = username || '';\n  return loadNotes();\n}\n\nfunction loadNotes() {\n  return api('/api/notes').then((data) => {\n    state.notes = data.notes || [];\n    renderList();\n  }).catch((err) => toast(err.message, 'error'));\n}\n\nfunction openNote(id) {\n  const mobile = window.matchMedia('(max-width: 760px)').matches;\n  if (state.current && state.current.id === id) {\n    if (mobile) el.appView.classList.add('show-editor');\n    return;\n  }\n  const load = () => api('/api/notes/' + encodeURIComponent(id)).then((data) => {\n    state.current = data.note;\n    state.dirty = false;\n    fillEditor();\n    renderList();\n    if (mobile) el.appView.classList.add('show-editor');\n  }).catch((err) => toast(err.message, 'error'));\n\n  if (state.dirty) {\n    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }\n    saveCurrent().then(load);\n  } else {\n    load();\n  }\n}\n\nfunction fillEditor() {\n  const n = state.current;\n  el.emptyState.classList.add('hidden');\n  el.editorWrap.classList.remove('hidden');\n  el.title.value = n.title || '';\n  el.tags.value = (n.tags || []).join(', ');\n  el.content.innerHTML = n.content ? renderMarkdown(n.content) : '';\n  updateWordCount();\n  updateMeta();\n  updateSaveStatus(n.updatedAt ? '已保存 ' + formatTime(n.updatedAt) : '尚未保存', 'saved');\n  setDocTitle(n.title || '无标题笔记');\n}\n\nlet saveTimer = null;\n\nfunction scheduleSave() {\n  state.dirty = true;\n  updateSaveStatus('未保存的更改', 'dirty');\n  if (saveTimer) clearTimeout(saveTimer);\n  saveTimer = setTimeout(saveCurrent, 1200);\n}\n\nfunction saveCurrent() {\n  if (!state.current || !state.dirty) return Promise.resolve();\n  const id = state.current.id;\n  const payload = {\n    title: el.title.value,\n    content: htmlToMarkdown(el.content),\n    tags: parseTags(el.tags.value)\n  };\n  updateSaveStatus('保存中…', 'saving');\n  return api('/api/notes/' + encodeURIComponent(id), {\n    method: 'PUT',\n    body: JSON.stringify(payload)\n  }).then((data) => {\n    state.dirty = false;\n    state.current = data.note;\n    updateSaveStatus('已保存 ' + formatTime(data.note.updatedAt), 'saved');\n    updateMeta();\n    setDocTitle(data.note.title || '无标题笔记');\n    const idx = state.notes.findIndex((n) => n.id === id);\n    const meta = {\n      id: data.note.id,\n      title: data.note.title,\n      snippet: makeSnippet(data.note.content),\n      tags: data.note.tags,\n      createdAt: data.note.createdAt,\n      updatedAt: data.note.updatedAt\n    };\n    if (idx === -1) state.notes.unshift(meta); else state.notes[idx] = meta;\n    renderList();\n  }).catch((err) => {\n    updateSaveStatus('保存失败', 'error');\n    toast('保存失败: ' + err.message, 'error');\n  });\n}\n\nfunction newNote() {\n  const create = () => api('/api/notes', {\n    method: 'POST',\n    body: JSON.stringify({ title: '', content: '', tags: [] })\n  }).then((data) => {\n    state.notes.unshift({\n      id: data.note.id,\n      title: data.note.title,\n      snippet: '',\n      tags: data.note.tags,\n      createdAt: data.note.createdAt,\n      updatedAt: data.note.updatedAt\n    });\n    openNote(data.note.id);\n    setTimeout(() => el.title.focus(), 0);\n  }).catch((err) => toast(err.message, 'error'));\n\n  if (state.dirty) {\n    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }\n    saveCurrent().then(create);\n  } else {\n    create();\n  }\n}\n\nfunction deleteNote() {\n  const n = state.current;\n  if (!n) return;\n  if (!window.confirm('确定删除「' + (n.title || '无标题笔记') + '」吗? 删除后不可恢复。')) return;\n  api('/api/notes/' + encodeURIComponent(n.id), { method: 'DELETE' })\n    .then(() => {\n      state.notes = state.notes.filter((x) => x.id !== n.id);\n      state.current = null;\n      state.dirty = false;\n      el.editorWrap.classList.add('hidden');\n      el.emptyState.classList.remove('hidden');\n      el.appView.classList.remove('show-editor');\n      renderList();\n      setDocTitle('');\n      toast('已删除');\n    })\n    .catch((err) => toast(err.message, 'error'));\n}\n\nfunction updateSaveStatus(text, kind) {\n  el.saveText.textContent = text;\n  el.saveStatus.className = 'save-status' + (kind ? ' is-' + kind : '');\n}\n\nfunction updateMeta() {\n  const n = state.current;\n  if (!n) return;\n  el.noteMeta.textContent = '创建于 ' + formatTime(n.createdAt) +\n    ' · 更新于 ' + formatTime(n.updatedAt || n.createdAt);\n}\n\nfunction updateWordCount() {\n  const chars = (el.content.textContent || '').replace(/\\s/g, '').length;\n  el.wordCount.textContent = chars + ' 字';\n}\n\n/* ==================== Markdown 工具栏 (所见即所得) ==================== */\nconst FMT_EXEC = {\n  bold: 'bold', italic: 'italic', strike: 'strikeThrough',\n  ul: 'insertUnorderedList', ol: 'insertOrderedList', hr: 'insertHorizontalRule'\n};\nconst FMT_BLOCK = { h1: 'h1', h2: 'h2', h3: 'h3', quote: 'blockquote', codeblock: 'pre' };\n\nfunction afterContentEdit() {\n  scheduleSave();\n  updateWordCount();\n}\n\nfunction ensureCaret() {\n  const box = el.content;\n  box.focus();\n  const sel = window.getSelection();\n  if (sel && sel.rangeCount && box.contains(sel.anchorNode)) return sel;\n  const range = document.createRange();\n  range.selectNodeContents(box);\n  range.collapse(false);\n  if (sel) { sel.removeAllRanges(); sel.addRange(range); }\n  return sel;\n}\n\nfunction insertHtml(html) {\n  if (!document.execCommand('insertHTML', false, html)) {\n    document.execCommand('insertText', false, html);\n  }\n}\n\nfunction buildTableHtml(cols, rows) {\n  let h = '<table><thead><tr>';\n  for (let c = 1; c <= cols; c++) h += '<th>表头' + c + '</th>';\n  h += '</tr></thead><tbody>';\n  for (let r = 1; r <= rows; r++) {\n    h += '<tr>';\n    for (let c = 1; c <= cols; c++) h += '<td><br></td>';\n    h += '</tr>';\n  }\n  return h + '</tbody></table><p><br></p>';\n}\n\nfunction looksLikeMarkdown(t) {\n  const s = String(t || '');\n  if (s.indexOf('**') !== -1 || s.indexOf('__') !== -1 || s.indexOf('~~') !== -1) return true;\n  if (s.indexOf('`') !== -1 || s.indexOf('![') !== -1 || s.indexOf('](') !== -1) return true;\n  return /(^|\\n)\\s*(#{1,6}\\s|>\\s?|[-*+]\\s|\\d+[.)]\\s|\\|.*\\||-{3,}|\\*{3,})/.test(s);\n}\n\nfunction mdPasteHtml(text) {\n  const block = /\\n/.test(text) || /^\\s*(#{1,6}\\s|>\\s?|[-*+]\\s|\\d+[.)]\\s|\\|.*\\|)/.test(text);\n  return block ? renderMarkdown(text) : renderInline(text);\n}\n\nfunction handlePaste(e) {\n  if (!state.current) return;\n  const dt = e.clipboardData;\n  if (!dt) return;\n  const text = dt.getData('text/plain') || '';\n  if (!text.trim() || !looksLikeMarkdown(text)) return;\n  const html = dt.getData('text/html') || '';\n  if (/<(b|strong|i|em|h[1-6]|ul|ol|li|pre|code|table|blockquote|a)\\b/i.test(html)) return;\n  e.preventDefault();\n  ensureCaret();\n  insertHtml(mdPasteHtml(text));\n  afterContentEdit();\n}\n\nfunction applyFormat(kind) {\n  if (!state.current) return;\n  ensureCaret();\n  if (FMT_EXEC[kind]) {\n    document.execCommand(FMT_EXEC[kind], false, null);\n  } else if (FMT_BLOCK[kind]) {\n    document.execCommand('formatBlock', false, FMT_BLOCK[kind]);\n  } else if (kind === 'code') {\n    const sel = window.getSelection();\n    const text = (sel && !sel.isCollapsed) ? sel.toString() : '代码';\n    insertHtml('<code>' + escapeHtml(text) + '</code>');\n  } else if (kind === 'link') {\n    const sel = window.getSelection();\n    const text = (sel && !sel.isCollapsed) ? sel.toString() : '链接文字';\n    const url = window.prompt('请输入链接地址', 'https://');\n    if (!url) return;\n    insertHtml('<a href=\"' + escapeHtml(url) + '\">' + escapeHtml(text) + '</a>');\n  } else if (kind === 'image') {\n    const url = window.prompt('请输入图片地址', 'https://');\n    if (!url) return;\n    insertHtml('<img src=\"' + escapeHtml(url) + '\" alt=\"图片\">');\n  } else if (kind === 'table') {\n    const spec = window.prompt('请输入表格尺寸 (行 x 列, 如 3x4)', '3x3');\n    if (!spec) return;\n    const m = String(spec).match(/(\\d+)\\D+(\\d+)/);\n    const rows = Math.min(Math.max(m ? Number(m[1]) : 3, 1), 30);\n    const cols = Math.min(Math.max(m ? Number(m[2]) : 3, 1), 12);\n    insertHtml(buildTableHtml(cols, rows));\n  } else {\n    return;\n  }\n  afterContentEdit();\n}\n\n/* ==================== 编辑器内容(HTML) -> Markdown ==================== */\nfunction mdInline(node) {\n  let out = '';\n  const kids = node.childNodes;\n  for (let i = 0; i < kids.length; i++) {\n    const c = kids[i];\n    if (c.nodeType === 3) {\n      out += c.nodeValue.replace(/\\u00a0/g, ' ').replace(/[ \\t]*\\n[ \\t]*/g, ' ');\n      continue;\n    }\n    if (c.nodeType !== 1) continue;\n    const tag = c.tagName.toLowerCase();\n    const inner = mdInline(c);\n    if (tag === 'br') { out += '\\n'; }\n    else if (tag === 'strong' || tag === 'b') { out += inner.trim() ? '**' + inner + '**' : ''; }\n    else if (tag === 'em' || tag === 'i') { out += inner.trim() ? '*' + inner + '*' : ''; }\n    else if (tag === 'del' || tag === 's' || tag === 'strike') { out += inner.trim() ? '~~' + inner + '~~' : ''; }\n    else if (tag === 'code') { out += inner.trim() ? '`' + inner + '`' : ''; }\n    else if (tag === 'a') { out += inner.trim() ? '[' + inner + '](' + (c.getAttribute('href') || '') + ')' : ''; }\n    else if (tag === 'img') { out += '![' + (c.getAttribute('alt') || '') + '](' + (c.getAttribute('src') || '') + ')'; }\n    else if (tag === 'span') {\n      const st = c.style || {};\n      if (st.fontWeight === 'bold' || st.fontWeight === '700') out += inner.trim() ? '**' + inner + '**' : '';\n      else if (st.fontStyle === 'italic') out += inner.trim() ? '*' + inner + '*' : '';\n      else if ((st.textDecoration || '').indexOf('line-through') !== -1) out += inner.trim() ? '~~' + inner + '~~' : '';\n      else out += inner;\n    }\n    else { out += inner; }\n  }\n  return out;\n}\n\nfunction blockToMd(parent, sink) {\n  for (let i = 0; i < parent.childNodes.length; i++) {\n    const c = parent.childNodes[i];\n    if (c.nodeType === 3) {\n      const t = c.nodeValue.replace(/\\u00a0/g, ' ').replace(/[ \\t]*\\n[ \\t]*/g, ' ').trim();\n      if (t) sink.push(t);\n      continue;\n    }\n    if (c.nodeType !== 1) continue;\n    const tag = c.tagName.toLowerCase();\n    if (/^h[1-6]$/.test(tag)) { sink.push('#'.repeat(Number(tag.charAt(1))) + ' ' + mdInline(c).trim()); }\n    else if (tag === 'hr') { sink.push('---'); }\n    else if (tag === 'pre') { sink.push('```\\n' + c.textContent.replace(/\\u00a0/g, ' ').replace(/^\\n+|\\n+$/g, '') + '\\n```'); }\n    else if (tag === 'blockquote') {\n      const q = [];\n      blockToMd(c, q);\n      sink.push(q.map((l) => (l ? '> ' + l : '>')).join('\\n'));\n    }\n    else if (tag === 'ul' || tag === 'ol') {\n      const items = c.children;\n      const ls = [];\n      for (let j = 0; j < items.length; j++) {\n        if (items[j].tagName.toLowerCase() !== 'li') continue;\n        ls.push((tag === 'ol' ? (ls.length + 1) + '. ' : '- ') + mdInline(items[j]).trim());\n      }\n      sink.push(ls.join('\\n'));\n    }\n    else if (tag === 'table') {\n      const trs = c.querySelectorAll('tr');\n      const rows = [];\n      for (let r = 0; r < trs.length; r++) {\n        const cs = trs[r].querySelectorAll('th,td');\n        const cells = [];\n        for (let k = 0; k < cs.length; k++) {\n          cells.push(mdInline(cs[k]).trim().replace(/\\|/g, '\\\\|').replace(/[ \\t]+/g, ' '));\n        }\n        rows.push('| ' + cells.join(' | ') + ' |');\n      }\n      if (rows.length) {\n        const ncol = trs[0].querySelectorAll('th,td').length || 1;\n        rows.splice(1, 0, '| ' + new Array(ncol).fill('---').join(' | ') + ' |');\n        sink.push(rows.join('\\n'));\n      }\n    }\n    else if (tag === 'div' || tag === 'p' || tag === 'section' || tag === 'article') {\n      if (c.querySelector('div,p,section,article,ul,ol,blockquote,pre,table,h1,h2,h3,h4,h5,h6,hr')) blockToMd(c, sink);\n      else sink.push(mdInline(c).trim());\n    }\n    else { sink.push(mdInline(c).trim()); }\n  }\n}\n\nfunction htmlToMarkdown(root) {\n  const out = [];\n  blockToMd(root, out);\n  const text = out.join('\\n').replace(/\\u00a0/g, ' ').replace(/[ \\t]+$/gm, '').replace(/\\n{3,}/g, '\\n\\n').trim();\n  return text ? text + '\\n' : '';\n}\n\n/* ==================== 列表渲染 ==================== */\nfunction renderList() {\n  const scrollTop = el.notesList.scrollTop;\n  const q = state.query.trim().toLowerCase();\n  const items = state.notes.filter((n) => {\n    if (!q) return true;\n    return (n.title || '').toLowerCase().includes(q)\n      || (n.snippet || '').toLowerCase().includes(q)\n      || (n.tags || []).some((t) => t.toLowerCase().includes(q));\n  });\n\n  el.notesCount.textContent = state.notes.length;\n\n  el.notesList.innerHTML = '';\n  if (!items.length) {\n    const li = document.createElement('li');\n    li.className = 'list-empty';\n    li.textContent = q ? '没有匹配的笔记\\n换个关键词试试' : '还没有笔记\\n点击「新建笔记」开始记录吧';\n    li.style.whiteSpace = 'pre-line';\n    el.notesList.appendChild(li);\n    return;\n  }\n\n  items.forEach((n) => {\n    const li = document.createElement('li');\n    li.className = 'note-item' + (state.current && state.current.id === n.id ? ' active' : '');\n\n    const title = document.createElement('div');\n    title.className = 'note-item-title';\n    title.textContent = n.title || '无标题笔记';\n\n    const snippet = document.createElement('div');\n    snippet.className = 'note-item-snippet';\n    snippet.textContent = n.snippet || '无内容';\n\n    const meta = document.createElement('div');\n    meta.className = 'note-item-meta';\n    meta.textContent = relTime(n.updatedAt || n.createdAt || Date.now());\n\n    li.appendChild(title);\n    li.appendChild(snippet);\n    li.appendChild(meta);\n\n    if ((n.tags || []).length) {\n      const tags = document.createElement('div');\n      tags.className = 'note-item-tags';\n      n.tags.slice(0, 3).forEach((t) => {\n        const chip = document.createElement('span');\n        chip.className = 'tag-chip';\n        chip.textContent = t;\n        tags.appendChild(chip);\n      });\n      li.appendChild(tags);\n    }\n\n    li.addEventListener('click', () => openNote(n.id));\n    el.notesList.appendChild(li);\n  });\n\n  el.notesList.scrollTop = scrollTop;\n}\n\n/* ==================== 导出为 Markdown (.md) ==================== */\nfunction safeFileName(title) {\n  const s = String(title || '').trim().replace(/[\\/:*?\"<>|\\s]+/g, '_').replace(/^_+|_+$/g, '');\n  return s.slice(0, 60) || '无标题笔记';\n}\n\nfunction noteToMarkdown(n) {\n  const title = n.title || '无标题笔记';\n  const meta = [];\n  if (n.tags && n.tags.length) meta.push('标签: ' + n.tags.join(', '));\n  meta.push('创建: ' + formatTime(n.createdAt));\n  meta.push('更新: ' + formatTime(n.updatedAt || n.createdAt));\n  return '# ' + title + '\\n\\n' +\n    '<!-- ' + meta.join(' | ') + ' -->\\n\\n' +\n    String(n.content || '').replace(/\\s+$/, '') + '\\n';\n}\n\nfunction downloadFile(filename, text) {\n  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });\n  const a = document.createElement('a');\n  a.href = URL.createObjectURL(blob);\n  a.download = filename;\n  document.body.appendChild(a);\n  a.click();\n  a.remove();\n  setTimeout(() => URL.revokeObjectURL(a.href), 2000);\n}\n\nfunction exportNotes() {\n  api('/api/export').then((data) => {\n    const notes = data.notes || [];\n    const d = new Date();\n    const stamp = d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate());\n    downloadFile('云笔记-' + stamp + '.md', notes.map(noteToMarkdown).join('\\n---\\n\\n'));\n    toast('已导出 ' + notes.length + ' 篇笔记 (.md)');\n  }).catch((err) => toast('导出失败: ' + err.message, 'error'));\n}\n\nfunction downloadCurrentNote() {\n  const n = state.current;\n  if (!n) return;\n  const note = {\n    title: el.title.value,\n    content: htmlToMarkdown(el.content),\n    tags: parseTags(el.tags.value),\n    createdAt: n.createdAt,\n    updatedAt: n.updatedAt || n.createdAt\n  };\n  downloadFile(safeFileName(note.title) + '.md', noteToMarkdown(note));\n  toast('已下载 .md 文件');\n}\n\n/* ==================== 事件绑定 ==================== */\nel.newNoteBtn.addEventListener('click', newNote);\nel.deleteBtn.addEventListener('click', deleteNote);\nel.backBtn.addEventListener('click', () => el.appView.classList.remove('show-editor'));\nel.searchInput.addEventListener('input', () => { state.query = el.searchInput.value; renderList(); });\nel.title.addEventListener('input', scheduleSave);\nel.tags.addEventListener('input', scheduleSave);\nel.content.addEventListener('input', afterContentEdit);\nel.content.addEventListener('paste', handlePaste);\nel.exportBtn.addEventListener('click', exportNotes);\nel.saveNoteBtn.addEventListener('click', downloadCurrentNote);\n\nel.formatToolbar.addEventListener('mousedown', (e) => {\n  if (e.target.closest('button')) e.preventDefault();\n});\nel.formatToolbar.addEventListener('click', (e) => {\n  const btn = e.target.closest('button[data-fmt]');\n  if (btn) applyFormat(btn.getAttribute('data-fmt'));\n});\n\ndocument.addEventListener('keydown', (e) => {\n  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;\n  const key = (e.key || '').toLowerCase();\n  if (key === 's') {\n    e.preventDefault();\n    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }\n    saveCurrent();\n    return;\n  }\n  if (!state.current || e.shiftKey) return;\n  if (key === 'b') { e.preventDefault(); applyFormat('bold'); }\n  else if (key === 'i') { e.preventDefault(); applyFormat('italic'); }\n  else if (key === 'k') { e.preventDefault(); applyFormat('link'); }\n});\n\nwindow.addEventListener('beforeunload', (e) => {\n  if (state.dirty) { e.preventDefault(); e.returnValue = ''; }\n});\n\n// 每分钟刷新一次相对时间\nsetInterval(() => { if (!state.query) renderList(); }, 60000);\n\n/* ==================== 启动: 检查登录态 ==================== */\napi('/api/me')\n  .then((data) => bootApp(data.username))\n  .catch(() => showLoginView(''));\n";
const APP_FAVICON = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 64 64\">\n  <rect x=\"6\" y=\"4\" width=\"38\" height=\"56\" rx=\"8\" fill=\"#3b6ef5\"/>\n  <g fill=\"#ffffff\">\n    <rect x=\"14\" y=\"14\" width=\"22\" height=\"4.5\" rx=\"2.25\" opacity=\"0.95\"/>\n    <rect x=\"14\" y=\"25\" width=\"22\" height=\"4.5\" rx=\"2.25\" opacity=\"0.75\"/>\n    <rect x=\"14\" y=\"36\" width=\"13\" height=\"4.5\" rx=\"2.25\" opacity=\"0.55\"/>\n  </g>\n  <g transform=\"rotate(45 44 46)\">\n    <rect x=\"38\" y=\"26\" width=\"12\" height=\"30\" fill=\"#ffb224\"/>\n    <polygon points=\"38,56 50,56 44,64\" fill=\"#f3e7c8\"/>\n  </g>\n</svg>\n";

export default {
  async fetch(request, env, ctx) {
    try {
      return await handleRequest(request, env);
    } catch (err) {
      console.error('worker error:', err && err.stack ? err.stack : err);
      return json({ error: '服务器内部错误' }, 500);
    }
  }
};

async function handleRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;

  // 登录 / 登出 (无需会话)
  if (path === '/api/login') return handleLogin(request, env);
  if (path === '/api/logout') return handleLogout(request, env);

  // 其余 API 均需登录
  if (path.startsWith('/api/')) {
    if (!env.NOTES_KV) {
      return json({ error: '服务端未绑定 KV 命名空间 NOTES_KV, 请检查 wrangler.toml' }, 500);
    }
    const session = await getSession(env, request);
    if (!session) return json({ error: '未登录或登录已过期' }, 401);
    return handleNotesApi(request, env, path, session);
  }

  // ===== 单文件部署: 前端资源已内联于本脚本 =====
  if (path === '/' || path === '/index.html') {
    return new Response(APP_HTML, { headers: assetHeaders('text/html') });
  }
  if (path === '/app.js') {
    return new Response(APP_JS, { headers: assetHeaders('text/javascript') });
  }
  if (path === '/style.css') {
    return new Response(APP_CSS, { headers: assetHeaders('text/css') });
  }
  if (path === '/favicon.svg') {
    return new Response(APP_FAVICON, { headers: assetHeaders('image/svg+xml', 86400) });
  }

  return new Response(NOT_FOUND_HTML, {
    status: 404,
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}

/* ------------------------- 登录 / 登出 ------------------------- */

async function handleLogin(request, env) {
  if (request.method !== 'POST') return json({ error: '仅支持 POST' }, 405);

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (loginRateLimited(ip)) {
    return json({ error: '登录尝试过于频繁, 请 5 分钟后再试' }, 429);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: '请求体不是合法 JSON' }, 400);
  }

  const username = String(body.username == null ? '' : body.username).trim();
  const password = String(body.password == null ? '' : body.password);
  if (!username || !password) return json({ error: '请输入用户名和密码' }, 400);

  const expectUser = String(env.AUTH_USER || 'admin');
  const expectPass = env.AUTH_PASS == null ? '' : String(env.AUTH_PASS);
  const expectHash = env.AUTH_PASS_HASH == null ? '' : String(env.AUTH_PASS_HASH).toLowerCase().trim();

  // 校验密码: 优先 AUTH_PASS_HASH(SHA-256 十六进制), 否则 AUTH_PASS 明文
  let passOk;
  if (expectHash) {
    passOk = await safeEqual(await sha256Hex(password), expectHash);
  } else if (expectPass) {
    passOk = await safeEqual(await sha256Hex(password), await sha256Hex(expectPass));
  } else {
    return json({ error: '服务端未配置密码: 请设置 AUTH_PASS 或 AUTH_PASS_HASH' }, 500);
  }
  const userOk = await safeEqual(await sha256Hex(username), await sha256Hex(expectUser));

  if (!passOk || !userOk) {
    return json({ error: '用户名或密码错误' }, 401);
  }

  // 创建会话(存 KV, 到期自动过期)
  const token = crypto.randomUUID();
  const ttl = sessionTtl(env);
  await env.NOTES_KV.put(
    SESSION_PREFIX + token,
    JSON.stringify({ username: expectUser, createdAt: Date.now() }),
    { expirationTtl: ttl }
  );

  const secure = new URL(request.url).protocol === 'https:' ? ' Secure;' : '';
  const cookie = SESSION_COOKIE + '=' + encodeURIComponent(token) +
    '; HttpOnly;' + secure + ' SameSite=Strict; Path=/; Max-Age=' + ttl;

  return json({ ok: true, username: expectUser }, 200, { 'Set-Cookie': cookie });
}

async function handleLogout(request, env) {
  const token = readToken(request);
  if (token && env.NOTES_KV) {
    await env.NOTES_KV.delete(SESSION_PREFIX + token);
  }
  return json({ ok: true }, 200, {
    'Set-Cookie': SESSION_COOKIE + '=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'
  });
}

/* ------------------------- 笔记 API ------------------------- */

async function handleNotesApi(request, env, path, session) {
  const method = request.method;

  if (path === '/api/me' && method === 'GET') {
    return json({ username: session.username });
  }

  if (path === '/api/notes') {
    if (method === 'GET') return json({ notes: await fetchNotes(env, false) });
    if (method === 'POST') return createNote(request, env);
    return json({ error: '仅支持 GET / POST' }, 405);
  }

  if (path === '/api/export' && method === 'GET') {
    return json({ exportedAt: new Date().toISOString(), notes: await fetchNotes(env, true) });
  }

  const m = path.match(/^\/api\/notes\/([^/]+)$/);
  if (m && ID_RE.test(m[1])) {
    const id = m[1];
    if (method === 'GET') {
      const note = await readNote(env, id);
      return note ? json({ note }) : json({ error: '笔记不存在' }, 404);
    }
    if (method === 'PUT') return updateNote(request, env, id);
    if (method === 'DELETE') {
      await env.NOTES_KV.delete(NOTE_PREFIX + id);
      return json({ ok: true });
    }
    return json({ error: '仅支持 GET / PUT / DELETE' }, 405);
  }

  return json({ error: '接口不存在' }, 404);
}

async function createNote(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: '请求体不是合法 JSON' }, 400);
  }

  const content = body.content == null ? '' : String(body.content);
  if (content.length > MAX_CONTENT) {
    return json({ error: '内容过长, 上限 ' + MAX_CONTENT + ' 字符' }, 413);
  }

  const now = Date.now();
  const note = {
    id: genId(),
    title: normTitle(body.title),
    content: content,
    tags: normTags(body.tags),
    createdAt: now,
    updatedAt: now
  };
  await env.NOTES_KV.put(NOTE_PREFIX + note.id, JSON.stringify(note));
  return json({ note: note }, 201);
}

async function updateNote(request, env, id) {
  const existing = await readNote(env, id);
  if (!existing) return json({ error: '笔记不存在' }, 404);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: '请求体不是合法 JSON' }, 400);
  }

  if (body.content != null) {
    const content = String(body.content);
    if (content.length > MAX_CONTENT) {
      return json({ error: '内容过长, 上限 ' + MAX_CONTENT + ' 字符' }, 413);
    }
    existing.content = content;
  }
  if (body.title !== undefined) existing.title = normTitle(body.title);
  if (body.tags !== undefined) existing.tags = normTags(body.tags);
  existing.updatedAt = Date.now();

  await env.NOTES_KV.put(NOTE_PREFIX + id, JSON.stringify(existing));
  return json({ note: existing });
}

async function fetchNotes(env, full) {
  const out = [];
  let cursor;
  do {
    const list = await env.NOTES_KV.list({ prefix: NOTE_PREFIX, cursor: cursor, limit: 1000 });
    const raws = await kvGetMany(env.NOTES_KV, list.keys.map((k) => k.name));
    for (const raw of raws) {
      const note = parseNote(raw);
      if (!note) continue;
      out.push(full ? note : {
        id: note.id,
        title: note.title,
        snippet: makeSnippet(note.content),
        tags: note.tags,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt
      });
    }
    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor);

  out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return out;
}

async function readNote(env, id) {
  return parseNote(await env.NOTES_KV.get(NOTE_PREFIX + id));
}

/* ------------------------- 会话 ------------------------- */

function sessionTtl(env) {
  const hours = Number(env.SESSION_TTL_HOURS);
  const h = Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_TTL_HOURS;
  return Math.floor(h * 3600);
}

async function getSession(env, request) {
  const token = readToken(request);
  if (!token) return null;
  const raw = await env.NOTES_KV.get(SESSION_PREFIX + token);
  if (!raw) return null;
  try {
    const s = JSON.parse(raw);
    return s && typeof s === 'object' ? { username: String(s.username || '') } : null;
  } catch {
    return null;
  }
}

function readToken(request) {
  const cookie = request.headers.get('Cookie') || '';
  const m = cookie.match(/(?:^|;\s*)cfn_session=([^;]+)/);
  if (m) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return m[1];
    }
  }
  const auth = request.headers.get('Authorization') || '';
  if (auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }
  return null;
}

/* ------------------------- 工具 ------------------------- */

function genId() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}

function normTitle(t) {
  const s = t == null ? '' : String(t).trim();
  return s.slice(0, MAX_TITLE);
}

function normTags(tags) {
  if (!Array.isArray(tags)) return [];
  const out = [];
  for (const t of tags) {
    const s = String(t).trim().slice(0, TAG_MAX_LEN);
    if (s && out.indexOf(s) === -1) out.push(s);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

function parseNote(raw) {
  if (!raw) return null;
  try {
    const n = JSON.parse(raw);
    if (!n || typeof n !== 'object' || !n.id) return null;
    return {
      id: String(n.id),
      title: typeof n.title === 'string' ? n.title.slice(0, MAX_TITLE) : '',
      content: typeof n.content === 'string' ? n.content : '',
      tags: Array.isArray(n.tags) ? n.tags.map(String).slice(0, MAX_TAGS) : [],
      createdAt: Number(n.createdAt) || Date.now(),
      updatedAt: Number(n.updatedAt) || Number(n.createdAt) || Date.now()
    };
  } catch {
    return null;
  }
}

function makeSnippet(content) {
  return String(content || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#>*`_~|[\]()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
}

async function kvGetMany(kv, keys, batchSize) {
  const size = batchSize || 25;
  const out = [];
  for (let i = 0; i < keys.length; i += size) {
    const slice = keys.slice(i, i + size);
    const values = await Promise.all(slice.map((k) => kv.get(k)));
    for (const v of values) out.push(v);
  }
  return out;
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function safeEqual(a, b) {
  // 先各自再做一次 SHA-256, 保证等长, 再逐位异或比较(近似常量时间)
  const ha = await sha256Hex(a);
  const hb = await sha256Hex(b);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) {
    diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  }
  return diff === 0;
}

function loginRateLimited(ip) {
  const now = Date.now();
  let rec = loginAttempts.get(ip);
  if (!rec || now > rec.resetAt) {
    rec = { count: 0, resetAt: now + LOGIN_WINDOW_MS };
  }
  rec.count += 1;
  loginAttempts.set(ip, rec);
  if (loginAttempts.size > 5000) loginAttempts.clear();
  return rec.count > LOGIN_MAX_ATTEMPTS;
}

function assetHeaders(type, maxAge) {
  return {
    'Content-Type': type + '; charset=utf-8',
    'Cache-Control': maxAge ? 'public, max-age=' + maxAge : 'no-cache, no-store, must-revalidate',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin'
  };
}

function json(data, status, extraHeaders) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    }, extraHeaders || {})
  });
}

const NOT_FOUND_HTML =
  '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
  '<title>404 - 云笔记</title></head>' +
  '<body style="margin:0;min-height:100vh;display:flex;flex-direction:column;' +
  'align-items:center;justify-content:center;font-family:sans-serif;color:#1c2333;background:#f5f6f8">' +
  '<div style="font-size:48px">\u{1F5D2}\uFE0F</div><h1 style="margin:8px 0 4px">404</h1>' +
  '<p style="color:#7a8499;margin:0 0 16px">页面不存在</p>' +
  '<a href="/" style="color:#3b6ef5;text-decoration:none">返回云笔记</a></body></html>';
