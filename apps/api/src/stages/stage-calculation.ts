import { discount } from '../comparison/calculation';
export interface CommercialPrice {
  amount: string | null;
  currency: string | null;
  vatMode: string;
}
export interface CommercialResponse {
  status: 'received' | 'no_reply' | 'withdrawn' | 'pending';
  price?: CommercialPrice;
}
export function stagePrice(previous: CommercialPrice | null, response: CommercialResponse) {
  const current =
    response.status === 'received'
      ? (response.price ?? null)
      : response.status === 'withdrawn'
        ? null
        : previous;
  const sameBasis =
    previous && current && previous.currency === current.currency && previous.vatMode === current.vatMode;
  return {
    current,
    discount:
      response.status === 'no_reply' && previous?.amount !== null && previous
        ? '0'
        : response.status === 'received' && sameBasis
          ? discount(previous.amount, current.amount)
          : null,
    status: response.status,
  };
}
