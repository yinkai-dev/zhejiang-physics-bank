# PDF 接口

GitHub Pages 继续承载静态题库；本服务仅负责按公开题目 ID 生成 XeLaTeX PDF。它使用独立账户、队列、SQLite 状态与文件目录，读取公开目录中已授权的冻结题库和已有 `physics-worksheet-mcp 0.1.2` 排版引擎，不调用原 MCP 账户或任务接口，不改其代码和状态。

引擎来源：[physics-worksheet-mcp](https://github.com/yinkai-dev/physics-worksheet-mcp)，0.1.2（部署版本 `6910da0`），AGPL-3.0-or-later。本目录为配套公开接口源码；上游引擎仍遵循其许可证。生产 Python 环境为固定版本、只读复用，不向原环境安装或升级依赖。

接口：

- `GET /bank-pdf/healthz`：状态、目录版本、50题上限。
- `POST /bank-pdf/jobs`：`{title, answers, items:[{id, fingerprint}]}`，返回随机任务 ID。题干、答案、编译参数和文件路径均不可由客户端指定。
- `GET /bank-pdf/jobs/{id}`：排队、运行、成功或失败。成功后返回练习卷和可用原卷答案的独立 PDF 下载地址。
- `GET /bank-pdf/files/{id}/worksheet`、`.../answers`：仅提供已校验 SHA256 的 PDF。

服务固定来源 release 与题目指纹，拒绝其他题库、重复题、来源漂移和超过50题的请求。4个任务队列、单任务执行、每IP 10分钟6次／每日30次；相同请求24小时内复用缓存。文件保留24小时，随机任务链接具有访问能力，勿公开含个人信息的自定义标题。IP只保存每日加盐哈希。

本机测试（先确认64位Python，再建立环境）：

```powershell
.venv/Scripts/python -m pip install -r pdf-service/requirements.txt
.venv/Scripts/python -m unittest discover -s pdf-service -p 'test_*.py' -v
```

生产参考单元为 `zjpdf.service`，仅绑定回环地址，由现有 HTTPS 反向代理增加独立 `/bank-pdf/*` 路由。代理必须覆盖 `X-Real-IP` 为真实对端地址，并限制请求体32KiB；不记录访问日志中的任务链接。编译子进程限制CPU时间、输出大小及180秒墙钟，禁用shell escape。源码、原始题包、TeX和诊断日志不通过下载接口公开。

服务更新由仓库根的 `node scripts/publish.mjs run` 完成，服务器一侧的逻辑在本目录 `deploy_remote.py`：

1. 探测：哪些题库 release 已安装、哪些文件内容服务器还没有（只读）。
2. 安装 release：只上传缺少的内容，其余从服务器已装 release 复用；在临时目录重建后逐文件核对 SHA256、用引擎的 `verify_release` 整体校验，再原子改名到 `<banks>/<bank>/releases/<release>`。不修改 `active.json`。
3. 切换：本目录代码与 `public/data/catalog.json`、`questions-index.json` 组成一个按内容命名的 bundle；确认目录引用的 release 均已安装、新 bundle 能加载目录后，才切换 `current` 并重启本服务，等待健康检查返回新数据版本；不健康则自动切回原 bundle。
4. 发布脚本随后经公网提交一个真实任务（新题，含答案）并核对下载的 PDF，失败同样回滚。

一次部署只需三次 SSH 连接；上传按 2 MB 分块校验，中断后重跑只补传缺少的分块。`healthz` 同时返回数据版本 `public_version`、题量和当前 bundle。数量不写死：接口启动时核对目录与索引一致，范围按公开集合白名单和实际发布目录共同校验。保留旧 bundle 目录可回退（`node scripts/publish.mjs rollback-pdf`）。不要重启或修改已有 MCP API/worker。部署记录仅留在项目 `.local/evidence/publish/`。
