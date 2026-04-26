# Testing

テストは **レイヤー × 目的** の 2 軸で分類する。高速に回す unit 層と、実 DB で
concurrent / OCC 挙動を検証する integration 層を分けることで、日常の開発
ループを軽く保ちつつ adapter の落とし穴を継続的にカバーする。

## テスト層の分類

### Unit (`pnpm test:unit`)

- **対象**: domain 層 + application 層のロジック。
- **依存**: in-memory fake repository (`app/core/application/__tests__/fakes/`)。
  `FakeTodoRepository` / `FakeOutboxRepository` / `FakeUnitOfWorkProvider` /
  `FakeClock` / `FakeLogger` を提供する。
- **狙い**: 振る舞いの確認、エラーコード分岐、イベント emit、バリデーション。
- **速度**: 数ミリ秒〜十数ミリ秒。Vitest の `--exclude '**/*.integration.test.ts'` で
  integration をスキップする。
- **命名**: `**/__tests__/<target>.test.ts`（例: `todo.test.ts`）。

### Integration (`pnpm test:integration`)

- **対象**: Drizzle SQLite アダプタ実装、adapter × application 連携、
  concurrent / OCC（optimistic concurrency control）シナリオ、outbox の
  poll / dispatch 挙動。
- **依存**: 実 SQLite（in-memory）。`setupTestContainer()` が
  `:memory:` 上に migration を流したコンテナを組み、afterEach で client を
  close する。
- **狙い**: transaction rollback、adapter 内蔵の `SQLITE_BUSY` リトライ、
  `OptimisticLockFailure`、outbox の `listPending` / `markProcessed` を
  リアルに確認する。
- **速度**: unit の 10 倍程度。普段は `pnpm test:unit` で回し、adapter を
  触ったときや PR 前に `pnpm test:integration` を流す。
- **命名**: `**/__tests__/<target>.integration.test.ts`（例: `todo.integration.test.ts`,
  `todoRepository.integration.test.ts`, `outboxRepository.integration.test.ts`）。

### Property-based (fast-check)

- **対象**: value object の不変条件、entity の状態遷移、ランダム入力で
  落ちるエッジケース。
- **依存**: `fast-check`（devDependency）。
- **狙い**: 「trim 後に長さが 1-140 なら必ず受理される」「toggle を 2 回
  かけると元の状態に戻る」「change status が同じ入力で冪等」等を数百サンプルで自動検証する。
- **使う場面**: 境界値（TitleEmpty / TitleTooLong）、状態遷移（active ⇄
  completed）、不変条件（`version` の単調増加）。独自の arbitrary は必要最小限に
  とどめ、`fc.string()` / `fc.integer()` の組み合わせで書けるものはそれで済ます。
- **命名**: `**/__tests__/<target>.property.test.ts`（例:
  `valueObject.property.test.ts`, `entity.property.test.ts`）。

## Fake repository 方針

`app/core/application/__tests__/fakes/` に在庫する。

- **実装の形**: `Map<Id, Entity>` + 配列で outbox 行を保持する素朴な in-memory
  実装。port interface にだけ合わせる。
- **制約**: transaction を **模倣しない**。`run` のコールバック内で
  throw しても、既に書いた Map 変更は巻き戻らない（即 commit 等価）。concurrent
  writer レース、`SQLITE_BUSY`、OCC violation などアダプタ起因の挙動は再現
  できない。
- **使う場面**: application service 層のロジックテスト、event emit の検証、
  入力バリデーション確認。rollback や並行性の検証は integration 層に寄せる。
- **セットアップ**: `setupFakeTestContainer()` が `beforeEach` で
  `FakeUnitOfWorkProvider` を差し込んだコンテナを用意する。afterEach は不要
  （毎テスト丸ごと再構築する）。

```typescript
const getContainer = setupFakeTestContainer();

it("records a todo.created event", async () => {
  const container = getContainer();
  await createTodo({ container, input: { title: "foo" } });
  expect(container.fakeUow.getRecordedEvents()).toHaveLength(1);
});
```

## Real DB test（integration）方針

- `setupTestContainer()` が `:memory:` SQLite client を作り、migration を流し、
  `DrizzleSqliteUnitOfWorkProvider(db)` の production 相当ワイヤリングで
  コンテナを返す。adapter は `SQLITE_BUSY` / `SQLITE_LOCKED` を内部で
  retry するので、application 層は transient 失敗を意識しない。
- afterEach で libsql client を close。adapter の transient retry の
  指数バックオフが乗るので `testTimeout: 15_000` を `vitest.config.ts` で
  設定している。
- concurrent / OCC を意識したテストを書くときは、`Promise.all` で
  `run` を同時発火させて `OptimisticLockFailure` を観測する、
  などのパターンを使う。

## Property-based 方針

- fast-check を採用しているのは **境界値 + 不変条件** の確認が主目的。
- ドメインの各 value object ファクトリ、entity の state transition、`toggle`
  の involution（2 回かけると元に戻る）、set 系 usecase の冪等性のような性質検査に有用。
- custom arbitrary を書く前に、既存の `fc.string()` / `fc.integer()` と `filter`
  で足りるか検討する。ドメインを fast-check に過度に依存させない。

## Timeout / flakiness

- `vitest.config.ts` は `testTimeout: 15_000`, `hookTimeout: 15_000`。
  unit は数百ミリ秒で終わるのでこの上限は実質 integration 専用。
- adapter 内蔵の transient retry のバックオフが stack すると 1 テストで
  数秒消費しうる。flaky を感じたら個別に `test.extend` / `vi.useFakeTimers` で
  時計を固定する前に、まず adapter のリトライ設定を確認する。
- 再試行のないテスト（単純な CRUD 成功パス等）がタイムアウトする場合は
  `SQLITE_BUSY` が潜んでいることが多い。integration の方で再現するか確認する。

## Commands

| 目的 | コマンド |
|---|---|
| 全部 | `pnpm test` |
| Unit だけ | `pnpm test:unit` |
| Integration だけ | `pnpm test:integration` |
| 特定ドメイン (application) | `TEST_DOMAIN=todo pnpm test:domain` |
| 特定ドメイン (domain) | `TEST_DOMAIN=todo pnpm test:domain-layer` |

## Coverage

カバレッジ値は強制しない。目安：

- **Domain**: ~100% を狙う。ロジックが局所的で FF 化しやすく、テスト漏れが
  そのまま不変条件崩壊に直結する。
- **Application (unit)**: ~80%。主要なハッピーパス + 主要なエラー分岐。
  orchestration の冗長分岐はカバレッジより「動作検証した」ことを重視する。
- **Adapter (integration)**: "代表パス" 単位。OCC 成功 / OCC 失敗、claim
  成功 / lease 失効後の再 claim、upsert の新規 / 更新など経路ごとに 1 本は用意。
- **Frontend**: 必要最小限。server function の wire 型境界と UI ロジックは
  Conform / Zod と `useServerAction` の挙動で大枠カバーされる。
