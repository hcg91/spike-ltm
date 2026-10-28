# 参考项目与取舍

本轮实现没有复制下列项目源码，也没有把研究克隆打入发布包。参考具体设计后在现有架构内独立实现；不把功能数量当效果排名。

| 项目 / 固定参考版本 | 采用的思路 | 本插件的取舍 |
|---|---|---|
| [Cairn](https://github.com/chenhw7/dsh-memory/tree/401a72951a56d90dc38135f57a9439724dd98f72)，MIT | 作用域、词法检索候选、保存来源与变更审计 | 路径绑定项目 UUID；词法仅筛选提炼上下文，注入仍过语义门槛；普通更新不引入审批队列 |
| [dsh-layered-memory](https://github.com/JunNanLYS/dsh-layered-memory/tree/69028fbee43e9950fffecc578430909fc827527e)，MIT | 分离原子事实与画像、按会话组织待提炼数据、持久缓冲 | 使用同库事务队列；维持事实/摘要两层，不增加 L2 场景图或捕获档位 |
| [Mem0 memory-benchmarks](https://github.com/mem0ai/memory-benchmarks) | 分开摄入、召回、回答和评分；保存原始证据 | 评测器隔离答案表，报告未完成和错误；不挪用托管服务分数为本地 OSS 背书 |

依赖：`@huggingface/transformers` 4.3.1（Apache-2.0），其传递依赖由 lockfile 固定并各自保留许可。默认模型 `Xenova/bge-small-zh-v1.5` 来自 Hugging Face，模型权重不随包分发；使用前应检查模型卡当前许可及运行环境。宿主 DeepSeek Harness 不随包分发。
