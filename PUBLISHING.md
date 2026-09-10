# 发布与使用 npm 包

npm 包 `@claudebuddy/claudebuddy-agent-sdk` 已发布到两个平台：

| 平台 | registry | 特点 |
|------|----------|------|
| **npmjs（主，推荐）** | `https://registry.npmjs.org/` | 公共，**任何人 `npm install` 无需登录/token** |
| GitHub Packages（可选） | `https://npm.pkg.github.com/` | 拉取需 GitHub token（即使包 public） |

本文档说明：如何发布新版本、如何在项目里安装使用。

---

## 1. 在项目里使用（安装 / import）

**npmjs 方式（零配置，推荐）**——无需任何 `.npmrc` / token / 登录：

```bash
npm install @claudebuddy/claudebuddy-agent-sdk
# 或指定版本
npm install @claudebuddy/claudebuddy-agent-sdk@0.5.0
```

> 默认走官方 npm registry。若你的环境把默认 registry 换成了镜像（如 `npmmirror`），
> 可显式指定：`npm install @claudebuddy/claudebuddy-agent-sdk --registry=https://registry.npmjs.org/`

代码里使用：

```ts
import { createAgent, query, SpillStore } from '@claudebuddy/claudebuddy-agent-sdk'

const agent = createAgent({
  model: 'claude-sonnet-4-6',
  goal: { enabledOnQuery: true, maxGoalRounds: 8 }, // 任务式自治
  spill: { enabledFor: ['get-data'] },               // 超大工具结果落盘
})

for await (const ev of agent.query('处理这批数据')) {
  // ev.type: 'assistant' | 'tool_result' | 'result'
}
```

---

## 2. 发布新版本（维护者）

> 发布前需先在 npmjs 登录：`npm whoami` 应显示 `claudebuddy`。
> 若未登录：`npm login --registry=https://registry.npmjs.org/`（输入用户名/密码/邮箱；
> 若开 2FA 会用浏览器或 OTP 认证）。

### 标准发版步骤

```bash
cd open-agent-sdk-typescript

# 1. 提升版本号（patch / minor / major 按需）
npm version minor      # 0.4.0 -> 0.5.0；或 npm version patch(->0.4.1)

# 2. 发布到 npmjs（自动先构建；若开 2FA 会要求验证码）
npm run publish:npm
# 等价于 npm publish --registry=https://registry.npmjs.org/

# 3. 提交版本号改动并推送
git add package.json package-lock.json
git commit -m "chore: release vX.Y.Z"
git push
```

### 同时发布到 GitHub Packages（可选）

```bash
export GITHUB_TOKEN="ghp_xxx"   # 需含 write:packages（加 delete:packages 才能删）
npm run publish:github
# 等价于 npm publish --registry=https://npm.pkg.github.com/
```

### 发布时提示 2FA/OTP（重要！）

如果你在 npm 开了双因素认证(2FA)，`npm publish` 会要求一次性验证码(OTP)：

- **推荐**：在**自己的终端**跑 `npm publish`，npm 会用浏览器弹出认证或提示你输入 App 里的 6 位码，你本人输入即可通过。
- 若想用 access token 免 OTP：在 npm 设置页生成一个 **Granular** token（限 `@claudebuddy` 包、Automation 级别），配置到 `.npmrc` 后发布无需验证码。

> ⚠️ token 有真实权限，**不要提交进 git**，用完可撤销重建。

---

## 3. 常见问题

**Q：`npm install` 需要 token/登录吗？**
A：从 **npmjs** 安装**不需要**（零配置）。只有从 GitHub Packages 安装才需要 token。

**Q：`npm publish` 报 `401 Unauthorized`？**
A：未登录或 token 失效。先 `npm login` 或正确配置 token。

**Q：`npm publish` 报 `403 permission_denied`？**
A：登录的是别的账号，或 token 权限不够（发布需要允许 publish / write）。

**Q：报 `EOTP` / 一直要验证码？**
A：2FA 认证问题。在**自己终端**跑 `npm publish` 完成交互式认证，或改用 Granular Automation token。

**Q：想从 npmjs 撤销/删一个错误版本？**
A：npm 不允许直接删最新版外的版本；可用 `npm unpublish <pkg>@<version> --force`（24 小时内）或操作 npm 后台。发布到 GitHub Packages 的版本可在 GitHub UI 删除。

---

## 4. 安全提醒

- 不要把 npm token、GitHub token 提交进 git（`.npmrc` 已被 `.gitignore` 忽略）。
- token 有真实权限，泄露即风险，建议短有效期 + 定期轮换。
- 优先用**最小权限**（限制到单个包、单个用途）。