# 评测与公平对比

工程回归、语义召回和端到端记忆效果分别报告，不能相加为“准确率”。`eval/smoke.json` 是公开开发样本，只有七个检查，不是盲测集。候选版已记录真实账号端到端运行，见 VALIDATION.md。

## 评测接口

`eval/run.js` 导出 `runSuite({scenarios, createAdapter, timeoutMs})`。每个 scenario 新建独立临时目录；按顺序执行 ingest、ask、forget，最后关闭适配器并清理该目录。适配器只收到 `{text, project, signal}`，不收到 expected/forbidden。任一步异常会停止该场景并列入 errors；未回答计入 unanswered，不从分母消失。截断输出不算通过。

评分先做 NFKC 和大小写归一，要求命中至少一个 expected 且不含任何 forbidden。此评分仅适合可明确检查的事实题；自由回答须人工双人复核，字符串匹配不是通用语义评分。报告保存原始回答和召回文本，只允许使用合成内容并检查后分享。

`eval/adapter.js` 使用生产代码：SQLite 持久提炼 → 本地 BGE 候选 → 同账号模型复核 → 同账号回答；遗忘调用与宿主工具相同的主题删除函数。必须显式传入 `{dir, llm, route:{provider,model}}`；它不搜索真实数据目录或默认凭据。需要在独立 Harness 评测进程中调用，不能装到日常桌面配置中自动运行。完成后由调用方停止语义子进程（`disposeSemantic`）。模型调用会使用账号额度。

## rc.2 效果回归

`eval/quality-development.json` 和 `eval/quality-heldout.json` 各有 10 个场景、51 个问题。覆盖身份与第三方、当前设备、固定活动、饮食、项目 A/B、假设、并存设备、长段叙述、职业变更和主题遗忘。每个场景从空库开始；单轮输入里的多个问题不算独立用户样本。

两份数据在第一次运行前保存哈希。后测集虽然最初未参与调试，但它后来暴露的遗忘问题用于修复，因此最终结果属于**已知样本回归**，不再称独立盲测。失败、超时、未回答和原始回复一起保留，不能只看成功回答的分母。

真实账号报告列出 `calls`、每次调用的用途、答案、召回内容和 `recallMs`；`sourceHashes` 用于核对运行的源码。`recallMs` 包含本地检索和候选复核，不包含生成答案的时间。评测器的回答提示词是固定短模板，没有运行桌面主代理的工具选择流程。

候选复核和主题删除在 deepseek-account 路由下关闭本次调用的长推理，提炼、回答及用户日常模型设置不受影响。其他提供方不传这个专有选项。超时和异常计入失败，不把降级算正确。

最小宿主内调用示例：

```js
import { readFileSync } from 'node:fs'
import { runSuite } from '../eval/run.js'
import { createAdapter } from '../eval/adapter.js'
import { disposeSemantic } from '../lib/semantic.js'

const scenarios = JSON.parse(readFileSync(new URL('../eval/smoke.json', import.meta.url)))
try {
  const report = await runSuite({
    scenarios,
    createAdapter: ({dir}) => createAdapter({dir, llm: ctx.llm,
      route: {provider:'deepseek-account', model:'deepseek-flash'}}),
  })
  // 保存到显式指定的新报告文件；不要输出凭据。
} finally { disposeSemantic() }
```

其他项目可写同一接口的适配模块，导出 `createAdapter({dir})`，返回 ingest/ask/forget/close；ask 返回 `{text, finish:'stop', recalled}`。CLI 运行：

```sh
node eval/cli.mjs --adapter ./my-adapter.mjs --cases ./my-cases.json --out ./NEW-report.json
```

CLI 不覆盖已有报告。适配器属于可信代码，必须审查其只操作传入临时目录；接口隔离答案不是安全沙箱。

## 同场比较规则

1. 固定代码提交、模型/账号通道、嵌入模型、提示预算与模型调用预算；记录时间、调用量、超时、失败和降级。
2. 冻结开发集后再建立独立盲测集，覆盖本人/第三方、临时/长期、明确纠正、遗忘、无依据回答、项目 A/B 和长对话。每个项目使用相同空库与相同输入，不能使用已有个人画像。
3. 对公开样本结果只称 smoke；正式比较至少另设 100 个未参与开发的场景、重复三次，报告均值和范围，保存失败原文。不要临时修改阈值追分。
4. 分开报告事实提炼、纠正、误存、遗忘残留、项目串扰、召回和最终答案；冷启动与热查询延迟分开。自动/人工评分分别标注。
5. 未跑出的项目记作“未测试”。本版未完成与 Cairn、dsh-layered-memory 或 Mem0 的同场盲测，不能声称领先。

默认 CI 只运行确定性回归与评测器自身测试，不会使用账号或调用付费模型。
