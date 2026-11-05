import { createApp } from 'vue';
import { VueQueryPlugin } from '@tanstack/vue-query';
import PrimeVue from 'primevue/config';
import Aura from '@primeuix/themes/aura';
import 'primeicons/primeicons.css';
import App from './App.vue';
import { router } from './router';
import './style.css';
createApp(App)
  .use(router)
  .use(VueQueryPlugin)
  .use(PrimeVue, { theme: { preset: Aura, options: { darkModeSelector: '.app-dark' } } })
  .mount('#app');
