# 云笔记 (Cloud Notes) · v1.6

运行在 **Cloudflare Workers** 上的个人云笔记应用：单文件部署、零依赖、无构建步骤，数据保存在 **Cloudflare KV** 中。

前端页面、样式、脚本全部内联在 `_worker.js` 里，由 Worker 直接返回，因此**只需部署一个文件**。

---

## 功能特性

- **所见即所得编辑器**：基于 `contenteditable`，设置格式后立即看到结果（不再是 `**加粗**` 这类源码样式）。
- **常用格式工具栏**：加粗 / 斜体 / 删除线 / 行内代码 / H1–H3 / 无序列表 / 有序列表 / 引用 / 代码块 / 链接 / 图片 / **表格** / 分割线。
- **插入表格**：点「表格」按钮，按 `行x列`（如 `3x4`，默认 `3x3`，上限 30 行 × 12 列）插入带表头的空表格；表格以 Markdown 管道语法存储，重新打开笔记时自动还原。
- **粘贴源码即刻渲染**：把 `**粗体**`、`## 标题`、`- 列表`、`~~删除线~~`、`| 表格 |` 这类 Markdown 源码直接粘进正文，会立即转成对应的富文本效果（加粗、标题、列表…），而不是显示原始符号；若剪贴板本身已带富文本格式，则按浏览器默认行为粘贴。
- **Markdown 存储**：内部统一存 Markdown（`.md`），重开笔记解析还原为富文本。
- **自动保存**：输入停止 1.2 秒后自动保存，`Ctrl / ⌘ + S` 立即保存；顶部有保存状态指示灯。
- **标签与搜索**：按标题 / 内容 / 标签实时筛选。
- **主题切换**：深色 / 浅色，选择记忆在 `localStorage`。
- **导出**：单篇或全部导出为 `.md` 文件。
- **移动端适配**：≤760px 时侧边栏变抽屉，编辑区全屏，工具栏横向可滚动，适配安全区。
- **轻量登录**：用户名 + 密码（密码仅在服务端以 SHA-256 摘要比较），会话存 KV 并带 TTL 自动过期。

---

## 技术架构

| 层 | 说明 |
| --- | --- |
| 运行环境 | Cloudflare Workers（ES Module，`export default { fetch }`） |
| 数据存储 | Cloudflare KV，绑定名必须是 `NOTES_KV` |
| 前端 | 原生 HTML / CSS / JS，内联于 `_worker.js`（`APP_HTML` / `APP_CSS` / `APP_JS` / `APP_FAVICON`） |
| 依赖 | 无第三方依赖，无 npm 包，无打包工具 |

### 目录结构

```
cfnotes/
├── _worker.js    # 全部后端 API + 内联前端（单文件部署）
└── README.md
```

> 说明：`_worker.js` 内含 `/api/*` 路由（后端）与 `/`、`/app.js`、`/style.css`、`/favicon.svg`（前端），因此**不需要配置静态资源目录**，也不需要 `public/`。

---

## 环境变量与绑定

部署前需要配置以下 3 项：

| 名称 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `NOTES_KV` | KV 命名空间绑定 | ✅ 必填 | 存储笔记与会话。**变量名必须一字不差地叫 `NOTES_KV`** |
| `AUTH_USER` | 变量（文本） | 可选 | 登录用户名，默认 `admin` |
| `AUTH_PASS` | 密钥（Secret） | 二选一 | 登录密码明文 |
| `AUTH_PASS_HASH` | 密钥（Secret） | 二选一 | 登录密码的 SHA-256 十六进制摘要（不想存明文时用） |
| `SESSION_TTL_HOURS` | 变量（文本） | 可选 | 会话有效期（小时），默认 `168`（7 天） |

> 密码校验优先级：`AUTH_PASS_HASH` > `AUTH_PASS`。两者都没有时登录接口会返回 500 并提示未配置密码。

### 生成 AUTH_PASS_HASH（可选）

PowerShell（Windows）：

```powershell
$p = '你的密码'
$sha = [System.Security.Cryptography.SHA256]::Create()
([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($p))) -replace '-','').ToLower()
```

Linux / macOS：

```bash
printf '%s' '你的密码' | sha256sum | cut -d' ' -f1
```

> 注意用 `printf '%s'`（不要换行），因为服务端对原始密码字符串做摘要，多一个换行结果就不一致。

---

## 部署步骤

### 方式一：Cloudflare Dashboard 粘贴代码（推荐，最简单）

1. **登录 Cloudflare Dashboard** → 左侧 **Workers & Pages** → **创建应用 / Create** → **Worker**（Start with Hello World）→ 给 Worker 起名，例如 `cfnotes` → **Deploy**。
2. **粘贴代码**：进入该 Worker → 点击 **编辑代码 / Edit code（Quick edit）** → 全选并删除模板内容 → 把本仓库 `_worker.js` 的**全部内容**粘贴进去 → 点击 **Deploy**。
   （该编辑器支持 ES Module 写法，`export default` 可直接使用。若编辑报语法错误，改用下方「方式二」。）
3. **创建 KV 命名空间**：左侧 **存储和数据库 / Storage & Databases** → **KV** → **创建命名空间**，命名为 `cfnotes-notes`（名字随意，只要自己认得）。
4. **绑定 KV 到 Worker**：回到该 Worker → **设置 / Settings** → **绑定 / Bindings** → **添加绑定 / Add binding** → 选择 **KV 命名空间** → **变量名必须填 `NOTES_KV`** → 选择第 3 步创建的命名空间 → 保存。
5. **配置登录凭据**：同一设置页的 **变量和机密 / Variables and Secrets** → 逐条添加：
   - `AUTH_USER` → 类型 **文本** → 值 `admin`（或你自己的用户名）
   - `AUTH_PASS` → 类型 **机密 / Secret** → 值填你的密码
   - （可选）`SESSION_TTL_HOURS` → 类型 **文本** → 值 `720` 表示会话 30 天
   - （可选）如使用摘要方式：`AUTH_PASS_HASH` → 类型 **机密** → 值填上一步生成的 SHA-256
6. **重新部署使配置生效**：Settings 保存后点一次 **Save and Deploy / 部署**。
7. **访问**：浏览器打开 `https://cfnotes.<你的账号子域>.workers.dev`，用第 5 步的用户名 / 密码登录。

### 方式二：Wrangler CLI（本地开发 / 自动化部署）

前置：Node.js ≥ 18，或直接使用 `npx`（无需全局安装）。

1. **创建 `wrangler.toml`**（放在本目录，与 `_worker.js` 同级）：

```toml
name = "cfnotes"
main = "_worker.js"
compatibility_date = "2025-10-01"

# 会话 / KV 等运行时不需要额外 flag

[[kv_namespaces]]
binding = "NOTES_KV"          # 必须与代码中的绑定名一致
id = "<在第 2 步生成的 KV 命名空间 ID>"

[vars]
AUTH_USER = "admin"
# AUTH_PASS 等敏感值不要写在这里，请用 wrangler secret put
```

2. **创建 KV 命名空间**（会输出 `id`，填入上面的 `id` 字段）：

```bash
npx wrangler kv namespace create NOTES_KV
```

3. **登录 Cloudflare**：

```bash
npx wrangler login
```

4. **写入密钥**（会交互式提示输入值）：

```bash
npx wrangler secret put AUTH_PASS
# 如果用摘要方式:
# npx wrangler secret put AUTH_PASS_HASH
```

5. **部署**：

```bash
npx wrangler deploy
```

6. 控制台会输出访问地址（形如 `https://cfnotes.<子域>.workers.dev`），打开即可。

### 本地开发（可选）

1. 创建 `.dev.vars`（**不要提交到版本库**）：

```
AUTH_USER=admin
AUTH_PASS=你的密码
```

2. 启动本地服务（Wrangler 会自动在本地模拟 KV）：

```bash
npx wrangler dev
```

默认监听 `http://127.0.0.1:8787`。

> 本地开发时 KV 数据存在 `.wrangler/` 目录下，与线上数据相互独立。

### 绑定自定义域名（可选）

Worker → **设置 / Settings** → **域和路由 / Domains & Routes** → **添加 / Add** → **自定义域 / Custom Domain** → 填你的域名（该域名需已在同一 Cloudflare 账号下托管）→ 保存。完成后直接用自定义域名访问，Cookie 会自动带 `Secure`。

---

## 使用说明

### 编辑器工具栏

第一排（标题右侧）：`导出`（下载当前笔记 `.md`）、`删除`。

第二排（格式工具栏，从左到右）：

| 按钮 | 作用 | 快捷键 |
| --- | --- | --- |
| B / I / S | 加粗 / 斜体 / 删除线 | `Ctrl+B` / `Ctrl+I` |
| `</>` | 行内代码 | — |
| H1 / H2 / H3 | 标题级别 | — |
| • / 1. | 无序 / 有序列表 | — |
| ❝ / `{ }` | 引用 / 代码块 | — |
| 链接 / 图片 | 插入链接 / 图片（弹框填 URL） | `Ctrl+K`（链接） |
| **表格** | 插入表格（弹框填 `行x列`，如 `3x4`） | — |
| — | 分割线 | — |

其他快捷键：`Ctrl / ⌘ + S` 立即保存。

### 存储格式

笔记正文以 Markdown 保存，表格使用标准管道语法：

```markdown
| 表头1 | 表头2 |
| --- | --- |
| 单元格 | 单元格 |
```

单元格内的 `|` 会自动转义为 `\|`；空单元格在渲染时显示为空白。导出的 `.md` 文件可直接用于 Obsidian、Typora、VS Code 等工具。

---

## API 接口

除 `/api/login`、`/api/logout` 外，其余接口均需登录（Cookie 会话）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/login` | 登录，Body: `{ "username": "...", "password": "..." }`，成功返回 `{ ok, username }` 并下发 `cfn_session` Cookie |
| POST | `/api/logout` | 退出登录，删除会话并清 Cookie |
| GET | `/api/me` | 返回当前登录用户 `{ username }`，未登录返回 401 |
| GET | `/api/notes` | 笔记列表（含摘要，不含正文全文） |
| POST | `/api/notes` | 新建笔记，Body: `{ title, content, tags }`，返回 201 + `{ note }` |
| GET | `/api/notes/:id` | 读取单篇笔记全文 |
| PUT | `/api/notes/:id` | 更新笔记（`title` / `content` / `tags` 均可选） |
| DELETE | `/api/notes/:id` | 删除笔记 |
| GET | `/api/export` | 导出全部笔记（含正文全文），用于备份 / 迁移 |

示例：

```bash
curl -c cookie.txt -X POST https://<你的域名>/api/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"你的密码"}'

curl -b cookie.txt https://<你的域名>/api/notes
```

---

## 数据模型

KV 中的键：

| 键 | 值 | 说明 |
| --- | --- | --- |
| `note:<id>` | `{ id, title, content, tags, createdAt, updatedAt }` | 单篇笔记，`id` 为随机字符串 |
| `session:<token>` | `{ username, createdAt }` | 会话，带 `expirationTtl`，到期自动删除 |

---

## 限制

| 项目 | 限制 |
| --- | --- |
| 单篇正文长度 | 1,000,000 字符（KV 单键上限 25 MiB） |
| 标题长度 | 200 字符 |
| 标签 | 最多 10 个，每个最多 20 字符 |
| 表格尺寸 | 最多 12 列 × 30 行（工具栏输入） |
| 会话有效期 | 默认 168 小时，可用 `SESSION_TTL_HOURS` 调整 |
| 登录频率 | 同一 IP 5 分钟内最多 10 次尝试（按 isolate 内存计数，尽力而为） |

> Cloudflare 免费版 KV 有每日读写次数与写入频率限制；个人使用足够，但请勿用于高频写入场景。

---

## 安全说明

- 密码不会以明文存储：服务端仅保存 `AUTH_PASS`（Secret）或 `AUTH_PASS_HASH`（SHA-256 摘要），比较使用常量时间比较。
- 会话 Token 为 `crypto.randomUUID()`，存于 KV 并设置 TTL；Cookie 为 `HttpOnly` + `SameSite=Strict`，HTTPS 下自动加 `Secure`。
- 所有 `/api/*` 均校验会话；未登录返回 401，前端自动跳回登录页。
- 本项目为**单用户**设计（一个用户名 + 一个密码），适合个人使用，不建议用于多人协作或多租户场景。

---

## 常见问题排查

| 现象 | 原因与解决 |
| --- | --- |
| 页面提示「服务端未绑定 KV 命名空间 NOTES_KV」 | 绑定名写错或未绑定。到 Worker → Settings → Bindings 确认 KV 绑定的**变量名**恰好是 `NOTES_KV` |
| 登录提示「服务端未配置密码」 | 没有设置 `AUTH_PASS` 或 `AUTH_PASS_HASH`，或设置后未重新部署 |
| 登录提示「用户名或密码错误」 | 检查 `AUTH_USER`（默认 `admin`）；使用 `AUTH_PASS_HASH` 时确认摘要生成方式正确（无多余换行、UTF-8 编码、十六进制） |
| 登录提示「登录尝试过于频繁」 | 5 分钟内失败超过 10 次，等待 5 分钟再试 |
| 修改代码后页面没变 | 静态资源响应为 `no-store`，但仍可能被浏览器缓存；用 `Ctrl+F5`（Mac: `Cmd+Shift+R`）强制刷新 |
| `Ctrl+S` 保存，但刷新后内容回退 | 确认保存指示灯为「已保存」；若为「保存失败」通常是 KV 绑定或配额问题，查看 Worker 实时日志 |
| 访问返回 404 | 路径不存在。前端只暴露 `/`、`/app.js`、`/style.css`、`/favicon.svg` 与 `/api/*` |
| 想看运行日志 | Dashboard → 该 Worker → **Logs / 实时日志**；或本地 `npx wrangler tail` |

---

## 版本

当前版本：**v1.6**（页面侧边栏底部与登录页均显示版本号）

## 备份与迁移

- 全量导出：登录后点击侧边栏底部下载图标（导出全部笔记为 `.md`），或直接 `GET /api/export`。
- 迁移：在新环境部署同一个 `_worker.js`（绑定新的 KV），历史数据通过 Markdown 文件重新录入，或使用 Cloudflare KV 的导入 / 导出功能迁移 `note:*` 键值。

## License

个人项目，未附带开源许可证；如需商用请自行补充授权条款。
