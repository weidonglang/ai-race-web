// =====================================
// Three.js + Recast Navigation Demo
// 自由放置障碍物 + NavMesh 烘焙 + 寻路 + 单人/竞速测试
// =====================================
//
// 核心功能：
// 1. 在平面上用鼠标放置立方体障碍物（Box），并支持选中 / 拖动 / 删除。
// 2. 使用 recast-navigation 对“地面 + 障碍物”烘焙 NavMesh。
// 3. 在 NavMesh 上，从起点到终点自动寻路，并用折线显示路径。
// 4. 沿路径运行 Agent：
//    - 单人回合（只跑一个 Agent，记录时间与路径长度到 localStorage）。
//    - A/B 竞速（两种速度/转向参数不同的 Agent 赛跑，并记录成绩）。
//
// 这份代码适合用于课堂讲解：展示从几何建模 → NavMesh 烘焙 → 寻路 → 运动控制 → 数据统计的完整流程。

import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { init as initRecast, NavMeshQuery } from 'recast-navigation'
import { generateSoloNavMesh } from 'recast-navigation/generators'
import { NavMeshHelper } from '@recast-navigation/three'

/* ---------- three.js 基础 ---------- */

// 拿到容器 div（例如 <div id="viewport"></div>）
const root = document.getElementById('viewport')

// 创建渲染器：开启抗锯齿
const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setSize(root.clientWidth, root.clientHeight)
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
root.appendChild(renderer.domElement)

// 三维场景
const scene = new THREE.Scene()
scene.background = new THREE.Color('#0f1115')

// 透视相机：视角 60°，近平面 0.1，远平面 1000
const camera = new THREE.PerspectiveCamera(
  60,
  root.clientWidth / root.clientHeight,
  0.1,
  1000
)
camera.position.set(10, 12, 18)

// 轨道控制器：允许用户旋转/缩放视角
const controls = new OrbitControls(camera, renderer.domElement)
controls.enableDamping = true // 开启阻尼，让旋转更平滑

// 半球光：模拟天空和地面环境光
const hemi = new THREE.HemisphereLight(0xffffff, 0x222233, 0.7)
scene.add(hemi)
// 平行光：模拟太阳光，用于产生立体感
const dir = new THREE.DirectionalLight(0xffffff, 0.8)
dir.position.set(6, 10, 6)
scene.add(dir)

/* 地面 + 网格 */

// 地面大小（正方形）
const FLOOR_SIZE = 30

// 一个大平面作为地面
const floorGeo = new THREE.PlaneGeometry(FLOOR_SIZE, FLOOR_SIZE, 1, 1)
// 平面默认朝向 +Z，需要旋转 90° 变成水平
floorGeo.rotateX(-Math.PI / 2)
const floorMat = new THREE.MeshStandardMaterial({
  color: 0x2b2f3a,
  metalness: 0.0,
  roughness: 1.0
})
const floor = new THREE.Mesh(floorGeo, floorMat)
floor.receiveShadow = true
floor.name = 'Floor'
scene.add(floor)

// 辅助的地面网格线（类似坐标纸）
const grid = new THREE.GridHelper(
  FLOOR_SIZE,
  FLOOR_SIZE,
  0x444a57,
  0x303543
)
grid.position.y = 0.01
scene.add(grid)

/* ---------- 全局状态 ---------- */

// 光线投射器：用于鼠标选取地面/障碍物
const raycaster = new THREE.Raycaster()
// 鼠标在 NDC（Normalized Device Coordinates）坐标下的位置
const mouseNDC = new THREE.Vector2()

// 当前“放置模式”：
// - 'box'  : 在地面上放置障碍物立方体
// - 'start': 设置寻路起点
// - 'end'  : 设置寻路终点
// - null   : 普通模式（选中 / 拖动 / 删除）
let placingMode = null

// 所有障碍物的 Mesh 列表
const obstacles = []

// 起点 / 终点标记球体 Mesh
let startMarker = null
let endMarker = null

// NavMesh 的查询器 & Three.js 可视化辅助
let navQuery = null
let navHelper = null

// 最近一次寻路得到的路径折线（Line 对象）
let pathLine = null
// 最近一次寻路得到的路径点（world-space，THREE.Vector3 数组）
let lastPathPoints = null

// pointerdown 的位置，用来区分“点击”和“拖动”
let downPos = null

// 当前选中/拖动的障碍物
let selectedObstacle = null
let draggingObstacle = null
let isDragging = false

// 根据当前状态更新鼠标指针样式
const updateCursor = () => {
  renderer.domElement.style.cursor = (placingMode || isDragging)
    ? 'crosshair'
    : 'default'
}

/* ---------- 工具函数：创建标记物 / 放置 & 选取 / 删除 ---------- */

/**
 * 创建一个彩色小球，用作起点/终点标记。
 * @param {number} color - 16 进制颜色值，例如 0xff0000
 */
function makeMarker (color) {
  return new THREE.Mesh(
    new THREE.SphereGeometry(0.25, 24, 16),
    new THREE.MeshStandardMaterial({ color })
  )
}

/**
 * 在指定位置放置一个障碍物立方体。
 * @param {THREE.Vector3} point - 世界坐标位置，一般来自地面点击点
 */
function addObstacleAt (point) {
  const geo = new THREE.BoxGeometry(2, 2, 2)
  const mat = new THREE.MeshStandardMaterial({
    color: 0x8b5cf6,
    metalness: 0.2,
    roughness: 0.8
  })
  const box = new THREE.Mesh(geo, mat)
  // 放置在点击点上方 y=1（立方体高度 2）
  box.position.copy(point).y = 1.0
  box.castShadow = true
  box.receiveShadow = true
  box.name = 'Obstacle'

  // 记录基础自发光颜色，用于选中高亮 / 取消高亮时恢复
  box.userData.baseEmissive = (
    box.material.emissive
      ? box.material.emissive.getHex()
      : 0x000000
  )

  scene.add(box)
  obstacles.push(box)
}

/**
 * 将鼠标事件转换成“地面上的点击点”。
 * 若射线没有打到地面，则返回 null。
 */
function pickOnFloor (ev) {
  const rect = renderer.domElement.getBoundingClientRect()
  // 像素坐标 → NDC
  mouseNDC.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1
  mouseNDC.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1
  raycaster.setFromCamera(mouseNDC, camera)
  const hit = raycaster.intersectObject(floor, false)[0]
  return hit ? hit.point : null
}

/**
 * 选中障碍物：返回鼠标下最近的障碍物 Mesh（或 null）。
 */
function pickObstacle (ev) {
  const rect = renderer.domElement.getBoundingClientRect()
  mouseNDC.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1
  mouseNDC.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1
  raycaster.setFromCamera(mouseNDC, camera)
  const hit = raycaster.intersectObjects(obstacles, false)[0]
  return hit ? hit.object : null
}

/**
 * 设置“当前选中的障碍物”，并处理高亮效果。
 * @param {THREE.Mesh|null} obj - 要选中的障碍物，若为 null 则取消选中
 */
function selectObstacle (obj) {
  // 先取消之前选中物体的高亮
  if (selectedObstacle && selectedObstacle !== obj) {
    if (selectedObstacle.material.emissive) {
      selectedObstacle.material.emissive.setHex(
        selectedObstacle.userData.baseEmissive ?? 0x000000
      )
    }
  }

  // 更新当前选中对象
  selectedObstacle = obj || null

  // 新选中的物体加上高亮（青色）
  if (selectedObstacle && selectedObstacle.material.emissive) {
    selectedObstacle.material.emissive.setHex(0x00ffff)
  }
}

/**
 * 删除一个障碍物：从场景和数组中移除。
 */
function deleteObstacle (obj) {
  const idx = obstacles.indexOf(obj)
  if (idx >= 0) obstacles.splice(idx, 1)
  scene.remove(obj)
  if (selectedObstacle === obj) selectedObstacle = null
}

/* ---------- 几何数据导出：为 Recast 准备三角网 ---------- */

/**
 * 将一组 Mesh（地面 + 所有障碍物）转换为
 * positions / indices 数组，供 recast-navigation 使用。
 *
 * @param {THREE.Mesh[]} meshes
 * @returns {[number[], number[]]} - [positions, indices]
 *   positions: [x0,y0,z0, x1,y1,z1, ...]
 *   indices  : [i0,i1,i2, i3,i4,i5, ...]（三角面索引）
 */
function getPositionsAndIndicesFromMeshes (meshes) {
  const positions = []
  const indices = []
  let indexOffset = 0

  for (const mesh of meshes) {
    // 复制几何体并将“世界变换矩阵”应用到顶点上
    const geom = mesh.geometry.clone()
    geom.applyMatrix4(mesh.matrixWorld)

    // 为简化处理，统一转为非索引几何（每个三角形显式写出3个顶点）
    const nonIdx = geom.index ? geom.toNonIndexed() : geom

    const arr = nonIdx.getAttribute('position').array
    // 顶点坐标推入 positions
    for (let i = 0; i < arr.length; i += 3) {
      positions.push(arr[i], arr[i + 1], arr[i + 2])
    }

    // arr 中每 9 个 float 对应一个三角形（3 个顶点）
    const triCount = arr.length / 9
    for (let t = 0; t < triCount; t++) {
      indices.push(
        indexOffset + t * 3 + 0,
        indexOffset + t * 3 + 1,
        indexOffset + t * 3 + 2
      )
    }

    // 更新下一个 mesh 的索引偏移
    indexOffset += triCount * 3
  }

  return [positions, indices]
}

/* ---------- NavMesh 烘焙 ---------- */

/**
 * 使用 recast-navigation 对当前“地面 + 障碍物”烘焙一个 NavMesh。
 * - 会清除旧的 NavMesh 可视化和路径折线。
 * - 会隐藏所有 Agent，避免视觉残留。
 */
async function bakeNavMesh () {
  // 1. 清理旧的 NavMesh 可视化和路径折线
  if (navHelper) {
    scene.remove(navHelper)
    navHelper = null
  }
  if (pathLine) {
    scene.remove(pathLine)
    pathLine = null
  }
  lastPathPoints = null

  // 2. 隐藏所有 agent（防止跑在旧路径上）
  agentSolo.stop(); agentSolo.mesh.visible = false
  agentA.stop();    agentA.mesh.visible = false
  agentB.stop();    agentB.mesh.visible = false

  // 3. 准备输入几何：地面 + 所有障碍物
  const inputMeshes = [floor, ...obstacles]
  const [positions, indices] = getPositionsAndIndicesFromMeshes(inputMeshes)

  // 4. 初始化 Recast WASM（只需调用一次，多次调用也安全）
  await initRecast()

  // 5. NavMesh 配置（cell size / agent 尺寸 / 最大坡度等）
  const cfg = {
    cs: 0.25,           // cell size：网格划分的 XY 平面分辨率
    ch: 0.2,            // cell height：Z 方向分辨率
    walkableHeight: 1.8,  // 可行走区域所需的最小高度（防止脑袋撞到天花板）
    walkableRadius: 0.4,  // Agent 半径
    walkableClimb: 0.4,   // 可跨越的台阶高度
    walkableSlopeAngle: 45 // 最大可行走坡度（度数）
  }

  // 6. 调用生成单块 NavMesh 的函数
  const { success, navMesh } = generateSoloNavMesh(positions, indices, cfg)
  if (!success) {
    alert('NavMesh 生成失败，请调整参数或几何！')
    return
  }

  // 7. 使用 NavMeshQuery 进行后续的路径查询
  navQuery = new NavMeshQuery(navMesh)

  // 8. 用 Three.js 的 NavMeshHelper 把 NavMesh 渲染出来（蓝色网格）
  navHelper = new NavMeshHelper(navMesh)
  scene.add(navHelper)
}

/* ---------- 寻路（高层 API） ---------- */

/**
 * 利用 navQuery，从 startMarker 到 endMarker 寻路，并在场景中画出路径折线。
 */
function findPathAndDraw () {
  if (!navQuery || !startMarker || !endMarker) {
    alert('请先设置起点/终点并烘焙 NavMesh')
    return
  }

  // 调用 recast-navigation 的高层接口 computePath
  const { success, path, error } = navQuery.computePath(
    {
      x: startMarker.position.x,
      y: startMarker.position.y,
      z: startMarker.position.z
    },
    {
      x: endMarker.position.x,
      y: endMarker.position.y,
      z: endMarker.position.z
    }
  )

  if (!success || !path || path.length < 2) {
    console.warn('computePath 失败：', error)
    alert('寻路失败：起点/终点可能不在可走区域附近，或区域不连通')
    return
  }

  // 保存最近一次路径点（用于 Agent 沿路径移动）
  lastPathPoints = path.map(p => new THREE.Vector3(p.x, p.y, p.z))

  // 为了视觉上不会埋在地面里，把 y 稍微抬高一点
  const pts = lastPathPoints.map(v => new THREE.Vector3(v.x, v.y + 0.05, v.z))
  const g = new THREE.BufferGeometry().setFromPoints(pts)
  const m = new THREE.LineBasicMaterial({ linewidth: 2, color: 0x00e5ff })

  // 清除旧路径，添加新路径
  if (pathLine) scene.remove(pathLine)
  pathLine = new THREE.Line(g, m)
  scene.add(pathLine)

  // 注意：此处不自动重置 / 显示 Agent，
  // 让用户自己决定何时开始单人回合或竞速。
}

/* ---------- Agent 类：沿路径移动的“小球” ---------- */

/**
 * Agent：沿 lastPathPoints 进行移动的小球。
 * 支持：
 * - resetToStart(): 重置到路径起点
 * - start(): 开始沿路径移动
 * - update(dt): 每帧移动一步
 */
class Agent {
  constructor (color = 0x00d084) {
    // 线速度（单位：m/s）
    this.speed = 3.0
    // 旋转追踪速度：越大转向越快
    this.turnK = 10.0
    // Agent 半径
    this.radius = 0.25

    // 使用球体 Mesh 作为可视化
    this.mesh = new THREE.Mesh(
      new THREE.SphereGeometry(this.radius, 24, 16),
      new THREE.MeshStandardMaterial({ color })
    )
    this.mesh.castShadow = true
    this.mesh.visible = false // start() 后才显示
    scene.add(this.mesh)

    // 当前要走的路径（THREE.Vector3 数组）
    this.path = null
    // 当前在 path 数组中的段索引（走 path[i] → path[i+1]）
    this.i = 0
    // 状态标志
    this.running = false
    this.done = false
  }

  /**
   * 将 Agent 重置到路径起点，但不自动开始移动。
   * 若当前没有有效路径，则隐藏自身。
   */
  resetToStart () {
    if (!lastPathPoints || lastPathPoints.length < 2) {
      this.path = null
      this.running = false
      this.done = false
      this.mesh.visible = false
      return
    }
    this.path = lastPathPoints
    this.i = 0
    this.running = false
    this.done = false
    const p0 = this.path[0]
    // 这里把 y 固定在 0.25，避免浮点误差导致埋入地面
    this.mesh.position.set(p0.x, 0.25, p0.z)
  }

  /**
   * 开始沿路径移动。
   * 若路径无效则返回 false。
   */
  start () {
    if (!this.path || this.path.length < 2) return false
    this.mesh.visible = true
    this.running = true
    this.done = false
    return true
  }

  /** 切换暂停/继续（仅控制 running 标志） */
  pauseToggle () {
    this.running = !this.running
  }

  /** 暂停（running = false） */
  stop () {
    this.running = false
  }

  /**
   * 每帧更新 Agent 位置。
   * @param {number} dt - delta time（秒）
   */
  update (dt) {
    if (!this.running || this.done || !this.path) return

    const pos = this.mesh.position
    let target = this.path[this.i + 1]

    // 如果已经走到 path 末尾，则标记完成
    if (!target) {
      this.done = true
      this.running = false
      return
    }

    // dir = target - current（忽略 y 分量，让 Agent 在平面上移动）
    const dir = new THREE.Vector3().subVectors(target, pos)
    dir.y = 0
    const dist = dir.length()

    // 如果距离目标点很近，切换到下一个段
    if (dist < 0.05) {
      this.i++
      target = this.path[this.i + 1]
      if (!target) {
        this.done = true
        this.running = false
        return
      }
    }

    // 以固定速度朝 dir 方向迈步
    dir.normalize()
    pos.addScaledVector(dir, this.speed * dt)

    // 计算水平面上的朝向角（yaw），并缓慢插值更新旋转
    const yaw = Math.atan2(dir.x, dir.z)
    this.mesh.rotation.y +=
      (yaw - this.mesh.rotation.y) * Math.min(1, this.turnK * dt)
  }
}

/* ---------- 单人回合控制 ---------- */

// 绿色 Agent（单人训练用）
const agentSolo = new Agent(0x00d084)

/**
 * 单人回合的状态结构：
 * - running / paused / finished：状态标志
 * - tStart: 当前（或最近一次恢复运行时）的起始时间戳
 * - tAccum: 累积运行时间（不含暂停段）
 * - pathLen: 本局路径长度
 * - lastTimeMs: 上一次完成用时（毫秒）
 */
let episode = {
  running: false,
  paused: false,
  finished: false,
  tStart: 0,
  tAccum: 0,
  pathLen: 0,
  lastTimeMs: 0
}

/**
 * 计算路径点数组的总长度。
 * @param {THREE.Vector3[]} pts
 */
function computePathLength (pts) {
  if (!pts || pts.length < 2) return 0
  let L = 0
  for (let i = 0; i < pts.length - 1; i++) {
    L += pts[i].distanceTo(pts[i + 1])
  }
  return L
}

/**
 * 开始一局单人回合。
 * 前提：已经成功寻路（lastPathPoints 有效）。
 */
function startEpisode () {
  if (!lastPathPoints || lastPathPoints.length < 2) {
    alert('请先完成寻路。')
    return
  }

  agentSolo.resetToStart()
  if (!agentSolo.start()) {
    alert('未找到可用路径')
    return
  }

  episode = {
    running: true,
    paused: false,
    finished: false,
    tStart: performance.now(),
    tAccum: 0,
    pathLen: computePathLength(lastPathPoints),
    lastTimeMs: 0
  }
}

/**
 * 切换单人回合的暂停/继续。
 * - 暂停：停止 Agent，记录已经经过的时间到 tAccum。
 * - 恢复：重新设置 tStart，为下一次开始计时做准备。
 */
function togglePause () {
  if (!episode.running && !episode.paused) return

  if (!episode.paused) {
    // 正在运行 → 暂停
    agentSolo.stop()
    episode.paused = true
    episode.tAccum += performance.now() - episode.tStart
  } else {
    // 已暂停 → 恢复
    agentSolo.running = true
    episode.paused = false
    episode.tStart = performance.now()
  }
}

/**
 * 重置单人回合状态（不记录成绩）。
 */
function resetEpisode () {
  episode.running = false
  episode.paused = false
  episode.finished = false
  episode.tAccum = 0
  episode.lastTimeMs = 0
  agentSolo.resetToStart()
  agentSolo.mesh.visible = false
}

/**
 * 将单人回合的结果保存到 localStorage('ai_runs')。
 * 格式：
 *   { timeMs, pathLen, ts }
 */
function saveSoloResult (timeMs) {
  const rec = {
    timeMs: Math.round(timeMs),
    pathLen: Number(episode.pathLen.toFixed(3)),
    ts: Date.now()
  }
  const key = 'ai_runs'
  const arr = JSON.parse(localStorage.getItem(key) || '[]')
  arr.push(rec)
  localStorage.setItem(key, JSON.stringify(arr))
}

/* ---------- A/B 竞速 ---------- */

// 两个带不同参数的 Agent，蓝 & 橙
const agentA = new Agent(0x00b0ff)  // 蓝
const agentB = new Agent(0xff6d00)  // 橙
agentA.speed = 3.0; agentA.turnK = 10
agentB.speed = 2.8; agentB.turnK = 12

/**
 * A/B 竞速状态结构：
 * - running / paused：是否在跑 / 是否暂停
 * - finishedA / finishedB：A/B 是否到达终点
 * - tStartA / tStartB：A/B 最近一次开始计时的时间戳
 * - tAccumA / tAccumB：A/B 累积用时
 * - timeA / timeB：A/B 完成时的总用时（固定值）
 * - pathLen：本局所使用路径的长度
 */
let race = {
  running: false,
  paused: false,
  finishedA: false,
  finishedB: false,
  tStartA: 0,
  tStartB: 0,
  tAccumA: 0,
  tAccumB: 0,
  timeA: 0,
  timeB: 0,
  pathLen: 0
}

/**
 * 开始一局 A/B 竞速。
 */
function raceStart () {
  if (!lastPathPoints || lastPathPoints.length < 2) {
    alert('请先完成寻路。')
    return
  }
  agentA.resetToStart()
  agentB.resetToStart()
  if (!agentA.start() || !agentB.start()) {
    alert('未找到可用路径')
    return
  }

  race = {
    running: true,
    paused: false,
    finishedA: false,
    finishedB: false,
    tStartA: performance.now(),
    tStartB: performance.now(),
    tAccumA: 0,
    tAccumB: 0,
    timeA: 0,
    timeB: 0,
    pathLen: computePathLength(lastPathPoints)
  }
}

/**
 * 切换竞速的暂停/继续。
 * - 暂停：停止 A/B，记录已经过的时间。
 * - 恢复：重新设置 tStart*。
 */
function racePauseToggle () {
  if (!race.running && !race.paused) return

  if (!race.paused) {
    // 正在运行 → 暂停
    agentA.stop()
    agentB.stop()
    race.paused = true
    const now = performance.now()
    race.tAccumA += now - race.tStartA
    race.tAccumB += now - race.tStartB
  } else {
    // 已暂停 → 恢复
    agentA.running = true
    agentB.running = true
    race.paused = false
    race.tStartA = performance.now()
    race.tStartB = performance.now()
  }
}

/**
 * 重置竞速状态（不记录成绩）。
 */
function raceReset () {
  race.running = false
  race.paused = false
  race.finishedA = race.finishedB = false
  race.tAccumA = race.tAccumB = 0
  race.timeA = race.timeB = 0
  agentA.resetToStart()
  agentB.resetToStart()
  agentA.mesh.visible = false
  agentB.mesh.visible = false
}

/**
 * 将 A/B 竞速结果保存到 localStorage('ai_dual_runs')。
 * 格式：
 *   {
 *     A: { timeMs },
 *     B: { timeMs },
 *     winner: 'A' | 'B' | 'tie',
 *     pathLen,
 *     ts
 *   }
 */
function saveRaceResult () {
  const winner =
    race.timeA === race.timeB
      ? 'tie'
      : (race.timeA < race.timeB ? 'A' : 'B')

  const rec = {
    A: { timeMs: Math.round(race.timeA) },
    B: { timeMs: Math.round(race.timeB) },
    winner,
    pathLen: Number(race.pathLen.toFixed(3)),
    ts: Date.now()
  }
  const key = 'ai_dual_runs'
  const arr = JSON.parse(localStorage.getItem(key) || '[]')
  arr.push(rec)
  localStorage.setItem(key, JSON.stringify(arr))
}

/* ---------- 放置 / 选择 / 拖动 / 删除交互 ---------- */

// pointerdown：记录起始坐标，用于区分点击和拖拽；
// 同时支持 Shift + 单击开始拖动障碍物。
renderer.domElement.addEventListener('pointerdown', (ev) => {
  downPos = { x: ev.clientX, y: ev.clientY }

  // Shift + 鼠标按下：若命中障碍物，则进入拖动模式
  if (!placingMode && ev.shiftKey) {
    const obj = pickObstacle(ev)
    if (obj) {
      isDragging = true
      draggingObstacle = obj
      selectObstacle(obj)
      controls.enabled = false // 拖动时禁用相机旋转
      updateCursor()
    }
  }
})

// pointermove：若处于“拖动状态”，更新障碍物位置到鼠标所在地面点
renderer.domElement.addEventListener('pointermove', (ev) => {
  if (!isDragging || !draggingObstacle) return
  const p = pickOnFloor(ev)
  if (p) draggingObstacle.position.set(p.x, 1.0, p.z)
})

// pointerup：结束拖动
renderer.domElement.addEventListener('pointerup', () => {
  if (isDragging) {
    isDragging = false
    draggingObstacle = null
    controls.enabled = true // 恢复相机控制
    updateCursor()
  }
})

// click：根据当前模式确定行为：
// 1. 放置模式：在地面上放置 Box / Start / End。
// 2. 普通模式：Ctrl+点击删除障碍物，否则切换选中状态。
renderer.domElement.addEventListener('click', (ev) => {
  if (ev.button !== 0) return // 只处理左键

  // 若 pointerdown 和 pointerup 距离太大，则认为是“拖动”，不算点击
  if (downPos) {
    const dx = ev.clientX - downPos.x
    const dy = ev.clientY - downPos.y
    if (Math.hypot(dx, dy) > 5) return
  }

  // === 1) 放置模式 ===
  if (placingMode) {
    const p = pickOnFloor(ev)
    if (!p) return

    if (placingMode === 'box') {
      // 放置障碍物
      addObstacleAt(p)
    } else if (placingMode === 'start') {
      // 放置/更新起点标记
      if (!startMarker) {
        startMarker = makeMarker(0x22cc88)
        scene.add(startMarker)
      }
      startMarker.position.set(p.x, 0.25, p.z)
      placingMode = null
      updateCursor()
    } else if (placingMode === 'end') {
      // 放置/更新终点标记
      if (!endMarker) {
        endMarker = makeMarker(0xff5555)
        scene.add(endMarker)
      }
      endMarker.position.set(p.x, 0.25, p.z)
      placingMode = null
      updateCursor()
    }
    return
  }

  // === 2) 非放置模式：删除 / 选择 ===
  const obj = pickObstacle(ev)
  if (obj) {
    if (ev.ctrlKey) {
      // Ctrl + 点击：快速删除
      deleteObstacle(obj)
    } else {
      // 普通点击：切换选中 / 取消选中
      selectObstacle(obj === selectedObstacle ? null : obj)
    }
  } else {
    // 点到空白区域：取消选中
    selectObstacle(null)
  }
})

// 全局键盘事件：
// - Escape：退出放置模式
// - Delete / Backspace：删除当前选中障碍物
const keydownHandler = (e) => {
  if (e.key === 'Escape') {
    placingMode = null
    updateCursor()
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && selectedObstacle) {
    e.preventDefault()
    deleteObstacle(selectedObstacle)
    selectedObstacle = null
  }
}
window.addEventListener('keydown', keydownHandler)
document.addEventListener('keydown', keydownHandler)

/* ---------- UI 绑定（按钮） ---------- */

document.getElementById('btnAddBox').onclick = () => {
  placingMode = (placingMode === 'box') ? null : 'box'
  updateCursor()
}
document.getElementById('btnSetStart').onclick = () => {
  placingMode = (placingMode === 'start') ? null : 'start'
  updateCursor()
}
document.getElementById('btnSetEnd').onclick = () => {
  placingMode = (placingMode === 'end') ? null : 'end'
  updateCursor()
}
document.getElementById('btnBake').onclick = () => bakeNavMesh()
document.getElementById('btnFind').onclick = () => { findPathAndDraw() }

document.getElementById('btnClear').onclick = () => {
  // 清空所有状态与几何
  placingMode = null
  updateCursor()
  obstacles.forEach(m => scene.remove(m))
  obstacles.length = 0
  selectObstacle(null)

  if (startMarker) { scene.remove(startMarker); startMarker = null }
  if (endMarker)   { scene.remove(endMarker);   endMarker = null }
  if (pathLine)    { scene.remove(pathLine);    pathLine = null }
  if (navHelper)   { scene.remove(navHelper);   navHelper = null }

  navQuery = null
  lastPathPoints = null

  agentSolo.stop(); agentSolo.mesh.visible = false
  raceReset()
  agentA.mesh.visible = false
  agentB.mesh.visible = false
}

/* 单人回合按钮 */
document.getElementById('btnRun').onclick   = () => startEpisode()
document.getElementById('btnPause').onclick = () => togglePause()
document.getElementById('btnReset').onclick = () => resetEpisode()

/* 竞速按钮 */
document.getElementById('btnRace').onclick       = () => raceStart()
document.getElementById('btnRacePause').onclick  = () => racePauseToggle()
document.getElementById('btnRaceReset').onclick  = () => raceReset()

/* ---------- HUD（信息面板） ---------- */

// 小工具：根据 id 获取元素
const $ = (id) => document.getElementById(id)

// HUD 中各个文本元素（显示障碍数量、Nav 状态、路径长度、用时等）
const hud = {
  obs: $('hudObs'),
  nav: $('hudNav'),
  pathLen: $('hudPathLen'),
  pts: $('hudPts'),
  soloStatus: $('hudSoloStatus'),
  soloSpeed: $('hudSoloSpeed'),
  soloTime: $('hudSoloTime'),
  raceA: $('hudRaceA'),
  raceB: $('hudRaceB'),
  winner: $('hudWinner')
}

/**
 * 将毫秒数格式化为“xxx ms”或“x.xx s”。
 */
function fmtMs (ms) {
  if (!ms || ms <= 0) return '0 ms'
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(2)} s`
}

/**
 * 每帧更新 HUD 显示的数据。
 * @param {number} nowMs - 当前时间戳（performance.now）
 */
function updateHUD (nowMs) {
  // 障碍物数量
  hud.obs.textContent = String(obstacles.length)

  // NavMesh 是否已经生成
  const navReady = !!navQuery
  hud.nav.textContent = navReady ? '已就绪' : '未烘焙'
  hud.nav.className = `tag ${navReady ? 'ok' : 'bad'}`

  // 路径总长度 & 点数
  const len = lastPathPoints ? computePathLength(lastPathPoints) : 0
  hud.pathLen.textContent = len.toFixed(2)
  hud.pts.textContent = lastPathPoints ? String(lastPathPoints.length) : '0'

  // 单人回合速度（Agent 参数）
  hud.soloSpeed.textContent = `${agentSolo.speed.toFixed(2)} m/s`

  // 单人回合状态 + 用时
  let soloState = 'Idle'
  let soloT = 0
  if (episode.running && !episode.paused) {
    soloState = 'Running'
    soloT = episode.tAccum + (nowMs - episode.tStart)
  } else if (episode.paused) {
    soloState = 'Paused'
    soloT = episode.tAccum
  } else if (episode.finished) {
    soloState = 'Done'
    soloT = episode.lastTimeMs
  }
  hud.soloStatus.textContent = soloState
  hud.soloTime.textContent = fmtMs(soloT)

  // 竞速部分：计算 A/B 当前用时和状态
  const curA = race.finishedA
    ? race.timeA
    : race.tAccumA +
      (race.running && !race.paused ? (nowMs - race.tStartA) : 0)

  const curB = race.finishedB
    ? race.timeB
    : race.tAccumB +
      (race.running && !race.paused ? (nowMs - race.tStartB) : 0)

  const stA = race.finishedA
    ? 'Done'
    : (race.paused
        ? (race.running ? 'Paused' : 'Idle')
        : (race.running ? 'Running' : 'Idle'))

  const stB = race.finishedB
    ? 'Done'
    : (race.paused
        ? (race.running ? 'Paused' : 'Idle')
        : (race.running ? 'Running' : 'Idle'))

  hud.raceA.textContent = `${stA} — ${fmtMs(curA)}`
  hud.raceB.textContent = `${stB} — ${fmtMs(curB)}`

  // 若 A/B 都完成，则显示赢家，否则显示“—”
  hud.winner.textContent =
    (race.finishedA && race.finishedB)
      ? (race.timeA === race.timeB
          ? '平局'
          : (race.timeA < race.timeB ? 'A' : 'B'))
      : '—'
}

/* ---------- 渲染循环 & 自适应 ---------- */

// 记录上一帧时间
let lastT = performance.now()

/**
 * 浏览器窗口尺寸变化时，更新相机宽高比和渲染器尺寸。
 */
function onResize () {
  const w = root.clientWidth
  const h = root.clientHeight
  camera.aspect = w / h
  camera.updateProjectionMatrix()
  renderer.setSize(w, h)
}
window.addEventListener('resize', onResize)

/**
 * 主动画循环：
 * 1. 更新单人回合 / 竞速的 Agent 位置与状态。
 * 2. 更新 HUD。
 * 3. 更新 OrbitControls 并渲染场景。
 */
;(function animate () {
  requestAnimationFrame(animate)

  const now = performance.now()
  // 限制 dt 不超过 0.05 秒，避免卡顿时 Agent 一口气“跳太远”
  const dt = Math.min((now - lastT) / 1000, 0.05)
  lastT = now

  // === 单人回合 ===
  if (episode.running && !episode.paused && !episode.finished) {
    agentSolo.update(dt)
    if (agentSolo.done) {
      // 本局结束
      episode.finished = true
      episode.running = false
      const tUsed = episode.tAccum + (performance.now() - episode.tStart)
      episode.lastTimeMs = tUsed
      saveSoloResult(tUsed)
      console.log(
        `单人回合完成：${Math.round(tUsed)} ms，路径 ${episode.pathLen.toFixed(3)} m`
      )
    }
  }

  // === A/B 竞速 ===
  if (race.running && !race.paused) {
    if (!race.finishedA) agentA.update(dt)
    if (!race.finishedB) agentB.update(dt)

    const nowMs = performance.now()
    if (!race.finishedA && agentA.done) {
      race.finishedA = true
      race.timeA = race.tAccumA + (nowMs - race.tStartA)
      console.log(`A 到达：${Math.round(race.timeA)} ms`)
    }
    if (!race.finishedB && agentB.done) {
      race.finishedB = true
      race.timeB = race.tAccumB + (nowMs - race.tStartB)
      console.log(`B 到达：${Math.round(race.timeB)} ms`)
    }

    // 两者都到达终点 → 竞速结束，保存结果
    if (race.finishedA && race.finishedB) {
      race.running = false
      saveRaceResult()
      console.log(
        `竞速完成，A=${Math.round(race.timeA)}ms，B=${Math.round(race.timeB)}ms`
      )
    }
  }

  controls.update()
  renderer.render(scene, camera)
  updateHUD(now)
})()
