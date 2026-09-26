# IndexedDB v1 → v5 迁移演示

纯前端演示：IndexedDB 多版本迁移与异常处理。技术栈：IndexedDB + Web Worker + DOM + Canvas（进度可视化）。无构建步骤。

## 运行

Web Worker 在 `file://` 协议下会被浏览器拦截，需通过 HTTP 访问：

```bash
cd 本目录
python3 -m http.server 8000
# 打开 http://localhost:8000
```

## 演示流程

1. **生成 v1 旧数据**：重建数据库为 v1，写入 300 条 users（含缺 `name` 的遗留记录）+ 500 条 orders（`state` 为数字码）。
2. **迁移到 v5**：Worker 执行结构升级（v1→v5 原子事务）+ 4 个数据迁移步骤（断点续跑），Canvas 实时显示进度。
3. **模拟中断**：迁移中点击，强制终止 Worker；再次迁移会从断点续跑。
4. **注入失败**：勾选后迁移，v4 数据步骤中途抛错，自动回滚该步骤数据。
5. **模拟占用 / 释放占用**：保持一个打开连接，迁移触发 `onblocked` 提示；释放后继续。
6. **演示版本回退**：用 v4 打开已是 v5 的数据库，捕获 `VersionError` 并提示。
7. **强制内存模式**：模拟隐私模式，降级为内存存储，功能正常但不持久化。

## 迁移内容

| 版本 | 结构变更 | 数据转换 |
|------|----------|----------|
| v2 | orders 加 `userId` 索引；新增 products 表 | users 补 `createdAt`；初始化 products |
| v3 | users 加 `email` 唯一索引 | `name` 拆分为 `firstName`/`lastName`，生成唯一 email |
| v4 | 新增 logs 表；users 加 `lastName` 索引 | orders `state`(数字码) → `status`(字符串) |
| v5 | orders 加 `status` 索引；下线 users `name` 索引 | users 计算 `score`（订单数×10）；logs 写入完成记录 |

## 验收标准对照

| 验收标准 | 实现 |
|----------|------|
| v1→v5 迁移成功且数据不丢 | 迁移后自动校验：记录数 + 关键字段完整性，日志输出结果 |
| 迁移中断可续 | 结构升级由浏览器原子提交；数据迁移按步骤写检查点（`__meta`），重跑从断点继续；所有数据步骤幂等 |
| 迁移失败可回滚 | 每个数据步骤执行前快照受影响表到 `__backup`，失败时还原并记录 `rolled-back` 状态 |
| 版本回退有提示 | 捕获 `VersionError`，页面与日志提示升级 |
| 旧数据兼容正确 | 缺字段记录兜底（无 `name` → 生成占位名）；未知 `state` 码兜底为 `pending` |
| 数据库被占用有提示 | `onblocked` 事件 → 页面状态栏 + 日志提示，释放后自动继续 |
| 隐私模式降级不崩 | 打开探测（含超时）失败 → 内存适配器降级，迁移流程照常跑通 |
| 浏览器差异兼容 | `indexedDB` 厂商前缀回退；无 `getAll` 时游标回退；以事务 `oncomplete` 为准；`onversionchange` 主动关闭 |
| 迁移进度可视化准确 | 按记录数估算工作量，分块事务上报进度，Canvas 按单位比例绘制步骤刻度与百分比 |

## 文件结构

- `index.html` — 页面与样式
- `main.js` — 主线程：DOM 交互、Canvas 进度、演示场景
- `migration-worker.js` — Worker：迁移引擎、适配器、检查点/回滚、降级
- `migrations.js` — 共享迁移定义（主线程与 Worker 共用）
