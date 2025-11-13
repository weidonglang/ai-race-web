// src/arena.js
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

/* ---------------- 场景基础搭建 ---------------- */

const root = document.getElementById('arena-viewport')
const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
resizeRenderer()
root.appendChild(renderer.domElement)

const scene = new THREE.Scene()
scene.background = new THREE.Color('#0f1115')

const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100)
camera.position.set(8, 8, 8)
camera.lookAt(0, 0, 0)

const controls = new OrbitControls(camera, renderer.domElement)
controls.target.set(0, 0, 0)
controls.update()

// 光照
const hemi = new THREE.HemisphereLight(0xffffff, 0x111827, 0.8)
scene.add(hemi)
const dir = new THREE.DirectionalLight(0xffffff, 0.6)
dir.position.set(5, 10, 5)
dir.castShadow = false
scene.add(dir)

// 地板 + 网格，仅作占位，后续会替换为 3D 迷宫
const groundGeo = new THREE.PlaneGeometry(20, 20)
const groundMat = new THREE.MeshStandardMaterial({ color: '#111827' })
const ground = new THREE.Mesh(groundGeo, groundMat)
ground.rotation.x = -Math.PI / 2
ground.receiveShadow = true
scene.add(ground)

const grid = new THREE.GridHelper(20, 20, 0x374151, 0x1f2933)
scene.add(grid)

/* ---------------- Agent 占位实现 ---------------- */

// 先用简单小球表示两只智能体：A（蓝）、B（橙）
const agentGeom = new THREE.SphereGeometry(0.3, 20, 20)
const matA = new THREE.MeshStandardMaterial({ color: '#60a5fa' })
const matB = new THREE.MeshStandardMaterial({ color: '#f97316' })

const meshA = new THREE.Mesh(agentGeom, matA)
const meshB = new THREE.Mesh(agentGeom, matB)
meshA.castShadow = meshB.castShadow = true
scene.add(meshA, meshB)

// 暂时用一条对角直线作为“路径”，后续会由迷宫路径替代
const startPos = new THREE.Vector3(-4, 0.3, -4)
const goalPos = new THREE.Vector3(4, 0.3, 4)

class AgentRunner {
  constructor (mesh, baseDuration) {
    this.mesh = mesh
    this.baseDuration = baseDuration // 基础耗时（秒），可当做“速度参数”
    this.reset()
  }

  reset () {
    this.t = 0
    this.duration = this.baseDuration
    this.done = false
    this.mesh.position.copy(startPos)
  }

  update (dt) {
    if (this.done) return
    this.t += dt
    const alpha = Math.min(this.t / this.duration, 1)
    this.mesh.position.lerpVectors(startPos, goalPos, alpha)
    if (alpha >= 1) {
      this.done = true
    }
  }
}

const runnerA = new AgentRunner(meshA, 6.0) // A 略快
const runnerB = new AgentRunner(meshB, 6.8) // B 略慢

/* ---------------- 对抗 Arena 生命周期 ---------------- */

// Arena 全局状态
const arena = {
  episode: 0,
  status: 'idle',          // 'idle' | 'running' | 'paused' | 'finished'
  paused: false,
  elapsedA: 0,             // 秒
  elapsedB: 0,
  doneA: false,
  doneB: false
}

// UI 元素引用
const $ep = document.getElementById('arenaEp')
const $status = document.getElementById('arenaStatus')
const $timeA = document.getElementById('arenaTimeA')
const $timeB = document.getElementById('arenaTimeB')
const $doneA = document.getElementById('arenaDoneA')
const $doneB = document.getElementById('arenaDoneB')
const $winner = document.getElementById('arenaWinner')

const btnStart = document.getElementById('btnArenaStart')
const btnPause = document.getElementById('btnArenaPause')
const btnNext = document.getElementById('btnArenaNext')
const btnClear = document.getElementById('btnArenaClear')

const HISTORY_KEY = 'arena_runs'

function updatePanel () {
  $ep.textContent = String(arena.episode)
  $status.textContent = arena.status + (arena.paused ? ' (Paused)' : '')
  $timeA.textContent = arena.elapsedA.toFixed(2) + ' s'
  $timeB.textContent = arena.elapsedB.toFixed(2) + ' s'
  $doneA.textContent = arena.doneA ? '是' : '否'
  $doneB.textContent = arena.doneB ? '是' : '否'
  $winner.textContent = computeWinnerLabel()
}

function computeWinnerLabel () {
  if (!arena.doneA && !arena.doneB) return '-'
  if (arena.doneA && !arena.doneB) return 'A'
  if (!arena.doneA && arena.doneB) return 'B'
  // 都到达了，比时间
  if (arena.elapsedA < arena.elapsedB - 1e-3) return 'A'
  if (arena.elapsedB < arena.elapsedA - 1e-3) return 'B'
  return '平局'
}

function beginEpisode () {
  arena.episode += 1
  arena.status = 'running'
  arena.paused = false
  arena.elapsedA = 0
  arena.elapsedB = 0
  arena.doneA = false
  arena.doneB = false

  runnerA.reset()
  runnerB.reset()

  updatePanel()
}

function finishEpisodeIfNeeded () {
  if (arena.status !== 'running') return
  if (!arena.doneA || !arena.doneB) return

  arena.status = 'finished'
  arena.paused = false

  // 写入历史，方便 Dashboard / 回放页使用
  const history = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]')
  history.push({
    ep: arena.episode,
    timeA: arena.elapsedA,
    timeB: arena.elapsedB,
    winner: computeWinnerLabel(),
    ts: Date.now()
  })
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history))

  updatePanel()
}

function togglePause () {
  if (arena.status !== 'running') return
  arena.paused = !arena.paused
  updatePanel()
}

function clearHistory () {
  localStorage.removeItem(HISTORY_KEY)
  // 不重置当前 episode，只是清空统计
  alert('arena_runs 历史记录已清空。')
}

/* ---------------- 按钮事件绑定 ---------------- */

btnStart.addEventListener('click', () => {
  if (arena.status === 'running') return
  beginEpisode()
})

btnPause.addEventListener('click', () => {
  togglePause()
})

btnNext.addEventListener('click', () => {
  // “下一局”= 不管当前状态如何，直接开启一局新对抗
  beginEpisode()
})

btnClear.addEventListener('click', () => {
  clearHistory()
})

/* ---------------- 动画主循环 ---------------- */

let lastTime = performance.now()

function loop (now) {
  // 计算本帧 dt（秒）
  const dt = (now - lastTime) / 1000
  lastTime = now

  if (arena.status === 'running' && !arena.paused) {
    runnerA.update(dt)
    runnerB.update(dt)

    if (!runnerA.done) {
      arena.elapsedA += dt
    } else {
      arena.doneA = true
    }
    if (!runnerB.done) {
      arena.elapsedB += dt
    } else {
      arena.doneB = true
    }

    finishEpisodeIfNeeded()
    updatePanel()
  }

  controls.update()
  renderer.render(scene, camera)
  requestAnimationFrame(loop)
}

requestAnimationFrame(loop)

/* ---------------- 自适应窗口大小 ---------------- */

function resizeRenderer () {
  const w = root.clientWidth || window.innerWidth
  const h = root.clientHeight || (window.innerHeight - 64)
  renderer.setSize(w, h)
  camera.aspect = w / h
  camera.updateProjectionMatrix()
}

window.addEventListener('resize', () => {
  resizeRenderer()
})
