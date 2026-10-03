# 参与贡献

感谢你帮助 VRChat 玩家把照片更方便地留在本机、整理和回看。可以从报告问题、补充文档、改进界面或完善测试开始，不必先提交代码。

## 报告问题和提出建议

先在 [Issues](https://github.com/kimi-tsuki/vrchat-album/issues)查找是否已有相同反馈。新问题请说明：

- 相册版本、操作系统和 Python 版本。
- 从哪一步开始出现问题，以及能重复出现的最少操作步骤。
- 你期望的结果和实际结果。
- 有助于定位的错误文本，以及使用的参数名称。路径请替换成通用示例。

请不要上传真实 VRChat 照片、相册数据库、`data/`、导出 JSON、完整日志、个人绝对路径或凭据。真实截图可能包含朋友、世界信息和备注，请使用合成测试图片；日志只摘录相关错误，并先遮去私人内容。涉及安全或隐私的反馈也应避免在公开 Issue 中附上敏感数据。

较大的功能或模块重构建议先开 Issue，说明具体使用场景和预期行为，便于确认范围。当前项目以个人电脑上的本地相册为主。

## 本地开发

需要 Python 3.10 或更新版本，建议使用 Python 3.12+。下载仓库后，在项目目录运行：

```text
python install.py
```

Windows 也可以使用：

```text
py -3 install.py
```

安装脚本使用标准库创建 `.venv`，在其中安装 `requirements.txt` 并验证 Pillow。无需激活虚拟环境，直接使用其中的解释器即可。

Windows 用户入口是双击“打开相册.cmd”：它选择已有 Python 3.10+，运行标准库 `bootstrap.py` 检查项目环境，仅在缺少依赖或版本不兼容时调用安装器，然后用 `.venv` 的 Python 启动相册。它不会自动安装 Python。开发时仍可单独运行 `install.py`，避免把安装与界面调试混在一起。

Windows 运行测试：

```text
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
```

macOS / Linux 运行测试：

```sh
python3 install.py
.venv/bin/python -m unittest discover -s tests -v
```

自动测试只使用生成的图片；界面预览也请使用独立数据目录，不改动真实相册标注。

### 前端开发

前端位于 `frontend/`，使用 React 19、TypeScript、HeroUI 3 和 Tailwind CSS 4，通过 Vite 7 构建。开发前端需要 Node.js 20.19+ 或 22.12+，这是 [Vite 7 的版本要求](https://vite.dev/blog/announcing-vite7#node-js-support)。日常运行相册不需要 Node.js：仓库提交了 `web/dist/` 构建产物，Python 直接提供这些本地文件。

在 `frontend/` 目录安装锁定的依赖、检查并构建：

```text
cd frontend
npm ci
npm run typecheck
npm test
npm run build
```

Windows PowerShell 如果限制运行 `npm.ps1`，使用对应的 `npm.cmd` 命令，例如 `npm.cmd ci`；不要修改执行策略。构建产物输出到 `web/dist/`，包含入口 HTML 和带内容哈希的脚本、样式。前端源码修改后，重新构建，并将新的构建文件与源码一起提交，保证下载 ZIP 后可直接运行。

通过下面的 Python 命令在合成相册中验证实际构建界面，完整功能与最终验证以 Python 提供的页面为准。后台的 Host 和请求来源校验应保持不变。

界面预览使用独立的合成照片和数据目录：

```text
.\.venv\Scripts\python.exe app.py --source "D:\AlbumTestPhotos" --data "D:\AlbumTestData" --port 18765 --open-browser
```

macOS / Linux 使用 `.venv/bin/python app.py` 和对应的测试目录。测试数据目录必须在照片目录之外。修改后按影响范围运行有意义的检查；后端逻辑或 HTTP 接口改动应运行自动测试，界面改动应检查实际操作和窄屏布局。通过后无需无理由重复测试。

需要热更新时，先用上面的命令在 `18765` 端口启动合成测试相册，再打开另一个终端，在 `frontend/` 中运行：

```powershell
$env:ALBUM_API_PORT = '18765'
npm.cmd run dev
```

macOS / Linux 使用 `ALBUM_API_PORT=18765 npm run dev`。打开 Vite 显示的 `http://127.0.0.1:5173` 地址；开发代理只连接指定的本机后台，并检查当前开发页面的请求来源。默认开发端口为 5173，占用时可通过 `ALBUM_DEV_PORT` 指定另一个端口。不要把开发代理指向真实相册数据进行测试；修改完成后仍需运行 `npm run build` 并在 Python 页面验证构建产物。

## 项目结构

| 文件或目录 | 用途 |
| --- | --- |
| `app.py` | 照片索引、元数据读取、缩略图、本地 HTTP API |
| `frontend/` | React + TypeScript 相册、HeroUI 界面组件和前端检查 |
| `web/dist/` | 随源码交付的 Vite 构建产物，运行时由 Python 提供 |
| `install.py` | 创建本地虚拟环境并安装依赖 |
| `bootstrap.py` | 检查项目 Python/Pillow，必要时安装，再启动相册 |
| `打开相册.cmd` | Windows 可见的一键安装依赖与启动入口 |
| `tests/` | 基于合成图片的自动测试 |
| `VERSION`、`CHANGELOG.md` | 当前版本与更新记录 |
| `data/` | 运行时生成的数据，始终保持 Git 忽略 |

## 需要保留的行为

- 原照片只读，不移动、删除或覆盖；去重只影响相册显示。
- 索引、缩略图和整理记录保存在照片目录之外。
- 首次确认照片目录后再整理；原生选择器取消时不改变来源，保留手动绝对路径入口。
- 照片来源选择写入 SQLite；`--source` 优先并保存，`--data` 仍指定独立的数据目录。
- 文件索引按来源隔离；收藏、标签、备注和自定义世界名按内容哈希保留，切换目录不得清空标注。
- HTTP 服务启动后及时显示扫描进度，照片读取与缩略图生成不能阻塞首次欢迎页面。
- 本地服务只监听 `127.0.0.1`，保留 Host 和编辑请求来源检查。
- 配色与布局独立选择，切换外观不重置筛选、分页、选择或查看器顺序；相册与使用指南共用主题色和偏好读取。
- 相册和使用指南的入口由同一套 React 界面提供；HTML 不缓存，带内容哈希的资源可长期缓存，升级后应加载新资源。
- 普通、可见的 Python 启动方式。不要添加执行策略绕过脚本、隐藏启动或安全防护关闭步骤。
- 不自动添加开机启动、照片云端上传或公网共享。
- 不提交真实照片、预览截图、整理记录、日志、凭据或个人路径配置；检查 `.gitignore` 和待提交内容。

更详细的仓库约定见 [AGENTS.md](AGENTS.md)。

## 提交 Pull Request

1. Fork 仓库，创建描述当前修改的分支。
2. 围绕一个明确问题修改，避免夹带无关格式化或功能。
3. 更新相关文档，并完成与修改范围相符的验证。
4. 检查提交内容，确保没有运行数据或私人信息。
5. 提交 PR，说明原问题、修改后的行为、验证结果和必要的兼容性事项。需要截图时使用合成图片。

新增或修改功能时，测试应验证实际行为及重要边界，不要只复述实现。提交说明要让未读过 Issue 的人也能理解改动。

## 版本和更新日志

版本号的唯一来源是根目录 `VERSION`，格式为 `major.minor.patch`。需要提交的新改动，同步维护 `VERSION`、`CHANGELOG.md` 和 README：

| 改动类型 | 版本变化 | 示例 |
| --- | --- | --- |
| 修复、小优化、文档调整 | patch +1 | `0.1.0 → 0.1.1` |
| 较大功能、模块重构 | minor +1，patch 归零 | `0.1.1 → 0.2.0` |
| major 升级 | 仅在维护者明确决定时升级 | 不自动升级 |

同一轮工作的多项修改合并为一个版本，以最高级别的变化决定升级幅度，不按文件数或提交次数反复升级。若存在并行 PR，版本号以最终合并顺序调整，避免重复占用版本。

更新日志记录玩家能感知的变化、修复和兼容性事项。当前 `0.4.0` 将前端重构为 React + TypeScript 与 HeroUI，按模块重构规模递增 minor；首个正式版本为 `0.1.0`。从 `0.1.x` 升级时，原自定义 `--source` 用户第一次仍应带原参数，确保旧索引来源归属正确；之后目录选择会保存。

## 许可证

本项目使用 [MIT License](LICENSE)。提交贡献意味着你同意自己的贡献以项目相同的 MIT 许可证发布。请确认新增代码或资源有适当授权；不要添加无权再分发的模型、图片或其他素材。

这是社区独立开发的项目，不是 VRChat 官方项目，也不隶属于 VRChat。
