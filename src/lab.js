import $ from 'jquery'
import 'jquery-validation'

$('#trainForm').validate({
  rules: {
    mapSize:  { required: true, min: 10, max: 200 },
    episodes: { required: true, min: 1,  max: 1000 },
    lr:       { required: true, min: 0,   max: 1 },
    vmax:     { required: true, min: 0.1, max: 20 }
  },
  messages: {
    mapSize:  '10~200 之间',
    episodes: '1~1000 之间',
    lr:       '0~1 之间',
    vmax:     '0.1~20 之间'
  },
  submitHandler: function(form) {
    const data = Object.fromEntries(new FormData(form).entries())
    localStorage.setItem('ai_lab_params', JSON.stringify(data))
    document.getElementById('saveHint').textContent = '参数已保存（本地浏览器）'
    return false
  }
})
