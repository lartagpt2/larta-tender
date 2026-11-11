export const gold: {
  supplierName: string;
  buyerName: string;
  taxId: string;
  email: string;
  total: string;
  currency: string;
  items: {
    name: string;
    quantity: string;
    unit: string;
    unitPrice: string;
    lineTotal: string;
    delivery: string;
    page: number;
  }[];
};
export function quotePdf(scan?: boolean, discount?: number): Buffer;
