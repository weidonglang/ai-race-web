// src/lab.js
// AI 实验室 · RL 超参数控制台逻辑
//
// 主要功能：
//   1. 使用 jquery-validation 对表单做前端校验（课程要求的“表单 + 校验”示例）
//   2. 把用户填写的 RL 超参数保存到 localStorage('ai_lab_params') 中
//   3. 下次进入页面时，从 localStorage 读取并自动填充表单
//   4. Arena 页在创建 RL 智能体时，从同一个 key 读取这些超参数
//
// 注意：本文件只负责“配置管理”，不直接启动训练。

import $ from 'jquery'
import 'jquery-validation'

// 统一的 localStorage key，Arena / Dashboard 等地方也会用到它
const LAB_KEY = 'ai_lab_params'

/**
 * 从 localStorage 中读取已经保存的实验参数。
 * 如果没有保存过，则返回一个空对象 {}。
 */
function loadLabParams () {
  try {
    return JSON.parse(localStorage.getItem(LAB_KEY) || '{}') || {}
  } catch (e) {
    console.warn('[Lab] 解析 localStorage(ai_lab_params) 失败，将使用默认值。', e)
    return {}
  }
}

/**
 * 把当前表单数据保存到 localStorage 中。
 * @param {HTMLFormElement} form 原始表单节点
 */
function saveLabParams (form) {
  const formData = new FormData(form)
  const data = {}
  for (const [k, v] of formData.entries()) {
    data[k] = v
  }

  try {
    localStorage.setItem(LAB_KEY, JSON.stringify(data))
    $('#saveHint').text(
      '超参数已保存到 localStorage(ai_lab_params)。请刷新「对抗 Arena」页以使新的 RL 配置生效。'
    )
  } catch (e) {
    console.error('[Lab] 写入 localStorage(ai_lab_params) 失败：', e)
    $('#saveHint').text('保存失败：浏览器可能禁止了本地存储。')
  }
}

/**
 * 把 “默认值 + 已保存值” 合并后填回表单。
 * - 默认值用于保证第一次打开页面时能看到合理的建议参数
 * - 已保存值用于保证刷新后仍然保持上次的配置
 */
function fillFormWithDefaultsAndSaved () {
  const saved = loadLabParams()

  // 默认建议值（如果没有保存过，就用这些）
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

  const merged = { ...defaults, ...saved }

  const $form = $('#trainForm')
  Object.entries(merged).forEach(([name, value]) => {
    const $input = $form.find(`[name="${name}"]`)
    if ($input.length) {
      $input.val(value)
    }
  })
}

/**
 * 初始化表单校验规则。
 * 使用 jquery-validation 提供的 validate()，
 * 以便在提交前先做“范围检查 + 必填检查”，并给出简短中文错误提示。
 */
function setupValidation () {
  const $form = $('#trainForm')

  $form.validate({
    // 每个字段对应的规则（名称要与 input 的 name 一致）
    rules: {
      gamma: {
        required: true,
        number: true,
        min: 0,
        max: 0.999
      },
      maxSteps: {
        required: true,
        digits: true,
        min: 10,
        max: 5000
      },
      recentWindow: {
        required: true,
        digits: true,
        min: 10,
        max: 500
      },

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

    // 每个字段对应的错误提示（简单中文，老师一眼能看懂）
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
     * 所有字段通过校验后触发。
     * 这里不真的提交到服务器，而是调用 saveLabParams() 写 localStorage。
     */
    submitHandler: function (form) {
      saveLabParams(form)
      // 阻止表单的默认提交行为（不跳转页面）
      return false
    }
  })
}

// DOM Ready 后初始化：填充默认值 + 设置校验
$(function () {
  fillFormWithDefaultsAndSaved()
  setupValidation()
})
