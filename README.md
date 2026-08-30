[![Discord](https://img.shields.io/badge/Join%20Our%20Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white)](https://discord.gg/8BxYbV4pkj)
[![Latest Build](https://img.shields.io/github/actions/workflow/status/TheNetsky/Microsoft-Rewards-Script/auto-release.yml?branch=v4&style=for-the-badge&label=Latest%20Build)](https://github.com/TheNetsky/Microsoft-Rewards-Script/actions/workflows/auto-release.yml)
[![Docker](https://img.shields.io/badge/Docker-GHCR-blue?style=for-the-badge&logo=docker)](https://github.com/TheNetsky/Microsoft-Rewards-Script/pkgs/container/microsoft-rewards-script)

> [!TIP]
> This version supports the **new, modern Bing Rewards dashboard only** - it does **not** support the legacy dashboard.
> If your account still uses the old dashboard, use the [v3 branch](https://github.com/TheNetsky/Microsoft-Rewards-Script/tree/v3) and v3.x releases instead!
>
> Use at your own risk - some features may not work as expected.

---

## Table of Contents

- [Table of Contents](#table-of-contents)
- [Quick Setup](#quick-setup)
    - [Bare metal](#bare-metal)
        - [Get the script](#get-the-script)
- [Account Setup](#account-setup)
- [Config Setup](#config-setup)
    - [Build and run the script (bare metal version)](#build-and-run-the-script-bare-metal-version)
- [Docker](#docker)
- [Control API and Dashboard](#control-api-and-dashboard)
- [Nix Setup](#nix-setup)
- [Configuration Options](#configuration-options)
    - [Core](#core)
    - [Workers](#workers)
    - [Activities](#activities)
    - [Search Settings](#search-settings)
        - [Query sources](#query-sources)
    - [Experimental](#experimental)
    - [Logging](#logging)
    - [Proxy](#proxy)
    - [Webhooks](#webhooks)
- [Troubleshooting](#troubleshooting)
    - [Session management](#session-management)
- [Disclaimer](#disclaimer)

---

## Quick Setup

### Bare metal

**Requirements:** Node.js >= 24 and Git  
Works on Windows, Linux, macOS, and WSL.

#### Get the script

```bash
git clone https://github.com/TheNetsky/Microsoft-Rewards-Script.git
cd Microsoft-Rewards-Script
```

Or, download the latest release ZIP and extract it.

## Account Setup

Accounts and proxies are stored in the local SQLite database at `data/accounts.db`. The `.env` file is now only for system settings such as `ACCOUNTS_DB_PATH`; account credentials do not need to live there.

For a new setup, generate one database encryption key and keep it in `.env`:

```bash
npm run accounts -- keygen
```

```env
ACCOUNTS_DB_KEY=paste-the-generated-key-here
```

Keep this key backed up; encrypted credentials cannot be recovered without it. For normal use, create `accounts.local.csv` from `accounts.example.csv`. Each row is one account, with no `ACCOUNT_1`, `ACCOUNT_2`, slot, or proxy label required:

```bash
npm run accounts:import -- ./accounts.local.csv
npm run accounts -- stats
npm run accounts -- list
```

Rows containing the same proxy URL, port, and username are automatically grouped under one proxy record. The importer also accepts `accounts.txt` blocks with plain `EMAIL=...`, `PASSWORD=...`, and `PROXY_*=...` fields separated by blank lines, plus the normalized JSON format for advanced use.

Pipe-delimited `.txt` files are converted automatically during import. Supported rows are:

```text
email@example.com|email-password
email@example.com|email-password|host:port
email@example.com|email-password|host:port|proxy-user|proxy-password
email@example.com|email-password|host:port:proxy-user:proxy-password
```

Rows containing only email and password are distributed evenly across active proxies already stored in the database. A proxy included in the row is created or updated automatically. To intentionally re-import addresses recorded in `deleted_accounts`, add `--restore-deleted`:

```bash
npm run accounts:import -- ./accounts.local.txt --restore-deleted
```

To intentionally run imported accounts through the machine's direct connection, use `--no-proxy`. This
mode ignores proxy columns in the import file and persists direct mode for those accounts:

```bash
npm run accounts:import -- ./accounts.local.txt --no-proxy
```

Proxy identity is based on protocol, host, port, and username. Changing `PROXY_HTTP`, password, status, or egress IP updates the existing proxy instead of creating another record. To reconcile duplicate rows created by an older version:

```bash
npm run accounts -- cleanup-proxies
```

Cleanup transfers accounts and stored job references to one surviving proxy inside a transaction before deleting duplicate rows.

Files named `accounts*.csv`, `accounts*.txt`, and `accounts*.json` are ignored by Git, except for the safe example files. Re-running import updates matching emails instead of creating duplicates. Queue-time parallelism is controlled separately for direct accounts and proxy routes.

### Local proxy-safe queue

The default queue runs directly on Windows, macOS, or Linux without Docker, Redis, or another service. SQLite stores batches, jobs, attempts, results, and leases in `data/accounts.db`. Atomic database transactions prevent worker lanes and separate worker processes on the same machine from claiming the same proxy lock simultaneously.

Add these settings to `.env`:

```env
QUEUE_BACKEND=sqlite
WORKER_CONCURRENCY=3
DIRECT_ROUTE_CONCURRENCY=3
QUEUE_PROXY_CONCURRENCY=1
PROXY_LEASE_TTL_MS=120000
QUEUE_POLL_INTERVAL_MS=1000
JOB_MAX_ATTEMPTS=3
JOB_RETRY_DELAY_MS=30000
JOB_IDLE_TIMEOUT_MS=300000
QUEUE_LOG_MODE=compact
QUEUE_SKIP_SUCCEEDED_TODAY=true
```

Build once, then test the complete queue without launching a browser session:

```bash
npm run build
npm run queue:dry-run
npm run queue:status
```

`queue:dry-run` forces local SQLite mode and never launches a browser. `npm run queue:run` creates a transient local run, processes it to completion, removes its batch/job records, and exits. A stale local run left by an interrupted process is discarded on the next invocation after all associated processes and leases have stopped, so concurrency changes always apply to newly created jobs. Validated per-account success timestamps are retained separately for daily skipping. `queue:run` is also the recommended command for Windows Task Scheduler.

For an always-running worker, use two terminals instead:

```bash
# Terminal 1
npm run queue:worker

# Terminal 2 whenever a new batch should start
npm run queue:schedule
```

`WORKER_CONCURRENCY` is the number of account lanes. With `WORKER_CONCURRENCY=3`, the worker exposes lanes `T01`, `T02`, and `T03`. A lane runs exactly one account process at a time. `DIRECT_ROUTE_CONCURRENCY` controls how many no-proxy accounts may run at once and defaults to `WORKER_CONCURRENCY`. `QUEUE_PROXY_CONCURRENCY` controls how many accounts may share one proxy/egress route concurrently; its default is `1`, so accounts on the same proxy/egress route are serialized. The scheduler keeps distinct proxy routes busy first. Every running job renews its slot lease; losing ownership aborts its browser process. Expired leases from a crashed worker are recovered and retried up to `JOB_MAX_ATTEMPTS`.

By default, a new batch skips accounts that already produced a validated successful `ACCOUNT-END` during the current local day. A completed run with `pointsGained=0` still counts as successful because there may be nothing left to earn. A flow error, missing `ACCOUNT-END`, non-zero process exit, lost lease, or idle timeout counts as failure and is retried up to `JOB_MAX_ATTEMPTS`. Set `QUEUE_SKIP_SUCCEEDED_TODAY=false` to deliberately run successful accounts again on the same day.

Queue console lines keep their concurrency context on every line:

```text
[2026-07-18T07:00:00.000Z] [INFO   ] [T01] [proxy:proxy-a] [ac*****@example.com] [job:12345678] [ACCOUNT-START] Starting account
[2026-07-18T07:00:00.120Z] [INFO   ] [T02] [proxy:proxy-b] [us***@example.com] [job:90abcdef] [ACCOUNT-START] Starting account
```

`QUEUE_LOG_MODE=compact` prints lifecycle, points, warning, and error events. Use `verbose` to print every child-process line or `silent` to keep only queue lifecycle lines. Full unmodified child output is always stored at `data/job-logs/<job-id>.log`; the matching `<job-id>.jsonl` contains structured records for APIs and dashboards. Account addresses are masked only in the shared console so concurrent output remains readable without exposing full addresses.

Add `PROXY_EGRESS_IP` to CSV/TXT imports when multiple proxy endpoints share the same public exit IP. Those endpoints will then use the same `ip:<address>` lock. Without it, the lock falls back to the normalized proxy endpoint identity. Accounts without a proxy share the `direct:default` route, split into `DIRECT_ROUTE_CONCURRENCY` lock slots.

Queue environment settings:

| Variable                     | Default   | Purpose                                                 |
| ---------------------------- | --------- | ------------------------------------------------------- |
| `QUEUE_BACKEND`              | `sqlite`  | `sqlite` for local use or `redis` for BullMQ            |
| `WORKER_CONCURRENCY`         | `3`       | Account lanes; each lane runs one account process       |
| `DIRECT_ROUTE_CONCURRENCY`   | `3`       | Concurrent no-proxy accounts, capped by worker lanes    |
| `QUEUE_PROXY_CONCURRENCY`    | `1`       | Concurrent accounts allowed per proxy/egress route      |
| `PROXY_LEASE_TTL_MS`         | `120000`  | Lease lifetime, renewed every third of the TTL          |
| `QUEUE_POLL_INTERVAL_MS`     | `1000`    | Local worker polling interval                           |
| `JOB_MAX_ATTEMPTS`           | `3`       | Maximum attempts for a failed account job               |
| `JOB_RETRY_DELAY_MS`         | `30000`   | Initial exponential retry delay                         |
| `JOB_IDLE_TIMEOUT_MS`        | `300000`  | Stop/retry a child after this long without output       |
| `QUEUE_DRY_RUN`              | `false`   | Test queue and locks without launching the browser tool |
| `QUEUE_EXIT_WHEN_IDLE`       | `false`   | Exit a local worker after all active jobs finish        |
| `QUEUE_LOG_MODE`             | `compact` | Console detail: `compact`, `verbose`, or `silent`       |
| `QUEUE_SKIP_SUCCEEDED_TODAY` | `true`    | Skip accounts with a validated success today            |

The queue starts one-account child processes, so its proxy leases remain the source of concurrency control regardless of the bot's `clusters` setting. SQLite mode supports multiple processes on one machine. Do not put `accounts.db` on a network share. Before distributing workers across multiple machines, move job/catalog state to PostgreSQL or another central database service.

Redis remains optional. Set `QUEUE_BACKEND=redis` and `REDIS_URL=redis://host:6379` only when an external Redis server is available; BullMQ will then handle dispatch while retaining the same account job database.

To enable or disable an account without editing the import file:

```bash
npm run accounts -- disable user@example.com
npm run accounts -- enable user@example.com
npm run accounts -- delete banned@example.com
```

`delete` permanently removes the selected account from SQLite, including related
completed queue records through foreign-key cascades. It refuses to run while the
account has pending, queued, or running jobs. A deletion marker prevents future
imports from accidentally creating the account again.

If account values already exist as `ACCOUNT_N_*` entries in `.env`, migrate them once with:

```bash
npm run accounts:migrate
```

Database mode is now the default. Use `ACCOUNTS_DB_PATH=path/to/accounts.db` for a custom location. `ACCOUNTS_SOURCE=env` remains available only as a compatibility mode during migration.

### Automatic Microsoft FunCaptcha solving

Microsoft may show an Arkose Labs FunCaptcha during sign-in. The script can solve it through [OMOCaptcha](https://docs.omocaptcha.com/captchas/funcaptcha/image/) when an API key is configured in `.env`:

```env
OMOCAPTCHA_API_KEY=your-omocaptcha-api-key
```

The integration sends the original puzzle image and its question to OMOCaptcha, polls the result with exponential backoff, selects the returned image index, and continues the login flow. The optional `OMOCAPTCHA_MAX_WAIT_MS` setting changes the default 90-second task timeout; `OMOCAPTCHA_API_URL` can override the default `https://api.omocaptcha.com` endpoint. If no API key is configured, normal login behavior is unchanged until a FunCaptcha appears, at which point the log explains how to enable the solver.

## Config Setup

> [!WARNING]
> Do **not** skip this step if you are running the script bare metal.

- **Bare metal:** Copy or rename `config.example.json` to `config.json` (in the project root) and customize your preferences.
- **Docker:** A valid `config.json` is automatically created on first run and saved locally to `./config/`. You can optionally manually create a `config.json` (e.g., if you need to specify regex values) using the provided `config.example.json`

> [!CAUTION]
> Prior versions of accounts.json and config.json are not compatible with current release.

### Build and run the script (bare metal version)

```bash
npm run pre-build
npm run build
npm run start
```

`npm run start` keeps the original account workflow and schedules it in proxy-safe lanes. Set `clusters` to `0` (the default) to create one worker for every distinct proxy route automatically. Accounts on the same proxy always stay in one worker and run sequentially; different proxies run in parallel. Set `clusters` to a positive number to cap the worker count. Accounts use a valid proxy by default and fail closed if it is missing; only accounts explicitly imported with `--no-proxy` may use direct traffic. Mobile and desktop fingerprints are persisted by default so saved sessions keep a stable browser identity.

## Docker

- Copy the sample [`compose.yaml`](compose.yaml)
- Put only the account database key in `.env`:

```env
ACCOUNTS_DB_KEY=your-generated-database-key
```

- Import `accounts.local.csv` before starting the container. The mounted `./data` directory contains `accounts.db`.

- Review `compose.yaml` to adjust scheduling, timezone, and config options.

> [!NOTE]
> A valid `config.json` is auto-generated on first run using default values, and saved locally to `./config/`.
> Optionally, use `CONFIG_*` variables in the `environment:` section of the `compose.yaml` to customise your options (e.g., clusters, webhook, etc.).
> A full list of available options are in the [table below](#configuration-options).
> `CONFIG_*` variables are applied on every startup and always take precedence over `./config/config.json`.

> [!TIP]
> If a new image adds config options you're missing, a warning will appear in the container logs.
> To update, delete `./config/config.json` and restart - a fresh one will be generated from the latest example, with your `compose.yaml` overrides re-applied.

- Start the container: `docker compose up -d`

> [!TIP]
> Monitor logs with `docker logs microsoft-rewards-script`, useful for viewing passwordless login codes or diagnosing issues.
> You can also enable a webhook in `compose.yaml` for notifications.

---

## Control API and Dashboard

The optional Control API lets a local dashboard or another trusted tool monitor
and control the script over HTTP. See the [complete Control API
documentation](scripts/api/README.md) for setup, authentication, every endpoint,
request fields, response examples, and security guidance.

Common uses include:

- checking API health and the current run state with `GET /health` and
  `GET /status`;
- reading live points, logs, errors, account summaries, run history, and error
  diagnostics;
- listing safe stored-session metadata and deleting the mobile/desktop sessions
  for one account;
- starting all accounts with `POST /start` and an empty JSON body;
- running only one account with `POST /start` and `{"accountIndex":2}`;
- running all accounts except selected slots with `POST /start` and
  `{"excludedAccountIndexes":[2,4]}`;
- stopping or restarting a run with `POST /stop` or `POST /restart`;
- streaming live logs and status updates from `GET /events` using
  Server-Sent Events (SSE);
- reading the active configuration and schedule, with config and schedule
  changes available only when their explicit `API_ALLOW_*` options are enabled.
- managing accounts and proxies remotely with `GET /proxies`,
  `POST /accounts/import`, `PATCH /accounts/:email/proxy`,
  `PATCH /accounts/:email/status`, and `DELETE /accounts/:email`;

For example, start only `ACCOUNT_2` with cURL:

```bash
curl --request POST \
  --url http://127.0.0.1:3010/start \
  --header 'Authorization: Bearer YOUR_API_TOKEN' \
  --header 'Content-Type: application/json' \
  --data '{"accountIndex":2}'
```

For the local web interface, use the [local Account Manager](rewards-dashboard/README.md).
It connects to this Control API through the local machine and keeps the worker,
account database, and secrets on the VPS.

## Project layout

The runtime is split by responsibility:

```text
src/                         worker implementation
scripts/api/                 VPS Control API and remote control routes
scripts/accounts/            account database, secret encryption, proxy logic
scripts/queue/               queue stores, scheduler and worker coordination
scripts/main/                operational CLI commands
scripts/docker/              Docker entrypoint and health scripts
deploy/vps/                  VPS env template and systemd service
deploy/local/                local dashboard deployment notes
local-dashboard/             local-only account management web app
```

Use `deploy/vps/README.md` for VPS setup and `deploy/local/README.md` for the
local dashboard. Keep `.env`, `data/`, `sessions/`, and account import files
outside Git.

---

## Nix Setup

If using Nix: `bash scripts/nix/run.sh`

---

## Configuration Options

Edit `config.json` to customize behavior, or set `CONFIG_*` environment variables in `compose.yaml` (Docker). Below are all currently available options.

> [!WARNING]
> Rebuild the script (bare metal), or recreate the container (Docker) after all config changes.

### Core

| Setting                     | Type    | Default      | Description                                                        | Docker environment variable           |
| --------------------------- | ------- | ------------ | ------------------------------------------------------------------ | ------------------------------------- |
| `sessionPath`               | string  | `"sessions"` | Directory to store browser sessions                                |                                       |
| `headless`                  | boolean | `false`      | Run browser invisibly                                              | Always `true` in Docker               |
| `clusters`                  | number  | `0`          | Max proxy-safe workers; `0` selects one worker per proxy route     | `CONFIG_CLUSTERS`                     |
| `errorDiagnostics`          | boolean | `false`      | Save error and unknown-login page diagnostics under `diagnostics/` | `CONFIG_ERROR_DIAGNOSTICS`            |
| `ensureStreakProtection`    | boolean | `true`       | Ensure streak protection is enabled                                | `CONFIG_ENSURE_STREAK_PROTECTION`     |
| `autoClaimPunchcardRewards` | boolean | `true`       | Auto-claim completed punchcard rewards                             | `CONFIG_AUTO_CLAIM_PUNCHCARD_REWARDS` |
| `skipNonPointTasks`         | boolean | `true`       | Skip tasks that award no points                                    | `CONFIG_SKIP_NON_POINT_TASKS`         |
| `searchOnBingLocalQueries`  | boolean | `false`      | Use the local query list for ExploreOnBing                         | `CONFIG_SEARCH_ON_BING_LOCAL`         |
| `globalTimeout`             | string  | `"30sec"`    | Timeout for all actions                                            | `CONFIG_GLOBAL_TIMEOUT`               |

### Workers

| Setting                        | Type    | Default | Description                                                                | Docker environment variable          |
| ------------------------------ | ------- | ------- | -------------------------------------------------------------------------- | ------------------------------------ |
| `workers.doDailySet`           | boolean | `true`  | Complete daily set                                                         | `CONFIG_WORKER_DAILY_SET`            |
| `workers.doClaimBonusPoints`   | boolean | `true`  | Claim bonus points                                                         | `CONFIG_WORKER_CLAIM_BONUS_POINTS`   |
| `workers.doMorePromotions`     | boolean | `true`  | Complete "more activities"                                                 | `CONFIG_WORKER_MORE_PROMOTIONS`      |
| `workers.doPunchCards`         | boolean | `true`  | Complete punchcards                                                        | `CONFIG_WORKER_PUNCH_CARDS`          |
| `workers.doAppPromotions`      | boolean | `true`  | Complete app promotions                                                    | `CONFIG_WORKER_APP_PROMOTIONS`       |
| `workers.doDesktopSearch`      | boolean | `true`  | Perform desktop searches                                                   | `CONFIG_WORKER_DESKTOP_SEARCH`       |
| `workers.doMobileSearch`       | boolean | `true`  | Perform mobile searches                                                    | `CONFIG_WORKER_MOBILE_SEARCH`        |
| `workers.doBonusSearches`      | boolean | `false` | Farm bonus searches beyond the cap                                         | `CONFIG_WORKER_BONUS_SEARCHES`       |
| `workers.doDailyCheckIn`       | boolean | `true`  | Complete daily check-in                                                    | `CONFIG_WORKER_DAILY_CHECKIN`        |
| `workers.doReadToEarn`         | boolean | `true`  | Complete Read-to-Earn                                                      | `CONFIG_WORKER_READ_TO_EARN`         |
| `workers.doActivateSearchPerk` | boolean | `true`  | Activate the "search Nx more" perk when present (runs after the daily set) | `CONFIG_WORKER_ACTIVATE_SEARCH_PERK` |
| `workers.doVisualSearch`       | boolean | `false` | Activate the visual-search streak and perform visual searches              | `CONFIG_WORKER_VISUAL_SEARCH`        |

### Activities

| Setting                   | Type    | Default | Description                    | Docker environment variable      |
| ------------------------- | ------- | ------- | ------------------------------ | -------------------------------- |
| `activities.urlReward`    | boolean | `true`  | Complete URL reward activities | `CONFIG_ACTIVITY_URL_REWARD`     |
| `activities.searchOnBing` | boolean | `true`  | Complete ExploreOnBing offers  | `CONFIG_ACTIVITY_SEARCH_ON_BING` |

### Search Settings

| Setting                                | Type     | Default                             | Description                                               | Docker environment variable        |
| -------------------------------------- | -------- | ----------------------------------- | --------------------------------------------------------- | ---------------------------------- |
| `searchSettings.scrollRandomResults`   | boolean  | `false`                             | Scroll randomly on results                                | `CONFIG_SEARCH_SCROLL_RANDOM`      |
| `searchSettings.clickRandomResults`    | boolean  | `false`                             | Click random links                                        | `CONFIG_SEARCH_CLICK_RANDOM`       |
| `searchSettings.runOnZeroPoints`       | boolean  | `false`                             | Run searches even when no search points remain            | `CONFIG_SEARCH_RUN_ON_ZERO_POINTS` |
| `searchSettings.maxBonusSearches`      | number   | `110`                               | Max bonus searches per run (when `doBonusSearches` is on) | `CONFIG_SEARCH_MAX_BONUS_SEARCHES` |
| `searchSettings.parallelSearching`     | boolean  | `true`                              | Run searches in parallel                                  | `CONFIG_SEARCH_PARALLEL`           |
| `searchSettings.queryEngines`          | string[] | see [Query sources](#query-sources) | Sources used to build the search query pool               | `CONFIG_SEARCH_QUERY_ENGINES` \*   |
| `searchSettings.searchResultVisitTime` | string   | `"10sec"`                           | Time to spend on each search result                       | `CONFIG_SEARCH_VISIT_TIME`         |
| `searchSettings.searchDelay.min`       | string   | `"30sec"`                           | Minimum delay between searches                            | `CONFIG_SEARCH_DELAY_MIN`          |
| `searchSettings.searchDelay.max`       | string   | `"1min"`                            | Maximum delay between searches                            | `CONFIG_SEARCH_DELAY_MAX`          |
| `searchSettings.readDelay.min`         | string   | `"30sec"`                           | Minimum delay for reading                                 | `CONFIG_SEARCH_READ_DELAY_MIN`     |
| `searchSettings.readDelay.max`         | string   | `"1min"`                            | Maximum delay for reading                                 | `CONFIG_SEARCH_READ_DELAY_MAX`     |

> [!NOTE]
> \* Docker `CONFIG_*` array values are comma-separated strings e.g. `"error,warn"`. Regex patterns must be set directly in `config.json`.

#### Query sources

`searchSettings.queryEngines` controls where search queries come from. Pick any combination; topics from all selected sources are pooled, de-duplicated, and expanded with Bing autosuggest/related terms.

Core sources:

| Selector     | Source                                           |
| ------------ | ------------------------------------------------ |
| `google`     | Google Trends (trending searches)                |
| `wikipedia`  | Wikipedia most-read articles (previous day)      |
| `wikirandom` | Random Wikipedia articles                        |
| `hackernews` | Hacker News front-page stories                   |
| `reddit`     | Reddit r/popular post titles                     |
| `local`      | Bundled `src/functions/search-queries.json` list |

RSS feeds use a dotted path - `rss` for every feed, `rss.<site>` for a whole site, or `rss.<site>.<endpoint>` for a single feed:

| Selector           | Feeds                                                          |
| ------------------ | -------------------------------------------------------------- |
| `rss.googleTrends` | Google Trends RSS (`gb`, `us`)                                 |
| `rss.googleNews`   | Google News (`gb`, `us`, `world`, `technology`, `business`)    |
| `rss.bbc`          | BBC News (`top`, `world`, `technology`, `business`, `science`) |
| `rss.guardian`     | The Guardian (`international`, `world`, `technology`)          |
| `rss.theVerge`     | The Verge (`all`)                                              |
| `rss.arsTechnica`  | Ars Technica (`all`)                                           |
| `rss.reddit`       | Reddit listing feeds (`popular`, `worldnews`, `technology`)    |

Add your own feeds in `src/constants/rssFeeds.ts`.

Default:

```json
[
    "google",
    "wikipedia",
    "wikirandom",
    "hackernews",
    "reddit",
    "local",
    "rss.googleTrends",
    "rss.googleNews",
    "rss.bbc",
    "rss.guardian.world",
    "rss.theVerge.all"
]
```

### Experimental

API-backed earning paths. Enabled by default; set either flag to `false` to use the browser path for that activity.

| Setting                        | Type    | Default | Description                                                       | Docker environment variable              |
| ------------------------------ | ------- | ------- | ----------------------------------------------------------------- | ---------------------------------------- |
| `experimental.apiSearch`       | boolean | `true`  | Perform Bing searches over HTTP instead of driving a browser page | `CONFIG_EXPERIMENTAL_API_SEARCH`         |
| `experimental.apiSearchOnBing` | boolean | `true`  | Complete ExploreOnBing offers over HTTP instead of the browser    | `CONFIG_EXPERIMENTAL_API_SEARCH_ON_BING` |

> [!NOTE]
> The API paths are faster but depend on the modern dashboard's endpoints. If an ExploreOnBing offer ever fails to be credited, turn `apiSearchOnBing` off to fall back to the browser path.

### Logging

| Setting                          | Type     | Default                | Description                       | Docker environment variable     |
| -------------------------------- | -------- | ---------------------- | --------------------------------- | ------------------------------- |
| `debugLogs`                      | boolean  | `false`                | Enable debug logging              | `CONFIG_DEBUG_LOGS`             |
| `consoleLogFilter.enabled`       | boolean  | `false`                | Enable console log filtering      | `CONFIG_LOG_FILTER_ENABLED`     |
| `consoleLogFilter.mode`          | string   | `"whitelist"`          | Filter mode (whitelist/blacklist) | `CONFIG_LOG_FILTER_MODE`        |
| `consoleLogFilter.levels`        | string[] | `["error", "warn"]`    | Log levels to filter              | `CONFIG_LOG_FILTER_LEVELS` \*   |
| `consoleLogFilter.keywords`      | string[] | `["starting account"]` | Keywords to filter                | `CONFIG_LOG_FILTER_KEYWORDS` \* |
| `consoleLogFilter.regexPatterns` | string[] | `[]`                   | Regex patterns for filtering      |                                 |

> [!NOTE]
> \* Docker `CONFIG_*` array values are comma-separated strings e.g. `"error,warn"`. Regex patterns must be set directly in `config.json`.

### Proxy

An account with a non-empty `PROXY_URL` is proxy-locked. Its browser traffic and all account-scoped HTTP requests, including query sources and user-agent metadata lookups, use that proxy. The runner never silently falls back to the machine's direct connection. Direct traffic is used only when the account was explicitly imported with `--no-proxy`. `PROXY_HTTP` is retained for import compatibility, but it cannot disable enforcement when `PROXY_URL` is present.

Before an account starts, the runner performs a bounded HTTP health check through the configured proxy. A failed proxy opens a 60-second circuit for that endpoint so other accounts assigned to the same dead proxy fail immediately instead of repeating long timeouts. Run `npm run proxies:check` to validate every configured proxy before a batch.

| Setting             | Type    | Default | Description                                                                 | Docker environment variable |
| ------------------- | ------- | ------- | --------------------------------------------------------------------------- | --------------------------- |
| `proxy.queryEngine` | boolean | `true`  | Legacy compatibility setting; account proxy-locking always takes precedence | `CONFIG_PROXY_QUERY_ENGINE` |

### Webhooks

| Setting                                  | Type     | Default                                              | Description                       | Docker environment variable             |
| ---------------------------------------- | -------- | ---------------------------------------------------- | --------------------------------- | --------------------------------------- |
| `webhook.discord.enabled`                | boolean  | `false`                                              | Enable Discord webhook            | `CONFIG_DISCORD_ENABLED`                |
| `webhook.discord.url`                    | string   | `""`                                                 | Discord webhook URL               | `CONFIG_DISCORD_URL`                    |
| `webhook.telegram.enabled`               | string   | `""`                                                 | Enable Telegram webhook           | `CONFIG_TELEGRAM_ENABLED`               |
| `webhook.telegram.botToken`              | string   | `""`                                                 | Telegram bot token                | `CONFIG_TELEGRAM_BOTTOKEN`              |
| `webhook.telegram.chatId`                | string   | `""`                                                 | Telegram chat id                  | `CONFIG_TELEGRAM_CHATID`                |
| `webhook.ntfy.enabled`                   | boolean  | `false`                                              | Enable ntfy notifications         | `CONFIG_NTFY_ENABLED`                   |
| `webhook.ntfy.url`                       | string   | `""`                                                 | ntfy server URL                   | `CONFIG_NTFY_URL`                       |
| `webhook.ntfy.topic`                     | string   | `""`                                                 | ntfy topic                        | `CONFIG_NTFY_TOPIC`                     |
| `webhook.ntfy.token`                     | string   | `""`                                                 | ntfy authentication token         | `CONFIG_NTFY_TOKEN`                     |
| `webhook.ntfy.title`                     | string   | `"Microsoft-Rewards-Script"`                         | Notification title                | `CONFIG_NTFY_TITLE`                     |
| `webhook.ntfy.tags`                      | string[] | `["bot", "notify"]`                                  | Notification tags                 | `CONFIG_NTFY_TAGS` \*                   |
| `webhook.ntfy.priority`                  | number   | `3`                                                  | Notification priority (1-5)       | `CONFIG_NTFY_PRIORITY`                  |
| `webhook.webhookLogFilter.enabled`       | boolean  | `false`                                              | Enable webhook log filtering      | `CONFIG_WEBHOOK_LOG_FILTER_ENABLED`     |
| `webhook.webhookLogFilter.mode`          | string   | `"whitelist"`                                        | Filter mode (whitelist/blacklist) | `CONFIG_WEBHOOK_LOG_FILTER_MODE`        |
| `webhook.webhookLogFilter.levels`        | string[] | `["error"]`                                          | Log levels to send                | `CONFIG_WEBHOOK_LOG_FILTER_LEVELS` \*   |
| `webhook.webhookLogFilter.keywords`      | string[] | `["starting account", "select number", "collected"]` | Keywords to filter                | `CONFIG_WEBHOOK_LOG_FILTER_KEYWORDS` \* |
| `webhook.webhookLogFilter.regexPatterns` | string[] | `[]`                                                 | Regex patterns for filtering      |                                         |

> [!NOTE]
> \* Docker `CONFIG_*` array values are comma-separated strings e.g. `"error,warn"`. Regex patterns must be set directly in `config.json`.

> [!WARNING]
> **NTFY** users set the `webhookLogFilter` to `enabled`, or you will receive push notifications for _all_ logs.
> When enabled, only account start, 2FA codes, and account completion summaries are delivered as push notifications.
> Customize which notifications you receive with the `keywords` options.

---

## Troubleshooting

> [!TIP]
> Most login issues can be fixed by deleting your /sessions folder, and redeploying the script

### Session management

The session utility requires an explicit command, so running it without an
argument only displays help and never deletes anything.

```bash
# List stored mobile and desktop sessions
npm run clear-sessions -- list

# Delete the sessions belonging to one account
npm run clear-sessions -- email user@example.com

# Delete every stored session
npm run clear-sessions -- all
```

```bash
# List safe session metadata
curl --request GET \
  --url http://127.0.0.1:3010/sessions \
  --header 'Authorization: Bearer YOUR_API_TOKEN'

# Delete only user@example.com's mobile and desktop sessions
curl --request DELETE \
  --url http://127.0.0.1:3010/sessions/user%40example.com \
  --header 'Authorization: Bearer YOUR_API_TOKEN'
```

See the [Control API session documentation](scripts/api/README.md#session-management)
for response data, Axios examples, and error behavior.

---

## Disclaimer

Use at your own risk.  
Automation of Microsoft Rewards may lead to account suspension or bans.  
This software is provided for educational purposes only.  
The authors are not responsible for any actions taken by Microsoft.
