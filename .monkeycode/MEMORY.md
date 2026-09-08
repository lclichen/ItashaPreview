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
