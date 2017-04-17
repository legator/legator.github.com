const Post = { template: ''}
const Twitter = { template: '' }
const Main = { template: '' }

const routes = [
  { path: '/post', component: Post },
  { path: '/twitter', component: Twitter },
  { path: '/', component: Main }
]

const router = new VueRouter({
  routes
})

const app = new Vue({
  router
}).$mount('#app')