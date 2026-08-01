# LOOP.md — `src/loop.js`, the heart of ScrappyAi

سلام؛ همه‌ی موارد این فایل که اجرا می‌شود، با schema دقیق ورودی/خروجی نشان داده شده: چی می‌ره داخل، چی برمی‌گرده بیرون، و چرا. هدف این سند این‌ که هیچ رفتار پنهانی توی `loop.js` نباشد.

`AgentLoop` یک چرخه‌ی `think → act → observe` است که سه چیز را ارکستره می‌کند: `ContextWindow` (`context.js`)، `ToolRegistry` (`tools.js`)، و یک تابع `reasoner` تزریقی (هیچ وابستگی به هیچ LLM provider خاصی داخل این فایل نیست).

---

## 1. جریان کلی (Mental Model)

```
run(userInput)
  │
  ├─ per step (1..maxSteps):
  │    ├─ LOOP SAFETY CHECKS  (به ترتیب، هر کدام می‌تواند run را همان‌جا خاتمه دهد)
  │    │    1. AbortSignal.aborted?           → status:'aborted',  reason: ABORTED
  │    │    2. elapsed >= maxTaskTimeoutMs?   → status:'error',    reason: TASK_TIMEOUT
  │    │    3. context.usedTokens > maxTokens (بعد از compaction)? → status:'error', reason: MAX_TOKENS
  │    │    4. هر stopCondition سفارشی؟        → status:'stopped',  reason: <custom string>
  │    │
  │    ├─ THINK   : action = await reasoner(context.render(), tools.toSchema())
  │    │            validate(action) طبق Action Schema ثابت (بخش ۳)
  │    │
  │    ├─ اگر action.type === 'final'              → status:'final',             reason: FINAL_ANSWER   (پایان)
  │    ├─ اگر action.type === 'need_clarification' → status:'need_clarification', reason: NEED_CLARIFICATION (پایان)
  │    ├─ اگر تشخیص stuck loop (همان tool+args تکراری) → status:'error', reason: STUCK_LOOP (پایان)
  │    │
  │    ├─ ACT     : _executeWithRetry(action)  — retry با backoff نمایی، فقط روی کدهای retryable
  │    │            اگر retry-ها تمام شد و ۲ بار پشت‌سرهم (پیش‌فرض) اتفاق افتاد → status:'error', reason: TOOL_FAILURE_EXHAUSTED (پایان)
  │    │
  │    └─ OBSERVE : نتیجه‌ی *فشرده* → ContextWindow (بودجه‌ی توکن)
  │                 نتیجه‌ی *کامل*   → Step Memory داخلی حلقه (برای دیباگ/replay، مستقل از چت)
  │
  └─ اگر maxSteps تمام شد بدون final/clarification → status:'max_steps', reason: MAX_STEPS
```

هر خروجی `run()` دقیقاً یکی از ۱۲ مقدار ثابت `TerminationReason` را دارد — هیچ‌وقت متن آزاد به‌جای دلیل واقعی.

از این نسخه به بعد، گاردهای پیش از THINK (پاس‌شدن/رد‌شدن abort signal، timeout، max tokens، stop conditions) همه از یک **Stop Condition Engine** واحد رد می‌شوند (بخش ۱۲)، و هر تغییر state با یک **State Management Engine** صریح (بخش ۱۳) ثبت می‌شود که دقیقاً چرخه‌ی
`CREATED → RUNNING → AWAITING_TOOL_APPROVAL → PAUSED → RESUMED → COMPLETED / FAILED`
را پیاده می‌کند. هر خروجی `run()`/`resume()`/`resumeWithApproval()` یک **Checkpoint** کامل همراه دارد که با `resume()`/`resumeWithApproval()` می‌شود از همان‌جا ادامه داد (بخش ۱۴)، و هر **checkpoint** هم علاوه بر حافظه‌ی داخلی، در یک **CheckpointManager** قابل جست‌وجو با id ثبت می‌شود (بخش ۱۶). یک ابزار حساس هم می‌تواند قبل از اجرا از دروازه‌ی **Tool Approval** رد شود (بخش ۱۵)، و هر رویداد — بدون استثنا — هم به کنسول (رندر شده‌ی زیبا، بخش ۱۸) و هم به فایل‌های per-session روی دیسک (بخش ۱۷) می‌رود.

---

## 2. `LoopResult` — schema خروجی `run()`

```ts
type LoopResult = {
  status: 'final' | 'need_clarification' | 'error' | 'max_steps' | 'aborted' | 'stopped' | 'paused' | 'awaiting_tool_approval';
  reason: TerminationReason | string;   // 'string' فقط وقتی status === 'stopped' (custom/named stop condition)
  steps: number;                        // چند step واقعاً اجرا شد (تا این run/resume، نه فقط این تک‌فراخوانی)
  budget: number;                       // بودجه‌ی استپ مؤثر (با adaptiveMaxSteps رشد می‌کند)
  elapsedMs: number;                    // زمان این فراخوانی run()/resume() به میلی‌ثانیه (نه کل عمر run اگر resume شده)
  stepMemory: StepRecord[];             // رونوشت کامل و ساخت‌یافته — بخش ۵
  state: LoopState;                     // state نهایی state machine در همین لحظه — بخش ۱۳
  checkpoint: Checkpoint;               // همیشه حاضر؛ برای resume()/resumeWithApproval() بعدی، حتی بعد از final/error — بخش ۱۴
  content?: string;                     // فقط وقتی status === 'final'
  question?: string;                    // فقط وقتی status === 'need_clarification'
  error?: string;                       // فقط وقتی status === 'error'
  message?: string;                     // پیام قابل‌خوانش از Stop Condition Engine (بخش ۱۲) یا Tool Approval (بخش ۱۵)
  stopCondition?: string;               // نام دقیق condition که run را متوقف کرد (مثلاً 'task_timeout', 'pause_requested')
  pendingApproval?: { tool: string, args: object, reasoning?: string, step: number };  // فقط وقتی status === 'awaiting_tool_approval' — بخش ۱۵
}
```

### `TerminationReason` (مقادیر ثابت، `export`‌شده)

| مقدار | یعنی چی | از کجا trigger می‌شود |
|---|---|---|
| `final_answer` | reasoner جواب نهایی داد | `action.type === 'final'` |
| `need_clarification` | reasoner نیاز به توضیح بیشتر از کاربر داشت | `action.type === 'need_clarification'` |
| `max_steps_reached` | به سقف `maxSteps` رسید بدون جواب نهایی | حلقه‌ی for تمام شد |
| `task_timeout` | کل run() از `maxTaskTimeoutMs` گذشت (مستقل از تعداد step) | چک زمان در ابتدای هر step |
| `max_tokens_exceeded` | context بعد از compaction هنوز over-budget است | مقایسه‌ی `usedTokens` با `maxTokens` |
| `stuck_loop_detected` | همان `tool+args` دقیقاً `maxRepeatedToolCalls` بار پشت‌سرهم | fingerprint matching |
| `tool_failure_exhausted` | یک ابزار `maxConsecutiveToolExhaustion` بار پشت‌سرهم همه‌ی retry-هایش را باخت | شمارنده‌ی consecutive exhaustion |
| `tool_overuse` | یک ابزار بیش از `maxToolCallsPerTool` بار در یک run صدا زده شد (حتی با آرگومان‌های متفاوت) | گارد ضد «Tool Misuse» — بخش ۲۲ |
| `aborted_by_signal` | `AbortSignal` بیرونی فعال شد | چک `signal.aborted` |
| `think_phase_error` | خود reasoner throw کرد (نه خطای validation) | catch در فاز THINK |
| `invalid_action` | reasoner یک Action نامعتبر برگرداند (schema mismatch) | `_validateAction()` |
| `paused_by_request` | یک‌جا فراخوانی `loop.pause()` شد | condition `pause_requested` در Stop Condition Engine |
| `awaiting_tool_approval` | یک tool_call به تایید نیاز داشت و هیچ `onToolApproval` hook‌ای برای تصمیم خودکار وجود نداشت | دروازه‌ی Tool Approval، قبل از فاز ACT — بخش ۱۵ |

---

## 3. Action Schema (ثابت) — چیزی که `reasoner` باید برگرداند

سه و فقط سه شکل مجاز؛ هرچیز دیگری → `reason: invalid_action`.

```ts
type Action =
  | { type: 'tool_call'; tool: string; args?: object; reasoning?: string; retry?: RetryPolicy }
  | { type: 'final'; content: string; reasoning?: string }
  | { type: 'need_clarification'; question: string; reasoning?: string };
```

قوانین validation (`_validateAction`، در `loop.js`):

| فیلد | قانون |
|---|---|
| `type` | باید یکی از `ActionType.TOOL_CALL/FINAL/NEED_CLARIFICATION` باشد |
| `tool_call.tool` | رشته‌ی غیرخالی و باید در `ToolRegistry` ثبت شده باشد (`tools.has(tool)`) |
| `tool_call.args` | اگر داده شود باید plain object باشد (نه آرایه، نه null) |
| `tool_call.retry` | اختیاری؛ override محلی روی retry policy پیش‌فرض حلقه (بخش ۴) |
| `final.content` | رشته‌ی غیرخالی |
| `need_clarification.question` | رشته‌ی غیرخالی |

---

## 4. Tool Retry — schema و رفتار

### ورودی: `RetryPolicy`

```ts
type RetryPolicy = {
  retries?: number;          // چند بار *دوباره* تلاش شود (پیش‌فرض 2 → یعنی حداکثر 3 تلاش کل)
  backoffMs?: number;        // تاخیر پایه قبل از تلاش دوم (پیش‌فرض 250ms)
  factor?: number;           // ضریب نمایی backoff (پیش‌فرض 2 → 250, 500, 1000, ...)
  retryableCodes?: string[]; // فقط این کدهای خطا retry می‌شوند
};
```

پیش‌فرض حلقه (`toolRetry` در constructor):
```js
{ retries: 2, backoffMs: 250, factor: 2,
  retryableCodes: ['TOOL_EXECUTION_ERROR', 'EXECUTION_ERROR'] }
```

نکته‌ی مهم ۱: کدهایی مثل `VALIDATION_ERROR` و `UNKNOWN_TOOL` **هرگز** retry نمی‌شوند — چون یک retry نمی‌تواند یک call ساختاریافته‌ی غلط را درست کند؛ تلاش اول شکست می‌خورد و فوراً به فاز observe می‌رود (fail-fast).

نکته‌ی مهم ۲ (قانون Fallback): timeout ها (`TOOL_TIMEOUT`) و خطاهای شبکه‌ای (`REQUEST_FAILED`, `HTTP_ERROR`,
`BAD_JSON`, `ENOTFOUND`, `ECONNREFUSED`, `ETIMEDOUT`, `STREAM_FAILED`, کدهای DNS) هم **fail-fast** هستند —
دیگر در پیش‌فرض retry نمی‌شوند. یک endpoint مرده با retry زنده نمی‌شود و فقط latency و توکن می‌سوزاند؛
reasoner باید بلافاصله به ابزار دیگری (مثلاً `web_search`) یا پاسخ از دانش خودش بپیچد. این قانون در
پرامپت سیستم هم قید شده است.

هر `action.retry` می‌تواند به‌صورت per-call این پالیسی را override کند (مثلاً یک ابزار حساس را retry نکن: `{ retry: { retries: 0 } }`).

### تابع داخلی: `_executeWithRetry(action, policy, ctx)`

**ورودی:**
```ts
{
  action: Action,           // فقط شکل tool_call
  policy: RetryPolicy,      // resolved (پیش‌فرض + override)
  ctx: { step: number, signal?: AbortSignal }
}
```

**خروجی:**
```ts
{ result: ToolResult, attempts: number }  // attempts >= 1
```

رفتار: تا زمانی که `result.ok === true` یا کد خطا در `retryableCodes` نباشد یا `attempts > policy.retries` شود، دوباره تلاش می‌کند؛ بین تلاش‌ها `backoffMs * factor^(attempt-1)` صبر می‌کند و یک event `TOOL_RETRY` منتشر می‌کند.

### Error Recovery در سطح run()

هر بار که یک tool_call همه‌ی retry-هایش را ببازد، شمارنده‌ی `_consecutiveToolExhaustion` یک واحد بالا می‌رود؛ هر بار که یک tool_call موفق شود (یا اصلاً retryable نبود، یعنی fail-fast)، شمارنده صفر می‌شود. یعنی حلقه به‌جای متوقف‌شدن سر اولین خطا، به reasoner فرصت می‌دهد ابزار دیگری امتحان کند یا مسیر را عوض کند — فقط وقتی همین شرایط `maxConsecutiveToolExhaustion` بار (پیش‌فرض 2) پشت‌سرهم تکرار شود، run با `tool_failure_exhausted` واقعاً تسلیم می‌شود.

---

## 5. Tool Result Schema (استاندارد) — از `tools.js`

هر `ToolRegistry.execute()` دقیقاً این شکل را برمی‌گرداند (هیچ‌وقت throw نمی‌کند):

```ts
type ToolResult =
  | { ok: true;  data: any;     durationMs: number }
  | { ok: false; error: string; code: string; durationMs: number };
```

کدهای خطای استاندارد: `UNKNOWN_TOOL`, `VALIDATION_ERROR`, `TOOL_TIMEOUT`, `TOOL_EXECUTION_ERROR`.

---

## 6. Tool Result Compression — چیزی که وارد `ContextWindow` می‌شود

`ContextWindow` بودجه‌ی توکن دارد؛ یک نتیجه‌ی بزرگ (مثلاً خروجی کامل یک فایل ۵۰KBی یا نتیجه‌ی shell طولانی) نباید کل بودجه را یک‌جا بخورد. برای همین، قبل از `context.addToolResult()`، نتیجه از `compressToolResult(result, {maxChars})` رد می‌شود:

**ورودی:**
```ts
compressToolResult(result: ToolResult, opts: { maxChars: number }) => ToolResult
```

**رفتار پیش‌فرض** (`defaultCompressToolResult`، قابل override با `opts.compressToolResult` در constructor):
- اگر `result.ok` و `data` رشته/آبجکتی بزرگ‌تر از `maxChars` باشد → کوتاه می‌شود با marker: `"...[truncated N chars, <type> result]"`.
- اگر `!result.ok` و `error` طولانی باشد → همان کوتاه‌سازی روی متن خطا.
- **نکته‌ی کلیدی:** این فشرده‌سازی فقط روی چیزی اعمال می‌شود که وارد `ContextWindow` (و از آن‌جا وارد پرامپت مدل) می‌شود. نسخه‌ی کامل و دست‌نخورده همیشه در **Step Memory** (بخش ۷) باقی می‌ماند — چیزی برای دیباگ گم نمی‌شود، فقط چیزی که به مدل فرستاده می‌شود کوچک می‌شود.

پیش‌فرض `compressMaxChars = 1500`.

---

## 7. Step Memory — حافظه‌ی داخل خود حلقه (نه فقط context چت)

`ContextWindow` یک ترنسکریپت شبیه چت است (متن، برای مدل). Step Memory یک آرایه‌ی جدا و ساخت‌یافته است، مخصوص خود `AgentLoop`، برای دیباگ/replay/تحلیل بعد از اجرا — مستقل از اینکه چه‌قدر context فشرده یا drop شده باشد.

### `StepRecord` schema

```ts
type StepRecord = {
  ts: number;                 // Date.now() لحظه‌ی ثبت
  step: number;
  phase: 'observe' | 'final' | 'need_clarification' | 'stuck_loop' | 'think_error';
  action: Action | null;
  result?: ToolResult;        // فقط phase === 'observe' — نسخه‌ی کامل، فشرده‌نشده
  attempts?: number;          // فقط phase === 'observe' — چند بار تلاش شد (retry شامل)
  error?: string;             // فقط در مسیرهای خطا
  durationMs: number;
}
```

**دسترسی:**
- `loop.getStepMemory()` → کپی از آرایه‌ی فعلی (حتی وسط یک run طولانی، برای مانیتورینگ زنده)
- `LoopResult.stepMemory` → همان آرایه، در انتهای `run()`

هر `run()` جدید، Step Memory را ریست می‌کند (`this._stepMemory = []`) — این حافظه‌ی *یک اجرا* است، نه حافظه‌ی بلندمدت (آن کار `context.js` و memory layers است).

---

## 8. Loop Safety — همه‌ی گاردها یک‌جا

| گارد | کجا کنترل می‌شود | پیش‌فرض | نتیجه‌ی فعال‌شدن |
|---|---|---|---|
| **max steps** | `maxSteps` در constructor | 12 | `status:'max_steps'`, `reason: max_steps_reached` |
| **timeout کل task** | `maxTaskTimeoutMs` در constructor؛ چک شده در ابتدای هر step با `Date.now() - startedAt` | 300000 (۵ دقیقه) | `status:'error'`, `reason: task_timeout` |
| **tool retry** | `toolRetry` در constructor + `action.retry` per-call | بخش ۴ | retry شفاف، بدون اطلاع‌رسانی به کاربر تا زمانی که موفق شود یا exhaust شود |
| **loop detection** | fingerprint (`tool:JSON(args)`) آخرین `maxRepeatedToolCalls` tool_call | 3 | `status:'error'`, `reason: stuck_loop_detected` |
| **max token guard** | مقایسه‌ی `context.usedTokens` با `context.maxTokens` *بعد* از تلاش compaction خودکار `ContextWindow` | از `ContextWindow` گرفته می‌شود | `status:'error'`, `reason: max_tokens_exceeded` |
| **tool-failure exhaustion** | `maxConsecutiveToolExhaustion` | 2 | `status:'error'`, `reason: tool_failure_exhausted` |
| **abort signal** | `runOpts.signal` استاندارد `AbortSignal` | — | `status:'aborted'`, `reason: aborted_by_signal` |
| **custom stop conditions** | آرایه‌ی `stopConditions` یا `namedStopConditions` در constructor؛ هرکدام یک condition در Stop Condition Engine (بخش ۱۲) | `[]` | `status:'stopped'`, `reason: <رشته‌ی خودت>` |
| **pause/resume** | `loop.pause()` هر زمان از بیرون؛ چک‌شده در مرز بین step‌ها | — | `status:'paused'`, `reason: paused_by_request`, `checkpoint` قابل‌resume |
| **tool approval gate** | `requireApprovalFor` در constructor (`'*'` یا آرایه‌ی اسم ابزار) OR تعریف خود ابزار (`requiresApproval: true`) | `[]` | `status:'awaiting_tool_approval'` (بدون hook) یا تصمیم فوری با `onToolApproval` — بخش ۱۵ |

### Stop Condition سفارشی — schema

```ts
type StopCondition = (state: {
  step: number;
  elapsedMs: number;
  context: ContextWindow;
  stepMemory: StepRecord[];
}) => string | null;   // رشته‌ی غیر-null یعنی «الان متوقف شو، این دلیلش است»
```

مثال: متوقف کردن اجرا اگر بیش از ۵ بار پشت‌سرهم یک ابزار خاص صدا زده شد (بدون نیاز به fingerprint دقیق args)، یا هر قانون کسب‌وکاری دیگری بدون نیاز به subclass کردن `AgentLoop`.

---

## 9. رویدادها (`LoopEvents`, برای `onEvent(event, payload)`)

| رویداد | کِی |
|---|---|
| `step_start` | ابتدای هر step، بعد از عبور از همه‌ی گاردهای safety |
| `think` | بعد از دریافت و validate شدن Action از reasoner |
| `act` | قبل از اجرای اولین تلاش یک tool_call |
| `tool_retry` | قبل از هر تلاش retry (نه تلاش اول) |
| `observe` | بعد از دریافت نتیجه‌ی نهایی (موفق یا exhaust‌شده) یک tool_call |
| `final` | وقتی `status` نهایی `'final'` شد |
| `need_clarification` | وقتی `status` نهایی `'need_clarification'` شد |
| `error` | فاز think شکست خورد، یا هر خطای دیگر |
| `max_steps_reached` | سقف step بدون جواب نهایی |
| `task_timeout` | سقف زمان کل task |
| `max_tokens_exceeded` | context هنوز over-budget بعد از compaction |
| `stuck_loop_detected` | fingerprint تکراری |
| `tool_failure_exhausted` | یک ابزار پشت‌سرهم retry-هایش را باخت |

هر throw داخل `onEvent` بی‌صدا catch می‌شود — observability هرگز نباید خود حلقه را بشکند.

---

## 10. `AgentLoop` constructor — schema کامل ورودی

```ts
new AgentLoop({
  context: ContextWindow,              // الزامی
  tools: ToolRegistry,                 // الزامی
  reasoner: (rendered, toolSchema) => Promise<Action>,  // الزامی
  maxSteps?: number = 12,
  maxRepeatedToolCalls?: number = 3,
  maxTaskTimeoutMs?: number = 300000,
  toolRetry?: RetryPolicy,             // پیش‌فرض بخش ۴
  maxConsecutiveToolExhaustion?: number = 2,
  maxToolCallsPerTool?: number = 8,          // گارد Tool Misuse — بخش ۲۲
  adaptiveMaxSteps?: { max: number, growthFactor?: number } | false = false,  // بودجه‌ی استپ تطبیقی — بخش ۲۲
  compressMaxChars?: number = 1500,
  compressToolResult?: (result: ToolResult, opts: {maxChars}) => ToolResult,
  stopConditions?: StopCondition[] = [],          // legacy، هنوز پشتیبانی می‌شود — بخش ۱۲
  namedStopConditions?: { [name: string]: StopCondition } = {},  // همان چیز، اما قابل شناسایی با نام — بخش ۱۲
  requireApprovalFor?: string[] | '*' = [],       // بخش ۱۵
  onToolApproval?: (request) => Promise<boolean|{approved,reason}>,  // بخش ۱۵
  lifecycleHooks?: LifecycleHooks = {},           // بخش ۱۳
  checkpointManager?: CheckpointManager,          // بخش ۱۶؛ پیش‌فرض یک نمونه‌ی خصوصی جدید
  checkpointDir?: string,                         // میانبر: new CheckpointManager({dir: checkpointDir})
  onEvent?: (event: string, payload: object) => void,
})
```

## `run()` / `resume()` / `resumeWithApproval()` — schema کامل

```ts
run(userInput: string, runOpts?: { signal?: AbortSignal, maxSteps?: number }) => Promise<LoopResult>  // maxSteps: override per-call بودجه‌ی پایه

resume(checkpoint: Checkpoint, runOpts?: { additionalInput?: string, signal?: AbortSignal }) => Promise<LoopResult>

resumeWithApproval(checkpoint: Checkpoint, approved: boolean, runOpts?: { additionalInput?: string, reason?: string, signal?: AbortSignal }) => Promise<LoopResult>
```

`AgentLoop.fromCheckpoint(checkpoint, constructorOpts) => AgentLoop` یک نمونه‌ی کاملاً جدید می‌سازد (برای حالت «پروسه ری‌استارت شد، فقط JSON چک‌پوینت را دارم») — بخش ۱۴.

## `getStepMemory()` / `getState()` / `getStateHistory()`

```ts
getStepMemory() => StepRecord[]     // کپی، نه رفرنس مستقیم به آرایه‌ی داخلی
getState() => LoopState             // state فعلی state machine — بخش ۱۳
getStateHistory() => Array<{from: LoopState|null, to: LoopState, at: number, meta: object}>
```

---

## 12. Stop Condition Engine (`StopConditionEngine`, `loop.stopEngine`)

قبل از این نسخه، چهار گارد (`abort_signal`, `task_timeout`, `max_tokens`, `custom stopConditions`) هرکدام یک `if` جدا در بدنه‌ی `run()` بودند. الان همه یک condition نام‌دار و اولویت‌دار داخل یک موتور واحدند — قابل inspect، register، unregister، بدون نیاز به دست‌زدن به کد `loop.js`.

### شکل یک condition

```ts
type StopConditionState = {
  step: number;
  elapsedMs: number;
  context: ContextWindow;
  stepMemory: StepRecord[];
  signal?: AbortSignal;
};

type StopConditionOutcome =
  | null | false | undefined                                  // نظری ندارم، ادامه بده
  | true                                                       // متوقف شو، reason = اسم خود condition
  | string                                                      // متوقف شو، reason = همین رشته
  | { reason: string; status?: string; message?: string };     // کنترل کامل روی خروجی

type StopCondition = (state: StopConditionState) => StopConditionOutcome;
```

### API

```ts
stopEngine.register(name: string, fn: StopCondition, opts?: { priority?: number = 100 }) => this
stopEngine.unregister(name: string) => this
stopEngine.list() => Array<{ name: string, priority: number }>
stopEngine.evaluate(state: StopConditionState) => { name, reason, status, message } | null
```

عدد `priority` کمتر = زودتر چک می‌شود. اولین condition که چیزی برگرداند، بقیه چک نمی‌شوند.

### چهار condition داخلی (به‌ترتیب اولویت)

| نام | priority | trigger | status |
|---|---|---|---|
| `pause_requested` | -10 | `loop.pause()` صدا زده شده | `'paused'` |
| `abort_signal` | 0 | `signal.aborted === true` | `'aborted'` |
| `task_timeout` | 10 | `elapsedMs >= maxTaskTimeoutMs` | `'error'` |
| `max_tokens` | 20 | context بعد از compaction هنوز over-budget | `'error'` |

هر ورودی `stopConditions` (آرایه، legacy) یا `namedStopConditions` (map) با priority `≥100` بعد از این چهارتا اضافه می‌شود — یعنی همیشه بعد از گاردهای safety پایه چک می‌شوند، نه قبلش.

یک condition که throw کند، بی‌صدا `null` در نظر گرفته می‌شود (log می‌شود اما هرگز run را نمی‌شکند) — دقیقاً همان قانون `onEvent`.

مثال استفاده‌ی زنده:
```js
loop.stopEngine.register('budget_cap', ({ step }) => (step >= 20 ? 'budget_cap_hit' : null), { priority: 50 });
// ...بعداً، اگر لازم شد:
loop.stopEngine.unregister('budget_cap');
```

---

## 13. State Management Engine (`LoopStateMachine`, `loop.state`)

یک state machine صریح و کوچک، مستقل از منطق تصمیم‌گیری. هر حرکت غیرمجاز throw می‌کند (`LoopError('INVALID_STATE_TRANSITION')`) به‌جای این‌که `.current` را در حالت مبهم بگذارد — خود `AgentLoop` هرگز اجازه نمی‌دهد این throw داخل حلقه منتشر شود (`_safeTransition` آن را catch و فقط log می‌کند)، اما اگر کد بیرونی مستقیم `loop.state.transition(...)` صدا بزند، خطا واقعی است.

### `LoopState` (مقادیر ثابت)

macro-lifecycle‌ای که از بیرون مهم است دقیقاً این است — هر state واقعاً وجود دارد، رصدپذیر است، و پرش غیرمجاز به آن throw می‌کند:

```
CREATED → RUNNING → AWAITING_TOOL_APPROVAL → PAUSED → RESUMED → COMPLETED / FAILED
```

`THINKING`/`ACTING`/`OBSERVING` هم واقعی و رصدپذیرند — فازهای ریزتر *داخل* یک `RUNNING` هستند (تاریخچه‌ی یک اجرای معمولی چیزی مثل `created→running→thinking→acting→observing→thinking→completed` است).

| state | یعنی چی |
|---|---|
| `created` | نمونه ساخته شده، هنوز `run()`ای صدا زده نشده (یا run قبلی کامل شده و آماده‌ی run بعدی است) |
| `running` | `run()`/`resume()`/`resumeWithApproval()` شروع شد، هنوز وارد اولین THINK نشده |
| `thinking` | منتظر خروجی `reasoner()` |
| `awaiting_tool_approval` | یک tool_call به تایید نیاز دارد؛ منتظر تصمیم خودکار (`onToolApproval`) یا بیرونی (`resumeWithApproval()`) — بخش ۱۵ |
| `acting` | در حال اجرای یک tool_call (شامل retry) |
| `observing` | نتیجه‌ی tool_call ثبت و compress می‌شود |
| `paused` | `pause()` گرفته شد؛ یک `checkpoint` معتبر برای `resume()` وجود دارد |
| `resumed` | لحظه‌ی گذرا بین یک `paused`/`awaiting_tool_approval` قبلی و برگشت به `running`؛ همیشه در تاریخچه ثبت می‌شود |
| `completed` | final / need_clarification / max_steps / یک stop condition عادی |
| `failed` | هر مسیر خطا (think_error, invalid_action, stuck_loop, tool_failure_exhausted, task_timeout, max_tokens, aborted) |

### جدول انتقال مجاز (`STATE_TRANSITIONS`)

| از | به |
|---|---|
| `created` | `running` |
| `running` | `thinking`, `acting`, `completed`, `failed`, `paused` |
| `thinking` | `acting`, `awaiting_tool_approval`, `completed`, `failed`, `paused` |
| `awaiting_tool_approval` | `acting`, `thinking`, `paused`, `failed`, `resumed` |
| `acting` | `observing`, `failed` |
| `observing` | `thinking`, `completed`, `failed`, `paused` |
| `paused` | `resumed`, `created` |
| `resumed` | `running` |
| `completed` | `created`, `running` |
| `failed` | `created`, `running` |

### API

```ts
class LoopStateMachine {
  constructor(initial?: LoopState = 'created')
  get current(): LoopState
  getHistory(): Array<{ from: LoopState|null, to: LoopState, at: number, meta: object }>
  canTransition(to: LoopState): boolean
  transition(to: LoopState, meta?: object): this     // throws LoopError روی حرکت نامعتبر
  reset(to?: LoopState = 'created'): this             // بدون validation؛ فقط checkpoint/resume از آن استفاده می‌کنند
}
```

هر تغییر state هم یک event `state_change` منتشر می‌کند: `{ to, meta, history: <آخرین رکورد> }`.

### Lifecycle Hooks (`lifecycleHooks`)

هر یک از هفت macro-state بالا یک هوک اختصاصی دارد که **دقیقاً یک بار**، هم‌زمان با ورود به آن state، صدا زده می‌شود — جدا از `onEvent` عمومی (که هر `state_change` را هم می‌بیند، شامل THINKING/ACTING/OBSERVING)، برای وقتی که فقط به این هفت لحظه‌ی خاص اهمیت می‌دهی:

```ts
type LifecycleHooks = {
  onCreated?: (payload: { state: 'created' }) => void;                               // همان لحظه‌ی new AgentLoop(...)
  onRunning?: (payload: { state: 'running', meta: object, step: number }) => void;
  onAwaitingToolApproval?: (payload: { state: 'awaiting_tool_approval', meta: object, step: number }) => void;
  onPaused?: (payload: { state: 'paused', meta: object, step: number }) => void;
  onResumed?: (payload: { state: 'resumed', meta: object, step: number }) => void;
  onCompleted?: (payload: { state: 'completed', meta: object, step: number }) => void;
  onFailed?: (payload: { state: 'failed', meta: object, step: number }) => void;
};
```

`onCreated` تنها هوکی است که همگام و داخل خود سازنده صدا زده می‌شود؛ بقیه از داخل `run()`/`resume()`/`resumeWithApproval()`. یک هوک که throw کند فقط لاگ می‌شود (`lifecycle:hook_failed`, در `logger.js`) — هیچ‌وقت حلقه را نمی‌شکند.

---

## 14. Checkpoint / Pause / Resume — قلب قابلیت توقف و ادامه

### چرا

یک run طولانی (مثلاً ۳۰ step، چند دقیقه) باید بشود از بیرون متوقفش کرد بدون از دست دادن پیشرفت، و بعداً — حتی روی یک process کاملاً جدید — از همان‌جا ادامه‌اش داد. `checkpoint()`/`pause()`/`resume()`/`AgentLoop.fromCheckpoint()` دقیقاً همین را می‌دهند.

### `Checkpoint` schema

```ts
type Checkpoint = {
  version: 1;
  createdAt: number;                 // Date.now() لحظه‌ی ساخت
  step: number;                      // آخرین step کامل‌شده (resume از step+1 شروع می‌کند)
  elapsedMs: number;                 // چند ms از بودجه‌ی maxTaskTimeoutMs مصرف شده (resume از همین‌جا ادامه می‌دهد)
  toolCallHistory: string[];         // fingerprint های اخیر، برای ادامه‌ی stuck-loop detection
  toolCallCounts: Record<string, number>;   // شمارنده‌ی per-tool (گارد overuse) — ادامه‌ی resume
  similarCallHistory: string[];      // پنجره‌ی هشدار الگوی تکراری
  budget: number | null;             // بودجه‌ی استپ مؤثر (تطبیقی) — resume از همان‌جا ادامه می‌دهد
  stepMemory: StepRecord[];          // کل تاریخچه‌ی ساخت‌یافته تا این لحظه
  consecutiveToolExhaustion: number; // شمارنده‌ی error recovery (بخش ۴)
  context: ReturnType<ContextWindow['toJSON']>;  // کل ترنسکریپت context (messages + dropped + بودجه)
  state: LoopState;                  // state لحظه‌ی ساخت checkpoint
  pendingApproval: { tool: string, args: object, reasoning?: string, step: number } | null;  // بخش ۱۵؛ فقط وقتی status بود 'awaiting_tool_approval'
};
```

### API

```ts
loop.pause() => this
// روی مرز بعدی step، run با status:'paused' برمی‌گردد و LoopResult.checkpoint را همراه دارد.

loop.checkpoint(meta?: { step?: number, elapsedMs?: number }) => Checkpoint
// می‌شود هر زمان صدایش کرد، حتی وسط یک run در حال اجرا (از هوک onEvent یا از یک تایمر بیرونی)،
// نه فقط بعد از pause(). همیشه از state زنده‌ی همین لحظه‌ی instance می‌سازد.

loop.resume(checkpoint: Checkpoint, runOpts?: { additionalInput?: string, signal?: AbortSignal }) => Promise<LoopResult>
// context را از checkpoint.context restore می‌کند (همان instance context، محتوایش overwrite می‌شود)،
// step numbering و ساعت maxTaskTimeoutMs را از همان‌جا ادامه می‌دهد (نه از صفر)،
// و اختیاری additionalInput را قبل از ادامه‌ی حلقه به context/reasoner اضافه می‌کند.

AgentLoop.fromCheckpoint(checkpoint: Checkpoint, constructorOpts: AgentLoopConstructorOpts) => AgentLoop
// یک نمونه‌ی کاملاً تازه می‌سازد (context/tools/reasoner جدید طبق constructorOpts)
// و بلافاصله محتوای آن context را با checkpoint.context رونویسی می‌کند.
// برای «process قبلی از بین رفته، فقط JSON چک‌پوینت رو دارم» — مثلاً از دیسک/DB خواندی.
// بعدش باید loop.resume(checkpoint)/resumeWithApproval(checkpoint, approved) را هم صدا بزنی تا واقعاً ادامه پیدا کند.
```

### نکات مهم

- **هر** `LoopResult` (نه فقط `status:'paused'`) یک `checkpoint` معتبر همراه دارد — یعنی حتی از یک `final` یا `error` هم می‌شود «ادامه» گرفت (مثلاً بعد از final، یک `resume({additionalInput: '...'})` عملاً یک turn جدید روی همان context است).
- `pause()` **cooperative** است: فقط در مرز بین step‌ها چک می‌شود، هرگز وسط یک tool call در حال اجرا قطع نمی‌کند.
- `ContextWindow.restore()`/`ContextWindow.fromJSON()` (در `context.js`) دقیقاً همین‌جا استفاده می‌شوند: پیام‌ها را بدون re-validate یا token-re-estimate مستقیم برمی‌گردانند، چون از یک `toJSON()` قبلاً معتبر آمده‌اند.
- `resume()`/`resumeWithApproval()` روی همان instance، `maxSteps`/`maxTaskTimeoutMs` را reset نمی‌کند — این دو همچنان سقف *کل عمر run* هستند، نه سقف هر تک‌فراخوانی.
- یک checkpoint با `pendingApproval` ست‌شده فقط با `resumeWithApproval()` ادامه پیدا می‌کند؛ `resume()` روی چنین checkpointی خطای `PENDING_APPROVAL` می‌دهد (بخش ۱۵).

---

## 15. Tool Approval — دروازه‌ی تایید قبل از اجرای یک ابزار

### چرا

بعضی ابزارها (حذف فایل، ارسال ایمیل، اجرای دستور روی prod) نباید بدون تایید انسانی یا یک قانون خودکار اجرا شوند. این دروازه دقیقاً همان چیزی است که Claude Code/Cursor برای «permission-gated tool» دارند: حلقه *قبل از ACT* متوقف می‌شود، نه بعدش.

### چه چیزی یک ابزار را گیت می‌کند

یک `tool_call` وقتی گیت می‌شود که **یکی** از این دو درست باشد:
- تعریف خود ابزار در `ToolRegistry.register({..., requiresApproval: true})` این را گفته باشد، یا
- اسم ابزار در `requireApprovalFor` (آرایه) constructor باشد، یا `requireApprovalFor === '*'` (همه‌ی ابزارها).

### دو مسیر تصمیم‌گیری

**۱. خودکار، بدون توقف** — وقتی `onToolApproval` داده شده:

```ts
type ApprovalRequest = { tool: string, args: object, reasoning?: string, step: number };
type ApprovalVerdict = boolean | { approved: boolean, reason?: string };
onToolApproval: (request: ApprovalRequest) => Promise<ApprovalVerdict>;
```

اگر `true`/`{approved:true}` → ابزار همان لحظه اجرا می‌شود (رویداد `tool_approval_granted`). اگر `false`/`{approved:false, reason}` → ابزار اجرا **نمی‌شود**، یک پیام سیستمی `[tool approval] ...` به context اضافه می‌شود تا reasoner بداند چرا رد شد و مسیر دیگری امتحان کند (رویداد `tool_approval_rejected`)، و run به THINK بعدی ادامه می‌دهد (بدون توقف).

**۲. بیرونی/انسانی، با توقف** — وقتی `onToolApproval` داده نشده: run با `status:'awaiting_tool_approval'` و `LoopResult.pendingApproval = {tool, args, reasoning, step}` برمی‌گردد؛ `state` هم `awaiting_tool_approval` است. تصمیم بعداً با این متد می‌رسد:

```ts
loop.resumeWithApproval(checkpoint: Checkpoint, approved: boolean, runOpts?: { additionalInput?: string, reason?: string, signal?: AbortSignal }) => Promise<LoopResult>
```

- `approved = true` → همان tool_call دقیقاً همان‌طور که قرار بود اجرا می‌شود (ACT+OBSERVE کامل)، بعد run عادی ادامه پیدا می‌کند.
- `approved = false` → مثل مسیر خودکار رد می‌شود؛ `runOpts.reason` وارد پیام رد می‌شود.
- شماره‌ی step دقیقاً همان step معلق ادامه پیدا می‌کند (نه +1)، چون آن step قبلاً «صرف» نشده بود.

### رویدادها

| رویداد | payload |
|---|---|
| `tool_approval_requested` | `{tool, args, reasoning, step}` |
| `tool_approval_granted` | `{step, tool}` |
| `tool_approval_rejected` | `{step, tool, reason?}` |

---

## 16. Checkpoint Manager (`CheckpointManager`, `loop.checkpoints`)

`loop.checkpoint()` همیشه، خودکار، هر snapshot را هم به یک `CheckpointManager` می‌سپارد — نه فقط آخرین snapshot را برمی‌گرداند. این یعنی یک supervisor بیرونی (bot Slack، cron، اسکریپت crash-recovery) می‌تواند **هر** checkpoint گذشته را با id پیدا کند، نه فقط آخرین.

```ts
new CheckpointManager({ dir?: string, maxInMemory?: number = 50 })

checkpoints.save(snapshot: Checkpoint, meta?: object) => Promise<string>   // id تازه
checkpoints.get(id: string) => Promise<{id, savedAt, meta, snapshot} | null>
checkpoints.list() => Array<{id, savedAt, meta, step, state}>             // بدون payload کامل — سبک
checkpoints.latest() => {id, savedAt, meta, snapshot} | null
checkpoints.loadFromDisk() => Promise<number>   // بعد از ری‌استارت پروسه، همه‌ی *.json موجود در dir را ایندکس می‌کند
checkpoints.delete(id: string) => Promise<void>
```

بدون `dir`، فقط در حافظه است (تا `maxInMemory` تای آخر نگه داشته می‌شود). با `dir`، هر checkpoint یک فایل `<id>.json` هم می‌شود — پس با `AgentLoop({ checkpointDir: '.../session-123' })` یا `checkpointManager` مشترک بین چند instance، می‌شود بعد از ری‌استارت کامل پروسه دوباره سراغ همه‌ی checkpointهای یک session رفت.

---

## 17. Session Logger — لاگ کامل هر session روی دیسک (برای دیباگ)

`logger.js` فقط stdout/stderr می‌نویسد (کنترل‌شده با `SCRAPPYAI_LOG_LEVEL`). `SessionLogger` مستقل از آن، **همیشه** برای هر session یک پوشه می‌سازد:

```
logs/<sessionId>/events.jsonl     یک خط JSON برای هر رویداد — {seq, ts, source, event, payload} — بدون خلاصه‌سازی
logs/<sessionId>/transcript.log   همان جریان، رندر انسانی: یک بلوک برای هر Thought/Tool Call/Observation/Final Answer
```

```ts
new SessionLogger({ sessionId: string, rootDir?: string = process.env.SCRAPPYAI_LOG_DIR || 'logs' })
sessionLogger.log(event: string, payload: object, source?: string = 'loop') => LoggedEntry
sessionLogger.logStep(record: StepRecord) => LoggedEntry

attachSessionLogger(loop: AgentLoop, sessionLogger: SessionLogger) => AgentLoop
// onEvent موجود loop را جایگزین نمی‌کند؛ هر رویداد را هم به sessionLogger و هم به onEvent قبلی می‌فرستد.
```

`buildAgent()` (در `index.js`) این را به‌طور پیش‌فرض روشن می‌کند (غیرفعال با `SCRAPPYAI_SESSION_LOG=false` یا `{ sessionLog: false }`)، و از همان `sessionId`ی استفاده می‌کند که برای memory scoping هم استفاده می‌شود — یعنی یک id، سه مصرف: memory، لاگ، و پوشه‌ی چک‌پوینت (`SCRAPPYAI_CHECKPOINT_DIR`).

---

## 18. Trace Renderer — خروجی ترمینال تمیز به‌جای JSON خام (`trace.js`)

`createTraceRenderer()` رویدادهای خام `onEvent` را به یک ترنسکریپت رنگی، خوانا، شبیه Claude Code تبدیل می‌کند:

```ts
createTraceRenderer({ output?: NodeJS.WritableStream = process.stdout, color?: boolean, verbose?: boolean = false })
  => { onEvent: (event, payload) => void, colorEnabled: boolean }
```

`● Thought` (فقط برای اکشن‌های غیر-tool_call)، `⚙ Tool Call`، `↻ retry`، `✔/✘` برای observe، `⏸ Awaiting Tool Approval`، `● Final Answer`، `● Clarification Needed`، `● Error` — همه با رنگ (auto-disable روی non-TTY یا `NO_COLOR`). `renderScratchpad(stepMemory)` هم کل Step Memory را به یک "Agent Scratchpad" شماره‌گذاری‌شده تبدیل می‌کند (مستقل از context فشرده‌شده). `index.js`/`repl.js` این‌ها را به‌جای `console.error(JSON.stringify(...))` قبلی استفاده می‌کنند؛ `/scratchpad` هم یک دستور REPL جدید است.

---

## 19. تست‌ها (اثبات رفتار، نه فقط ادعا)

`tests/loop-advanced.test.js` (۹ تست — retry، exhaustion، fail-fast، task timeout، max tokens، compression، custom stop condition، invalid action، step memory) +
`tests/loop-checkpoint.test.js` (۸ تست — pause/resume/checkpoint/state machine/stop engine) +
`tests/loop-approval.test.js` (۱۰ تست جدید — tool approval، lifecycle hooks، CheckpointManager، SessionLogger):

**loop-checkpoint.test.js:**
1. `pause()` دقیقاً روی مرز step بعدی متوقف می‌شود و یک checkpoint معتبر برمی‌گرداند
2. `resume()` همان run را تا `final` ادامه می‌دهد، با step numbering ادامه‌دار (نه از صفر)
3. `AgentLoop.fromCheckpoint()` روی یک نمونه‌ی کاملاً جدید (شبیه‌سازی ری‌استارت process) کار می‌کند
4. تاریخچه‌ی state machine برای یک اجرای موفق دقیقاً `created→running→thinking→acting→observing→thinking→completed` است
5. `LoopStateMachine` یک انتقال غیرمجاز را throw می‌کند و state را دست‌نخورده نگه می‌دارد
6. `stopEngine.list()`/`register()`/`unregister()` چهار condition داخلی + یک condition سفارشی را درست مدیریت می‌کنند
7. `namedStopConditions` یک condition قابل‌شناسایی با اسم دلخواه ثبت می‌کند و `stopCondition` را در نتیجه برمی‌گرداند
8. `checkpoint()` وسط یک run (بدون pause) هم یک snapshot معتبر و قابل‌resume می‌سازد

**loop-approval.test.js:**
1. یک ابزار با `requiresApproval: true` و بدون `onToolApproval` دقیقاً در `awaiting_tool_approval` متوقف می‌شود
2. `resumeWithApproval(checkpoint, true)` ابزار گیت‌شده را واقعاً اجرا می‌کند و تا final ادامه می‌دهد
3. `resumeWithApproval(checkpoint, false)` هندلر ابزار را اصلاً صدا نمی‌زند و یک پیام رد به context اضافه می‌کند
4. `onToolApproval` تصمیم را خودکار می‌گیرد، بدون توقف run
5. `requireApprovalFor: '*'` همه‌ی ابزارها را گیت می‌کند، حتی بدون `requiresApproval` خود ابزار
6. `lifecycleHooks` دقیقاً به‌ترتیب ورود به هر macro-state آتش می‌شوند (`onCreated` هم‌زمان با constructor)
7. `lifecycleHooks.onFailed` روی یک خطای واقعی (reasoner که throw می‌کند) آتش می‌شود
8. `CheckpointManager.save()/get()/list()` در حافظه با id درست کار می‌کنند
9. `CheckpointManager` با یک `dir`، بعد از یک نمونه‌ی کاملاً تازه (`loadFromDisk()`)، همان checkpoint را برمی‌گرداند
10. `SessionLogger` هر رویداد یک run را در `events.jsonl` (JSON کامل) و `transcript.log` (خوانا) می‌نویسد

### یادداشت: `running → acting`

`STATE_TRANSITIONS` اجازه‌ی `running → acting` را هم می‌دهد — تنها مصرف‌کننده‌ی این یال، مسیر
`resumeWithApproval(checkpoint, true)` است که اکشنش از قبل تصمیم‌گیری شده و بدون فاز THINK
مستقیم وارد ACT می‌شود. یک `run()` تازه همیشه `running → thinking → acting` می‌رود و این یال
اضافی را لمس نمی‌کند. بدون آن، state machine تاریخچه‌ی فازهای acting/observing یک resume
تأییدشده را بی‌صدا رد می‌کرد (فقط لاگ می‌شد) و تاریخچه‌ی state ناقص می‌ماند.

---

## 20. Streaming — loop آگاه نیست، و نباید هم باشد

Streaming عمداً بیرون از `loop.js` پیاده شده تا قرارداد `reasoner(rendered, toolSchema) => Action`
دست‌نخورده بماند:

- `clients/9router.js` متد دوم `chatStream({ systemPrompt, messages, tools, onDelta, signal })`
  دارد: همان بدنه‌ی درخواست با `stream: true`، اما پاسخ به‌صورت SSE زنده خوانده می‌شود.
  `delta.content` ها یکی‌یکی از `onDelta({type:'content', text})` عبور می‌کنند و fragment های
  `delta.tool_calls[].function.arguments` بر اساس `index` ادغام می‌شوند تا یک tool_call کامل
  ساخته شود. سه حالت دفاعی: بدنه‌ی JSON ساده (gateway ای که stream:true را نادیده می‌گیرد)
  همان‌طور پارس می‌شود؛ هر چیزی بعد از `data: [DONE]` نادیده گرفته می‌شود؛ و اگر هیچ آبجکت
  SSE‌ای نرسد، همان `parseJsonResponse` دفاعی مسیر `chat()` استفاده می‌شود.
- `src/reasoner.js` با `createReasoner({ stream: true, onToken })` — وقتی `client.chatStream`
  موجود باشد از آن استفاده می‌کند (وگرنه همان `chat()`)، خروجی را به همان `Action` نرمال می‌کند،
  و فقط chunk های محتوای پاسخ نهایی را به `onToken(text)` می‌دهد (fragment های آرگومان tool هرگز).
  `reasoner.setTokenSink(fn)` سینک را بعد از ساخت reasoner عوض می‌کند — REPL/UI نیازی به
  بازسازی agent ندارد.
- حلقه (این فایل) هیچ تغییری نکرده: یک turn streaming دقیقاً همان
  `think → act → observe` را طی می‌کند، چون reasoner چه stream کند چه نکند همان `Action` را
  برمی‌گرداند. تست‌ها (`tests/streaming.test.js`، ۱۰ تست) این را اثبات می‌کنند: یک run کامل
  با 9router واقعی + fetch تقلبی که اول tool_call استریمی می‌فرستد و بعد پاسخ نهایی استریمی.



## 22. بودجه‌ی استپ تطبیقی + گاردهای استفاده از ابزار

### Adaptive step budget — «max_steps بر اساس کار لازم»

یک سقف ثابت یا خیلی کم استپ‌ها را می‌برد یا توکن می‌سوزاند. حالا `maxSteps` فقط *پایه* است:

- `adaptiveMaxSteps: { max, growthFactor = 2 }` — بودجه از `maxSteps` شروع می‌شود و تا `max` (پیش‌فرض
  در `buildAgent()`: ۴۸) هر بار که یک step کامل شود و run هنوز به پایان نرسیده، دو برابر می‌شود
  (`budget_extended` event + لاگ `run:budget_extended`). مسیرهای خطا (stuck/timeout/overuse) به این
  نقطه نمی‌رسند، پس رشد فقط پاداش پیشرفت واقعی است.
- `runOpts.maxSteps` — override per-call روی پایه.
- `LoopResult.budget` و `checkpoint.budget` — بودجه‌ی مؤثر؛ resume از همان بودجه ادامه می‌دهد.
- خاموش با `adaptiveMaxSteps: false` یا `SCRAPPYAI_ADAPTIVE_MAX_STEPS=false`.

### گارد Tool Overuse (ضد «Tool Misuse»)

`maxToolCallsPerTool` (پیش‌فرض ۸): شمارنده‌ی per-tool کل run (آرگومان‌ها مهم نیستند — همان ابزار با
کوئری‌های بی‌پایان هم شمرده می‌شود). عبور از سقف → `status:'error'`, `reason:'tool_overuse'`,
پیام `[loop guard]` در context، رویداد `tool_overuse`. شمارنده در checkpoint ذخیره و در resume
بازیابی می‌شود.

### هشدار Similar Call (الگوی تکراری)

`_isSimilarCall()` — همان ابزار با آرگومان‌هایی که بعد از normalize (مرتب‌سازی کلیدها) یکسان‌اند،
اگر در پنجره‌ی ۸ فراخوانی اخیر دیده شده باشند (به‌جز تکرار متوالیِ دقیق که مال گارد stuck-loop است):
یک پیام `[loop guard]` به context اضافه و رویداد `similar_call` منتشر می‌شود — غیرترمینال؛ فقط به
reasoner هشدار می‌دهد که داده را دارد و تکرار نکند.

---

## 23. حافظه بین turn ها — sync پیام‌های سیستمی در reasoner

دو باگ واقعی باعث می‌شد «حافظه بین turn ها» بی‌صدا کار نکند:

1. `wireMemory()` بلوک `[memory]` را به `ContextWindow` اضافه می‌کرد، اما `createReasoner()` فقط
   پیام‌های user/assistant/tool را به history بومی‌اش mirror می‌کرد — پس مدل هرگز بلوک حافظه را
   نمی‌دید. حالا reasoner در هر فراخوانی، پیام‌های سیستمیِ پویا را از context رندر شده sync می‌کند:
   بلوک فعلی `[memory]` جایگزین بلوک قبلی می‌شود (فکت‌ها عوض می‌شوند؛ تکرار توکن نمی‌سوزاند) و
   پیام‌های سیستمی دیگر (`[loop guard]`, `[context summary]`) یک بار (dedupe با content) اضافه می‌شوند.
2. استخراج فکت فقط به یک model call وابسته بود؛ اگر مدل خطا می‌داد یا چیزی برنمی‌گرداند، هیچ‌چیز
   به خاطر سپرده نمی‌شد. حالا `memory-extractor.js` وقتی trigger منطبق است و مدل خروجی نداشت، با
   الگوهای محلی قطعی (name/email/phone/city/role/preference/birthday) فکت را با
   `source:'explicit', confidence:1` استخراج می‌کند — «اسم من X است» حتی با مدل خراب هم ثبت می‌شود.

ضمناً `wireMemory()` حالا `resume()`/`resumeWithApproval()` را هم wrap می‌کند (تزریق قبل، ثبت بعد)
و رویدادهای حافظه را از طریق `agent.onEvent` جاری (شامل wrapper سشن‌لاگر) منتشر می‌کند تا در
`events.jsonl` هم دیده شوند.

---

## 24. شمارش نهایی تست‌ها

همه‌ی فایل‌های تست با هم: **۱۵۲/۱۵۲ تست سبز** — ۹ تست `loop-advanced`، ۸ تست `loop-checkpoint`،
۱۰ تست `loop-approval`، ۱۵ تست `reasoner` (شامل sync حافظه و non-duplication پرامپت)، ۱۰ تست `9router`، ۱۳ تست `tools`، ۵ تست `planning` (موتور برنامه، DAG، GoalDecomposer، TaskTree، DAGExecutor و ابزارهای plan_create/update/get/add_tasks)، ۷ تست `verification` (موتور تایید، VerificationPipeline، validators و ابزارهای verify_file/command/json/suite)، ۸ تست `loop-guards`
(بودجه‌ی تطبیقی، overuse، similar-call)، ۹ تست `filesystem`، ۶ تست `shell-extra`، ۹ تست
`code-package`، ۱۴ تست `memory` (شامل fallback محلی و fix حافظه بین turn)، ۱۰ تست `streaming`،
۶ تست `logger`، ۸ تست `smoke` و ۵ تست `repl`. بدون شکستن هیچ‌کدام.

اجرا: `npm test` (از ریشه‌ی `scrappyai`).
