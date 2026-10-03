import { Button, Card } from '@heroui/react';
import { useEffect, useState } from 'react';
import { usePreferences } from './preferences';
import { Appearance } from './components/Appearance';
import { Icon } from './components/Icon';
import { albumApi } from './api';

export function Guide() {
  const prefs = usePreferences();
  const [appearance, setAppearance] = useState(false);
  const [version, setVersion] = useState('');
  useEffect(() => { document.title = '使用指南 · VRChat 漫游相册'; albumApi.status().then(status => setVersion(status.version)).catch(() => {}); }, []);
  return <main className="guide-page">
    <nav className="guide-nav"><a href="/">← 返回相册</a><Button variant="outline" size="sm" onPress={() => setAppearance(true)}><Icon name="palette" />外观</Button></nav>
    <p className="eyebrow">YOUR MOMENTS, YOUR COMPUTER</p><h1>把漫游的照片，<br />收进自己的相册</h1>
    <p className="guide-intro">照片、缩略图与整理记录保留在你的电脑上。选好照片文件夹后，相册默认每 20 秒检查新照片。</p>
    <Card><Card.Header><Card.Title>Windows：第一次打开相册</Card.Title></Card.Header><Card.Content><ol>
      <li>在 <a href="https://github.com/kimi-tsuki/vrchat-album" target="_blank" rel="noopener noreferrer">GitHub 项目仓库</a>中选择 Code → Download ZIP，完整解压。</li>
      <li>双击 <code>打开相册.cmd</code>，它会检查 Python 并准备本地环境和依赖，再打开网页。</li>
      <li>如果没有 Python，从 <a href="https://www.python.org/downloads/" target="_blank" rel="noopener noreferrer">Python 官网</a>安装 Python 3.10 或以上版本（建议 3.12 或以上），再运行启动文件。</li>
      <li>首次使用，在网页确认照片文件夹，再点击“开始整理”。</li>
    </ol><p>首次安装需要联网下载 Python 依赖。以后使用无需安装 Node.js，也无需云端服务。运行期间请保留启动窗口，不能直接在 ZIP 中启动。</p></Card.Content></Card>
    <section><h2>照片放在其他地方？</h2><p>默认建议当前用户的 <code>Pictures\VRChat</code>。首次使用或点击“更换照片文件夹”，可通过本机文件夹窗口选择目录；取消选择会保留原路径。检查路径后点击确认才会开始整理，子目录也会扫描。</p><p>选择窗口打不开时，手动粘贴完整路径，例如 <code>D:\VRChatPhotos</code>。目录保存在本机，下次继续使用。更换目录会清除搜索、筛选和选图状态；未保存的标注请先保存。照片原件始终只读。</p></section>
    <section><h2>第一次整理会发生什么？</h2><p>相册查找 PNG、JPG、JPEG 和 WebP，读取照片信息、准备缩略图，并将完全相同的副本合并显示。网页显示处理阶段与数量，所有原文件仍保留在原位。没有照片时可以选择另一个目录。</p></section>
    <section><h2>先这样逛逛相册</h2><ul><li>按世界或月份缩小范围，再按世界、日期或游玩场次分组。</li><li>搜索世界、日期、文件名、标签或备注。搜索和筛选一起生效。</li><li>点击照片看原图；左右方向键翻页，Esc 关闭。填写世界、标签和备注后点击“保存这段回忆”；翻页或关闭时也会先保存改动。</li><li>星标用于收藏照片，“选择”可以一次整理多张。只有包含元数据的照片才会自动识别世界；未命名世界可以手动填写。</li></ul></section>
    <section><h2>换一种相册外观</h2><p>顶部“外观”提供暖黑、纸白、冷蓝、玻璃风、雾紫、极简黑白六种主题，面板质感、圆角与按钮样式也随主题变化。整齐网格、自然比例瀑布流、横排照片墙三种照片布局可以与主题自由组合，选择立即生效。指南也跟随主题。</p><p>偏好保存在当前浏览器，刷新后继续使用，不需要重新扫描照片。收藏与标注保留；清除浏览器网站数据后恢复默认外观。</p></section>
    <section><h2>关闭、备份与更新</h2><p>关闭网页后后台仍会继续运行。使用 Ctrl+C、关闭启动窗口或点击“停止后台”退出。</p><p>备份前停止相册，复制整个 <code>data/</code> 文件夹；使用 <code>--data</code> 时备份实际指定的位置。它包含索引、缩略图、收藏和标注，原照片另行备份。导出的 JSON 可留档，目前没有导入功能。</p><p>升级前停止并备份，把新版本解压到新目录，复制旧 <code>data/</code>，再运行启动文件。不要复制旧 <code>.venv/</code>，新位置会重新准备环境。使用 Git 的用户参照 README 更新。</p><p>从 0.1.1 升级，需先确认原照片目录，也可沿用 <code>--source</code>。旧索引保留，重新扫描后沿用已有星标与标注。</p></section>
    <section><h2>macOS / Linux 与手动启动</h2><p>安装 Python 3.10 或以上，完整解压后在项目目录运行：</p><pre>python3 install.py{'\n'}.venv/bin/python app.py --open-browser</pre><p>Windows 可运行 <code>python install.py</code> 或 <code>py -3 install.py</code>，然后运行启动文件。指定其他目录前先停止现有相册：</p><pre>{'.\\打开相册.cmd --source "D:\\VRChatPhotos"\n\n.venv/bin/python app.py --source "/你的/VRChat照片目录" --open-browser'}</pre></section>
    <section><h2>找不到照片或打不开？</h2><ul><li>安装失败：查看启动窗口提示，确认 Python 已安装并可联网下载依赖。</li><li>选择失败：确认目录存在且可读，或手动填写完整路径。</li><li>空相册：清空搜索与筛选，确认目录正确且照片写入完成。</li><li>连接中断：检查启动窗口，重新启动并打开 <code>http://127.0.0.1:18764</code>。</li><li>端口占用：先关闭旧相册，或添加 <code>--port 18765</code>。</li><li>安全软件拦截：记录具体提示与文件名，在仓库提出问题以便检查。</li></ul></section>
    <footer>漫游相册 {version && `v${version}`} · 本项目是社区工具，与 VRChat 官方无关联。发布问题或截图前，请移除个人目录、照片、备注及其他不想公开的信息。</footer>
    <Appearance isOpen={appearance} onClose={() => setAppearance(false)} {...prefs} onChange={prefs.updatePreferences} />
  </main>;
}
