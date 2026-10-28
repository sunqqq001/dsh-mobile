# 贡献者 / Contributors

GitHub 的 [Contributors 图表](https://github.com/saya-ch/dsh-mobile/graphs/contributors) 按进入默认分支的提交自动统计，无法手动加入仅提交 issue 或 PR 提案的成员。本页按截至 2026-10-18 的实际参与方式感谢社区成员；仓库维护者与自动依赖更新仍可在 GitHub 历史记录中查看。

GitHub's Contributors graph counts commits on the default branch; issue reports and PR proposals cannot be manually added to it. This page credits community members by how they contributed, through 2026-10-18. The repository maintainer and automated dependency updates remain visible in GitHub's history.

## 0.6.12 问题定位 / Issue findings for 0.6.12

感谢 [@jamorzzz](https://github.com/jamorzzz) 在 [#230](https://github.com/saya-ch/dsh-mobile/issues/230) 提供社区认证插件的导航响应与网关握手分析，[@Akiyuki1130](https://github.com/Akiyuki1130) 在 [#231](https://github.com/saya-ch/dsh-mobile/issues/231) 复现共享代理下的匿名限流耗尽，以及 [@yunyunlyk](https://github.com/yunyunlyk) 在 [#232](https://github.com/saya-ch/dsh-mobile/issues/232) 提供具体华为内核版本与 App／浏览器对照。这些报告分别促成认证握手、凭据限流和旧内核启动反馈改进；未将报告者真机写成已完成修复验收。

Thanks [@jamorzzz](https://github.com/jamorzzz) for the community-auth navigation and Gateway exchange analysis in [#230](https://github.com/saya-ch/dsh-mobile/issues/230), [@Akiyuki1130](https://github.com/Akiyuki1130) for reproducing anonymous rate-limit exhaustion behind a shared proxy in [#231](https://github.com/saya-ch/dsh-mobile/issues/231), and [@yunyunlyk](https://github.com/yunyunlyk) for the exact Huawei engine version and App/browser comparison in [#232](https://github.com/saya-ch/dsh-mobile/issues/232). These reports informed authentication, credential-admission and old-engine startup feedback improvements; they are not recorded as completed acceptance on the reporters' devices.

## 0.6.11 代码贡献 / Code contributions in 0.6.11

[@ayiejosh](https://github.com/ayiejosh) 的 [#226](https://github.com/saya-ch/dsh-mobile/pull/226) 为 HTTP 认证和 CSRF 拒绝添加诊断记录。0.6.11 保留原作者提交 [`115b174`](https://github.com/saya-ch/dsh-mobile/commit/115b174d65c5bcb33f96f671e83dcb15db461e3f)，并追加隐私、限频、统计和错误隔离修正。

[@ayiejosh](https://github.com/ayiejosh)'s [#226](https://github.com/saya-ch/dsh-mobile/pull/226) adds diagnostic records for HTTP authentication and CSRF rejections. Version 0.6.11 retains author commit [`115b174`](https://github.com/saya-ch/dsh-mobile/commit/115b174d65c5bcb33f96f671e83dcb15db461e3f) alongside privacy, rate-limit, counting and failure-containment corrections.

[@chintoleung](https://github.com/chintoleung) 在 [#228](https://github.com/saya-ch/dsh-mobile/issues/228) 定位历史加载时的滚动抖动，并在 [#229](https://github.com/saya-ch/dsh-mobile/pull/229) 提供加载行尺寸、自动加载输入判定及浏览器回归测试。0.6.11 保留原作者的五个提交，包括最终修正 [`675154d`](https://github.com/saya-ch/dsh-mobile/commit/675154d5739c3a2de663e7c35da6ba8657017a5e)，并追加维护者修正。

[@chintoleung](https://github.com/chintoleung) traced history-loading scroll oscillation in [#228](https://github.com/saya-ch/dsh-mobile/issues/228) and contributed loader sizing, input-aware auto-loading and browser regression checks in [#229](https://github.com/saya-ch/dsh-mobile/pull/229). Version 0.6.11 retains the author's five commits, including final correction [`675154d`](https://github.com/saya-ch/dsh-mobile/commit/675154d5739c3a2de663e7c35da6ba8657017a5e), alongside maintainer corrections.

## 0.6.7 代码贡献 / Code contributions in 0.6.7

[@GavinQiEr](https://github.com/GavinQiEr) 在 [#207](https://github.com/saya-ch/dsh-mobile/issues/207) 提出 cpolar 固定子域名支持，并在 [#208](https://github.com/saya-ch/dsh-mobile/pull/208) 提供配置、启动参数和文档实现。[#211](https://github.com/saya-ch/dsh-mobile/pull/211) 的整合保留原作者提交 [`8dd7574`](https://github.com/saya-ch/dsh-mobile/commit/8dd75749d3823aecafdb6f5d9faccf674577e7b1)，并追加维护者修正，纳入 0.6.7。

[@GavinQiEr](https://github.com/GavinQiEr) requested reserved cpolar subdomains in [#207](https://github.com/saya-ch/dsh-mobile/issues/207) and implemented the configuration, process arguments and guides in [#208](https://github.com/saya-ch/dsh-mobile/pull/208). Integration [#211](https://github.com/saya-ch/dsh-mobile/pull/211) retains author commit [`8dd7574`](https://github.com/saya-ch/dsh-mobile/commit/8dd75749d3823aecafdb6f5d9faccf674577e7b1) alongside maintainer corrections for 0.6.7.

## 0.6.4 代码贡献 / Code contributions in 0.6.4

[@abworks-dev](https://github.com/abworks-dev) 的 [#200](https://github.com/saya-ch/dsh-mobile/pull/200) 提供窄屏输入栏包装层与按钮点击区域的尺寸修正及回归测试，代码已随 0.6.4 发布；随后以合并提交 [`71754e5`](https://github.com/saya-ch/dsh-mobile/commit/71754e5191d3e9eadfedad16982e144491272f26) 保留原作者提交 [`03604ae`](https://github.com/saya-ch/dsh-mobile/commit/03604ae7623ceb42090ff4c4ed0e84d4aff7144a)。这次历史补全不改变已发布的功能或标签。

[@abworks-dev](https://github.com/abworks-dev)'s [#200](https://github.com/saya-ch/dsh-mobile/pull/200) supplies the narrow-screen composer wrapper sizing fix and regression checks shipped in 0.6.4. The subsequent merge [`71754e5`](https://github.com/saya-ch/dsh-mobile/commit/71754e5191d3e9eadfedad16982e144491272f26) retains the original author commit [`03604ae`](https://github.com/saya-ch/dsh-mobile/commit/03604ae7623ceb42090ff4c4ed0e84d4aff7144a) without changing the released functionality or tags.

## 0.6.3 代码贡献 / Code contributions in 0.6.3

[@abworks-dev](https://github.com/abworks-dev) 的 [#190](https://github.com/saya-ch/dsh-mobile/pull/190)、[#192](https://github.com/saya-ch/dsh-mobile/pull/192)，以及 [@chintoleung](https://github.com/chintoleung) 的 [#191](https://github.com/saya-ch/dsh-mobile/pull/191) 和在 [#189](https://github.com/saya-ch/dsh-mobile/issues/189) 提供的三个 Worker 原型提交参与本版，保留原始提交并追加适配与修正。具体范围见 [更新记录](CHANGELOG.md#063---2026-10-10)。

[@abworks-dev](https://github.com/abworks-dev)'s [#190](https://github.com/saya-ch/dsh-mobile/pull/190) and [#192](https://github.com/saya-ch/dsh-mobile/pull/192), plus [@chintoleung](https://github.com/chintoleung)'s [#191](https://github.com/saya-ch/dsh-mobile/pull/191) and three Worker prototype commits supplied through [#189](https://github.com/saya-ch/dsh-mobile/issues/189), contribute to this release with original history and maintainer corrections. See the [release scope](CHANGELOG.md#063---2026-10-10).

## 已合并 PR / Merged PRs

| 社区成员 / Community member | 已合并 PR / Merged PRs |
| --- | --- |
| [@1624318455](https://github.com/1624318455) | [#93](https://github.com/saya-ch/dsh-mobile/pull/93) |
| [@abworks-dev](https://github.com/abworks-dev) | [#91](https://github.com/saya-ch/dsh-mobile/pull/91), [#98](https://github.com/saya-ch/dsh-mobile/pull/98), [#99](https://github.com/saya-ch/dsh-mobile/pull/99), [#152](https://github.com/saya-ch/dsh-mobile/pull/152), [#184](https://github.com/saya-ch/dsh-mobile/pull/184), [#185](https://github.com/saya-ch/dsh-mobile/pull/185), [#200](https://github.com/saya-ch/dsh-mobile/pull/200) |
| [@ayiejosh](https://github.com/ayiejosh) | [#109](https://github.com/saya-ch/dsh-mobile/pull/109), [#110](https://github.com/saya-ch/dsh-mobile/pull/110), [#116](https://github.com/saya-ch/dsh-mobile/pull/116), [#117](https://github.com/saya-ch/dsh-mobile/pull/117), [#119](https://github.com/saya-ch/dsh-mobile/pull/119), [#124](https://github.com/saya-ch/dsh-mobile/pull/124), [#125](https://github.com/saya-ch/dsh-mobile/pull/125), [#133](https://github.com/saya-ch/dsh-mobile/pull/133), [#136](https://github.com/saya-ch/dsh-mobile/pull/136), [#226](https://github.com/saya-ch/dsh-mobile/pull/226) |
| [@chintoleung](https://github.com/chintoleung) | [#104](https://github.com/saya-ch/dsh-mobile/pull/104), [#147](https://github.com/saya-ch/dsh-mobile/pull/147), [#148](https://github.com/saya-ch/dsh-mobile/pull/148), [#158](https://github.com/saya-ch/dsh-mobile/pull/158), [#161](https://github.com/saya-ch/dsh-mobile/pull/161), [#162](https://github.com/saya-ch/dsh-mobile/pull/162), [#167](https://github.com/saya-ch/dsh-mobile/pull/167), [#229](https://github.com/saya-ch/dsh-mobile/pull/229) |
| [@cjxh21](https://github.com/cjxh21) | [#154](https://github.com/saya-ch/dsh-mobile/pull/154), [#155](https://github.com/saya-ch/dsh-mobile/pull/155) |
| [@fengfanfan-max](https://github.com/fengfanfan-max) | [#143](https://github.com/saya-ch/dsh-mobile/pull/143) |
| [@fqf060420](https://github.com/fqf060420) | [#170](https://github.com/saya-ch/dsh-mobile/pull/170) |
| [@idoall](https://github.com/idoall) | [#61](https://github.com/saya-ch/dsh-mobile/pull/61), [#66](https://github.com/saya-ch/dsh-mobile/pull/66), [#67](https://github.com/saya-ch/dsh-mobile/pull/67), [#77](https://github.com/saya-ch/dsh-mobile/pull/77) |
| [@JackRushante](https://github.com/JackRushante) | [#16](https://github.com/saya-ch/dsh-mobile/pull/16) |
| [@liudasheng](https://github.com/liudasheng) | [#100](https://github.com/saya-ch/dsh-mobile/pull/100), [#130](https://github.com/saya-ch/dsh-mobile/pull/130) |
| [@longisland-icetea](https://github.com/longisland-icetea) | [#59](https://github.com/saya-ch/dsh-mobile/pull/59), [#60](https://github.com/saya-ch/dsh-mobile/pull/60), [#63](https://github.com/saya-ch/dsh-mobile/pull/63) |
| [@qzyqmzn](https://github.com/qzyqmzn) | [#38](https://github.com/saya-ch/dsh-mobile/pull/38), [#75](https://github.com/saya-ch/dsh-mobile/pull/75) |
| [@Sanksu](https://github.com/Sanksu) | [#118](https://github.com/saya-ch/dsh-mobile/pull/118) |
| [@StrawberryAO](https://github.com/StrawberryAO) | [#34](https://github.com/saya-ch/dsh-mobile/pull/34), [#40](https://github.com/saya-ch/dsh-mobile/pull/40) |
| [@xhwxt](https://github.com/xhwxt) | [#105](https://github.com/saya-ch/dsh-mobile/pull/105), [#134](https://github.com/saya-ch/dsh-mobile/pull/134) |
| [@xingleiwu](https://github.com/xingleiwu) | [#79](https://github.com/saya-ch/dsh-mobile/pull/79), [#84](https://github.com/saya-ch/dsh-mobile/pull/84), [#85](https://github.com/saya-ch/dsh-mobile/pull/85), [#86](https://github.com/saya-ch/dsh-mobile/pull/86) |

## 0.6.0 代码贡献 / Code contributions in 0.6.0

以下 PR 通过整合 [#182](https://github.com/saya-ch/dsh-mobile/pull/182) 纳入 0.6.0，保留原作者提交并追加维护者修正。 / These PRs contribute code to 0.6.0 through integration [#182](https://github.com/saya-ch/dsh-mobile/pull/182); original author commits are retained alongside maintainer corrections.

这批贡献包含资源重试、托管 Caddy 实现、应用图标、扫码改进、电脑切换快捷方式和设备排序；实际发布范围及组件可用性见 [更新记录](CHANGELOG.md#060---2026-10-07)。 / These contributions cover resource retries, the managed Caddy implementation, launcher icons, scanning, the computer-switch shortcut and device ordering. See [release notes](CHANGELOG.md#060---2026-10-07) for the shipped scope and component availability.

| 社区成员 / Community member | 已整合 PR / Integrated PRs |
| --- | --- |
| [@abworks-dev](https://github.com/abworks-dev) | [#173](https://github.com/saya-ch/dsh-mobile/pull/173), [#175](https://github.com/saya-ch/dsh-mobile/pull/175), [#176](https://github.com/saya-ch/dsh-mobile/pull/176), [#177](https://github.com/saya-ch/dsh-mobile/pull/177), [#179](https://github.com/saya-ch/dsh-mobile/pull/179) |
| [@xhwxt](https://github.com/xhwxt) | [#180](https://github.com/saya-ch/dsh-mobile/pull/180), [#181](https://github.com/saya-ch/dsh-mobile/pull/181) |

## 已吸收但未直接合并的 PR / Incorporated without a direct merge

[@BlueandwhiteXD](https://github.com/BlueandwhiteXD) 的 [#15](https://github.com/saya-ch/dsh-mobile/pull/15) 提出了并实现了 Android 键盘遮挡修复。由于发布分支已有重叠的状态栏改动，该方案改写后进入主线提交 [`09ef315`](https://github.com/saya-ch/dsh-mobile/commit/09ef31590219f2a436bd801214703338c215b00d)，并在 [`04e6a0d`](https://github.com/saya-ch/dsh-mobile/commit/04e6a0da030353d4f0897419d0f692dc538a752d) 以 `Co-authored-by` 致谢。PR 的 Closed 状态不应掩盖这项已采用的代码贡献。

[@qzyqmzn](https://github.com/qzyqmzn) 的 [#32](https://github.com/saya-ch/dsh-mobile/pull/32) 和 [#37](https://github.com/saya-ch/dsh-mobile/pull/37) 被后续已合并的 [#38](https://github.com/saya-ch/dsh-mobile/pull/38) 取代；其正式贡献已列在上方。

[@BlueandwhiteXD](https://github.com/BlueandwhiteXD)'s [#15](https://github.com/saya-ch/dsh-mobile/pull/15) supplied the Android keyboard-overlap fix. It was adapted into [`09ef315`](https://github.com/saya-ch/dsh-mobile/commit/09ef31590219f2a436bd801214703338c215b00d) alongside overlapping status-bar work and credited with `Co-authored-by` in [`04e6a0d`](https://github.com/saya-ch/dsh-mobile/commit/04e6a0da030353d4f0897419d0f692dc538a752d). Its Closed PR status does not mean the code contribution was rejected. @qzyqmzn's [#32](https://github.com/saya-ch/dsh-mobile/pull/32) and [#37](https://github.com/saya-ch/dsh-mobile/pull/37) were superseded by merged [#38](https://github.com/saya-ch/dsh-mobile/pull/38).

## 问题反馈与建议 / Issue reports and ideas

感谢 [@Void-LifeStream](https://github.com/Void-LifeStream) 在 [#225](https://github.com/saya-ch/dsh-mobile/issues/225) 提供不可达局域网连接长期停留在等待界面的详细计时与复现，促成 Android 取消连接和超时收尾改进。 / Thanks [@Void-LifeStream](https://github.com/Void-LifeStream) for the timed reproduction of an unreachable LAN connection remaining on its waiting screen in [#225](https://github.com/saya-ch/dsh-mobile/issues/225), informing Android cancellation and timeout handling.

感谢 [@Anyways366](https://github.com/Anyways366) 在 [#223](https://github.com/saya-ch/dsh-mobile/issues/223) 提供 Funnel 错误覆盖和诊断信息缺失的详细复现与修正建议。 / Thanks [@Anyways366](https://github.com/Anyways366) for the detailed Funnel error-overwrite and missing-diagnostic reproduction and proposed corrections in [#223](https://github.com/saya-ch/dsh-mobile/issues/223).

感谢 [@Yurzi](https://github.com/Yurzi) 在 [#213](https://github.com/saya-ch/dsh-mobile/issues/213) 报告不同电脑的远程配对记录互相覆盖。 / Thanks [@Yurzi](https://github.com/Yurzi) for reporting remote pairing records on different computers overwriting one another in [#213](https://github.com/saya-ch/dsh-mobile/issues/213).

感谢 [@Dantezcx](https://github.com/Dantezcx) 在 [#209](https://github.com/saya-ch/dsh-mobile/issues/209) 和 [#210](https://github.com/saya-ch/dsh-mobile/issues/210) 提供侧栏命中、短屏布局和定制资源加载的详细诊断。 / Thanks [@Dantezcx](https://github.com/Dantezcx) for the detailed sidebar hit-testing, short-viewport and customization-loading diagnostics in [#209](https://github.com/saya-ch/dsh-mobile/issues/209) and [#210](https://github.com/saya-ch/dsh-mobile/issues/210).

感谢 [@xhwxt](https://github.com/xhwxt) 在 [#203](https://github.com/saya-ch/dsh-mobile/pull/203) 中提出文档选择器改进方案，以及 [@Void-LifeStream](https://github.com/Void-LifeStream) 在 [#205](https://github.com/saya-ch/dsh-mobile/issues/205) 中提供附件选择与回传问题的详细反馈。

Thanks [@xhwxt](https://github.com/xhwxt) for the document-picker proposal in [#203](https://github.com/saya-ch/dsh-mobile/pull/203), and [@Void-LifeStream](https://github.com/Void-LifeStream) for the detailed attachment-selection and delivery report in [#205](https://github.com/saya-ch/dsh-mobile/issues/205).

以下名单包括提出问题、复现缺陷和建议功能的成员；出现在本表不表示提交过代码。 / These members opened repository issues; listing them does not imply code authorship.

| 反馈贡献者 / Issue reporter | 提交的问题 / Issues |
| --- | --- |
| [@1624318455](https://github.com/1624318455) | [#92](https://github.com/saya-ch/dsh-mobile/issues/92) |
| [@2647954284](https://github.com/2647954284) | [#199](https://github.com/saya-ch/dsh-mobile/issues/199) |
| [@abworks-dev](https://github.com/abworks-dev) | [#174](https://github.com/saya-ch/dsh-mobile/issues/174) |
| [@Ann-luo](https://github.com/Ann-luo) | [#150](https://github.com/saya-ch/dsh-mobile/issues/150) |
| [@Anyways366](https://github.com/Anyways366) | [#223](https://github.com/saya-ch/dsh-mobile/issues/223) |
| [@azri57806-design](https://github.com/azri57806-design) | [#97](https://github.com/saya-ch/dsh-mobile/issues/97) |
| [@BrainZombie](https://github.com/BrainZombie) | [#128](https://github.com/saya-ch/dsh-mobile/issues/128) |
| [@CESAEREE](https://github.com/CESAEREE) | [#1](https://github.com/saya-ch/dsh-mobile/issues/1) |
| [@CharlesLueng](https://github.com/CharlesLueng) | [#68](https://github.com/saya-ch/dsh-mobile/issues/68) |
| [@chintoleung](https://github.com/chintoleung) | [#103](https://github.com/saya-ch/dsh-mobile/issues/103), [#166](https://github.com/saya-ch/dsh-mobile/issues/166), [#189](https://github.com/saya-ch/dsh-mobile/issues/189), [#228](https://github.com/saya-ch/dsh-mobile/issues/228) |
| [@chmzs](https://github.com/chmzs) | [#73](https://github.com/saya-ch/dsh-mobile/issues/73) |
| [@gjzbbs](https://github.com/gjzbbs) | [#123](https://github.com/saya-ch/dsh-mobile/issues/123) |
| [@fishdivinity](https://github.com/fishdivinity) | [#202](https://github.com/saya-ch/dsh-mobile/issues/202) |
| [@hairyf](https://github.com/hairyf) | [#114](https://github.com/saya-ch/dsh-mobile/issues/114) |
| [@helan-1997](https://github.com/helan-1997) | [#168](https://github.com/saya-ch/dsh-mobile/issues/168) |
| [@hpsks416](https://github.com/hpsks416) | [#132](https://github.com/saya-ch/dsh-mobile/issues/132) |
| [@idoall](https://github.com/idoall) | [#42](https://github.com/saya-ch/dsh-mobile/issues/42), [#45](https://github.com/saya-ch/dsh-mobile/issues/45), [#46](https://github.com/saya-ch/dsh-mobile/issues/46), [#47](https://github.com/saya-ch/dsh-mobile/issues/47), [#62](https://github.com/saya-ch/dsh-mobile/issues/62), [#64](https://github.com/saya-ch/dsh-mobile/issues/64) |
| [@IvyC-zz](https://github.com/IvyC-zz) | [#58](https://github.com/saya-ch/dsh-mobile/issues/58), [#78](https://github.com/saya-ch/dsh-mobile/issues/78) |
| [@jillkayat](https://github.com/jillkayat) | [#10](https://github.com/saya-ch/dsh-mobile/issues/10) |
| [@jonaskilli](https://github.com/jonaskilli) | [#198](https://github.com/saya-ch/dsh-mobile/issues/198) |
| [@jueruibo](https://github.com/jueruibo) | [#101](https://github.com/saya-ch/dsh-mobile/issues/101) |
| [@KMGTPEZY](https://github.com/KMGTPEZY) | [#95](https://github.com/saya-ch/dsh-mobile/issues/95) |
| [@luoyangchan](https://github.com/luoyangchan) | [#187](https://github.com/saya-ch/dsh-mobile/issues/187) |
| [@LWping](https://github.com/LWping) | [#94](https://github.com/saya-ch/dsh-mobile/issues/94) |
| [@MLYR](https://github.com/MLYR) | [#193](https://github.com/saya-ch/dsh-mobile/issues/193) |
| [@oliverwan97](https://github.com/oliverwan97) | [#26](https://github.com/saya-ch/dsh-mobile/issues/26) |
| [@optttt](https://github.com/optttt) | [#111](https://github.com/saya-ch/dsh-mobile/issues/111) |
| [@qjjer](https://github.com/qjjer) | [#156](https://github.com/saya-ch/dsh-mobile/issues/156) |
| [@Quadrapole](https://github.com/Quadrapole) | [#178](https://github.com/saya-ch/dsh-mobile/issues/178) |
| [@reducm](https://github.com/reducm) | [#127](https://github.com/saya-ch/dsh-mobile/issues/127) |
| [@rgshendong](https://github.com/rgshendong) | [#87](https://github.com/saya-ch/dsh-mobile/issues/87) |
| [@RonaldinhoL](https://github.com/RonaldinhoL) | [#89](https://github.com/saya-ch/dsh-mobile/issues/89) |
| [@rushpixy](https://github.com/rushpixy) | [#165](https://github.com/saya-ch/dsh-mobile/issues/165), [#194](https://github.com/saya-ch/dsh-mobile/issues/194) |
| [@sanmaoAI1432](https://github.com/sanmaoAI1432) | [#169](https://github.com/saya-ch/dsh-mobile/issues/169) |
| [@shengyvself](https://github.com/shengyvself) | [#13](https://github.com/saya-ch/dsh-mobile/issues/13), [#14](https://github.com/saya-ch/dsh-mobile/issues/14) |
| [@snailium](https://github.com/snailium) | [#144](https://github.com/saya-ch/dsh-mobile/issues/144) |
| [@sznyhgm](https://github.com/sznyhgm) | [#96](https://github.com/saya-ch/dsh-mobile/issues/96) |
| [@sortjiajun](https://github.com/sortjiajun) | [#90](https://github.com/saya-ch/dsh-mobile/issues/90) |
| [@StrawberryAO](https://github.com/StrawberryAO) | [#39](https://github.com/saya-ch/dsh-mobile/issues/39) |
| [@Surpass567](https://github.com/Surpass567) | [#80](https://github.com/saya-ch/dsh-mobile/issues/80), [#81](https://github.com/saya-ch/dsh-mobile/issues/81) |
| [@Void-LifeStream](https://github.com/Void-LifeStream) | [#205](https://github.com/saya-ch/dsh-mobile/issues/205), [#219](https://github.com/saya-ch/dsh-mobile/issues/219), [#225](https://github.com/saya-ch/dsh-mobile/issues/225), [#234](https://github.com/saya-ch/dsh-mobile/issues/234) |
| [@WalkerJay666](https://github.com/WalkerJay666) | [#201](https://github.com/saya-ch/dsh-mobile/issues/201) |
| [@up-and-down-0618](https://github.com/up-and-down-0618) | [#115](https://github.com/saya-ch/dsh-mobile/issues/115) |
| [@taki-ohh](https://github.com/taki-ohh) | [#19](https://github.com/saya-ch/dsh-mobile/issues/19) |
| [@tianyimc](https://github.com/tianyimc) | [#126](https://github.com/saya-ch/dsh-mobile/issues/126) |
| [@Xingcheng-wang](https://github.com/Xingcheng-wang) | [#76](https://github.com/saya-ch/dsh-mobile/issues/76) |
| [@xhwxt](https://github.com/xhwxt) | [#107](https://github.com/saya-ch/dsh-mobile/issues/107), [#108](https://github.com/saya-ch/dsh-mobile/issues/108), [#145](https://github.com/saya-ch/dsh-mobile/issues/145), [#146](https://github.com/saya-ch/dsh-mobile/issues/146), [#149](https://github.com/saya-ch/dsh-mobile/issues/149), [#171](https://github.com/saya-ch/dsh-mobile/issues/171) |
| [@Yurzi](https://github.com/Yurzi) | [#17](https://github.com/saya-ch/dsh-mobile/issues/17), [#213](https://github.com/saya-ch/dsh-mobile/issues/213) |
| [@Ztyss](https://github.com/Ztyss) | [#22](https://github.com/saya-ch/dsh-mobile/issues/22), [#23](https://github.com/saya-ch/dsh-mobile/issues/23) |
