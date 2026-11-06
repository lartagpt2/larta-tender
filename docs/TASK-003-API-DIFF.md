# TASK-003 OpenAPI changes

Generated contract: [OpenAPI JSON](./openapi-TASK-003.json).

API version 1.0 → 1.1. Existing GET /api/health is unchanged. This is the foundation contract; no frontend persistence is connected in TASK-003.

| Added route                | Contract                                                                       | Authorization / audit                                              |
| -------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| GET /api/tenders           | Up to 100 newest visible TenderDto rows                                        | Owner/member; no sensitive fields                                  |
| POST /api/tenders          | CreateTenderDto {title}, 1–300 characters, nonblank; returns TenderDto and 201 | Server-configured actor owns new tender; audit in same transaction |
| GET /api/tenders/{id}      | TenderDto {id,title,revision}                                                  | Owner/member; absent/inaccessible → 404                            |
| GET /api/tenders/{id}/lots | LotDto[] {id,name,ordinal}, ordered                                            | Same SQL-statement access filter                                   |

UUID parameters are validated; extra request fields and invalid titles → 400; absent/incorrect development token → 401; disabled data access → 503. All errors keep a server-generated correlationId and omit exception/SQL contents. API access is disabled by default and always disabled in production until corporate authentication is implemented. Bearer scheme is included in OpenAPI; token values are never included.

OpenAPI JSON remains opt-in, nonproduction only at /api/openapi.json. Tests assert the actual generated specification contains the new routes. DTOs use explicit runtime validation for tsx and emitDecoratorMetadata builds alike.

Other domain routes in [DOMAIN_API](./DOMAIN_API.md) are planned contracts, not available endpoints. No placeholder endpoint claims to upload, extract, confirm, compare, send mail or save an offer. The repository receipt helper is internal and is not a binary upload API. Typed minimal domain projections live in [models](../apps/api/src/data/models.ts); the complete schema is in the proposed migration.
