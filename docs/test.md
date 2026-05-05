# Testing

テストは **レイヤー × 目的** の 2 軸で分類する。高速に回す unit 層と、実 DB で
concurrent / OCC 挙動を検証する integration 層を分けることで、日常の開発
ループを軽く保ちつつ adapter の落とし穴を継続的にカバーする。

## テスト層の分類

### Unit (`pnpm test:unit`)

- **対象**: domain 層 + application 層のロジック（pure な部分）。
- **依存**: 在庫している fake は `app/core/application/__tests__/fakes/` 以下の
  `FakeIdGenerator`（決定論的 UUIDv7 ストリーム）と `FakeLogger`（記録用 Logger）
  の 2 つだけ。`Clock` はフリースタンディング関数として `now: Date` を usecase に
  渡せば良いし、リポジトリ系の fake は意図的に置いていない（in-memory fake で
  transaction / OCC を模倣しても integration の代替にはならないという判断）。
  application 層のロジックを fake で網羅することは目指さず、振る舞い検証は
  integration test に寄せる。
- **狙い**: domain 層（value object / entity / events のデコード）の不変条件、
  エラーコード分岐、`retry()` のような application-層ヘルパーの挙動確認。
- **速度**: 数ミリ秒〜十数ミリ秒。Vitest の `--exclude '**/*.integration.test.ts'` で
  integration をスキップする。
- **命名**: `**/__tests__/<target>.test.ts`（例: `entity.test.ts`, `events.test.ts`,
  `retry.test.ts`）。

### Integration (`pnpm test:integration`)

- **対象**: Drizzle SQLite アダプタ実装、adapter × application 連携、
  concurrent / OCC（optimistic concurrency control）シナリオ、outbox の
  poll / dispatch 挙動。
- **依存**: 実 SQLite（in-memory）。`setupTestContainer()` が
  `:memory:` 上に migration を流したコンテナを組み、afterEach で client を
  close する。
- **狙い**: transaction rollback、adapter 内蔵の `SQLITE_BUSY` リトライ、
  `OptimisticLockFailure`、outbox の `claimPending` / `markProcessed` を
  リアルに確認する。
- **速度**: unit の 10 倍程度。普段は `pnpm test:unit` で回し、adapter を
  触ったときや PR 前に `pnpm test:integration` を流す。
- **命名**: `**/__tests__/<target>.integration.test.ts`（例: `todo.integration.test.ts`,
  `todoRepository.integration.test.ts`, `outboxRepository.integration.test.ts`）。

### Property-based (fast-check)

- **対象**: value object の不変条件、entity の状態遷移、ランダム入力で
  落ちるエッジケース。
- **依存**: `fast-check`（devDependency）。
- **狙い**: 「trim 後に長さが 1-140 なら必ず受理される」「`complete` → `reopen`
  で元の active 状態に戻る」「change status が同じ入力で冪等」等を数百サンプルで
  自動検証する。
- **使う場面**: 境界値（TitleEmpty / TitleTooLong）、状態遷移（active ⇄
  completed）、不変条件（`version` の単調増加）。独自の arbitrary は必要最小限に
  とどめ、`fc.string()` / `fc.integer()` の組み合わせで書けるものはそれで済ます。
- **命名**: `**/__tests__/<target>.property.test.ts`（例:
  `valueObject.property.test.ts`, `entity.property.test.ts`）。

## Fake 方針

`app/core/application/__tests__/fakes/` に在庫しているのは現状以下の 2 つ：

- **`FakeIdGenerator`** — カウンタを UUIDv7 のテンプレに埋め込む形で決定論的な
  id を返す。出力は adapter 側の rehydration validation（`IdGenerator.validate`）
  を通る形になっており、storage 経由の round-trip テストでも format 検証で落ちない。
  `seed` で開始番号を固定でき、生成 id がテストの outbox 行よりも後に並ぶよう
  prefix を `f0...` にしてある（`(createdAt, id)` ソート時にテスト固定の
  `01950000-...` 系より後に来る）。
- **`FakeLogger`** — `info` / `warn` / `error` の各呼び出しを `entries` 配列に
  記録するだけ。`byLevel("error")` で取り出して relay worker / usecase の観測性
  挙動を assert する。

リポジトリ・UoW・Clock 用の fake は意図的に持たない。

- リポジトリ / UoW を in-memory で fake にしても transaction、`SQLITE_BUSY`
  retry、`OptimisticLockFailure` のような adapter 由来の本質的挙動は再現できない。
  application service のロジックテストは integration 層（実 SQLite）で行う方が
  実害をカバーできる。
- `Clock` は単なる `() => Date` なので、テスト内で `new Date(0)` などの定数を
  作って usecase / domain に渡せば足りる。port のオブジェクトとして fake 化する
  必要は無い。

## Real DB test（integration）方針

- 統合テストは `vitest-pool-workers` 経由で **Workers isolate + Miniflare の
  D1 binding** に対して走る。`vitest.config.integration.ts` がプール設定、
  `app/core/adapters/d1/__tests__/setup.ts` がマイグレーション適用と
  `beforeEach` の TRUNCATE を担う。
- `setupTestContainer()` (`app/core/application/__tests__/helpers.ts`) が
  `env.DB` から D1 backed の production 相当コンテナを返す。テスト間の
  状態クリーンアップはグローバル setup が見るので、helper は単なる
  factory + getter。
- ファイル名は `*.integration.test.ts`。Node プールの `vitest.config.ts`
  はこのパターンを除外して unit テストのみ走らせる。
- concurrent / OCC を意識したテストを書くときは、`Promise.all` で
  `run` を同時発火させて `OptimisticLockFailure` を観測する、
  などのパターンを使う。D1 の deferred-batch UoW では race の片側が
  `_occ_guard` の CHECK 違反、もう片側が空 batch、と分岐するため、
  どちらの失敗形でも通るようアサーションを緩めにすると安定する。

## Property-based 方針

- fast-check を採用しているのは **境界値 + 不変条件** の確認が主目的。
- ドメインの各 value object ファクトリ、entity の state transition
  （`complete` → `reopen` で active 状態に戻る、`rename` を同じ値で繰り返しても
  version が増えない冪等性、など）、set 系 usecase の冪等性のような性質検査に有用。
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
- **Application + Adapter (integration)**: "代表パス" 単位。OCC 成功 / OCC 失敗、
  outbox の同一 tx 配置、relay worker の decode 失敗 per-row 隔離、concurrent
  delete のレースなど、経路ごとに 1 本は用意する。usecase の orchestration
  カバレッジは fake で網羅するより integration で「実 DB 上で動いた」ことを
  重視する。
- **Frontend**: 必要最小限。server function の wire 型境界と UI ロジックは
  Conform / Zod と `useActionState` / `useOptimistic` の挙動で大枠カバーされる。
