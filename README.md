# AI Race – 3D Maze & RL Arena Web Demo

*(中文 / English Bilingual README)*

AI Race 是一个基于 Web 的 **3D 迷宫 + NavMesh 编辑器 + 强化学习对抗 Arena** 综合演示项目。
项目展示了从 **导航网格构建**、**路径规划** 到 **Q-learning 智能体训练**、**训练统计可视化** 的完整链路，全部在浏览器端完成，无需后端服务。

AI Race is a browser-based demo that combines a **3D maze / NavMesh editor** with a **reinforcement learning (RL) arena**.
It covers the full pipeline from **NavMesh generation** and **path planning** to **Q-learning agent training** and **dashboard visualization**, all running on the client side only.

---

## ✨ Features | 功能特性

* **Multi-page demo / 多页面交互网站**

  * `index.html`：首页 + 粒子背景 + Swiper 轮播介绍
  * `editor.html`：NavMesh 编辑器 & 单人 / A/B 竞速
  * `rl.html`：离散网格世界 Q-learning 演示
  * `arena.html`：3D 迷宫 + 对抗 Arena + 双智能体训练
  * `dashboard.html`：训练看板（双智能体 RL 曲线对比）
  * `lab.html`：RL 超参数实验室（表单 + 校验）
  * `help.html`：帮助 / 原理说明
  * `about.html`：项目说明与致谢（可按需要补充）

* **3D NavMesh Editor / 三维导航网格编辑器**

  * 使用 **Three.js + recast-navigation**
  * 支持添加、拖拽、删除障碍物（Box / Column 等）
  * 一键烘焙 NavMesh，单击测试起点 / 终点，自动寻路
  * 单人回合 & A/B 竞速，实时显示 **路径长度、耗时、胜者**

* **Q-learning RL Demos / 强化学习演示**

  * `rl.html`：基于 7×7 网格世界的 **标准 Q-learning**，公式为
    `Q(s,a) ← Q(s,a) + α [ r + γ max_a' Q(s',a') − Q(s,a) ]`
  * 支持 **启动 / 暂停 / 单步 / N 局训练**，实时显示

    * 成功次数 / 成功率（最近窗口）
    * 平均奖励 / 平均步数
    * 最近一局奖励与步数

* **3D RL Arena / 3D 迷宫对抗 Arena**

  * `arena.html` 中的 3D 迷宫由 `arena_core.js` 管理
  * 两名传统选手 A / B 在同一迷宫中竞速（带“进化式”速度 / 探索偏好调整）
  * 同时挂接 **双 Q-learning 智能体**（Agent A / Agent B），在迷宫网格上训练，训练过程写入 `localStorage('arena_rl_dual_stats')`

* **Dashboard & Analytics / 训练看板与分析**

  * 使用 Chart.js 绘制三张关键曲线：

    * 成功率趋势（谁学得更快）
    * 平均步数 vs 理论最短步数（谁走得更接近最优）
    * epsilon 衰减曲线（探索率变化）
  * 文本区域总结：

    * 全程平均成功率
    * 最近窗口路径效率（平均步数 / 最短步数）
    * 首次接近 100% 成功率的回合
    * 当前“领先选手”的判断说明

* **Config Lab & Form Validation / 配置实验室 + 表单校验**

  * `lab.html` + `lab.js` 提供一个 **RL 参数控制台**：

    * Episode 数量、单局最大步数、统计窗口大小
    * 智能体 A/B 的 α、ε₀、ε 衰减系数等
  * 使用 `jquery-validation` 对表单进行前端校验
  * 参数统一存入 `localStorage('ai_lab_params')`，Arena 训练时自动读取

* **Modern UI & Animations / 现代 UI 与动效**

  * 顶部导航 + 下拉“更多”菜单
  * 首页可交互粒子背景：随鼠标移动，粒子连线动态变化
  * Swiper 轮播卡片展示各页面功能
  * 页面布局响应式设计，适配桌面端与常见移动端宽度
  * （可选）在 Help / About 页面通过滚动触发的渐显动画，营造时间轴 / 故事感

---

## 🧱 Tech Stack | 技术栈

前端 & 构建工具：

* **Vite**（假定使用标准 `npm run dev / build`，可按实际 package.json 调整）
* 原生 **HTML5 + CSS3 + ES Modules**

主要第三方库：

* [`three`](https://threejs.org/)：3D 渲染与场景管理
* [`recast-navigation` + `@recast-navigation/three`]：NavMesh 生成与查询
* [`swiper`](https://swiperjs.com/)：首页轮播卡片
* [`chart.js`](https://www.chartjs.org/)：训练曲线可视化
* [`jquery` + `jquery-validation`]：Lab 页面表单与校验

浏览器存储：

* `localStorage('ai_lab_params')`：RL 超参数配置
* `localStorage('ai_runs')`：NavMesh 编辑器单人/竞速记录
* `localStorage('arena_runs')`：对抗 Arena 历史结果
* `localStorage('arena_rl_dual_stats')`：双智能体 RL 训练快照（Dashboard 使用）

---

## 📁 Project Structure | 项目结构

大致结构如下：

```text
.
├─ index.html         # 首页（粒子背景 + Swiper）
├─ editor.html        # NavMesh 编辑器
├─ arena.html         # 3D 对抗 Arena + 双 RL 训练
├─ rl.html            # 2D 网格世界 Q-learning Demo
├─ dashboard.html     # 训练看板（双智能体 RL）
├─ lab.html           # RL 超参数配置实验室
├─ help.html          # 帮助 / 原理说明
├─ about.html         # 关于本项目
└─ src/
   ├─ style.css             # 全站样式 + 首页布局
   ├─ main.js               # 首页 Swiper + 粒子背景
   ├─ editor.js             # NavMesh 编辑器核心逻辑
   ├─ arena_core.js         # 3D 迷宫场景 & 路径生成
   ├─ arena_train.js        # Arena 对抗 + 双 RL 训练 + 数据写入
   ├─ arena_rl_core.js      # 迷宫网格上的 Q-learning 核心
   ├─ arena_rl.js           # 2D 网格世界 Q-learning Demo
   ├─ dashboard.js          # 读取 arena_rl_dual_stats 并画 Chart.js 图
   ├─ lab.js                # RL 实验室表单 + jQuery 校验 + localStorage
   ├─ rewards.js            # 奖励积分系统（路径 / 时间 / 安全性评分）
   └─ counter.js            # Vite 模板自带的小示例（可选）
```

> ⚠️ 注意：
> 当前 HTML 中 `<link rel="stylesheet" href="/src/style.css">` 和
> `<script type="module" src="/src/xxx.js">` 指向 `src` 目录，
> 请确保实际文件路径与之对应，或根据部署方式自行调整。

---

## 🚀 Running the Project | 运行项目

> 以下步骤以 Vite 工程为假设。如与你的 `package.json` 存在差异，请按实际脚本名称修改。

### 1. Install dependencies / 安装依赖

```bash
npm install
# 或者 pnpm / yarn 等等
```

### 2. Start dev server / 启动开发服务器

```bash
npm run dev
```

然后在浏览器中访问类似：

```text
http://localhost:5173/
# 若部署在子路径（例如 GitHub Pages: /ai-race-web/），则为：
# http://localhost:5173/ai-race-web/
```

### 3. Build for production / 构建发布版

```bash
npm run build
```

打包产物通常会输出到 `dist/` 目录，你可以：

* 用任意静态服务器（如 `npx serve dist`）本地预览
* 或直接部署到 GitHub Pages / 学校服务器等

---

## 🔗 Data Flow | 数据流与页面联动

用一句话总结：**Lab 配参数 → Arena 训练 & 对抗 → Dashboard 看曲线**。

1. **在 Lab 中配置 RL 超参数**

   * 用户在 `lab.html` 填写 episode 数、α（学习率）、γ（折扣因子）、ε 相关参数
   * 通过 `jquery-validation` 校验后保存到 `localStorage('ai_lab_params')`

2. **在 Arena 中挂双智能体训练**

   * `arena_train.js` 在创建 RL 智能体时，从 `ai_lab_params` 读取参数
   * 训练过程中，每个 episode 结束后，将统计快照写入
     `localStorage('arena_rl_dual_stats')`

3. **在 Dashboard 中分析训练效果**

   * `dashboard.js` 从 `arena_rl_dual_stats` 读取全部历史记录
   * 用 Chart.js 绘制成功率 / 平均步数 / ε 曲线
   * 文本区域给出“谁学得更快”、“谁走得更近似最短路径”等结论


---

## 🎮 Interaction Summary | 交互方式概览

* 鼠标点击 / 拖拽

  * NavMesh 编辑器中添加 / 拖动 / 删除障碍物
  * 选择起点、终点并烘焙路径
  * Arena 中控制开始对抗、暂停、下一局等

* 键盘输入

  * Editor 中通过 `Esc` 取消当前放置模式
  * `Delete / Backspace` 删除当前选中障碍物
  * RL Demo 中通过按钮与键盘组合控制训练节奏（视具体实现）

* 表单输入

  * Lab 页面输入各种超参数，实时校验并存入 localStorage

* 动态数据更新

  * NavMesh 路径长度 / 用时、A/B 竞速结果
  * RL 成功率 / 平均奖励 / 平均步数
  * Dashboard 上多条折线与统计文字自动刷新

