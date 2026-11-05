// Synthetic input for the local AST smoke check; no business data.
export function normalizeSupplierName(name: string): string {
  return name.trim();
}
export function supplierLabel(name: string): string {
  return normalizeSupplierName(name);
}
