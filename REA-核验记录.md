# Atlas 网站功能核验

2026-11-21，从未登录的桌面浏览器访问 [Atlas](https://atlas.worldlabs.ai/)。本记录用于后续复现与验收。本文件记录开始开发前的观察。现有本地实现、启动方式和验证范围见 [工作台使用说明](README.md)。

## 浏览器实测

| 操作 | 结果 | REA 证据 |
| --- | --- | --- |
| 新建空会话，访问首页 | 跳转到 `/sign-in?redirect=%2F` | `ev_f584cda78d1705977eb55df0a1715716f9ed1783fd65e1e451b345433b59a50a` |
| 等待入口按钮并检查页面 | 全屏背景使用带封面图的静音循环视频，左上角是 World Labs 链接，中央是 ENTER 按钮 | `ev_0600f55c2ae529047e5e5258114095fce4248605e696e50dcd974538414f71bd` |
| 等待登录组件挂载，点击 ENTER | 同页出现登录标题、Google 登录按钮、邮箱输入框和继续按钮 | `ev_fc67f2b19fb97c97d2fb2c4def8709c830ca4437d69873014e0ee8561c2ce5ab` |

浏览器为 REA 启动的独立 Edge 会话，视口 1280 × 720。登录组件先挂载再显示，因此验收入口切换时应等待邮箱输入框可见。这次观察止于该步骤。

从官方产品页打开 [Viewfinder](https://atlas.worldlabs.ai/workflows/viewfinder)、[新建场景](https://atlas.worldlabs.ai/workflows/viewfinder/new) 和 [开发者页面](https://atlas.worldlabs.ai/developers) 也会进入登录页，回跳参数保留目标路径。

另一次 REA 观察逐个切换产品页的四个工具选项，确认了 Viewfinder 以及 [Chisel](https://atlas.worldlabs.ai/workflows/chisel-a-world)、[Splats to Mesh](https://atlas.worldlabs.ai/workflows/splat-to-mesh)、[Relight](https://atlas.worldlabs.ai/workflows/relight-splats) 的链接目标。证据编号为 `ev_6f123a92b108d81166513a86281b105ddf8be28d72ebafaf1e1bdf4a40fd8649`。同目录的 `rea-observations.json` 保存了首页和登录表单三次成功观察的关键字段。

## 官方资料可确认的功能

| 工作流 | 用户输入与结果 | 复现时的验收依据 |
| --- | --- | --- |
| Viewfinder | 导入照片或生成起始图像，重建场景，移动相机，设置相机路径并渲染视频 | 核对输入图像、相机姿态与深度图的匹配关系。导出的视频应按指定路径依次经过各个视点。[产品说明](https://worldlabs.ai/atlas) · [视频工作流](https://docs.atlas.worldlabs.ai/scene-to-video) |
| Chisel | 用三维白模安排物体与相机，用提示词生成外观，或用遮罩修改已有视图 | 移动物体后，各相机的预览应更新。遮罩编辑应能指定修改区域和保留区域。[产品说明](https://worldlabs.ai/atlas) · [Chisel 指南](https://docs.atlas.worldlabs.ai/atlas-chisel-tutorial) |
| 三维重建与网格导出 | 从带位姿和深度的图像生成 Gaussian splat，再转换为 GLB 网格 | 用三维查看器打开输出；按所选参数检查纹理、顶点颜色或碰撞盒。[任务说明](https://docs.atlas.worldlabs.ai/task-overview) |
| Relight | 调整 splat 场景的光照；Studio 另有计费的图像编辑 | 官方公开任务索引中未找到对应独立端点。仍需核对编辑器控件、保存和导出行为。[产品说明](https://worldlabs.ai/atlas) · [计费说明](https://docs.atlas.worldlabs.ai/billing) |
| Frameboy | 以交互方式移动视点并接收云端生成的画面 | 应分别验证本地视口与远端交互会话。公开任务索引中未找到启动该会话的端点。[技术介绍](https://worldlabs.ai/blog/atlas-realtime) · [公开接口索引](https://docs.atlas.worldlabs.ai/llms.txt) |
| 任务与资产管理 | 项目密钥用于访问资产及异步计算任务，开发者可查看、等待或申请取消任务 | 应验证任务成功、失败和取消，核对项目归属和输出资产。网页账号下的订阅和支付管理另需账号权限。[API 文档](https://docs.atlas.worldlabs.ai/api-reference) · [计费说明](https://docs.atlas.worldlabs.ai/billing) |

## 公开推理接口

| 任务 | 输入 | 结果 |
| --- | --- | --- |
| `atlasTextToImage` | 文本描述 | 起始图像 |
| `images2PosedRGBD` | 一张或多张图像 | 相机参数与深度 |
| `atlasGenerate` | 已定位的彩色图像、深度与目标相机 | 指定视点的新图像，可选深度 |
| `atlasChisel` | 带相机的布局或待编辑视图、提示词及相应约束 | 深度引导生成或局部修改后的视图 |
| `posedImages2Splats` | 带位姿和深度的图像组 | Gaussian splat 场景 |
| `splats2Mesh` | Gaussian splat 场景 | GLB 网格 |

接口名称和用途来自 [官方任务目录](https://docs.atlas.worldlabs.ai/task-overview)。使用项目密钥调用官方推理服务会按任务计费，本次调查没有提交生成任务。[认证与接入](https://docs.atlas.worldlabs.ai/quickstart) · [计费说明](https://docs.atlas.worldlabs.ai/billing)

## 尚待验证

- 登录后真实可见的导航、权限、编辑器快捷键、撤销重做、保存与重新打开、分享及导出选项。
- 对同一输入进行端到端测试时，实际生成质量、任务耗时、失败恢复及各输出格式的可用性。
- Relight、Frameboy 和账号管理与公开开发者接口之间的功能差距。

若目标是匹配官方生成结果，可用本地编辑器保存项目和相机路径，在服务端接入上述官方接口。若要求断网使用，则需要独立选择和部署模型，并为重建质量、硬件需求和等待时间另设验收条件。两种方案均需用登录后界面或录屏核对操作细节。
