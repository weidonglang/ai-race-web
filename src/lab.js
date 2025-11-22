// src/lab.js
// AI 实验室 · RL 超参数控制台逻辑
//
// 这个文件只做一件事：
//  —— 管理“RL 超参数表单”的读取 / 校验 / 保存。
// 不直接跑训练、不画 3D，只是一个“配置面板”的前端逻辑。
//
// 功能拆解：
//   1. 使用 jquery-validation 对表单做前端校验
//      （课程要求的“表单 + 校验”示例就在这里实现）
//   2. 把用户填写的 RL 超参数保存到 localStorage('ai_lab_params') 中
//   3. 下次进入页面时，从 localStorage 读取并自动填充表单
//   4. Arena 页在创建 RL 智能体时，从同一个 key 读取这些超参数
//
// 注意：
//   - 本文件只负责“配置管理”，不直接启动训练；
//   - 训练逻辑在 arena_rl_core.js / arena_train.js 等文件中。

import $ from 'jquery'
import 'jquery-validation'

// 统一的 localStorage key，Arena / Dashboard 等地方也会用到它。
// 约定：
//   - Lab 页写入 'ai_lab_params'
//   - Arena 页读取 'ai_lab_params'
// 这样就实现了“把 Lab 页配置传给 Arena 页”的效果。
const LAB_KEY = 'ai_lab_params'

/**
 * 从 localStorage 中读取已经保存的实验参数。
 *
 * 设计要点：
 *   - localStorage 是浏览器提供的“本地小仓库”，以 key-value 形式保存字符串；
 *   - 这里约定 value 是一个 JSON 字符串（例如 '{"gamma":0.95,...}'）；
 *   - JSON.parse 时可能抛异常（比如被用户手动改坏了），所以需要 try-catch。
 *
 * @returns {Object} 解析后的参数对象；
 *                   如果没有保存过，或解析失败，则返回一个空对象 {}。
 */
function loadLabParams () {
  try {
    // 读取字符串，如果不存在则用 '{}' 兜底，再 parse 成对象。
    return JSON.parse(localStorage.getItem(LAB_KEY) || '{}') || {}
  } catch (e) {
    // 如果 JSON 被破坏（例如用户手改），不要让页面直接报错，
    // 用 console.warn 提示开发者，同时返回一个空对象。
    console.warn('[Lab] 解析 localStorage(ai_lab_params) 失败，将使用默认值。', e)
    return {}
  }
}

/**
 * 把当前表单数据保存到 localStorage 中。
 *
 * 使用方式：
 *   - 在表单 submit 时调用 saveLabParams(form)
 *   - 通过 FormData(form) 把 form 中所有带 name 的字段收集成一个键值对对象 data
 *   - 然后 JSON.stringify(data) 存入 localStorage
 *
 * @param {HTMLFormElement} form 原始表单节点（不是 jQuery 对象）
 */
function saveLabParams (form) {
  // FormData 能一次性把 form 里所有 <input name="..."> 的值都取出来
  const formData = new FormData(form)
  const data = {}

  // entries() 迭代出 [字段名, 字段值]
  for (const [k, v] of formData.entries()) {
    data[k] = v
  }

  try {
    // 把对象序列化为 JSON 字符串后写入 localStorage
    localStorage.setItem(LAB_KEY, JSON.stringify(data))

    // 给页面上一个提示区域（id=saveHint）写入友好提示
    $('#saveHint').text(
      '超参数已保存到 localStorage(ai_lab_params)。请刷新「对抗 Arena」页以使新的 RL 配置生效。'
    )
  } catch (e) {
    // 某些情况下浏览器可能禁止写 localStorage（隐私模式 / 容量满等），
    // 这里用 console.error 打印，并在页面上提示“保存失败”。
    console.error('[Lab] 写入 localStorage(ai_lab_params) 失败：', e)
    $('#saveHint').text('保存失败：浏览器可能禁止了本地存储。')
  }
}

/**
 * 把 “默认值 + 已保存值” 合并后填回表单。
 *
 * 逻辑：
 *   1. 写死一组“建议默认值”（第一次打开页面用它）；
 *   2. 从 localStorage 读出“已保存值”，覆盖默认值；
 *   3. 把最终合并后的对象 merged 填进表单。
 *
 * 这样可以做到：
 *   - 第一次打开就看到一组合理的参数（不会全空）；
 *   - 之后每次刷新仍然保持上次的填写结果。
 */
function fillFormWithDefaultsAndSaved () {
  // 1. 尝试读取用户之前保存的参数（可能为空）
  const saved = loadLabParams()

  // 2. 默认建议值（如果没有保存过，就用这些）
  //    这里是一个比较“温和”的 RL 超参数配置。
  const defaults = {
    gamma: 0.95,       // 折扣因子 γ，0~1 越大越“看重远期奖励”
    maxSteps: 256,     // 每局最大步数（避免 agent 卡在循环里）
    recentWindow: 100, // 统计最近 N 局时用的窗口大小

    // 智能体 A 的学习率 / 探索率设置（偏激进）
    alphaA: 0.30,          // 学习率 α_A
    epsilonStartA: 1.0,    // 初始探索率 ε0_A
    epsilonDecayA: 0.995,  // 每局后探索率衰减系数

    // 智能体 B 的学习率 / 探索率设置（偏保守）
    alphaB: 0.20,
    epsilonStartB: 0.80,
    epsilonDecayB: 0.997
  }

  // 3. 合并，已保存值覆盖默认值
  //    （后面用 merged[name] 统一给 input 赋值）
  const merged = { ...defaults, ...saved }

  // 4. 选中整个表单
  const $form = $('#trainForm')

  // 5. 遍历 merged 中的每一个键值对：
  //    - name：字段名 -> 对应 <input name="xxx">
  //    - value：要填的值
  Object.entries(merged).forEach(([name, value]) => {
    // 按 name 属性查找对应 input
    const $input = $form.find(`[name="${name}"]`)
    if ($input.length) {
      // 如果找到了，就把 value 塞进去
      $input.val(value)
    }
  })
}

/**
 * 初始化表单校验规则。
 *
 * 使用 jquery-validation 提供的 validate()：
 *   - 对每个字段写入“必须填写 / 取值范围”等规则；
 *   - 对每个字段写入一条中文错误提示；
 *   - 所有字段通过校验后，执行 submitHandler(form)。
 *
 * 优点：
 *   - 不需要自己手写很多 if/else 检查；
 *   - 错误信息会自动显示在 input 旁边；
 *   - 非常适合作为“表单 + 校验”的教学示例。
 */
function setupValidation () {
  const $form = $('#trainForm')

  $form.validate({
    // === 1. 每个字段对应的校验规则 ===
    // 名称要与 input 的 name 一致
    rules: {
      gamma: {
        required: true, // 必填
        number: true,   // 必须是数字
        min: 0,
        max: 0.999
      },
      maxSteps: {
        required: true,
        digits: true,   // 必须是整数
        min: 10,
        max: 5000
      },
      recentWindow: {
        required: true,
        digits: true,
        min: 10,
        max: 500
      },

      // A 智能体的 α / ε 配置
      alphaA: {
        required: true,
        number: true,
        min: 0,
        max: 1
      },
      epsilonStartA: {
        required: true,
        number: true,
        min: 0,
        max: 1
      },
      epsilonDecayA: {
        required: true,
        number: true,
        min: 0.8,
        max: 0.9999
      },

      // B 智能体的 α / ε 配置
      alphaB: {
        required: true,
        number: true,
        min: 0,
        max: 1
      },
      epsilonStartB: {
        required: true,
        number: true,
        min: 0,
        max: 1
      },
      epsilonDecayB: {
        required: true,
        number: true,
        min: 0.8,
        max: 0.9999
      }
    },

    // === 2. 每个字段对应的错误提示（简单中文，老师一眼能看懂） ===
    messages: {
      gamma:        'γ 需在 0 ~ 0.999 之间',
      maxSteps:     '每局最大步数建议 10 ~ 5000 之间',
      recentWindow: '统计窗口建议 10 ~ 500 之间',

      alphaA:        'α_A 需在 0 ~ 1 之间',
      epsilonStartA: 'ε0_A 需在 0 ~ 1 之间',
      epsilonDecayA: 'decay_A 建议 0.8 ~ 0.9999 之间',

      alphaB:        'α_B 需在 0 ~ 1 之间',
      epsilonStartB: 'ε0_B 需在 0 ~ 1 之间',
      epsilonDecayB: 'decay_B 建议 0.8 ~ 0.9999 之间'
    },

    /**
     * === 3. 所有字段通过校验后触发 ===
     *
     * 注意：
     *   - 这里不真正“提交到服务器”，而是拦截默认行为，
     *     改为调用 saveLabParams(form) 写 localStorage；
     *   - return false 可以阻止浏览器执行默认的页面跳转。
     */
    submitHandler: function (form) {
      saveLabParams(form)
      // 阻止表单的默认提交行为（不跳转页面）
      return false
    }
  })
}

// DOM Ready 后初始化：填充默认值 + 设置校验
// 简写形式：$(function () { ... }) 等价于 $(document).ready(...)
$(function () {
  fillFormWithDefaultsAndSaved() // 第一次打开时填入“默认值+已保存值”
  setupValidation()              // 初始化校验规则
})
