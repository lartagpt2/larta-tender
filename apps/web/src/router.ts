import TenderList from './TenderList.vue';
import TenderCreate from './TenderCreate.vue';
import TenderDetail from './TenderDetail.vue';
import DocumentsPage from './DocumentsPage.vue';
import { createRouter, createWebHistory } from 'vue-router';
import { screens } from './navigation';
import WorkspacePage from './WorkspacePage.vue';
export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/tenders' },
    { path: '/tenders', component: TenderList },
    { path: '/tenders/new', component: TenderCreate },
    { path: '/tenders/:id', component: TenderDetail },
    { path: '/documents', component: DocumentsPage },
    ...screens
      .filter((s) => !['S01', 'S02', 'S03'].includes(s.code))
      .map((screen) => ({ path: screen.path, component: WorkspacePage, props: { screen } })),
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
