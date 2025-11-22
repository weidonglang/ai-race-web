// src/arena_train.js
// ================================================
// 对抗 Arena 的训练控制逻辑 + 双 RL 智能体可视化 + 统计写入
// --------------------------------
// 你可以把这个文件看成整个项目的“总调度中心 / 控制塔”：
//   - 负责驱动 Three.js 迷宫中的【对抗选手 A/B】沿路径跑步、进化参数；
//   - 负责调用 RL 核心引擎，训练两个网格世界的 Q-learning 智能体（RL-A / RL-B）；
//   - 负责把训练过程中的关键指标写入 localStorage，供 Dashboard / 回放页面使用；
//   - 负责响应页面上的按钮（开始 / 暂停 / 下一局 / 清空历史 / 调整 RL 速度 等）。
//
// 从结构上，大致可以分为几块：
//   1）DOM 元素获取（迷宫面板 / 对抗面板 / RL 面板）；
//   2）本地存储 key 约定与统计快照写入工具；
//   3）Three.js 对抗选手 A/B 的创建与对抗 Episode 控制（进化系统）；
//   4）RL 智能体创建（调用 arena_rl_core.js）与 3D 小球可视化；
//   5）主渲染循环：统一更新对抗 + RL + 渲染场景。
// ================================================

import * as THREE from 'three'
import * as core from './arena_core.js'
import { computeEpisodeRewards, defaultRewardConfig } from './rewards.js'
import { createRlAgent } from './arena_rl_core.js'

/* ---------- 简单 DOM 工具 ---------- */
const $ = id => document.getElementById(id)

/* ---------- Maze 面板元素（迷宫信息 + 加载按钮） ---------- */
const domMaze = {
  id: $('arenaMazeId'),
  diff: $('arenaMazeDiff'),
  size: $('arenaMazeSize'),
  btnEasy: $('btnMazeEasy'),
  btnMed: $('btnMazeMedium'),
  btnHard: $('btnMazeHard')
}

/* ---------- 对抗（进化模式）面板元素 ---------- */
const domArena = {
  ep: $('arenaEp'),
  status: $('arenaStatus'),
  timeA: $('arenaTimeA'),
  lenA: $('arenaLenA'),
  exploreA: $('arenaExploreA'),
  trapsA: $('arenaTrapsA'),
  scoreA: $('arenaScoreA'),
  timeB: $('arenaTimeB'),
  lenB: $('arenaLenB'),
  exploreB: $('arenaExploreB'),
  trapsB: $('arenaTrapsB'),
  scoreB: $('arenaScoreB'),
  winner: $('arenaWinner'),
  histCount: $('arenaHistCount'),
  btnStart: $('btnArenaStart'),
  btnPause: $('btnArenaPause'),
  btnNext: $('btnArenaNext'),
  btnClear: $('btnArenaClear')
}

/* ---------- RL 面板元素（双智能体 A/B 汇总显示） ---------- */
const domRL = {
  ep: $('rlEp'),
  succRate: $('rlSuccRate'),
  avgR: $('rlAvgR'),
  avgSteps: $('rlAvgSteps'),
  lastR: $('rlLastR'),
  lastSteps: $('rlLastSteps'),
  epsNow: $('rlEpsNow'),
  btnStart: $('btnRlStart'),
  btnPause: $('btnRlPause'),
  btnStepEp: $('btnRlStepEp'),
  btnReset: $('btnRlReset'),
  // 训练速度滑块 + 显示文本
  speedSlider: $('rlSpeed'),
  speedValue: $('rlSpeedValue')
}

/* ---------- localStorage Key 约定 ---------- */
// 这里统一管理所有和 Arena / RL 相关的数据持久化 key，便于调试和其他页面使用。

// Arena 对抗历史（进化 A/B）：每一局对抗结束后记一条记录
const RUNS_STORAGE_KEY = 'arena_runs'
// 进化参数（A/B 的 speed / exploreBias），方便下次打开网页时延续“进化结果”
const EVO_STORAGE_KEY = 'arena_evo_params'
// 双 RL 智能体的 Episode 统计快照（Dashboard 用折线图）
const RL_STATS_KEY = 'arena_rl_dual_stats'
// Lab 页面保存的 RL 超参数（lab.js 会写入）
const LAB_KEY = 'ai_lab_params'

/* ---------- 训练统计快照写入工具 ---------- */
/**
 * 将当前双 RL 智能体的统计信息，压缩成一条“快照”，保存到 localStorage。
 * 每条快照对应某个时间点/若干 episode 后的摘要，用于 Dashboard 做折线图。
 *
 * 注意两个层面的“节流”：
 *   1）调用方（updateRlPanel）已经保证只有在 episode 数变化时才调用；
 *   2）这里再限制最多只保留最近 MAX_SNAPSHOTS 条记录，防止 localStorage 爆炸。
 *
 * @param {Object} statsA  - rlAgentA.getStats() 返回的统计
 * @param {Object} statsB  - rlAgentB.getStats() 返回的统计
 * @param {number} shortestSteps - 当前迷宫理论最短步数（格子数）
 * @param {Object} meta    - 当前迷宫元数据 getMazeMeta()
 */
function pushRlSnapshot (statsA, statsB, shortestSteps, meta) {
  try {
    let arr = JSON.parse(localStorage.getItem(RL_STATS_KEY) || '[]') || []

    arr.push({
      mazeId:        meta?.id || null,
      difficulty:    meta?.difficulty || 'unknown',
      epA:           statsA.episodeCount,
      epB:           statsB.episodeCount,
      succA:         statsA.successRateRecent,   // 0~100
      succB:         statsB.successRateRecent,
      avgStepsA:     statsA.avgStepsRecent,
      avgStepsB:     statsB.avgStepsRecent,
      shortestSteps: shortestSteps || 0,
      epsA:          statsA.epsilon,
      epsB:          statsB.epsilon,
      ts:            Date.now()
    })

    // 最多只保留最近 2000 条快照，防止 localStorage 过大 / dashboard 卡顿
    const MAX_SNAPSHOTS = 2000
    if (arr.length > MAX_SNAPSHOTS) {
      arr = arr.slice(arr.length - MAX_SNAPSHOTS)
    }

    localStorage.setItem(RL_STATS_KEY, JSON.stringify(arr))
  } catch (e) {
    console.warn('[RL Stats] 写入 arena_rl_dual_stats 失败', e)
  }
}

/* ---------- 基本工具 ---------- */
const fmtTimeSec = (sec) => `${sec.toFixed(2)} s`
const fmtMeters = (m) => `${m.toFixed(2)} m`
const clamp = (x, a, b) => Math.min(b, Math.max(a, x))

/* ---------- 从 arena_core 中取 Three.js 和迷宫工具 ---------- */
const scene = core.scene
const camera = core.camera
const renderer = core.renderer
const controls = core.controls
const loadRandomMaze = core.loadRandomMaze
const getMazeMeta = core.getMazeMeta
const gridToWorld = core.gridToWorld
const getMazeNeighbors = core.getMazeNeighbors

if (!scene || !camera || !renderer || !controls || !loadRandomMaze || !getMazeMeta || !gridToWorld) {
  console.error('[Arena] arena_core.js 必要导出缺失，请检查 scene/camera/renderer/controls/loadRandomMaze/getMazeMeta/gridToWorld 是否正确导出。')
}

/* ---------- 路径获取 & 距离计算（兼容多种实现） ---------- */
/**
 * 统一从 arena_core 获取“路径信息”：
 * - 优先 core.getMazePathCells（返回 {i,k}[]，格子坐标）
 * - 其次 core.getMazePathPoints（返回 world-space 点）
 * 这里不关心路径是怎么生成的，只负责“取出来用”。
 */
function getRawPathFromCore () {
  if (typeof core.getMazePathCells === 'function') {
    return core.getMazePathCells()
  }
  if (typeof core.getMazePathPoints === 'function') {
    return core.getMazePathPoints()
  }
  console.warn('[Arena] arena_core.js 未导出 getMazePathCells / getMazePathPoints，当前对抗模式将无法沿路径移动。')
  return null
}

/**
 * 计算一条 world-space 路径的总长度（多段折线）。
 * 若 arena_core 已提供 computePathLength，则优先用那一版；
 * 否则使用这里的本地实现。
 *
 * @param {THREE.Vector3[]} points
 * @returns {number} 路径总长度（米）
 */
function computePathLengthLocal (points) {
  if (!points || points.length < 2) return 0
  let L = 0
  for (let i = 0; i < points.length - 1; i++) {
    L += points[i].distanceTo(points[i + 1])
  }
  return L
}

const computePathLength =
  typeof core.computePathLength === 'function'
    ? core.computePathLength
    : computePathLengthLocal

/* ---------- 3D 对抗选手（A/B）Mesh ---------- */
/**
 * 创建一个小球 Mesh 作为对抗选手（A 或 B）。
 * @param {number} color - 十六进制颜色（0xRRGGBB）
 * @returns {THREE.Mesh}
 */
function createAgentMesh (color) {
  const geo = new THREE.SphereGeometry(0.3, 24, 16)
  const mat = new THREE.MeshStandardMaterial({ color })
  const mesh = new THREE.Mesh(geo, mat)
  mesh.castShadow = true
  mesh.visible = false
  scene.add(mesh)
  return mesh
}

// 这里的 A/B 球体只负责“演示对抗路径”，不参与 RL 逻辑
const agentMeshA = createAgentMesh(0x00b0ff) // 蓝色球体 = 对抗选手 A
const agentMeshB = createAgentMesh(0xff6d00) // 橙色球体 = 对抗选手 B

/* ---------- 对抗 Episode 状态 & 进化参数 ---------- */
// 进化参数：控制对抗选手 A/B 的速度（speed）和“偏好绕路程度”（exploreBias）。
// 这些参数会随着对抗结果被缓慢更新，形成一种“简单的进化过程”。
const evoParams = {
  A: { speed: 3.0, exploreBias: 0.25 },
  B: { speed: 2.8, exploreBias: 0.30 }
}

// 从 localStorage 还原进化参数（如果存在），保证刷新页面后“进化”不会丢失。
try {
  const saved = JSON.parse(localStorage.getItem(EVO_STORAGE_KEY) || 'null')
  if (saved && saved.A && saved.B) {
    evoParams.A.speed = saved.A.speed ?? evoParams.A.speed
    evoParams.A.exploreBias = saved.A.exploreBias ?? evoParams.A.exploreBias
    evoParams.B.speed = saved.B.speed ?? evoParams.B.speed
    evoParams.B.exploreBias = saved.B.exploreBias ?? evoParams.B.exploreBias
  }
} catch (e) {
  console.warn('[Arena] 无法解析本地 evo 参数，使用默认值', e)
}

/** 保存当前进化参数到 localStorage（刷新后也能延续训练结果） */
function saveEvoParams () {
  try {
    localStorage.setItem(EVO_STORAGE_KEY, JSON.stringify(evoParams))
  } catch (e) {
    console.warn('[Arena] 保存 evo 参数失败', e)
  }
}

// 对抗 Episode 运行时状态
let currentEpisode = 0             // 已跑过的对抗局数
let arenaState = 'idle'           // 'idle' | 'running' | 'paused' | 'finished'
let arenaAutoLoop = false         // 是否开启“持续对抗模式”（自动一局接一局）

let episodeTimeA = 0
let episodeTimeB = 0
let episodeDoneA = false
let episodeDoneB = false
let episodeWinner = '-'
let pathPoints = []          // 当前迷宫的理想路径（THREE.Vector3 数组）
let pathLen = 0
let exploredCellsA = 0
let exploredCellsB = 0
let trapHitsA = 0
let trapHitsB = 0   // 暂时没实际使用，预留

// 路径进度 t ∈ [0,1]，用于插值沿路径移动
let tA = 0
let tB = 0

/* ---------- 从迷宫元数据重建 world-space 路径 ---------- */
/**
 * 从 arena_core 提供的路径数据（网格 {i,k} 或 world-space 点）构建 pathPoints[]，
 * 并更新 pathLen。
 */
function rebuildPathFromMaze () {
  const raw = getRawPathFromCore()
  if (!raw || raw.length < 2) {
    pathPoints = []
    pathLen = 0
    console.warn('[Arena] 当前迷宫没有有效路径（getMazePathCells/getMazePathPoints 返回为空）。')
    return
  }

  // 兼容两种形式：
  // 1) world-space 点：有 x/y/z 属性（可能是 THREE.Vector3 或普通对象）
  // 2) 网格坐标：有 i/k 属性，需要用 gridToWorld 映射到 world-space
  const first = raw[0]
  if (first && typeof first.x === 'number' && typeof first.y === 'number') {
    // world-space 点
    pathPoints = raw.map(p => new THREE.Vector3(p.x, p.y, p.z ?? 0))
  } else if (first && typeof first.i === 'number' && typeof first.k === 'number') {
    // 网格坐标 -> 转成 world-space
    pathPoints = raw.map(c => gridToWorld(c.i, c.k, 0.3))
  } else {
    console.warn('[Arena] 无法识别路径数据格式，raw[0] =', first)
    pathPoints = []
    pathLen = 0
    return
  }

  pathLen = computePathLength(pathPoints)
}

/* ---------- 对抗 Episode 状态重置 ---------- */
/**
 * 将对抗 Episode 的运行时指标全部清零，并把 A/B 球体放到路径起点。
 * 只负责“这一局的状态”，不改 currentEpisode 计数。
 */
function resetEpisodeRuntime () {
  episodeTimeA = 0
  episodeTimeB = 0
  episodeDoneA = false
  episodeDoneB = false
  episodeWinner = '-'
  exploredCellsA = 0
  exploredCellsB = 0
  trapHitsA = 0
  trapHitsB = 0
  tA = 0
  tB = 0

  if (pathPoints.length > 0) {
    const p0 = pathPoints[0]
    agentMeshA.position.copy(p0)
    agentMeshB.position.copy(p0)
    agentMeshA.visible = true
    agentMeshB.visible = true
  } else {
    agentMeshA.visible = false
    agentMeshB.visible = false
  }
}

/* ---------- 对抗 Episode 生命周期 ---------- */
/** 启动一局新的对抗 Episode（currentEpisode++） */
function startNewEpisode () {
  if (!pathPoints || pathPoints.length < 2) {
    rebuildPathFromMaze()
  }
  if (!pathPoints || pathPoints.length < 2) {
    alert('当前迷宫没有有效路径，请先加载迷宫。')
    return
  }
  currentEpisode += 1
  arenaState = 'running'
  resetEpisodeRuntime()
  updateArenaPanel()
}

/** 暂停 / 继续 对抗（只切换状态，不修改 episode） */
function pauseOrResumeArena () {
  if (arenaState === 'running') {
    arenaState = 'paused'
  } else if (arenaState === 'paused') {
    arenaState = 'running'
  }
  updateArenaPanel()
}

/** 停止对抗并将 Episode 状态重置为 idle */
function stopArenaAndResetEpisode () {
  arenaState = 'idle'
  resetEpisodeRuntime()
  updateArenaPanel()
}

/* ---------- 对抗 Episode 更新 ---------- */
/**
 * 按给定 t ∈ [0,1]，沿 pathPoints 插值移动 mesh。
 * - 这里使用线性插值 lerpVectors，实现平滑移动效果。
 */
function moveAlongPath (mesh, t) {
  if (pathPoints.length < 2) return null
  const segCount = pathPoints.length - 1
  const totalT = clamp(t, 0, 0.999999)
  const f = totalT * segCount
  const i = Math.floor(f)
  const localT = f - i
  const p0 = pathPoints[i]
  const p1 = pathPoints[i + 1]
  mesh.position.lerpVectors(p0, p1, localT)
  return mesh.position
}

/**
 * 对抗 Episode 的每帧更新逻辑：
 * - 根据 speed / pathLen 推进 tA / tB；
 * - 更新用时（episodeTimeA/B）和“探索格子数”简单指标；
 * - 当 A/B 都到达终点时，结束本局并调用 finishEpisodeAndEvolve()。
 *
 * @param {number} dt - 本帧经过的时间（秒）
 */
function updateArenaEpisode (dt) {
  if (arenaState !== 'running') return
  if (pathPoints.length < 2) return

  const speedA = evoParams.A.speed
  const speedB = evoParams.B.speed

  // 把 speed 转换成“t 增长率”：speed / pathLen
  // pathLen 越长，每一单位距离对应的 t 就越小。
  const baseRateA = speedA / Math.max(pathLen, 1e-6)
  const baseRateB = speedB / Math.max(pathLen, 1e-6)

  if (!episodeDoneA) {
    tA += baseRateA * dt
    if (tA >= 1.0) {
      tA = 1.0
      episodeDoneA = true
    }
    moveAlongPath(agentMeshA, tA)
    episodeTimeA += dt
  }

  if (!episodeDoneB) {
    tB += baseRateB * dt
    if (tB >= 1.0) {
      tB = 1.0
      episodeDoneB = true
    }
    moveAlongPath(agentMeshB, tB)
    episodeTimeB += dt
  }

  // 简单定义“探索格子数”：和路径长度相关，再叠加一点 exploreBias 的影响
  exploredCellsA = Math.round(pathPoints.length * (1 + evoParams.A.exploreBias * 0.2))
  exploredCellsB = Math.round(pathPoints.length * (1 + evoParams.B.exploreBias * 0.2))

  // 如果 A/B 都到终点：结束一局，写入 arena_runs 并进化参数
  if (episodeDoneA && episodeDoneB && arenaState === 'running') {
    arenaState = 'finished'
    finishEpisodeAndEvolve()
  }
}

/**
 * 一局对抗结束后：
 * - 使用 computeEpisodeRewards 计算 A/B 积分（包含时间/路径长度/陷阱等因素）；
 * - 把本局记录写入 arena_runs（用于 Arena 回放页和统计）；
 * - 调整 evoParams（即简单“进化”：弱方向强方靠拢）；
 * - 若开启持续模式，则自动开启下一局。
 */
function finishEpisodeAndEvolve () {
  const meta = (typeof getMazeMeta === 'function') ? getMazeMeta() || {} : {}
  const difficulty = meta.difficulty || 'unknown'

  // 为奖励模块准备 A/B 的指标
  const metricsA = {
    reachedGoal: episodeDoneA,
    timeSec: episodeTimeA,
    pathLen,
    exploredNewCells: exploredCellsA,
    trapsHit: trapHitsA,
    difficulty
  }
  const metricsB = {
    reachedGoal: episodeDoneB,
    timeSec: episodeTimeB,
    pathLen,
    exploredNewCells: exploredCellsB,
    trapsHit: trapHitsB,
    difficulty
  }

  // 迷宫摘要（目前用理想路径长度当作“最短路径”）
  const mazeSummary = {
    id: meta.id || null,
    difficulty,
    shortestPathLen: pathLen || 0
  }

  const rewards = computeEpisodeRewards(
    { maze: mazeSummary, A: metricsA, B: metricsB },
    defaultRewardConfig
  )

  const scoreA = rewards && rewards.A ? rewards.A.score : 0
  const scoreB = rewards && rewards.B ? rewards.B.score : 0

  let winner = 'tie'
  if (scoreA > scoreB) winner = 'A'
  else if (scoreB > scoreA) winner = 'B'
  episodeWinner = winner

  const runRec = {
    mazeId: mazeSummary.id,
    difficulty,
    episode: currentEpisode,
    metricsA,
    metricsB,
    scoreA,
    scoreB,
    winner,
    ts: Date.now()
  }

  // 把本局记录 append 到 arena_runs
  try {
    const arr = JSON.parse(localStorage.getItem(RUNS_STORAGE_KEY) || '[]')
    arr.push(runRec)
    localStorage.setItem(RUNS_STORAGE_KEY, JSON.stringify(arr))
  } catch (e) {
    console.warn('[Arena] 保存 arena_runs 失败', e)
  }

  // 根据本局奖励做一次参数微调（简单进化）
  evolveParamsFromEpisode(scoreA, scoreB)
  updateArenaPanel()
  saveEvoParams()

  // 若开启持续对抗模式，则自动开始下一局
  if (arenaAutoLoop) {
    setTimeout(() => {
      if (arenaAutoLoop) {
        startNewEpisode()
      }
    }, 0)
  }
}

/**
 * 根据本局 A/B 积分更新 evoParams：
 * - 得分高的一方为“老师”，另一方向其速度/探索参数靠近 + 少量随机扰动；
 * - 平局时双方都做小扰动。
 *
 * 这是一个非常简化版的“进化策略”，用于让参数逐渐调整，不保证收敛。
 */
function evolveParamsFromEpisode (scoreA, scoreB) {
  const mut = (v, scale) => v + (Math.random() * 2 - 1) * scale

  if (scoreA > scoreB) {
    // A 更好：B 朝 A 靠近
    evoParams.B.speed = mut(
      evoParams.B.speed + 0.3 * (evoParams.A.speed - evoParams.B.speed),
      0.05
    )
    evoParams.B.exploreBias = clamp(
      mut(
        evoParams.B.exploreBias + 0.3 * (evoParams.A.exploreBias - evoParams.B.exploreBias),
        0.02
      ),
      0.0,
      1.0
    )
  } else if (scoreB > scoreA) {
    // B 更好：A 朝 B 靠近
    evoParams.A.speed = mut(
      evoParams.A.speed + 0.3 * (evoParams.B.speed - evoParams.A.speed),
      0.05
    )
    evoParams.A.exploreBias = clamp(
      mut(
        evoParams.A.exploreBias + 0.3 * (evoParams.B.exploreBias - evoParams.A.exploreBias),
        0.02
      ),
      0.0,
      1.0
    )
  } else {
    // 平局：双方都做小扰动
    evoParams.A.speed = mut(evoParams.A.speed, 0.03)
    evoParams.B.speed = mut(evoParams.B.speed, 0.03)
    evoParams.A.exploreBias = clamp(mut(evoParams.A.exploreBias, 0.02), 0.0, 1.0)
    evoParams.B.exploreBias = clamp(mut(evoParams.B.exploreBias, 0.02), 0.0, 1.0)
  }

  // 把 speed 限制在一个合理范围内，避免出现特别离谱的值
  evoParams.A.speed = clamp(evoParams.A.speed, 1.0, 8.0)
  evoParams.B.speed = clamp(evoParams.B.speed, 1.0, 8.0)
}

/* ---------- 面板更新：Maze / Arena ---------- */
/**
 * 更新 Maze 信息面板（当前迷宫 id / 难度 / 尺寸）。
 */
function updateMazePanel () {
  if (!domMaze.id) return
  const meta = getMazeMeta && getMazeMeta()
  if (!meta) {
    domMaze.id.textContent = '-'
    domMaze.diff.textContent = '-'
    domMaze.size.textContent = '-'
    return
  }
  domMaze.id.textContent = meta.id || '未命名迷宫'
  domMaze.diff.textContent = meta.difficulty || '未知'
  domMaze.size.textContent = `${meta.width} × ${meta.height}`
}

/**
 * 更新 Arena 对抗面板：
 * - 当前 episode / 状态；
 * - 历史对抗记录数量；
 * - 本局 A/B 时间 / 理想路径长度 / 探索格子数 / 踩陷阱数；
 * - 最近一局 A/B 积分；
 * - 本局赢家。
 */
function updateArenaPanel () {
  if (!domArena.ep) return

  domArena.ep.textContent = String(currentEpisode)
  domArena.status.textContent = arenaState

  // 历史对抗局数（从 localStorage 中读取）
  let histCount = 0
  try {
    const arr = JSON.parse(localStorage.getItem(RUNS_STORAGE_KEY) || '[]')
    histCount = arr.length
  } catch (e) {
    // ignore
  }
  domArena.histCount.textContent = String(histCount)

  domArena.timeA.textContent = fmtTimeSec(episodeTimeA)
  domArena.lenA.textContent = fmtMeters(pathLen)
  domArena.exploreA.textContent = String(exploredCellsA)
  domArena.trapsA.textContent = String(trapHitsA)

  domArena.timeB.textContent = fmtTimeSec(episodeTimeB)
  domArena.lenB.textContent = fmtMeters(pathLen)
  domArena.exploreB.textContent = String(exploredCellsB)
  domArena.trapsB.textContent = String(trapHitsB)

  // 显示最近一局的积分
  try {
    const arr = JSON.parse(localStorage.getItem(RUNS_STORAGE_KEY) || '[]')
    const last = arr[arr.length - 1]
    if (last) {
      const sA = last.scoreA ?? 0
      const sB = last.scoreB ?? 0
      domArena.scoreA.textContent = typeof sA === 'number' ? sA.toFixed(1) : String(sA)
      domArena.scoreB.textContent = typeof sB === 'number' ? sB.toFixed(1) : String(sB)
    } else {
      domArena.scoreA.textContent = '0'
      domArena.scoreB.textContent = '0'
    }
  } catch (e) {
    domArena.scoreA.textContent = '0'
    domArena.scoreB.textContent = '0'
  }

  domArena.winner.textContent = episodeWinner
}

/* ---------- Maze 加载按钮绑定 ---------- */
// 三个按钮：简单 / 中等 / 困难。点击后：
//   1）调用 loadRandomMaze(difficulty) 从 mazes/ 目录随机加载一个迷宫；
//   2）重建路径；
//   3）停止当前对抗并重置状态；
//   4）刷新 Maze 面板显示。
if (domMaze.btnEasy) {
  domMaze.btnEasy.onclick = async () => {
    try {
      await loadRandomMaze('easy')
      rebuildPathFromMaze()
      stopArenaAndResetEpisode()
      updateMazePanel()
    } catch (e) {
      console.error('[Arena] 加载简单迷宫失败', e)
    }
  }
}
if (domMaze.btnMed) {
  domMaze.btnMed.onclick = async () => {
    try {
      await loadRandomMaze('medium')
      rebuildPathFromMaze()
      stopArenaAndResetEpisode()
      updateMazePanel()
    } catch (e) {
      console.error('[Arena] 加载中等迷宫失败', e)
    }
  }
}
if (domMaze.btnHard) {
  domMaze.btnHard.onclick = async () => {
    try {
      await loadRandomMaze('hard')
      rebuildPathFromMaze()
      stopArenaAndResetEpisode()
      updateMazePanel()
    } catch (e) {
      console.error('[Arena] 加载困难迷宫失败', e)
    }
  }
}

/* ---------- 对抗控制按钮绑定 ---------- */
// 这里的按钮只控制“对抗 A/B”这条支线，不会影响 RL 双智能体。
if (domArena.btnStart) {
  domArena.btnStart.onclick = () => {
    // 切换“持续对抗”模式开关
    arenaAutoLoop = !arenaAutoLoop

    // 如果刚刚开启持续模式，并且当前没有在跑，就从当前迷宫启动一局
    if (arenaAutoLoop && arenaState !== 'running') {
      startNewEpisode()
    }
  }
}
if (domArena.btnPause) {
  domArena.btnPause.onclick = () => {
    pauseOrResumeArena()
  }
}
if (domArena.btnNext) {
  domArena.btnNext.onclick = () => {
    // “下一局”只跑单次，关闭持续模式
    arenaAutoLoop = false
    if (arenaState === 'running') return
    startNewEpisode()
  }
}
if (domArena.btnClear) {
  domArena.btnClear.onclick = () => {
    if (!confirm('确认清空所有 Arena 对抗历史记录？')) return
    arenaAutoLoop = false
    localStorage.removeItem(RUNS_STORAGE_KEY)
    domArena.histCount.textContent = '0'
  }
}

/* ---------- RL 智能体 & 训练集成（双智能体对比） ---------- */
/**
 * 为 RL 智能体提供统一的迷宫描述。
 * - 读取 getMazeMeta() 的迷宫尺寸、起终点、陷阱/障碍等；
 * - 若 arena_core 提供 getMazeNeighbors，则构造 edgeMask[k][i][4]，用于防止 RL 穿墙。
 *
 * 这个函数的返回格式正好对接 arena_rl_core.js 中的接口要求。
 */
function getMazeDescForRL () {
  const meta = getMazeMeta && getMazeMeta()
  if (
    !meta ||
    meta.width == null ||
    meta.height == null ||
    !meta.start ||
    !meta.end
  ) {
    return null
  }

  // 尝试从 arena_core 拿邻接表，构造 edgeMask
  const neighbors = getMazeNeighbors && getMazeNeighbors()
  let edgeMask = null

  if (
    neighbors &&
    Array.isArray(neighbors) &&
    neighbors.length === meta.height &&
    Array.isArray(neighbors[0]) &&
    neighbors[0].length === meta.width
  ) {
    const w = meta.width
    const h = meta.height
    // edgeMask[k][i][action]，action: 0=上,1=下,2=左,3=右
    edgeMask = Array.from({ length: h }, () =>
      Array.from({ length: w }, () => [false, false, false, false])
    )

    for (let k = 0; k < h; k++) {
      for (let i = 0; i < w; i++) {
        const neigh = (neighbors[k] && neighbors[k][i]) || []
        const mask = edgeMask[k][i]
        for (const n of neigh) {
          if (n.i === i && n.k === k - 1) mask[0] = true // 可以向上走
          else if (n.i === i && n.k === k + 1) mask[1] = true // 可以向下走
          else if (n.i === i - 1 && n.k === k) mask[2] = true // 可以向左走
          else if (n.i === i + 1 && n.k === k) mask[3] = true // 可以向右走
        }
      }
    }
  }

  return {
    id: meta.id || null,
    width: meta.width,
    height: meta.height,
    start: { i: meta.start.i, k: meta.start.k },
    end:   { i: meta.end.i,   k: meta.end.k },
    traps: meta.traps || meta.trapCells || [],
    blocks: meta.blocks || meta.blockCells || [],
    edgeMask                    // 传给 RL 核心，可能是 null
  }
}

/**
 * 从 Lab 页（lab.html / lab.js）读取 RL 超参数：
 * - gamma, maxSteps, recentWindow 为 A/B 共有；
 * - alpha / epsilonStart / epsilonDecay 为 A/B 各自独立配置；
 * 若 lab 里没有填或解析失败，则使用合理默认值。
 */
function loadLabRlConfig () {
  let raw = {}
  try {
    raw = JSON.parse(localStorage.getItem(LAB_KEY) || '{}') || {}
  } catch (e) {
    console.warn('[Arena] 解析 ai_lab_params 失败，使用默认 RL 配置。', e)
  }

  const defaults = {
    gamma: 0.95,
    maxSteps: 256,
    recentWindow: 100,

    alphaA: 0.30,
    epsilonStartA: 1.0,
    epsilonDecayA: 0.995,

    alphaB: 0.20,
    epsilonStartB: 0.80,
    epsilonDecayB: 0.997
  }

  const cfg = { ...defaults, ...raw }

  const toNum = (v) => {
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
  }

  return {
    gamma:         toNum(cfg.gamma)         ?? defaults.gamma,
    maxSteps:      toNum(cfg.maxSteps)      ?? defaults.maxSteps,
    recentWindow:  toNum(cfg.recentWindow)  ?? defaults.recentWindow,

    alphaA:        toNum(cfg.alphaA)        ?? defaults.alphaA,
    epsilonStartA: toNum(cfg.epsilonStartA) ?? defaults.epsilonStartA,
    epsilonDecayA: toNum(cfg.epsilonDecayA) ?? defaults.epsilonDecayA,

    alphaB:        toNum(cfg.alphaB)        ?? defaults.alphaB,
    epsilonStartB: toNum(cfg.epsilonStartB) ?? defaults.epsilonStartB,
    epsilonDecayB: toNum(cfg.epsilonDecayB) ?? defaults.epsilonDecayB
  }
}

// 读取 Lab 页的 RL 超参数配置
const labCfg = loadLabRlConfig()

// 两个 RL 智能体共享的参数（折扣因子 / 每局最大步数 / 统计窗口大小）
const commonRlCfg = {
  gamma: labCfg.gamma,
  maxStepsPerEpisode: labCfg.maxSteps,
  recentWindow: labCfg.recentWindow
}

// RL-A：探索更激进（学习率较高、起始 epsilon 更大、衰减稍快）
const rlAgentA = createRlAgent(getMazeDescForRL, {
  ...commonRlCfg,
  alpha: labCfg.alphaA,
  epsilonStart: labCfg.epsilonStartA,
  epsilonDecay: labCfg.epsilonDecayA
})

// RL-B：探索更保守（学习率较低、起始 epsilon 较低、衰减较慢）
const rlAgentB = createRlAgent(getMazeDescForRL, {
  ...commonRlCfg,
  alpha: labCfg.alphaB,
  epsilonStart: labCfg.epsilonStartB,
  epsilonDecay: labCfg.epsilonDecayB
})

// RL 训练流程的运行状态
let rlRunning = false
let rlPaused = false

// 每“训练一步”之间的时间间隔（毫秒），数值越大 => 训练越慢；数值越小 => 训练越快。
// 默认给一个中等速度，后面由滑块覆盖。
let rlStepIntervalMs = 120
// 时间累积器：根据每帧 dt 决定何时“走一步”
let rlAccumMs = 0

// 两个 RL 智能体对应的 3D 可视化小球
const rlGeo = new THREE.SphereGeometry(0.25, 24, 16)
const rlMatA = new THREE.MeshStandardMaterial({ color: 0xa855f7 }) // A：紫色
const rlMatB = new THREE.MeshStandardMaterial({ color: 0x22c55e }) // B：绿色
const rlMeshA = new THREE.Mesh(rlGeo, rlMatA)
const rlMeshB = new THREE.Mesh(rlGeo, rlMatB)
rlMeshA.castShadow = true
rlMeshB.castShadow = true
rlMeshA.visible = false
rlMeshB.visible = false
scene.add(rlMeshA)
scene.add(rlMeshB)

// 记录首次“最近窗口成功率≈100%”对应的 episode，用于教学展示“收敛速度”
let firstPerfectEpA = null
let firstPerfectEpB = null
// 记录上一次写入快照时的 episode，用于节流写入 RL_STATS_KEY
let lastSnapshotEpA = 0
let lastSnapshotEpB = 0

/** 同步双 RL 智能体的小球在 3D 场景中的位置 */
function syncRlMeshesPosition () {
  const meta = getMazeMeta && getMazeMeta()
  if (!meta) {
    rlMeshA.visible = false
    rlMeshB.visible = false
    return
  }

  const visA = rlAgentA.getVisualState()
  if (!visA || visA.i == null || visA.k == null) {
    rlMeshA.visible = false
  } else {
    const posA = gridToWorld(visA.i, visA.k, 0.35)
    rlMeshA.position.copy(posA)
    rlMeshA.visible = true
  }

  const visB = rlAgentB.getVisualState()
  if (!visB || visB.i == null || visB.k == null) {
    rlMeshB.visible = false
  } else {
    const posB = gridToWorld(visB.i, visB.k, 0.35)
    rlMeshB.position.copy(posB)
    rlMeshB.visible = true
  }
}

/**
 * 获取当前迷宫的理论最短步数（格子数）。
 * 这里直接使用 getRawPathFromCore() 的路径点数 - 1。
 */
function getShortestStepsForCurrentMaze () {
  const raw = getRawPathFromCore && getRawPathFromCore()
  if (!raw || raw.length < 2) return 0
  return raw.length - 1
}

/**
 * 更新 RL 面板上显示的各种统计，并在“episode 变化时”写入一条统计快照：
 * - 面板：总局数、成功率、平均奖励、平均步数（相对最短步数的倍数）、
 *         首次满成功率 episode、最近一局步数、当前 epsilon；
 * - 统计：pushRlSnapshot -> arena_rl_dual_stats（Dashboard 使用）。
 */
function updateRlPanel () {
  if (!domRL.ep) return

  const statsA = rlAgentA.getStats()
  const statsB = rlAgentB.getStats()
  const shortestSteps = getShortestStepsForCurrentMaze()
  const meta = getMazeMeta && getMazeMeta()

  // 更新首次“最近窗口成功率≈100%”对应的 episode（这里用 >=99.5% 当作 100%）
  if (statsA.successRateRecent >= 99.5 && firstPerfectEpA == null) {
    firstPerfectEpA = statsA.episodeCount
  }
  if (statsB.successRateRecent >= 99.5 && firstPerfectEpB == null) {
    firstPerfectEpB = statsB.episodeCount
  }

  // 1) 总局数
  domRL.ep.textContent =
    `A: ${statsA.episodeCount} | B: ${statsB.episodeCount}`

  // 2) 成功率（最近窗口）
  domRL.succRate.textContent =
    `A: ${statsA.successRateRecent.toFixed(1)}% | B: ${statsB.successRateRecent.toFixed(1)}%`

  // 3) 平均奖励（最近窗口）
  domRL.avgR.textContent =
    `A: ${statsA.avgRewardRecent.toFixed(2)} | B: ${statsB.avgRewardRecent.toFixed(2)}`

  // 4) 平均步数 + 相对于最短步数的倍数
  let ratioA = '-'
  let ratioB = '-'
  if (shortestSteps > 0) {
    ratioA = (statsA.avgStepsRecent / shortestSteps).toFixed(2)
    ratioB = (statsB.avgStepsRecent / shortestSteps).toFixed(2)
  }
  domRL.avgSteps.textContent =
    `A: ${statsA.avgStepsRecent.toFixed(1)} (${ratioA}×最短) | ` +
    `B: ${statsB.avgStepsRecent.toFixed(1)} (${ratioB}×最短)`

  // 5) 首次达到“满成功率”的 episode 号
  domRL.lastR.textContent =
    `first100% A: ${firstPerfectEpA != null ? firstPerfectEpA : '-'} | ` +
    `B: ${firstPerfectEpB != null ? firstPerfectEpB : '-'}`

  // 6) 最近一局步数
  domRL.lastSteps.textContent =
    `lastSteps A: ${statsA.lastStepsEpisode} | B: ${statsB.lastStepsEpisode}`

  // 7) 当前 epsilon
  domRL.epsNow.textContent =
    `eps A: ${statsA.epsilon.toFixed(2)} | B: ${statsB.epsilon.toFixed(2)}`

  // 8) 仅在 episode 发生变化时，写入一条快照（避免每帧写入导致卡顿）
  if (
    statsA.episodeCount !== lastSnapshotEpA ||
    statsB.episodeCount !== lastSnapshotEpB
  ) {
    pushRlSnapshot(statsA, statsB, shortestSteps, meta)
    lastSnapshotEpA = statsA.episodeCount
    lastSnapshotEpB = statsB.episodeCount
  }
}

/* ---------- RL 控制按钮（对两个智能体同时生效） ---------- */
if (domRL.btnStart) {
  domRL.btnStart.onclick = () => {
    rlRunning = true
    rlPaused = false
    syncRlMeshesPosition()
    updateRlPanel()
  }
}
if (domRL.btnPause) {
  domRL.btnPause.onclick = () => {
    if (!rlRunning) return
    rlPaused = !rlPaused
  }
}
if (domRL.btnStepEp) {
  domRL.btnStepEp.onclick = () => {
    // 只在未持续训练或已暂停时允许“单步一整局”
    if (rlRunning && !rlPaused) return
    rlAgentA.trainOneEpisode()
    rlAgentB.trainOneEpisode()
    syncRlMeshesPosition()
    updateRlPanel()
  }
}
if (domRL.btnReset) {
  domRL.btnReset.onclick = () => {
    rlAgentA.resetAll()
    rlAgentB.resetAll()
    rlRunning = false
    rlPaused = false
    firstPerfectEpA = null
    firstPerfectEpB = null
    lastSnapshotEpA = 0
    lastSnapshotEpB = 0
    rlMeshA.visible = false
    rlMeshB.visible = false

    // 清空历史 RL 统计
    try {
      localStorage.removeItem(RL_STATS_KEY)
    } catch (e) {
      console.warn('[RL Stats] 清空 arena_rl_dual_stats 失败', e)
    }

    updateRlPanel()
  }
}

/* ---------- RL 速度滑块（1~100） => 映射为步/秒 ---------- */
if (domRL.speedSlider && domRL.speedValue) {
  domRL.speedSlider.min = '1'
  domRL.speedSlider.max = '100'

  // 默认放中间，看着比较舒服
  domRL.speedSlider.value = '50'

  /**
   * 将滑块值 1~100 映射为“每秒训练步数 speed”，并换算成 rlStepIntervalMs。
   * 采用 log 插值，可覆盖很大范围（既能慢速肉眼观察，也能快速刷训练）。
   */
  const updateRlSpeedFromSlider = () => {
    const raw = Number(domRL.speedSlider.value) || 1
    const v = clamp(raw, 1, 100)

    const MIN_SPEED = 5     // 步/秒（非常慢，便于观察）
    const MAX_SPEED = 5000  // 步/秒（非常快，便于“挂机刷训练”）

    // 转为 [0,1]
    const t = (v - 1) / 99

    // 在 log 空间线性插值 => speed 在数值空间指数变化
    const logMin = Math.log(MIN_SPEED)
    const logMax = Math.log(MAX_SPEED)
    const speed = Math.exp(logMin + (logMax - logMin) * t)

    // 主循环里 rlAccumMs += dt * 10000，
    // 所以 interval = 10000 / speed 可以让 speed ≈ 实际步/秒。
    rlStepIntervalMs = 10000 / speed

    // 显示“步/秒”，而不是原始 1~100 档位
    let text
    if (speed < 10) text = speed.toFixed(2)
    else if (speed < 100) text = speed.toFixed(1)
    else text = speed.toFixed(0)
    domRL.speedValue.textContent = text + ' steps/s'
  }

  // 初始化一次
  updateRlSpeedFromSlider()
  // 滑块变动时更新
  domRL.speedSlider.addEventListener('input', updateRlSpeedFromSlider)
}

/* ---------- 主渲染循环 ---------- */
// 这里统一驱动：
//   - 3D 对抗演示（A/B 沿路径移动 + 进化）；
//   - 双 RL 智能体训练（arena_rl_core 内部更新 Q 表）；
//   - Three.js 场景渲染（renderer.render）。

let lastTime = performance.now()

function loop (now) {
  const dt = (now - lastTime) / 1000
  lastTime = now

  // 对抗模式更新（A/B 球沿理想路径前进 + 进化）
  if (arenaState === 'running') {
    updateArenaEpisode(dt)
  }

  // RL 训练：按“时间间隔”走一步，而不是每帧走很多步，
  // 方便通过滑块把训练速度调得肉眼可见或者极快刷数据。
  if (rlRunning && !rlPaused) {
    // 累积时间（单位：毫秒的 1/10000，方便和前面的公式配合）
    rlAccumMs += dt * 10000

    // 安全下限，避免极端情况下 interval 过小导致 while 死循环
    const interval = Math.max(rlStepIntervalMs, 5)

    // 每跨过一个 interval，就让两个智能体各训练一步
    while (rlAccumMs >= interval) {
      rlAccumMs -= interval
      rlAgentA.trainSteps(1)
      rlAgentB.trainSteps(1)
    }

    // 每帧更新可视化和面板
    syncRlMeshesPosition()
    updateRlPanel()
  }

  controls && controls.update()
  renderer && renderer.render(scene, camera)

  requestAnimationFrame(loop)
}

/* ---------- 初始化 ---------- */
updateMazePanel()
updateArenaPanel()
updateRlPanel()

requestAnimationFrame(loop)
