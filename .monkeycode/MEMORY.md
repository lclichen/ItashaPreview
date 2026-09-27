# User Instruction Memory

This file records user instructions, preferences, and teachings for reference in future interactions.

## Entries

[Project Knowledge Summary]
- Date: 2026-08-31
- Context: Agent 在开发痛车设计工具时下载并分析懂车帝 360 环绕车图
- Category: Environment Configuration
- Instructions:
  - 懂车帝 CDN 图片（p3.dcarimg.com）无防盗链，可直接 curl 下载，无需 Referer
  - 小鹏 G7 的 360 环绕序列共 36 帧（public/car360/frame_01..36.webp），每帧 10 度
  - 角度映射：angle = (frameIndex0based - 4) * 10，正前=frame_05(索引4)、正右=frame_14(索引13)、正后=frame_23(索引22)、正左=frame_32(索引31)
  - 车图 1200x800 自带 alpha 透明背景（约 83% 像素全透明），可用于辅助抠图

[Project Knowledge Summary]
- Date: 2026-09-02
- Context: Agent 集成本地 AI 抠图（@imgly/background-removal）与 remove.bg 时踩坑
- Category: Environment Configuration
- Instructions:
  - 沙箱外网严格受限：jsdelivr / unpkg / staticimgly.com / huggingface 均不可达；npm registry、dcarimg 可达；api.remove.bg 时通时断
  - @imgly/background-removal@1.7.0 必须搭配 onnxruntime-web@1.21.0（peer 精确锁定），且必须显式安装（它运行时动态 import onnxruntime-web/webgpu，未声明依赖）
  - @imgly/background-removal-data npm 包内只有加密 blob，模型需从 staticimgly.com 下载 package.tgz 自托管到 public/imgly-data/；沙箱内无法完成，运行时设计为 /imgly-data/ 优先、失败回退官方 CDN
  - 浏览器端调 remove.bg 用 Vite proxy 转发（/removebg-api -> https://api.remove.bg），避免 CORS；fake key 会返回真实 401，可用于链路测试
  - vite dev server 每次新增依赖后必须重启，否则动态 import 会 Failed to fetch dynamically imported module

[Project Knowledge Summary]
- Date: 2026-09-02
- Context: Agent 实现自动遮罩的车轮剔除算法
- Category: Troubleshooting & Debugging
- Instructions:
  - 自动遮罩流程：Sobel+Otsu(与 maxMag*0.08 取小) 边缘墙 + alpha 先验 -> 外部洪泛 -> 车体 -> 暗色组件剔除（灵敏度滑块 20-90 映射 darkT = bodyLuma*(1.05-s*0.01)）-> 闭运算填门缝 -> 保留面积 >=5% 的组件
  - 剔除判定：接触遮罩底部且平均亮度 < bodyLuma*0.75，或大面积且平均亮度 < darkT
  - 车窗默认被剔除（深色大面积），后窗贴纸需求由用户画笔手动加回

[Project Knowledge Summary]
- Date: 2026-09-09
- Context: Agent 实现并 E2E 验证 undo/redo 命令栈（history.ts）
- Category: Build Methods
- Instructions:
  - Playwright 对同一 input 多次 setInputFiles 相同文件时 change 可能不触发，测试脚本需先 evaluate 清空 fileInput.value 再 setInputFiles
  - E2E 像素断言选特征前先确认目标区域的实际颜色：白色车体区域 B-R 约为 0，用紫色(B-R>40)特征会漏检，应改用白色(R/G/B>190)特征
  - git 误提交 node_modules/dist 后的修复路径：git rm -r --cached <dir> + git commit --amend + push --force-with-lease（仅限个人仓库、已同步的最近一次提交）

[Project Knowledge Summary]
- Date: 2026-09-09
- Context: 用户要求补充 .gitignore 并修复历史提交
- Category: Workflow & Collaboration
- Instructions:
  - 本仓库提交前必须检查 .gitignore 生效：node_modules/、dist/、assets/（旧车图副本目录）一律不入库
  - 用户对本地个人仓库的历史修正持授权态度（能修就修），改写已 push 历史时使用 force-with-lease

[Project Knowledge Summary]
- Date: 2026-09-14
- Context: E2E 验证 IndexedDB 图层缓存恢复时发现 reload 后图层"丢失"
- Category: Troubleshooting & Debugging
- Instructions:
  - IndexedDB 持久化链路是 markDirty -> 800ms debounce -> persistAll（内部 blob 序列化异步）：E2E 中上传图层后到 reload 之间必须等待 >=2s，否则事务未完成数据未落盘，属测试时序问题而非产品缺陷

[Project Knowledge Summary]
- Date: 2026-09-16
- Context: 为图层列表增加双击重命名时，发现 dblclick 无法触发
- Category: Troubleshooting & Debugging
- Instructions:
  - 列表项 click 处理器若调用整表重建（renderLayerList），第二次 click 的 DOM 目标会被替换掉，导致 dblclick 永不触发；选中态更新应改为只切换 class（updateSelectionStyles），不要重建 DOM
  - HTML5 拖拽排序在 Playwright 中需手动合成 DragEvent + DataTransfer（dragstart/dragover/drop/dragend），page.dragTo 走鼠标事件不会触发 HTML5 DnD 处理器

[Project Knowledge Summary]
- Date: 2026-09-16
- Context: 实现四角透视（逐格仿射纹理映射）时出现网格状接缝，以及撤销语义错乱
- Category: Troubleshooting & Debugging
- Instructions:
  - canvas 2D 用"分割网格 + 逐格 clip + 仿射 drawImage"做透视时，1:1 分辨率下必然出现网格接缝；解法是离屏 2 倍超采样渲染后再缩回目标尺寸（网格缝在低分辨率下不可见）
  - 命令栈的 800ms 合并窗口只适用于"高频连续同类提交"（如滚轮缩放）；模式切换类离散操作（进入/退出某种编辑模式）必须 push 独立命令，否则会与栈顶同类命令合并，导致撤销回退错误的一步
  - Playwright 在 page.reload 后旧的 ElementHandle 会失效，需重新 page.$ 获取画布并重算坐标映射

[Project Knowledge Summary]
- Date: 2026-09-21
- Context: 为导出功能（尺寸倍率 / 透明背景 / 不含车体 / 分层导出）编写 E2E 验证
- Category: Testing Methods
- Instructions:
  - 浏览器下载类功能用 Playwright 的 page.on('download') 收集下载，再用 download.saveAs() 落盘，最后用 PIL 校验尺寸、色彩模式与 alpha 采样占比；分层导出会连续触发多个下载，用 downloads.length 的差值切片区分本轮文件
  - 验证"是否绘制车体"这类叠加差异时，最干净的对照是"隐藏全部图层"后的两次导出：不含车体应 0% 不透明像素，含车体约 16% 不透明（1200×800 每隔 4 像素采样）

[Project Knowledge Summary]
- Date: 2026-09-23
- Context: 改进自动遮罩提取质量（重写 autoMaskFromEdges、收紧 refineMaskExcludeDarkParts）
- Category: Troubleshooting & Debugging
- Instructions:
  - 车图已由懂车帝抠好（约 83.5% 像素 Alpha=0，半透明过渡仅约 1%），车身轮廓应以 Alpha 主体为准；旧的 Sobel + 膨胀墙 + 边界洪泛在车底会形成闭合环，把地面/阴影区域误判为车体（典型症状：车下方多出一块"地板"遮罩）
  - refineMaskExcludeDarkParts 按全局亮度剔除暗块时必须叠加空间约束（块的 maxY 需接近车体最底行），否则车顶、车窗、天窗等大面积暗部会被一起剔除
  - 自动遮罩单帧耗时约 0.3-1.5s；"同步图层到全部视角"会连续为缺失遮罩的视角各生成一次，可能阻塞 UI 数秒

[Project Knowledge Summary]
- Date: 2026-09-25
- Context: 增加图层混合模式与工程导入/导出
- Category: Troubleshooting & Debugging
- Instructions:
  - 图层混合模式（multiply / screen 等）要求车体与图层在同一个离屏画布上合成；沿用旧写法（遇到车体层就先把已累积图层刷到主画布、再单独绘制车体）时图层与车漆之间不会发生混合
  - 白底立绘配合 multiply 叠在车漆上时白色区域不改变车漆，用户可不抠图直接贴，这是痛车贴膜的常见用法
  - 工程文件为单个 JSON：{app:'itasha-studio', version, exportedAt, images:{key:dataURL}, views:{front|right|rear|left:{layers:[…], mask}}}；图层图片按 HTMLImageElement 引用去重（同一图片跨四视角共享时只存一份，webp 0.95 编码），遮罩用 PNG 无损；导入后需 clearHistory() 并刷新图层列表与属性面板

[Project Knowledge Summary]
- Date: 2026-09-27
- Context: 增加「前盖」视角（允许用户单独上传引擎盖/车头照片作为底图）时踩到的坑
- Category: Troubleshooting & Debugging
- Instructions:
  - 上传图片生成的 blob URL 不能在加载完成后 revokeObjectURL：图片解码后仍被缩略图 <img> 使用，revoke 会让缩略图重新请求该 blob，控制台报 net::ERR_FILE_NOT_FOUND
  - 无对应车图帧的视角（前盖）不能沿用基于 Alpha 的自动遮罩：照片通常整幅不透明，自动遮罩会按暗部误剔区域；这类视角的默认遮罩应直接铺满全幅，交给用户手动编辑
  - 新增无帧视角后，所有 ORTHO_FRAME_1BASED[...]-1 的索引运算都要加保护（无帧视角得到 -1），并统一通过 baseImageOf() 取底图（自定义底图优先，否则用车图帧）；360 旋转预览必须强制使用车图帧，否则会拿自定义底图当旋转底图
  - E2E 中点击「清空缓存」会触发页面自动 reload：必须 waitForLoadState('networkidle') + waitForSelector('.view-tab…') 之后再操作，否则点击落在未渲染完成的 DOM 上会静默丢失
