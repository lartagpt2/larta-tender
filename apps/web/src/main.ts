import { createApp } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import { VueQueryPlugin } from '@tanstack/vue-query';
import PrimeVue from 'primevue/config';
import Aura from '@primeuix/themes/aura';
import 'primeicons/primeicons.css';
import App from './App.vue';
import './style.css';
const router = createRouter({
  history: createWebHistory(),
  routes: [{ path: '/:pathMatch(.*)*', component: { template: '<span />' } }],
});
createApp(App)
  .use(router)
  .use(VueQueryPlugin)
  .use(PrimeVue, { theme: { preset: Aura } })
  .mount('#app');
