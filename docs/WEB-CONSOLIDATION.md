# 网页唯一来源

扩展源码恢复点：`f4d1a49d5ed968c229035cab0d15d1273b1fd35b`。
核对网页源：[`crowd-pages@368a7775`](https://github.com/huming0018-dot/crowd-pages/tree/368a7775c9d2ce7846fe73ab9bb8f3431474c033)。

本批从 crawler-extension 删除 apply.html、install.html、install-mobile.html、owner-rate.html、status.html、submit.html、sw.js、app-manifest.json。网页只在 crowd-pages 保留维护，不复制代码过去、不改变发布仓。

## 不是八份完全相同的文件
- submit.html、sw.js、owner-rate.html、install-mobile.html 四份同 Git blob。
- app-manifest.json 的 JSON 内容相同，仅文本不同。
- apply/install/status 有版本差异；不覆盖发布仓的较新或不同实现。crawler 中旧安装说明与状态展示没有需要再次维护的独立核心；差异仍可由恢复点读取。
- PR3 的 Mac 退出说明仍在 RETIRED-DISTRIBUTION.md。删除本仓安装页不意味着发布仓已采用该说明或线上安装器已撤下。

## 引用与边界
扩展 manifest 只加载 src 下脚本/页面与 icon128，不加载本批网页。其更新 URL 仍指向既有发布端点，保持不变。crowd-pages 的 index 链接提交和安装入口；其 PWA manifest、submit、sw 分享链完整保留。README 改指网页源并去掉本地网页目录与 sw.js 检查命令；onboarding 只修改一行说明，不改执行逻辑。

不删除图标，不改扩展运行实现，不改 crowd-pages、GitHub Pages、存储桶、CRX/ZIP、updates.xml、服务端或设备。没有新网页、重定向页或新框架。本批不是众包功能修复，也不声称真实网站、RPC 或安装流程已验收。

## 恢复
从上述扩展固定提交读取所需文件即可恢复；不另存一份旧源码。历史文档中的旧文件名是审计证据，不是当前本地入口。
