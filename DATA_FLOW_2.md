# Data Flow — as literally implemented today

This traces the real code paths: [app/(tabs)/chat.tsx](app/(tabs)/chat.tsx) → [lib/api.ts](lib/api.ts) → Supabase Edge Functions → Anthropic Claude API → Postgres. Nothing here is aspirational — every box/arrow corresponds to a line of code found while reading the repo.

```mermaid
flowchart TD
    User["User text / voice\n(app/(tabs)/chat.tsx)"]

    subgraph CLIENT["Client wrapper — lib/api.ts"]
        SendMsg["sendChatMessage()"]
        Accept["acceptIntent()"]
        EditFn["editIntent()"]
        Classify["classifyAccount()\n(direct table update, no edge fn)"]
        CsvRow["processCsvRow() / resolveCsvRow()"]
    end

    User --> SendMsg

    subgraph CHATFN["Edge Function: chat/index.ts"]
        ChatLoop["Persona loop\n(reads history, profile, vocab,\nlast-30-days transactions)"]
        ReadExec["Executes ONE read tool\nper turn via readRegistry\n(category_breakdown, period_totals, etc.)"]
        Collect["Write tool calls are\nNEVER executed here —\ncollected as pendingIntents"]
    end

    SendMsg --> ChatLoop
    ChatLoop -->|tool_use: read| ReadExec --> DB
    ReadExec -->|tool_result fed back| ChatLoop
    ChatLoop -->|tool_use: write| Collect

    ChatLoop <--> ClaudeMain["Anthropic Claude API\nmodel: claude-sonnet-4-6\n(_shared/anthropic.ts)"]

    Collect --> Reply["reply + pendingIntents +\npendingClassifications"]
    ReadExec --> Reply
    Reply --> UI["Chat UI renders text bubble +\nIntentCard / ClassifyAccountCard"]

    subgraph MEMBOT["Background mini-bot (fire-and-forget)"]
        MemWriter["updateProfile()\nrewrites user's compact profile"]
    end
    ChatLoop -.after reply sent.-> MemWriter
    MemWriter <--> ClaudeMemory["Anthropic Claude API\nmodel: claude-haiku-4-5\n(cheap/fast)"]
    MemWriter --> ProfilesTable[("profiles table")]

    %% ---------- CONFIRM LOOP ----------
    UI -->|Reject tap| LocalRemove["Card removed client-side only\n— no server call at all"]

    UI -->|Accept tap| Accept --> ConfirmFn

    subgraph CONFIRMFN["Edge Function: confirm/index.ts"]
        ConfirmFn["action='accept'"]
        DupCheck["duplicateWarning()\nplain SQL match check\n(amount+date+account)\nNO AI involved"]
        WriteExec["writeRegistry handler executes\nthe real Postgres write\n(add_expense, add_transfer,\nadd_budget, adjust_balance, ...)"]
        EditAction["action='edit'"]
    end

    ConfirmFn --> DupCheck
    DupCheck -->|duplicate found, force≠true| WarnBack["returns warning,\ncard stays + 'force' flag set"]
    WarnBack --> UI
    DupCheck -->|no duplicate, or force=true| WriteExec --> DB
    WriteExec --> SavedBack["executed:true → UI removes card,\nshows 'Saved.'"]

    UI -->|Edit tap with instruction| EditFn --> EditAction
    EditAction --> EditBot["Edit micro-agent\nsingle call, NO conversation history,\ntool_choice forced to same intent name"]
    EditBot <--> ClaudeEdit["Anthropic Claude API\nmodel: claude-sonnet-4-6"]
    EditBot --> CorrectedIntent["corrected intent returned\n— still NOT executed"]
    CorrectedIntent --> UIUpdateCard["UI updates the card text\nwith the correction —\nwaits for user to tap Accept"]
    UIUpdateCard -.user must tap Accept.-> Accept

    %% ---------- CLASSIFY ACCOUNT ----------
    UI -->|Classify tap| Classify --> AccountsTable[("accounts table\nplain RLS update, no edge fn, no AI")]

    %% ---------- CSV IMPORT ----------
    SettingsCSV["Settings: CSV picked,\nclient parses rows itself"] --> CsvRow

    subgraph CSVFN["Edge Function: csv-import/index.ts"]
        Deterministic["tryDeterministicParse()\nregex/date/type rules — no AI"]
        AiFallback["aiReinterpret() mini-bot\n(only if deterministic parse fails)"]
        InsertRow["insertParsed()\nfind-or-create account/category\n+ direct transactions insert\n(NO confirm card — auto-committed)"]
        FlagRow["csv_import_flags row\n(manual review in Settings UI)"]
    end

    CsvRow --> Deterministic
    Deterministic -->|fail| AiFallback
    AiFallback <--> ClaudeRouter["Anthropic Claude API\nmodel: claude-haiku-4-5"]
    Deterministic -->|ok| InsertRow
    AiFallback -->|ok| InsertRow
    AiFallback -->|still unsure| FlagRow
    InsertRow --> DB

    %% ---------- DELETE ACCOUNT ----------
    DeleteBtn["Settings: Delete account"] --> DeleteFn

    subgraph DELFN["Edge Function: delete-account/index.ts"]
        DeleteFn["createServiceClient()\nauth.admin.deleteUser()\n— no AI"]
    end
    DeleteFn --> DB

    DB[("Postgres (Supabase)\ntables: messages, conversations,\nprofiles, accounts, categories,\ntransactions, budgets, recurrences,\ncsv_import_flags\n+ RPCs: transaction_search,\nunclassified_accounts, category_breakdown, ...")]
```

## Plain-language legend

- **Mini-bots** = the 3 separate, narrow Claude calls outside the main chat loop: the background **memory writer** (rewrites your profile after every chat turn, Haiku, cheap), the **edit micro-agent** (fixes a single pending card when you tap Edit, Sonnet, no memory of the conversation), and the **CSV AI fallback** (only fires when a spreadsheet row can't be parsed by plain rules, Haiku).
- **The main persona** (in `chat/index.ts`) is one Claude call (Sonnet) that can both look things up (reads, executed immediately) and propose changes (writes, *never* executed immediately — always turned into a card).
- **The confirm loop** is the only place an actual database write happens: `confirm/index.ts`, action `accept`. Reject never even reaches the server. Edit calls a mini-bot to patch the card text, then waits for the user to tap Accept on the patched version (no auto-accept).
- **Things that bypass AI entirely**: classifying an account's type, deleting all your data, deleting your account, and the deterministic half of CSV import — these are plain Supabase table calls, no Claude involved.
- **Duplicate detection** before a write is a plain SQL exact-match check, not AI judgment.
