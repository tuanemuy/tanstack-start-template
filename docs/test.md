# Testing

- Use `pnpm test` for tests
- Use in-memory database for DrizzleSqlite adapters
- Only when it is difficult to use actual adapters, prepare Empty adapters and mock it using `vi.spyOn` , etc.

## Application Service Tests

- Use `app/core/application/${domain}/${usecase}.test.ts` for unit tests of application services
