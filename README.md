# Arcals Multi-EOA Mint

本地生成资金钱包和多个工作钱包，在 Arc Mainnet 上等额分配原生 USDC，并由工作钱包并发 Mint，直到余额不足下一次 `0.1 USDC + Gas`。

> 本程序会保存私钥并可发送真实主网交易。请先预览命令，只投入可承受损失的资金，绝不要分享 `private/`。

## 准备

需要 Node.js 22.22+、pnpm 10.33，以及 Linux x64/arm64、macOS arm64 或 Windows x64。

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm build
cp multi-eoa.config.example.json multi-eoa.config.json
```

## 使用

命令默认只预览；`init`、`run`、`resume` 只有加 `--execute` 才会创建密钥或签名交易。

```sh
# 1. 创建资金钱包，并记录输出的 fundingAddress
node apps/cli/multi-eoa.mjs init multi-eoa.config.json --execute

# 2. 向 fundingAddress 充值 Arc Mainnet 原生 USDC 后查看方案
node apps/cli/multi-eoa.mjs plan multi-eoa.config.json

# 3. 先预览，再等额分配并开始 Mint
node apps/cli/multi-eoa.mjs run multi-eoa.config.json
node apps/cli/multi-eoa.mjs run multi-eoa.config.json --execute
```

程序会根据 CPU、内存和 `maxWallets` 自动选择 1–12 个工作钱包。每个钱包以启动余额为本次会话的支出上限；余额不足下一次 Mint 和最大 Gas 时停止，因此通常会留下少量余额。

中断后保留 `private/`，使用同一配置恢复：

```sh
node apps/cli/multi-eoa.mjs resume multi-eoa.config.json --execute
node apps/cli/multi-eoa.mjs status multi-eoa.config.json
node apps/cli/multi-eoa.mjs stop multi-eoa.config.json
```

`stop` 只阻止新的签名，已广播的交易仍可能确认。钱包、恢复日志和运行状态都保存在被 Git 忽略的 `private/`；不要同时运行两个实例，也不要复制、提交或分享该目录。

配置示例见 [`multi-eoa.config.example.json`](multi-eoa.config.example.json)。默认配置会保留资金钱包余额，并要求每个工作钱包除首张 Mint 外还有最低 Gas 余量。

## 验证

```sh
pnpm typecheck
pnpm test
```

项目基于 Arcals 官方 MIT 客户端的协议、SDK、合约绑定和 RandomX worker。固定的链上地址、部署信息及 worker 校验值位于 `manifests/arc-mainnet.json`。

## License

[MIT](LICENSE)。RandomX 使用 BSD 3-Clause 许可证。
