# v4 Mac 更新通道

4.2.0首次接通使用crowd-pages的bootstrap包。macOS 14+，通用arm64/x86_64程序；本轮实机为Apple芯片，Intel仅完成编译。浏览器开发者模式必须保持开启。用户在原设备接通一次Native Messaging助手并刷新扩展；后续由扩展每小时检查，不重启整个浏览器。原4.1.2不会凭服务器发布自动拥有此能力。

助手路径为用户的`Library/Application Support/CrowdV4Updater`，只绑定原v4目录。只支持status/apply/ack/rollback四个消息动作，不接受浏览器传入的路径、网址、命令或脚本。用户可在插件中关闭自动更新。本机LaunchAgent每5分钟只做未确认更新/中断暂存的恢复检查，不联网、不启动采集。

发布清单使用Ed25519签名，公钥固定在ReleaseKey.swift。ZIP必须来自固定提交的crowd-pages地址；校验包和release.json摘要、所有文件、协议、版本、扩展公钥、完整manifest形状和固定恢复入口。新增权限或其他manifest结构变化拒绝自动安装。相同/较低版本不安装；失败的发布序号不再自动尝试。

下载、校验在原文件之外完成，同一设备进程使用排他锁。插件等待当前采集写入结束，阻止新动作，再原子交换目录、保存备份、只reload自己。新worker用实际版本与release.json摘要确认后才计为applied。代码导入失败由独立入口请求恢复旧文件并reload；进程中断由5分钟恢复任务处理。Chrome被用户禁用、浏览器管理策略或整个浏览器故障不属于助手可绕过的范围。

签名私钥仅保存在开发机工作区外层的`.crowd-launch/v4-update-signing.pem`（0600），不在三个canonical仓、ZIP或诊断中。发布者必须保护并备份它；丢失后不能生成旧助手认可的新签名。不要把测试fixture的私钥当作发布密钥。

## 构建与发布

1. 默认客户端回归、诊断SQL测试及下述宿主/真实Chrome测试全部通过。
2. `python3 v4/build.py --output /private/candidate.zip`
3. `python3 v4/updater/build.py --output /private/crowd-v4-updater`，生成macOS 14+通用程序（ad-hoc签名，未公证）。
4. 在crowd-pages构建bootstrap，提交canonical ZIP与bootstrap，取得不可变提交SHA。不可覆盖已发布版本。
5. `node v4/updater/publish.cjs KEY CANONICAL_ZIP PINNED_RAW_URL SEQUENCE channel.json`。版本与序号都递增；清单放crowd-pages交接分支`v4/releases/channel.json`。
6. 实际下载公开清单和ZIP，使用生产助手确认签名及版本检查；后台核对实际加载版本，不能用Git推送或下载成功代替。

## 测试

`python3 v4/updater/test_host.py`编译独立测试公钥的宿主，验证签名/摘要拒绝、原子替换、握手、回退、防重试、权限扩张、路径穿越和中断暂存清理。TESTING编译允许本地fixture通道，生产构建不存在此覆盖。

按输出FIXTURE设置`CROWD_UPDATE_FIXTURE`，并设置既有`CROWD_PUPPETEER_MODULE`和`CROWD_CHROME_BIN`，运行`node v4/tests/update-engine.cjs`。浏览器和本机宿主均使用临时目录、假身份与假证据，不修改参与者资料。测试通过界面打开开发者模式，验证4.2.0→4.2.1实际加载、身份/证据保留、浏览器不重启，以及签名但语法损坏的4.2.2自动恢复4.2.1。

安装接通脚本的宿主注册/LaunchAgent安装尚未在真实参与者设备执行；不能把隔离宿主和浏览器测试写成该设备已接通或采集已恢复。
