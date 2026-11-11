import TenderStages from './TenderStages.vue';
import OfferReview from './OfferReview.vue';
import OfferComparison from './OfferComparison.vue';
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
    { path: '/review', component: OfferReview },
    { path: '/comparison', component: OfferComparison },
    { path: '/stages', component: TenderStages },
    { path: '/accreditation', component: TenderStages, props: { accreditation: true } },
    ...screens
      .filter((s) => !['S01', 'S02', 'S03', 'S04', 'S05', 'S06', 'S07'].includes(s.code))
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
