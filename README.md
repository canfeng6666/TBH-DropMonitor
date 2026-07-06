# TBH 掉落监控 Umi-OCR 开源版

这是一个用于 Taskbar Hero 的掉落列表监控工具开源整理版。  
程序通过 Frida 读取游戏掉落列表，通过 Umi-OCR 识别开箱提示，并在监控物品出现时暂停循环、等待掉落列表刷新。

> 本仓库是开源版：已移除网络验证、卡密登录、卡密缓存和心跳逻辑。

## 功能

- 连接并加载 Frida 脚本，读取游戏掉落列表。
- 支持普通循环关卡。
- 支持跨难度循环。
- 支持自动入库录制和定时执行。
- 支持监控物品列表。
- 支持命中监控物品后暂停点击，等待掉落列表内监控物品消失后继续。
- 支持 Umi-OCR HTTP 接口识别宝箱获得提示。
- 支持市场价格接口显示价格。
- UI 使用外部 HTML 文件，后续修改界面主要改 `jade_drop_items_ui/index.html`。

## 开源版改动

- 删除网络验证窗口和卡密验证逻辑。
- 删除卡密缓存、心跳线程、心跳接口。
- 启动后直接进入主界面。
- 版本更新接口改为本机地址：`http://127.0.0.1/version`。
- 删除监控列表的“预期”列和对应过滤逻辑。
- 默认价格接口仍保留，可按需自行修改。

## 目录结构

```text
TBH_DropMonitor_OpenSource_20260706/
├─ drop_items_jade_hybrid_ui_umi.py   主程序
├─ drop_items_info_v4_new2.js         Frida 脚本
├─ drop_items_config.json             默认配置
├─ jade_drop_items_ui/
│  ├─ index.html                      前端 UI
│  ├─ runtime_config.js               UI 运行配置
│  └─ donate.jpg                      打赏图片
├─ 1212.ico                           程序图标
├─ 赞赏.jpg                           打赏图片备份
├─ 打包.txt                           Nuitka 打包命令
├─ .gitignore
└─ README.md
```

## 环境要求

- Windows
- Python 3.12 推荐
- Taskbar Hero 游戏进程：`TaskbarHero.exe`
- Umi-OCR，并开启 HTTP 服务
- 管理员权限运行更稳定

## 安装依赖

```powershell
pip install jadeview frida psutil pillow
```

如果你用的是虚拟环境，先进入虚拟环境后再安装。

## 启动 Umi-OCR

请先打开 Umi-OCR，并开启 HTTP 服务，默认地址：

```text
http://127.0.0.1:1224
```

程序默认会直接调用这个接口。  
如果你的 Umi-OCR HTTP 地址不同，可以设置环境变量：

```powershell
$env:TBH_UMI_HTTP_URL="http://127.0.0.1:1224"
python drop_items_jade_hybrid_ui_umi.py
```

## 运行源码

在项目目录打开终端：

```powershell
cd /d C:\Users\CanFeng\Downloads\tbh_drop_info\TBH_DropMonitor_OpenSource_20260706
python drop_items_jade_hybrid_ui_umi.py
```

如果需要调试控制台：

```powershell
python drop_items_jade_hybrid_ui_umi.py --console
```

## 版本更新接口

开源版默认请求：

```text
http://127.0.0.1/version
```

返回 JSON 示例：

```json
{
  "version": "1.0.6",
  "data": "公告内容",
  "url": "https://example.com/TBH.exe",
  "sha256": ""
}
```

字段说明：

- `version`：最新版本号。
- `data`：公告内容。
- `url`：更新下载地址，可为空。
- `sha256`：文件校验，可为空。

如果不需要更新功能，可以忽略这个本机接口；检查更新失败不会影响主功能。

## 打包 EXE

可以参考 `打包.txt`。常用命令：

```powershell
cd /d C:\Users\CanFeng\Downloads\tbh_drop_info\TBH_DropMonitor_OpenSource_20260706

python -m nuitka --standalone --onefile --windows-console-mode=disable --windows-uac-admin --windows-icon-from-ico=1212.ico --include-package=jadeview --include-package=frida --include-package=psutil --include-package=PIL --include-package-data=jadeview --include-data-dir="jade_drop_items_ui=jade_drop_items_ui" --include-data-files="drop_items_info_v4_new2.js=drop_items_info_v4_new2.js" --include-data-files="drop_items_config.json=drop_items_config.json" --include-data-files="1212.ico=1212.ico" --include-data-files="赞赏.jpg=赞赏.jpg" --output-dir=build_ui_umi --output-filename="TBH掉落监控-OpenSource.exe" drop_items_jade_hybrid_ui_umi.py
```

注意：

- 如果 JadeView DLL 没有自动打进去，请按你本机路径额外添加 `JadeView_x64.dll`。
- 打包路径尽量使用英文目录，避免 Nuitka/VS 链接器在部分电脑上因为中文路径失败。
- 打包输出目录 `build_ui_umi/` 已在 `.gitignore` 中忽略，不建议上传到 GitHub。

## 上传到 GitHub

### 方式一：网页上传

1. 打开 [GitHub](https://github.com/) 并登录。
2. 点击右上角 `+`，选择 `New repository`。
3. 填写仓库名，例如 `TBH-DropMonitor-OpenSource`。
4. 选择 `Public` 或 `Private`。
5. 不要勾选自动生成 README，因为本项目已经有 README。
6. 创建仓库后，点击 `uploading an existing file`。
7. 把本目录里的文件拖进去。
8. 不要上传这些目录或文件：
   - `build_ui_umi/`
   - `output/`
   - `version/`
   - `__pycache__/`
   - `*.log`
9. 点击 `Commit changes`。

### 方式二：Git 命令上传

先进入项目目录：

```powershell
cd /d C:\Users\CanFeng\Downloads\tbh_drop_info\TBH_DropMonitor_OpenSource_20260706
```

初始化仓库：

```powershell
git init
git add .
git commit -m "Initial open source release"
```

在 GitHub 创建空仓库后，把下面地址替换成你的仓库地址：

```powershell
git branch -M main
git remote add origin https://github.com/你的用户名/你的仓库名.git
git push -u origin main
```

以后更新代码：

```powershell
git add .
git commit -m "Update"
git push
```

## 建议发布前检查

```powershell
python -m py_compile drop_items_jade_hybrid_ui_umi.py
node --check drop_items_info_v4_new2.js
```

确认没有误上传：

```powershell
git status
```

## 打赏

如果这个项目对你有帮助，可以请作者喝杯咖啡。

<img src="jade_drop_items_ui/donate.jpg" alt="打赏" width="260">

## 免责声明

本项目仅用于学习和研究。使用 Frida、内存读取、自动点击等功能可能违反部分软件或游戏的使用条款。  
请自行承担使用风险，作者不对任何账号、数据、系统或其他损失负责。
