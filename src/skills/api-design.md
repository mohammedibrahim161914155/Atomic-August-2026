---
skill: api-design
domains: [api, rest, graphql, rate-limiting, versioning]
applies_to: [planning, integration, production]
priority: high
---

# API Design Skill

## REST API Conventions

### URL Design
- Resource-first: `/api/v1/users`, `/api/v1/users/:id/orders`
- Plural nouns only: `/users` not `/user`
- Kebab-case for multi-word: `/api/v1/payment-methods`
- Nested only one level deep: `/users/:id/orders` ✓, `/users/:id/orders/:id/items` ✗ (use `/order-items/:id`)
- Actions as sub-resources: `POST /users/:id/activate` not `PUT /users/:id?active=true`

### HTTP Methods & Status Codes
| Method | Semantic | Idempotent | Status Codes |
|--------|----------|------------|--------------|
| GET    | Read     | ✓          | 200, 404, 304 |
| POST   | Create   | ✗          | 201+Location, 400, 409 |
| PUT    | Replace  | ✓          | 200, 204, 404 |
| PATCH  | Modify   | ✗          | 200, 400, 404 |
| DELETE | Remove   | ✓          | 204, 404, 409 |

### Request/Response Envelope
```typescript
// Success — single resource
{ "data": { ...resource }, "meta": { "requestId": "..." } }

// Success — collection
{ "data": [...], "pagination": { "cursor": "...", "hasMore": true }, "meta": { "total": 1234 } }

// Error
{ "error": { "code": "VALIDATION_ERROR", "message": "Email is invalid", "field": "email" }, "meta": { "requestId": "..." } }
```

## Rate Limiting

### Headers (follow GitHub's convention)
```
X-RateLimit-Limit: 1000
X-RateLimit-Remaining: 999
X-RateLimit-Reset: 1714000000
Retry-After: 60  (only on 429)
```

### Algorithm
- **Token bucket**: burst-friendly, good for API clients
- **Sliding window**: fairer under sustained load
- **Fixed window**: simple but allows burst at window boundary

### Tier Design (common defaults)
| Tier | Requests/min | Max Burst |
|------|-------------|-----------|
| Free | 10 | 20 |
| Pro | 100 | 200 |
| Enterprise | 1000 | 2000 |
| Internal | 10000 | 20000 |

## API Versioning

### URL Prefix (recommended for most APIs)
`/api/v1/`, `/api/v2/` — explicit, easy to route, easy to deprecate

### Deprecation Policy
1. Add `Sunset` header with deprecation date: `Sunset: Sat, 31 Dec 2025 23:59:59 GMT`
2. Add `Deprecation` header (RFC 8594): `Deprecation: Tue, 01 Jan 2025 00:00:00 GMT`
3. Log all requests to deprecated endpoints with a warning
4. 6-month deprecation window minimum for breaking changes

## Input Validation

```typescript
// Use Zod for all request validation — never trust raw req.body
const CreateUserSchema = z.object({
  email: z.string().email().max(320).toLowerCase(),
  name: z.string().min(1).max(100).trim(),
  role: z.enum(['user', 'admin']).default('user'),
});

// Validate in route handler
const body = CreateUserSchema.safeParse(req.body);
if (!body.success) {
  return res.status(400).json({ error: { code: 'VALIDATION_ERROR', issues: body.error.flatten() } });
}
```

## Pagination

### Cursor-Based (recommended for large datasets)
```typescript
// Request: GET /users?cursor=eyJpZCI6MTIzfQ&limit=20
// Response:
{
  "data": [...],
  "pagination": {
    "cursor": "eyJpZCI6MTQ0fQ",  // opaque base64url cursor
    "hasMore": true,
    "limit": 20
  }
}
```

### Offset-Based (acceptable for small, stable datasets)
```typescript
// Request: GET /users?offset=40&limit=20
// Response: { "data": [...], "pagination": { "total": 1234, "offset": 40, "limit": 20 } }
```

## Idempotency

For mutation endpoints (POST), support the `Idempotency-Key` header:
```typescript
// Client sends: Idempotency-Key: unique-uuid-per-request
// Server: check Redis/DB for existing response with this key
// If found: return cached response (status 200/201)
// If not: process request, cache response with 24h TTL
```

Always return the same response for the same idempotency key, including status code.

## Error Handling Anti-Patterns

- **Never** return a 200 with `{ success: false }` — use the correct 4xx/5xx status
- **Never** expose internal stack traces in production error responses
- **Never** use different error shapes for different endpoints
- **Always** include a `code` (machine-readable) AND `message` (human-readable) in errors
- **Always** log the request ID so errors can be traced in logs
