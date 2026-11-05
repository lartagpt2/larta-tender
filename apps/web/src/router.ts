import { createRouter, createWebHistory } from 'vue-router';
import { screens } from './navigation';
import WorkspacePage from './WorkspacePage.vue';
export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/tenders' },
    ...screens.map((screen) => ({ path: screen.path, component: WorkspacePage, props: { screen } })),
    {
      path: '/:pathMatch(.*)*',
      component: WorkspacePage,
      props: {
        screen: {
          code: '404',
          title: 'Страница не найдена',
          subtitle: 'Проверьте адрес страницы',
          empty: 'Такой страницы нет',
          description: 'Вернитесь в список тендеров.',
          icon: 'pi-compass',
          next: '/tenders',
          action: 'К тендерам',
        },
      },
    },
  ],
});
