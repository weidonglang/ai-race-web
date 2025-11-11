// src/editor.js
// Three.js + recast-navigation-js（Solo NavMesh 烘焙 + 一键寻路）
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'   // 官方路径 :contentReference[oaicite:2]{index=2}

import { init, NavMeshQuery } from '@recast-navigation/core'
import { generateSoloNavMesh } from '@recast-navigation/generators'
import { NavMeshHelper } from '@recast-navigation/three'
// ↑ 官方文档：init / generateSoloNavMesh / NavMeshQuery / NavMeshHelper 的用法与参数说明。:contentReference[oaicite:3]{index=3}

const root = document.getElementById('viewport')

// === 基础 three.js 场景 ===
const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setSize(root.clientWidth, root.clientHeight)
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
root.appendChild(renderer.domElement)

const scene = new THREE.Scene()
scene.background = new THREE.Color('#0f1115')

const camera = new THREE.PerspectiveCamera(60, root.clientWidth / root.clientHeight, 0.1, 1000)
camera.position.set(10, 12, 18)

const controls = new OrbitControls(camera, renderer.domElement)
controls.enableDamping = true

// 光照
scene.add(new THREE.HemisphereLight(0xffffff, 0x222233, 0.7))
const dir = new THREE.DirectionalLight(0xffffff, 0.8); dir.position.set(6, 10, 6); scene.add(dir)

// 地面 + 网格
const FLOOR_SIZE = 30
const floorGeo = new THREE.PlaneGeometry(FLOOR_SIZE, FLOOR_SIZE, 1, 1)
floorGeo.rotateX(-Math.PI / 2)
const floor = new THREE.Mesh(
  floorGeo,
  new THREE.MeshStandardMaterial({ color: 0x2b2f3a, metalness: 0.0, roughness: 1.0 })
)
floor.receiveShadow = true
floor.name = 'Floor'
scene.add(floor)
const grid = new THREE.GridHelper(FLOOR_SIZE, FLOOR_SIZE, 0x444a57, 0x303543)
grid.position.y = 0.01
scene.add(grid)

// 交互状态
const raycaster = new THREE.Raycaster()
const mouseNDC = new THREE.Vector2()
let placingMode = null         // 'box' | 'start' | 'end'
const obstacles = []           // THREE.Mesh[]
let startMarker = null         // THREE.Mesh
let endMarker = null           // THREE.Mesh
let navQuery = null            // NavMeshQuery
let navHelper = null           // NavMeshHelper
let pathLine = null            // THREE.Line

function makeMarker(color) {
  const m = new THREE.Mesh(
    new THREE.SphereGeometry(0.25, 24, 16),
    new THREE.MeshStandardMaterial({ color })
  )
  m.castShadow = true
  return m
}

function addObstacleAt(point) {
  const box = new THREE.Mesh(
    new THREE.BoxGeometry(2, 2, 2),
    new THREE.MeshStandardMaterial({ color: 0x8b5cf6, metalness: 0.2, roughness: 0.8 })
  )
  box.position.copy(point).y = 1.0
  box.castShadow = true
  box.receiveShadow = true
  box.name = 'Obstacle'
  scene.add(box)
  obstacles.push(box)
}

function pickOnFloor(ev) {
  const rect = renderer.domElement.getBoundingClientRect()
  mouseNDC.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1
  mouseNDC.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1
  raycaster.setFromCamera(mouseNDC, camera)
  const hit = raycaster.intersectObject(floor, false)[0]
  return hit ? hit.point : null
}

renderer.domElement.addEventListener('pointerdown', (ev) => {
  const p = pickOnFloor(ev)
  if (!p) return
  if (placingMode === 'box') {
    addObstacleAt(p)
  } else if (placingMode === 'start') {
    if (!startMarker) { startMarker = makeMarker(0x22cc88); scene.add(startMarker) }
    startMarker.position.copy(p).y = 0.25
  } else if (placingMode === 'end') {
    if (!endMarker) { endMarker = makeMarker(0xff5555); scene.add(endMarker) }
    endMarker.position.copy(p).y = 0.25
  }
})

// 将地面+障碍转为 positions / indices（右手坐标 & CCW）
function getPositionsAndIndicesFromMeshes(meshes) {
  const positions = []
  const indices = []
  let indexOffset = 0

  for (const mesh of meshes) {
    const geom = mesh.geometry.clone()
    geom.applyMatrix4(mesh.matrixWorld)
    const nonIdx = geom.index ? geom.toNonIndexed() : geom
    const arr = nonIdx.getAttribute('position').array
    // push 顶点
    for (let i = 0; i < arr.length; i += 3) {
      positions.push(arr[i + 0], arr[i + 1], arr[i + 2])
    }
    // 顺序索引（每 3 个点一个三角形）
    const triCount = arr.length / 9
    for (let t = 0; t < triCount; t++) {
      indices.push(indexOffset + t * 3 + 0)
      indices.push(indexOffset + t * 3 + 1)
      indices.push(indexOffset + t * 3 + 2)
    }
    indexOffset += triCount * 3
  }
  return [positions, indices]
}

// NavMesh 烘焙
async function bakeNavMesh() {
  if (navHelper) { scene.remove(navHelper); navHelper = null }
  if (pathLine) { scene.remove(pathLine); pathLine = null }

  const [positions, indices] = getPositionsAndIndicesFromMeshes([floor, ...obstacles])

  // 初始化 recast wasm（多次调用也会秒返回）
  await init() // :contentReference[oaicite:4]{index=4}

  // 常用配置（可按需调整）
  const cfg = {
    cs: 0.25,              // cell size
    ch: 0.2,               // cell height
    walkableHeight: 1.8,   // 代理身高
    walkableRadius: 0.4,   // 代理半径
    walkableClimb: 0.4,    // 可跨越台阶
    walkableSlopeAngle: 45 // 最大坡度
  }

  const { success, navMesh } = generateSoloNavMesh(positions, indices, cfg) // :contentReference[oaicite:5]{index=5}
  if (!success) {
    alert('NavMesh 生成失败，请调整参数或几何！')
    return
  }

  // 创建查询器 & 可视化
  navQuery = new NavMeshQuery(navMesh) // 有 computePath / findNearestPoly 等方法 :contentReference[oaicite:6]{index=6}
  navHelper = new NavMeshHelper(navMesh)
  scene.add(navHelper)
}

// 一键寻路（内部完成最近多边形+走廊+拉直）
function findPathAndDraw() {
  if (!navQuery || !startMarker || !endMarker) return

  const { success, path, error } = navQuery.computePath(
    { x: startMarker.position.x, y: startMarker.position.y, z: startMarker.position.z },
    { x: endMarker.position.x,   y: endMarker.position.y,   z: endMarker.position.z },
    // 也可传 { halfExtents: {x:2,y:4,z:2} } 自定义搜索范围；不传则用默认。:contentReference[oaicite:7]{index=7}
  )

  if (!success || !path || path.length < 2) {
    console.warn('computePath 失败：', error)
    alert('寻路失败：起点或终点可能不在可走区域附近')
    return
  }

  const pts = path.map(p => new THREE.Vector3(p.x, p.y + 0.05, p.z))
  const g = new THREE.BufferGeometry().setFromPoints(pts)
  const m = new THREE.LineBasicMaterial({ linewidth: 2, color: 0x00e5ff })
  if (pathLine) scene.remove(pathLine)
  pathLine = new THREE.Line(g, m)
  scene.add(pathLine)
}

// 绑定 UI
document.getElementById('btnAddBox').onclick  = () => placingMode = 'box'
document.getElementById('btnSetStart').onclick = () => placingMode = 'start'
document.getElementById('btnSetEnd').onclick   = () => placingMode = 'end'
document.getElementById('btnBake').onclick     = () => bakeNavMesh()
document.getElementById('btnFind').onclick     = () => findPathAndDraw()
document.getElementById('btnClear').onclick    = () => {
  placingMode = null
  obstacles.forEach(m => scene.remove(m)); obstacles.length = 0
  if (startMarker) scene.remove(startMarker), startMarker = null
  if (endMarker) scene.remove(endMarker), endMarker = null
  if (pathLine) scene.remove(pathLine), pathLine = null
  if (navHelper) scene.remove(navHelper), navHelper = null
  navQuery = null
}

// 渲染循环与自适应
function onResize() {
  const w = root.clientWidth, h = root.clientHeight
  camera.aspect = w / h
  camera.updateProjectionMatrix()
  renderer.setSize(w, h)
}
window.addEventListener('resize', onResize)

;(function animate(){
  requestAnimationFrame(animate)
  controls.update()
  renderer.render(scene, camera)
})()
