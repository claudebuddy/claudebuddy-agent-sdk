# 发布与使用 GitHub Packages

本仓库的 npm 包 `@claudebuddy/claudebuddy-agent-sdk` 发布在 GitHub Packages
（`npm.pkg.github.com`）上。本文档说明：

1. 如何生成一个有正确权限的 GitHub Token
2. 如何发布新版本
3. 如何在项目里安装、使用这个包

> 本仓库根目录的 `.npmrc` 不会提交到 git（见 `.gitignore`），避免泄露 token。
> 发布用的配置可参考随附模板 **`.npmrc.example`**。
> 消费方项目（你自己的项目）请按第 3 节自己创建一份 `.npmrc`。

---

## 1. 先搞清：你要哪个用途？

GitHub Packages 的 Token 权限因「用途」而不同，**刻意只给够用的最小权限**：

| 用途 | 需要的权限（scope） | 最低配置 |
|------|--------------------|---------|
| **安装 / 拉取包**（只需要 `npm install`） | `read:packages` | 只勾这一个即可 |
| **发布新版本**（push 包到仓库） | `write:packages` | 发布必需 |
| **删除 / 撤销版本** | `delete:packages` | 错误版本撤回时需要 |

> **安全第一**：如果你只是「在项目里 `npm install`」，请**只勾 `read:packages`**，
> 不要给 `write:packages`。权限越大风险越大，最小权限原则。

---

## 2. 生成 Token 的方法（详细步骤）

### 第 1 步：进入创建页

1. 打开 GitHub，点击右上角**头像**
2. 依次进入：**Settings**（设置）→ 左侧 **Developer settings** → **Personal access tokens** → **Tokens (classic)**
3. 点击 **Generate new token** → **Generate new token (classic)**

> 也可以直接访问：`https://github.com/settings/tokens/new`

### 第 2 步：填写并勾选权限

- **Note**：起个能记住的名字，例如 `npm-install` 或 `npm-publish`
- **Expiration**：按需选择有效期（建议选短一点，到期重生成更安全）

然后**按你的用途**勾选 scopes（在页面下方的 `Select scopes` 区域）：

| 用途 | 勾选 |
|------|------|
| 只安装 | ☑ `read:packages` |
| 发布 | ☑ `read:packages` + ☑ `write:packages` |
| 发布 + 可删版本 | ☑ `read:packages` + ☑ `write:packages` + ☑ `delete:packages` |

### 第 3 步：生成并复制

点击底部的 **Generate token**，会生成一串以 `ghp_` 开头的字符串。
**立刻复制保存**——这个值只显示一次，页面刷新后就看不到了。

---

## 3. 在项目里使用（安装 / import）

### 配置 `.npmrc`

在**你的项目根目录**创建 `.npmrc`（和 `package.json` 同级）：

```ini
@claudebuddy:registry=https://npm.pkg.github.com/
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

> 说明：
> - 第一行告诉 npm：`@claudebuddy` 开头的包走 GitHub Packages
> - 第二行用环境变量 `${GITHUB_TOKEN}` 引用你的 Token，**不要把 Token 明文写进文件**（避免泄露）

### 设置环境变量并安装

```bash
# 把下面的 xxx 换成你生成的 Token
export GITHUB_TOKEN="ghp_xxx"

# 安装
npm install @claudebuddy/claudebuddy-agent-sdk
# 或指定版本
npm install @claudebuddy/claudebuddy-agent-sdk@0.3.0
```

### 代码里使用

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

## 4. 发布新版本（维护者）

> ⚠️ 发布需要 `write:packages`（可选再勾 `delete:packages`）权限的 Token。

### 准备

```bash
export GITHUB_TOKEN="ghp_xxx"   # 发布用的 token，必须含 write:packages
```

本仓库已内置 `.npmrc` 和 `publishConfig`（registry 指向 GitHub Packages、
`access: public`），并且 `npm publish` 会自动触发构建（`prepublishOnly: build`），
所以**直接发布即可，无需手动改配置**。

### 发版步骤

```bash
cd open-agent-sdk-typescript

# 1. 提升版本号（patch / minor / major 按需）
npm version minor   # 0.3.0 -> 0.4.0；或 npm version patch(->0.3.1)

# 2. 发布（自动先构建）
npm publish

# 3. 提交版本号改动并推送
git add package.json package-lock.json
git commit -m "chore: release vX.Y.Z"
git push
```

> `npm version` 会自动改 `package.json` 里的版本号并打一个 git tag。
> 如果没装 `npm version` 的 git 自提交，也可以手动改 `"version"` 字段后提交。

---

## 5. 常见问题

**Q：`npm install` 报 `401 Unauthorized`？**
A：`.npmrc` 里的 `_authToken` 缺失或 Token 过期。确认已 `export GITHUB_TOKEN=...`，
且 Token 至少含 `read:packages`。

**Q：`npm publish` 报 `403 permission_denied`？**
A：Token 缺 `write:packages`。重新生成一个勾选了 `read:packages + write:packages` 的 Token。

**Q：想删掉错误发布的版本？**
A：需要 `delete:packages` 权限。可在 GitHub Web 界面删除，或用 API（见前面权限表）。

**Q：包是 public，为什么还要 Token？**
A：这是 GitHub Packages npm registry 的硬性限制——即使包公开，拉取仍要求认证
（与本 SDK 无关，DeepSeek/微软的类似包也如此）。要用 Token 才能 `npm install`。

---

## 6. 安全提醒

- **不要把 Token 提交进 git**。`.npmrc` 用 `${GITHUB_TOKEN}` 占位而非明文。
- Token 具有真实权限，泄露=泄露对仓库的操作权。建议使用**短有效期** + 定期轮换。
- 不同项目用 `read:packages`，尽量避免共用发布权限的 Token。