# yinkai 的浙江高考物理题库

面向浙江物理选考备考的静态题库：按备考年份、首考／二考、试卷和主题找原题，查看已有原卷答案，组成练习并打印。

公开仓库：[yinkai-dev/zhejiang-physics-bank](https://github.com/yinkai-dev/zhejiang-physics-bank)。

网站：[打开浙江高考物理题库](https://yinkai-dev.github.io/zhejiang-physics-bank/)。

题库覆盖 **历年选考真题** 和 **2025 首考、2025 二考、2026 首考、2026 二考、2027 首考** 五个备考集合，共 **156 卷、2,954 题**。其中正式选考真题 **22 卷、484 题**，覆盖 2015 年 10 月至 2026 年 6 月全部 22 个官方选考考次。其余 134 卷为模拟、联考及诊断等备考试卷。备考分类中的年份表示备考届别，实际考试年月另存。

## 项目文档


| 入口 | 内容 |
| --- | --- |
| [执行计划](docs/执行计划.md) | 日常维护与后续待办 |
| [数据与标签规范](docs/数据与标签规范.md) | 六库结构、年份和考试分类、题目与答案分层、导出与校验合同 |
| [错题诊断与自适应推荐调研](docs/错题诊断与自适应推荐调研.md) | 下一阶段错因推理节点与自适应选题调研 |
| [v1 归档](docs/archive/v1-执行日志.md) | 首版方案、P0–P14 开发记录与上线验收 |
| [试卷目录](metadata/paper-catalog.json) | 六库（历年选考真题 + 五个备考集合）及 156 卷元数据 |

技术路线：本机整理和构建，GitHub 管理代码及可公开的静态产物，GitHub Pages 托管网页。浏览器完成筛选、单题展示与练习清单；独立 PDF 接口复用现有 XeLaTeX 引擎，按选题顺序生成练习卷和原卷答案，保留浏览器打印入口。题库浏览不依赖 PDF 服务。

本机原始题包、审核材料与导入证据保存在 Git 忽略的 `.local/`。`public/data/` 和 `public/images/` 是经过字段白名单检查的公开投影，包含 2,954 道完整题面、2,915 条来源答案（含详解）、39 条 AI 参考答案（全站 2,954/2,954 题 100% 有答案可查）及 4,834 张实际引用图片。仅克隆公开仓库即可构建网站；重新导出真实题库需要另行提供本机来源快照。

## 使用

- 按“备考年份”“备考阶段”、主题、题型、答案状态组合筛选；更多筛选中可选实际考试年份、月份和试卷性质。同一维度多选取并集，不同维度取交集。
- 搜索支持卷名、学校／地区／联盟与题文关键词。可切换试卷或题目视图，URL 保留筛选、排序和页码。
- 单题答案默认折叠；在试卷或题目旁点击“加入练习”，到“我的练习”调序、移除或整卷选入。
- 点击“生成 PDF”取得 XeLaTeX 排版的练习卷，勾选答案开关可同时生成独立原卷答案 PDF。每次最多50题，生成文件保留24小时，请及时下载；持有下载链接的人可访问文件。
- 也可使用“浏览器打印”：等待“已就绪”后打印题目版或末尾附答案版；推荐 A4、关闭浏览器页眉页脚。清单只保存在当前浏览器。

## 开发与更新

需要 Node.js 22.12+（当前使用 Node 24）。

```powershell
npm ci
npm run dev -- --port 5173
npm test
npm run check:math
npm run build
npm run preview -- --port 4173
```

开发和预览入口均使用 `/zhejiang-physics-bank/` 子路径。公式渲染器随站点发布，不依赖外部 CDN。

### 更新题库

题库有新 release 后，在 `main` 上运行一条命令即可把站点和 PDF 服务一起更新：

```powershell
node scripts/publish.mjs status          # 一屏查看本机、站点、PDF 服务是否同一数据版本
node scripts/publish.mjs run --dry-run   # 查看快照差异和当前公开投影的上传计划
node scripts/publish.mjs run             # 正式发布
```

`--dry-run` 只生成计划。需要提前诊断本机构建时可加 `--verify`，正式发布始终校验待部署的产物。正常导出校验本次引用的全部 release，历史归档可用 `node scripts/export-bank.mjs --verify-history` 一并核对。

`run` 依次执行：从题库同步快照并刷新 `metadata/paper-catalog.json` → 导出公开投影 → 数据／公式／接口测试与生产构建 → 与已发布数据对比 → 把缺少的题库 release 安装到 PDF 服务器 → 切换 PDF 服务并用新题真实生成一份 PDF → 提交并推送公开数据 → 等待 Pages 构建 → 验证线上版本。先更新 PDF 服务再发布站点，避免网页上出现暂时无法排版的新题。每一步幂等，中断后重跑会从未完成处继续；运行记录写入 `.local/evidence/publish/`。`--scope pdf` 或 `--scope site` 可只做一侧，`node scripts/publish.mjs rollback-pdf` 把 PDF 服务切回上一版。

不再有写死的卷数题数。验收规则改为：目录元数据、题库 release 与导出结果三者数量一致；已上线的题目只能新增或补上来源答案，若会被移除或内容发生变化，导出和发布都会中止并列出题号，经确认后才可加 `--allow-change`。首页、“关于题库”、页面描述、测试和 PDF 接口的数量均从目录数据生成。

向服务器传输时只上传服务器尚无的文件内容，其余在服务器上从已安装的 release 复用，再整体校验后原子安装；分块可续传。部署只新增 release 目录并切换 PDF 服务自己的指针，不修改原 MCP 服务及其 `active.json`。

本机设置放在不入库的 `.local/publish-config.json`：

```json
{ "source_banks": "<题库 banks 根目录>", "ssh_host": "<~/.ssh/config 中的主机别名>" }
```

单独步骤仍可手动运行：`node scripts/sync-bank.mjs`（同步快照，新卷的年月从卷名 `物理卷-YYMM…` 推得，无法推得时用 `--paper-meta` 提供）、`npm run export`、`npm run check:data`。新机器只要有题库来源和已入库的 `metadata/paper-catalog.json`，同步加导出即可重建完全相同的公开数据。PDF 接口见 [PDF 接口说明](pdf-service/README.md)。main 的网站变更经 Actions 校验并部署 `dist/`；纯文档更新不触发重新部署。

若仓库切换公开／私密后网站出现 404，先在 Settings → Pages 确认站点已启用，发布方式选择 GitHub Actions，再到 Actions → Build and deploy Pages → Run workflow，选择 main 重新部署。免费账户把公开仓库改为私密会使 Pages 自动下线，改回公开后仍需检查发布设置并重新部署，见 [GitHub 可见性说明](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility)。

## 验证与已知问题

- 全量：156 卷／2,954 题、2,915 条来源答案、39 条明确缺失（均附独立标注的 AI 参考答案）、0 条尚未入库，4,834 张引用图片哈希与文件集合一致。
- 公式：38,873 个公式块通过 MathJax 转换检查（0 错误）。
- 首版桌面与手机检查、跨卷 PDF 样本及后续上线验证见 [v1 执行日志](docs/archive/v1-执行日志.md)。
- 浏览器打印为快捷备选，长题可跨页，分页取决于浏览器和纸张设置，不复刻原卷版式。
- 当前独立历年真题库已完整收录 2015.10–2026.06 全部 22 套正式选考真题（484 题），五个备考集合收录 134 套备考卷（老高考理综暂未纳入）；备考卷日期主要从卷名推得，尚未逐卷重新确认；新增题目的分类与转录经 AI 核验，尚未由教师逐题复核。
- 全站 2,954 题已 100% 覆盖答案（其中 2,915 题为原卷来源答案，39 题因原卷无答案提供单独折叠并注明未教师复核的 AI 参考答案，尚未入库已清零）。精细考点与难度尚未标注。
- 首次访问包含按需加载的题图，速度受 GitHub Pages 线路影响；清单不跨设备同步。PDF服务为单任务排版、有限队列，忙时需等待；50题上限和24小时保留期适用于首版。
- PDF 服务的多日运行、证书自动续期和大量同时访问尚未经过长期观察；首次部署及当前线路测试不代表所有网络均稳定。

工程验证不等于教师审核或教学效果证明。题目内容和依赖声明见网站“关于题库”及 [第三方声明](public/THIRD_PARTY_NOTICES.txt)。

参考项目：[Wasio 物理竞赛题库](https://github.com/wasio-official/wasio-official.github.io)。借鉴其静态数据组织和考点导航；网站界面独立实现。
