import Swiper from 'swiper'
import 'swiper/css'
import 'swiper/css/navigation'
import 'swiper/css/pagination'
import { Navigation, Pagination, A11y } from 'swiper/modules'

new Swiper('.swiper', {
  modules: [Navigation, Pagination, A11y],
  loop: true,
  spaceBetween: 24,
  slidesPerView: 1,
  navigation: { nextEl: '.swiper-button-next', prevEl: '.swiper-button-prev' },
  pagination: { el: '.swiper-pagination', clickable: true }
})
