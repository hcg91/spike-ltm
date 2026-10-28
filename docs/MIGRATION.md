# 迁移和回退

## 操作前

先停止会写源 JSON 的宿主实例。不要通过正在运行的聊天让同一个实例迁移自己；源哈希复核只能发现读取期间发生的变化，不能阻止未来继续写入。

迁移命令必须显式指定 source 和全新 target。默认不创建备份，也不改 JSON；原 JSON 本身就是切换前保留的旧数据。目标存在即拒绝，包括不完整的上次目标。

## 校验和切换

1. 运行 `node scripts/migrate.mjs --source ... --target ...`。
2. 确认 `ok:true`、`integrity:ok`、`foreignKeys:ok`，对照 imported、historicalVersions、statusCounts、unboundImported、profileDeferred。任何数量异常先停止切换。
3. 未绑定项目保留在 SQLite 的 unbound 范围，正常界面/召回不读取；本版不提供猜测归属或自动绑定。
4. 将校验后的库用于目标数据目录的 memory.db，显式设置插件 `storeBackend: sqlite`。由用户启动宿主，先验证保存一条合成标记、重开、修改、删除及项目 A/B 隔离，再用于日常工作。

v1 SQLite 拒绝开启；v2/v3 开发库升级为 v4，重建旧作用域约束和任务表，检查外键后提交。旧开发任务无法验证上下文和令牌，保留 dead 收据，不执行未知负载。当前版本缺表、缺外键或版本字段损坏即拒绝，不假装新库。

## 回退

关闭写入实例，将 storeBackend 改回 json 才会回到保留的旧 JSON。**切换后新增或修改的 SQLite 数据不会自动写回 JSON**；不得把这种回退称为无损。保留 SQLite 文件，明确核对切换后的数据差异后再决定如何处理。不要删除数据库或自动覆盖任一侧。

本版不提供 JSON/SQLite 双写、自动热切换、真实历史聊天批量导入或跨机器同步。
