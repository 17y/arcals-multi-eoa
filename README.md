# Arcals Multi-EOA Mint

一个入口完成创建钱包、充值检查、自动分配和多钱包 Mint。程序会根据电脑性能选择钱包数量，并持续运行到各钱包余额不足下一次 `0.1 USDC + Gas`。

> 会生成私钥并发送真实 Arc Mainnet 交易。只充值你能承受损失的资金，绝不要分享 `private/`。

## 直接启动

先安装 [Node.js 22.22+](https://nodejs.org/)，然后打开对应入口：

- macOS：双击 `START-MAC.command`
- Windows：双击 `START-WINDOWS.cmd`
- Linux：运行 `./start-linux.sh`
- 终端通用方式：`pnpm start`

首次启动会自动安装依赖、编译程序并创建本地配置。以后仍使用同一个入口。

向导会依次完成：

1. 在本机创建一个资金钱包，并显示充值地址；
2. 等待用户充值 Arc Mainnet 原生 USDC；
3. 检查余额以及 CPU、内存对应的钱包和并发数量；
4. 再次确认后，创建工作钱包并等额分配 USDC；
5. 自动并发 Mint，直到余额不足下一次 Mint；
6. 中断后从同一入口查看状态、恢复或请求停止。

创建钱包和发送真实交易前都会明确确认。菜单里的余额查询、状态查询和预览不会签名交易。

## 安全

- 钱包、私钥、分配恢复日志和运行账本位于 `private/`，并被 Git 忽略。
- 不要上传、截图、复制或分享 `private/`；删除它可能永久失去钱包。
- `Ctrl+C` 或菜单中的停止只阻止新的签名，已经广播的交易仍可能确认。
- “余额耗尽”表示余额不足下一次 Mint 和最大 Gas，通常会留下少量 USDC。

## 开发验证

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
```

高级命令仍可直接使用 `node apps/cli/multi-eoa.mjs ...`。配置示例见 [`multi-eoa.config.example.json`](multi-eoa.config.example.json)。

## License

[MIT](LICENSE)。RandomX 使用 BSD 3-Clause 许可证。
