// 一个非常简单的计数器示例，用于演示“模块导出 + DOM 交互”的最小案例。
// 在本项目中基本没有实质性逻辑，只是保留作为教学用 / 模板代码。
export function setupCounter (element) {
  // 内部计数值，初始为 0
  let counter = 0

  /**
   * 内部工具函数：更新计数值并刷新 DOM 内容。
   * @param {number} count - 要设置的最新计数值
   */
  const setCounter = (count) => {
    counter = count
    // 将最新的计数值渲染到传入的 DOM 元素上
    element.innerHTML = `count is ${counter}`
  }

  // 点击元素时，计数 +1
  element.addEventListener('click', () => setCounter(counter + 1))

  // 初始化：页面首次渲染时显示 0
  setCounter(0)
}

