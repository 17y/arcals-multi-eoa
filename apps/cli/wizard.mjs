#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

process.umask(0o077);

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const configPath = resolve(
  process.env.ARCALS_WIZARD_CONFIG ??
    join(repositoryRoot, "multi-eoa.config.json"),
);
const exampleConfigPath = join(repositoryRoot, "multi-eoa.config.example.json");
const cliPath = join(repositoryRoot, "apps/cli/multi-eoa.mjs");
const buildSentinel = join(repositoryRoot, "apps/cli/dist/index.js");
const manifestPath = join(repositoryRoot, "manifests/arc-mainnet.json");

let activeChild = null;

const PROGRESS_INTERVAL_MS = 30_000;
const PROGRESS_MINT_STEP = 5;

function elapsedText(elapsedMs) {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${String(hours)}小时${String(minutes)}分`;
  if (minutes > 0) return `${String(minutes)}分${String(seconds)}秒`;
  return `${String(seconds)}秒`;
}

export class MintProgressSummary {
  constructor(nowMs = Date.now()) {
    this.startedAt = nowMs;
    this.lastPrintedAt = 0;
    this.lastPrintedConfirmed = -1;
    this.wallets = 0;
    this.maximumMints = 0;
    this.confirmed = 0;
    this.finishedWallets = new Set();
    this.retryCount = 0;
    this.started = false;
    this.terminal = false;
  }

  summary(nowMs = Date.now()) {
    const maximum = Math.max(0, this.maximumMints);
    const confirmed = Math.min(Math.max(0, this.confirmed), maximum);
    const remaining = Math.max(0, maximum - confirmed);
    const percent = maximum === 0 ? 0 : Math.floor((confirmed * 100) / maximum);
    return `进度：${String(confirmed)}/${String(maximum)}（${String(percent)}%）｜剩余 ${String(remaining)}｜已结束钱包 ${String(this.finishedWallets.size)}/${String(this.wallets)}｜自动重试 ${String(this.retryCount)}｜运行 ${elapsedText(nowMs - this.startedAt)}`;
  }

  maybeSummary(nowMs, force = false) {
    if (!this.started || this.terminal) return [];
    const timeDue = nowMs - this.lastPrintedAt >= PROGRESS_INTERVAL_MS;
    const mintDue =
      this.confirmed >= this.lastPrintedConfirmed + PROGRESS_MINT_STEP;
    if (!force && !timeDue && !mintDue) return [];
    this.lastPrintedAt = nowMs;
    this.lastPrintedConfirmed = this.confirmed;
    return [this.summary(nowMs)];
  }

  tick(nowMs = Date.now()) {
    return this.maybeSummary(nowMs);
  }

  event(event, nowMs = Date.now()) {
    if (event.state === "RUNNING" && event.fundingWallet === undefined) {
      this.started = true;
      this.startedAt = nowMs;
      this.wallets = Number(event.wallets ?? 0);
      this.maximumMints = Number(event.maximumMints ?? 0);
      this.confirmed = Number(event.confirmedMints ?? 0);
      this.lastPrintedAt = nowMs;
      this.lastPrintedConfirmed = this.confirmed;
      return [
        `Mint 已启动：${String(this.wallets)} 个钱包，最多 ${String(event.maxConcurrency)} 路并发。`,
        this.summary(nowMs),
      ];
    }

    if (event.state === "LANE_RESULT") {
      if (event.ok && event.resultState === "MINT_CONFIRMED") {
        this.confirmed += 1;
        return this.maybeSummary(nowMs);
      }
      if (!event.ok && event.error?.code !== "INSUFFICIENT_FUNDS") {
        const wallet =
          event.index === undefined ? "" : `钱包 ${String(event.index)}：`;
        return [`${wallet}Mint 暂未完成，程序将自动重试或安全停止该钱包。`];
      }
      return [];
    }

    if (event.state === "LANE_RETRY") {
      this.retryCount += 1;
      if (this.retryCount === 1 || this.retryCount % 5 === 0) {
        return [
          `网络或服务暂时不可用，正在自动重试（累计 ${String(this.retryCount)} 次）。`,
        ];
      }
      return [];
    }

    if (event.state === "LANE_COMPLETE") {
      this.finishedWallets.add(event.index);
      return this.maybeSummary(nowMs, true);
    }

    if (["COMPLETE", "NEEDS_ATTENTION", "STOPPED"].includes(event.state)) {
      const results = Array.isArray(event.results) ? event.results : [];
      for (const result of results) {
        if (["COMPLETE", "BALANCE_EXHAUSTED"].includes(result.state)) {
          this.finishedWallets.add(result.index);
        }
      }
      const lines = this.started ? [this.summary(nowMs)] : [];
      this.terminal = true;
      return [...lines, ...describeEvent(event)];
    }

    if (event.state === "STOPPED_ERROR") {
      this.terminal = true;
      return describeEvent(event);
    }

    if (event.lane !== undefined) return [];
    return describeEvent(event);
  }
}

export function nodeVersionSupported(version = process.versions.node) {
  const [major = 0, minor = 0] = version
    .split(".")
    .slice(0, 2)
    .map((part) => Number.parseInt(part, 10));
  return major > 22 || (major === 22 && minor >= 22);
}

export function shouldResume({ workersExist, stateExists }) {
  return workersExist || stateExists;
}

export function workerPlatformKey(
  platform = process.platform,
  architecture = process.arch,
) {
  return `${platform}-${architecture}`;
}

export function platformSupported(
  manifest,
  platform = process.platform,
  architecture = process.arch,
) {
  return Object.hasOwn(
    manifest?.worker?.platforms ?? {},
    workerPlatformKey(platform, architecture),
  );
}

export function describeEvent(event) {
  const wallet = event.index === undefined ? "" : `钱包 ${String(event.index)}`;
  switch (event.state) {
    case "FUNDING_WALLET_CREATED":
      return [
        "资金钱包已创建。",
        `充值地址：${event.fundingAddress}`,
        "网络：Arc Mainnet；资产：原生 USDC。",
      ];
    case "PLAN":
      return [
        `资金地址：${event.fundingAddress ?? "尚未创建"}`,
        `当前余额：${event.fundingBalanceUSDC ?? "—"} USDC`,
        `本机方案：${String(event.walletCount)} 个工作钱包，${String(event.maxConcurrency)} 路并发，${String(event.miningThreads)} 个挖矿线程`,
        event.machine
          ? `机器检测：${String(event.machine.logicalCpus)} CPU / ${String(event.machine.totalMemoryGiB)} GiB 内存`
          : "",
      ].filter(Boolean);
    case "DISTRIBUTION_PREPARED":
      return [
        `分配方案已锁定：${String(event.walletCount)} 个钱包，每个 ${event.amountPerWalletUSDC} USDC。`,
      ];
    case "WORKER_FUNDED":
      return [
        `${wallet} 已到账 ${event.amountUSDC} USDC（${event.transactionHash}）。`,
      ];
    case "RUNNING":
      if (event.fundingWallet !== undefined) break;
      return [
        `Mint 已启动：${String(event.wallets)} 个钱包，最多 ${String(event.maxConcurrency)} 路并发。`,
        `本次最多 Mint ${String(event.maximumMints)} 张；会话截止 ${event.expiresAt}。`,
      ];
    case "LANE_RESULT":
      return event.ok
        ? [
            `${wallet}：${event.resultState}${event.issuedId === null || event.issuedId === undefined ? "" : `，编号 ${String(event.issuedId)}`}`,
          ]
        : [
            `${wallet}：暂未完成，${event.error?.message ?? event.resultState ?? "稍后重试"}`,
          ];
    case "LANE_RETRY":
      return [`${wallet}：网络或服务暂时不可用，程序会自动重试。`];
    case "LANE_COMPLETE":
      return [`${wallet} 已完成，共确认 ${String(event.confirmed)} 张。`];
    case "COMPLETE":
      return ["全部钱包已完成，或余额已不足下一次 Mint。"];
    case "NEEDS_ATTENTION":
      return ["部分钱包需要处理，请先查看状态后再恢复。"];
    case "STOPPED":
      return ["已停止创建新的签名；已广播交易仍可能确认。"];
    case "STOP_REQUESTED":
      return ["停止请求已记录，不会再创建新的签名。"];
    case "STOPPED_ERROR":
      return [`错误：${event.message}`];
    default:
      break;
  }

  if (event.fundingWallet !== undefined && event.workerWallets !== undefined) {
    return [
      `运行状态：${event.state}`,
      `资金钱包：${event.fundingWallet}；工作钱包：${event.workerWallets}；分配：${event.distribution}`,
      `已确认 Mint：${String(event.totalConfirmed ?? 0)}；停止请求：${event.stopRequested ? "是" : "否"}`,
    ];
  }

  if (event.lane !== undefined && event.state !== undefined) {
    return [`钱包 ${String(event.lane)}：${event.state}`];
  }
  return [];
}

function printRule() {
  process.stdout.write("\n────────────────────────────────────────\n");
}

function printTitle() {
  process.stdout.write("\nArcals 多钱包自动 Mint\n");
  process.stdout.write("一个入口完成创建钱包、充值检查、分配和 Mint。\n");
  printRule();
}

function runSetupCommand(command, arguments_) {
  const result = spawnSync(command, arguments_, {
    cwd: repositoryRoot,
    stdio: "inherit",
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${arguments_.join(" ")} 执行失败`);
  }
}

function packageManager() {
  const corepack = spawnSync("corepack", ["--version"], { stdio: "ignore" });
  if (corepack.status === 0) return ["corepack", ["pnpm"]];
  const pnpm = spawnSync("pnpm", ["--version"], { stdio: "ignore" });
  if (pnpm.status === 0) return ["pnpm", []];
  throw new Error(
    "找不到 pnpm/Corepack。请先安装 Node.js 22.22 或更高版本，然后重新打开入口。",
  );
}

function ensureSetup() {
  if (!nodeVersionSupported()) {
    throw new Error(
      `Node.js 版本过低（当前 ${process.versions.node}），需要 22.22 或更高版本。`,
    );
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!platformSupported(manifest)) {
    throw new Error(
      `当前系统不受支持（${workerPlatformKey()}）。支持：macOS Apple Silicon、Windows x64、Linux x64/arm64。`,
    );
  }
  const [command, prefix] = packageManager();
  if (!existsSync(join(repositoryRoot, "node_modules/.modules.yaml"))) {
    process.stdout.write("首次运行：正在安装依赖，请稍候……\n");
    runSetupCommand(command, [...prefix, "install", "--frozen-lockfile"]);
  }
  if (!existsSync(buildSentinel)) {
    process.stdout.write("首次运行：正在编译程序，请稍候……\n");
    runSetupCommand(command, [...prefix, "-r", "--if-present", "build"]);
  }
}

function ensureConfig() {
  if (existsSync(configPath)) return;
  copyFileSync(exampleConfigPath, configPath);
  chmodSync(configPath, 0o600);
}

function localPaths() {
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const base = dirname(configPath);
  const walletStoreDir = resolve(base, config.walletStoreDir);
  const stateDir = resolve(base, config.stateDir);
  return {
    walletStoreDir,
    fundingStoreDir: join(walletStoreDir, "funding"),
    workerStoreDir: join(walletStoreDir, "workers"),
    stateDir,
  };
}

function fundingAddress() {
  const { fundingStoreDir } = localPaths();
  const indexPath = join(fundingStoreDir, "wallets.json");
  if (!existsSync(indexPath)) return null;
  const parsed = JSON.parse(readFileSync(indexPath, "utf8"));
  const address = parsed?.wallets?.[0]?.address;
  return typeof address === "string" && /^0x[a-f0-9]{40}$/u.test(address)
    ? address
    : null;
}

function hasRuntimeState() {
  const { workerStoreDir, stateDir } = localPaths();
  return shouldResume({
    workersExist: existsSync(workerStoreDir),
    stateExists:
      existsSync(join(stateDir, "distribution.json")) ||
      existsSync(join(stateDir, "session.json")),
  });
}

async function runCli(command, execute = false) {
  const arguments_ = [cliPath, command, configPath];
  if (execute) arguments_.push("--execute");
  const child = spawn(process.execPath, arguments_, {
    cwd: repositoryRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });
  activeChild = child;
  const events = [];
  const aggregate =
    execute && (command === "run" || command === "resume")
      ? new MintProgressSummary()
      : null;
  const detailLogPath =
    aggregate === null
      ? null
      : join(localPaths().stateDir, "mint-events.jsonl");
  if (detailLogPath !== null) {
    mkdirSync(dirname(detailLogPath), { recursive: true, mode: 0o700 });
  }
  const progressTimer =
    aggregate === null
      ? null
      : setInterval(() => {
          for (const description of aggregate.tick()) {
            process.stdout.write(`${description}\n`);
          }
        }, 1_000);
  progressTimer?.unref();
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  const closed = new Promise((resolveClose) => {
    child.once("close", (code) => resolveClose(code ?? 1));
  });
  const lines = createInterface({ input: child.stdout });
  for await (const line of lines) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      process.stdout.write(`${line}\n`);
      continue;
    }
    events.push(parsed);
    if (detailLogPath !== null) {
      appendFileSync(
        detailLogPath,
        `${JSON.stringify({ recordedAt: new Date().toISOString(), ...parsed })}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
    }
    const descriptions =
      aggregate === null ? describeEvent(parsed) : aggregate.event(parsed);
    if (descriptions.length === 0) continue;
    for (const description of descriptions) {
      process.stdout.write(`${description}\n`);
    }
  }
  const code = await closed;
  if (progressTimer !== null) clearInterval(progressTimer);
  activeChild = null;
  return { code, events };
}

function positiveDecimal(value) {
  return (
    typeof value === "string" &&
    /^\d+(?:\.\d+)?$/u.test(value) &&
    /[1-9]/u.test(value)
  );
}

async function confirm(question, io) {
  const answer = (await io.question(`${question} [y/N] `)).trim().toLowerCase();
  return answer === "y" || answer === "yes" || answer === "是";
}

async function pause(io) {
  await io.question("\n按回车返回主菜单……");
}

async function guidedStart(io) {
  printRule();
  let address = fundingAddress();
  if (address === null) {
    process.stdout.write(
      "第一步会在本机生成一个资金钱包。私钥只保存在 private/，不会显示或上传。\n",
    );
    if (!(await confirm("现在创建资金钱包吗？", io))) return;
    const created = await runCli("init", true);
    if (created.code !== 0) {
      await pause(io);
      return;
    }
    address = fundingAddress();
  }

  if (hasRuntimeState()) {
    process.stdout.write(
      "\n检测到已经确认的分配记录，将直接从现有工作钱包恢复 Mint，不会再次转账。\n",
    );
    await runCli("status");
    const approval = (await io.question("确认恢复请输入 START："))
      .trim()
      .toUpperCase();
    if (approval !== "START") {
      process.stdout.write("已取消，没有发送交易。\n");
      await pause(io);
      return;
    }
    printRule();
    process.stdout.write("正在恢复原任务……\n");
    await runCli("resume", true);
    await pause(io);
    return;
  }

  process.stdout.write("\n请向下面地址充值 Arc Mainnet 原生 USDC：\n\n");
  process.stdout.write(`${address}\n\n`);
  process.stdout.write("不要充值其他网络或其他资产。充值到账后再继续。\n");
  const next = (
    await io.question("充值完成后按回车检查余额；输入 q 返回菜单：")
  )
    .trim()
    .toLowerCase();
  if (next === "q") return;

  printRule();
  process.stdout.write("正在检查链上余额和机器配置……\n");
  const planResult = await runCli("plan");
  const plan = planResult.events.find((event) => event.state === "PLAN");
  if (
    planResult.code !== 0 ||
    plan === undefined ||
    !positiveDecimal(plan.fundingBalanceUSDC)
  ) {
    if (planResult.code === 0) {
      process.stdout.write("尚未检测到余额，请稍后再试。\n");
    }
    await pause(io);
    return;
  }

  process.stdout.write(
    "\n下一步会创建工作钱包、等额分配 USDC，并发送真实主网 Mint 交易。\n",
  );
  process.stdout.write(
    "程序会持续运行，直到各钱包余额不足下一次 Mint；可随时按 Ctrl+C 请求停止。\n",
  );
  const approval = (await io.question("确认开始请输入 START："))
    .trim()
    .toUpperCase();
  if (approval !== "START") {
    process.stdout.write("已取消，没有发送交易。\n");
    await pause(io);
    return;
  }

  const command = hasRuntimeState() ? "resume" : "run";
  printRule();
  process.stdout.write(
    command === "resume" ? "正在恢复原任务……\n" : "正在启动……\n",
  );
  await runCli(command, true);
  await pause(io);
}

async function showPlan(io) {
  printRule();
  if (fundingAddress() === null) {
    process.stdout.write("资金钱包尚未创建，请先选择“开始或继续”。\n");
  } else {
    process.stdout.write("正在查询链上余额……\n");
    await runCli("plan");
  }
  await pause(io);
}

async function showStatus(io) {
  printRule();
  await runCli("status");
  await pause(io);
}

async function requestStop(io) {
  printRule();
  if (!(await confirm("确认停止创建新的签名吗？", io))) return;
  await runCli("stop");
  await pause(io);
}

async function showSecurity(io) {
  const paths = localPaths();
  printRule();
  process.stdout.write(`配置文件：${configPath}\n`);
  process.stdout.write(`钱包目录：${paths.walletStoreDir}\n`);
  process.stdout.write(`运行状态：${paths.stateDir}\n\n`);
  process.stdout.write(
    "private/ 中包含私钥和恢复记录：不要上传、截图或分享。删除该目录可能永久失去钱包。\n",
  );
  await pause(io);
}

export async function main() {
  ensureSetup();
  ensureConfig();
  const io = createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      printTitle();
      const address = fundingAddress();
      process.stdout.write(
        `资金钱包：${address === null ? "尚未创建" : address}\n\n`,
      );
      process.stdout.write("1. 开始或继续自动流程\n");
      process.stdout.write("2. 查看充值余额和机器方案\n");
      process.stdout.write("3. 查看 Mint 进度\n");
      process.stdout.write("4. 请求安全停止\n");
      process.stdout.write("5. 查看本地文件与安全说明\n");
      process.stdout.write("0. 退出\n\n");
      const choice = (await io.question("请选择：")).trim();
      if (choice === "0") break;
      if (choice === "1") await guidedStart(io);
      else if (choice === "2") await showPlan(io);
      else if (choice === "3") await showStatus(io);
      else if (choice === "4") await requestStop(io);
      else if (choice === "5") await showSecurity(io);
      else process.stdout.write("请输入 0–5。\n");
    }
  } finally {
    io.close();
  }
}

process.on("SIGINT", () => {
  if (activeChild !== null) {
    activeChild.kill("SIGINT");
    return;
  }
  process.stdout.write("\n已退出。\n");
  process.exit(130);
});

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`\n启动失败：${message}\n`);
    process.exitCode = 1;
  });
}
