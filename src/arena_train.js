// src/arena_train.js
// 对抗 Arena 的训练控制逻辑 + RL 训练可视化（容错版）

import * as THREE from 'three'
import * as core from './arena_core.js'
import { computeEpisodeRewards, defaultRewardConfig } from './rewards.js'
import { createRlAgent } from './arena_rl_core.js'

/* ---------- DOM 工具 ---------- */
const $ = id => document.getElementById(id)

/* ---------- Maze 面板元素 ---------- */
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

/* ---------- RL 面板元素 ---------- */
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
  btnReset: $('btnRlReset')
}

/* ---------- 基本工具 ---------- */
const fmtTimeSec = (sec) => `${sec.toFixed(2)} s`
const fmtMeters = (m) => `${m.toFixed(2)} m`
const clamp = (x, a, b) => Math.min(b, Math.max(a, x))

// 从 arena_core 里取常用对象（如果不存在就抛错，方便你发现）
const scene = core.scene
const camera = core.camera
const renderer = core.renderer
const controls = core.controls
const loadRandomMaze = core.loadRandomMaze
const getMazeMeta = core.getMazeMeta
const gridToWorld = core.gridToWorld

if (!scene || !camera || !renderer || !controls || !loadRandomMaze || !getMazeMeta || !gridToWorld) {
  console.error('[Arena] arena_core.js 必要导出缺失，请检查 scene/camera/renderer/controls/loadRandomMaze/getMazeMeta/gridToWorld 是否正确导出。')
}

/* ---------- 路径获取 & 距离计算（兼容多种实现） ---------- */

/**
 * 统一从 arena_core 获取“路径信息”：
 * - 优先 core.getMazePathCells（返回 {i,k}[]）
 * - 其次 core.getMazePathPoints（返回 {i,k}[] 或 world-space 点）
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
 * 自己实现一份路径长度计算；如果 arena_core 有 computePathLength 就优先用它
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

/* ---------- 3D 选手（A/B）Mesh ---------- */
function createAgentMesh (color) {
  const geo = new THREE.SphereGeometry(0.3, 24, 16)
  const mat = new THREE.MeshStandardMaterial({ color })
  const mesh = new THREE.Mesh(geo, mat)
  mesh.castShadow = true
  mesh.visible = false
  scene.add(mesh)
  return mesh
}

const agentMeshA = createAgentMesh(0x00b0ff) // 蓝
const agentMeshB = createAgentMesh(0xff6d00) // 橙

/* ---------- 对抗 Episode 状态 & 进化参数 ---------- */

// 进化参数：控制速度和“探索偏好系数”
const evoParams = {
  A: { speed: 3.0, exploreBias: 0.25 },
  B: { speed: 2.8, exploreBias: 0.30 }
}

const EVO_STORAGE_KEY = 'arena_evo_params'
const RUNS_STORAGE_KEY = 'arena_runs'

// 从 localStorage 还原进化参数
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

function saveEvoParams () {
  try {
    localStorage.setItem(EVO_STORAGE_KEY, JSON.stringify(evoParams))
  } catch (e) {
    console.warn('[Arena] 保存 evo 参数失败', e)
  }
}

// 对抗 Episode 运行时状态
let currentEpisode = 0
let arenaState = 'idle' // 'idle' | 'running' | 'paused' | 'finished'
let arenaAutoLoop = false // 是否开启“持续对抗”模式

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
let trapHitsB = 0

// 路径进度 t ∈ [0,1]
let tA = 0
let tB = 0

/* ---------- 从迷宫元数据重建路径 ---------- */

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
  // 2) 网格坐标：有 i/k 属性，需要用 gridToWorld 映射
  const first = raw[0]
  if (first && typeof first.x === 'number' && typeof first.y === 'number') {
    // world-space 点
    pathPoints = raw.map(p => new THREE.Vector3(p.x, p.y, p.z ?? 0))
  } else if (first && typeof first.i === 'number' && typeof first.k === 'number') {
    // 网格坐标
    pathPoints = raw.map(c => gridToWorld(c.i, c.k, 0.3))
  } else {
    console.warn('[Arena] 无法识别路径数据格式，raw[0] =', first)
    pathPoints = []
    pathLen = 0
    return
  }

  pathLen = computePathLength(pathPoints)
}

/* ---------- 选手状态重置 ---------- */

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

function pauseOrResumeArena () {
  if (arenaState === 'running') {
    arenaState = 'paused'
  } else if (arenaState === 'paused') {
    arenaState = 'running'
  }
  updateArenaPanel()
}

function stopArenaAndResetEpisode () {
  arenaState = 'idle'
  resetEpisodeRuntime()
  updateArenaPanel()
}

/* ---------- 对抗 Episode 更新 ---------- */

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

function updateArenaEpisode (dt) {
  if (arenaState !== 'running') return
  if (pathPoints.length < 2) return

  const speedA = evoParams.A.speed
  const speedB = evoParams.B.speed

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

  // 简单定义探索格子：路径长度 * (1 + exploreBias * 0.2)
  exploredCellsA = Math.round(pathPoints.length * (1 + evoParams.A.exploreBias * 0.2))
  exploredCellsB = Math.round(pathPoints.length * (1 + evoParams.B.exploreBias * 0.2))

  // 如果已经都到终点：结束一局
  if (episodeDoneA && episodeDoneB && arenaState === 'running') {
    arenaState = 'finished'
    finishEpisodeAndEvolve()
  }
}

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

  // 迷宫摘要（目前用理想路径长度当作最短路径）
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

  try {
    const arr = JSON.parse(localStorage.getItem(RUNS_STORAGE_KEY) || '[]')
    arr.push(runRec)
    localStorage.setItem(RUNS_STORAGE_KEY, JSON.stringify(arr))
  } catch (e) {
    console.warn('[Arena] 保存 arena_runs 失败', e)
  }

  // 根据本局奖励做一次参数微调
  evolveParamsFromEpisode(scoreA, scoreB)
  updateArenaPanel()
  saveEvoParams()

  // 如果开启了持续对抗模式，则自动开启下一局
  if (arenaAutoLoop) {
    // 延迟到当前调用栈结束后再启动，避免递归过深
    setTimeout(() => {
      if (arenaAutoLoop) {
        startNewEpisode()
      }
    }, 0)
  }
}


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

  evoParams.A.speed = clamp(evoParams.A.speed, 1.0, 8.0)
  evoParams.B.speed = clamp(evoParams.B.speed, 1.0, 8.0)
}

/* ---------- 面板更新 ---------- */

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

function updateArenaPanel () {
  if (!domArena.ep) return

  domArena.ep.textContent = String(currentEpisode)
  domArena.status.textContent = arenaState

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
// “开始持续对抗”：切换持续模式开关，并在需要时启动一局
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

/* ---------- RL 智能体 & 训练集成 ---------- */

const rlAgent = createRlAgent(() => {
  const meta = getMazeMeta && getMazeMeta()
  // 如果还没有迷宫，或者缺少关键字段，就告诉 RL：当前没有可用迷宫
  if (
    !meta ||
    meta.width == null ||
    meta.height == null ||
    !meta.start ||
    !meta.end
  ) {
    return null
  }

  return {
    id: meta.id || null,
    width: meta.width,
    height: meta.height,
    start: { i: meta.start.i, k: meta.start.k },
    end:   { i: meta.end.i,   k: meta.end.k },
    traps: meta.traps || meta.trapCells || [],
    blocks: meta.blocks || meta.blockCells || []
  }
})


let rlRunning = false
let rlPaused = false
const RL_STEPS_PER_FRAME = 24

const rlGeo = new THREE.SphereGeometry(0.25, 24, 16)
const rlMat = new THREE.MeshStandardMaterial({ color: 0xa855f7 })
const rlMesh = new THREE.Mesh(rlGeo, rlMat)
rlMesh.castShadow = true
rlMesh.visible = false
scene.add(rlMesh)

function syncRlMeshPosition () {
  const vis = rlAgent.getVisualState()
  const meta = getMazeMeta && getMazeMeta()
  // 如果还没有迷宫或者 RL 还没拿到位置，就先不画紫色小球
  if (!meta || !vis) {
    rlMesh.visible = false
    return
  }
  const pos = gridToWorld(vis.i, vis.k, 0.35)
  rlMesh.position.copy(pos)
  rlMesh.visible = true
}

function updateRlPanel () {
  if (!domRL.ep) return
  const stats = rlAgent.getStats()
  domRL.ep.textContent = String(stats.episodeCount)
  domRL.succRate.textContent = `${stats.successRateRecent.toFixed(1)}%`
  domRL.avgR.textContent = stats.avgRewardRecent.toFixed(2)
  domRL.avgSteps.textContent = stats.avgStepsRecent.toFixed(1)
  domRL.lastR.textContent = stats.lastRewardEpisode.toFixed(2)
  domRL.lastSteps.textContent = String(stats.lastStepsEpisode)
  domRL.epsNow.textContent = stats.epsilon.toFixed(2)
}

// RL 控制按钮
if (domRL.btnStart) {
  domRL.btnStart.onclick = () => {
    rlRunning = true
    rlPaused = false
    syncRlMeshPosition()
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
    if (rlRunning && !rlPaused) return
    rlAgent.trainOneEpisode()
    syncRlMeshPosition()
    updateRlPanel()
  }
}
if (domRL.btnReset) {
  domRL.btnReset.onclick = () => {
    rlAgent.resetAll()
    rlRunning = false
    rlPaused = false
    rlMesh.visible = false
    updateRlPanel()
  }
}

/* ---------- 主渲染循环 ---------- */

let lastTime = performance.now()

function loop (now) {
  const dt = (now - lastTime) / 1000
  lastTime = now

  if (arenaState === 'running') {
    updateArenaEpisode(dt)
  }

  if (rlRunning && !rlPaused) {
    rlAgent.trainSteps(RL_STEPS_PER_FRAME)
    syncRlMeshPosition()
    updateRlPanel()
  }

  core.controls && core.controls.update()
  core.renderer && core.renderer.render(core.scene, core.camera)

  requestAnimationFrame(loop)
}

updateMazePanel()
updateArenaPanel()
updateRlPanel()

requestAnimationFrame(loop)
