# Mindmark 原文阅读与知识卡双视图实施方案

> 状态：已实施并完成远端 v5 发布
>
> 日期：2026-08-02
>
> 参考方向：RemNote 同一知识空间内的文档阅读与闪卡学习切换
>
> 适用范围：UPLOAD Learning Project 与 PACK Learning Project 的 Chapter 学习界面

## 1. 目标

实施结果：UPLOAD Chapter 已支持按 Source Block 连续阅读；Chapter 页通过 URL 分段控件切换原文/课程正文与知识卡浏览；卡片浏览支持展开、代码展示和双向来源定位，正式 FSRS 复习仍保持独立。`solidity-foundations@5.0.0` 已发布，16 章、112 张卡均绑定同章作者正文块。

Mindmark 当前已经能按 Chapter 浏览知识卡并进入 FSRS 复习，但上传资料的原文只作为 AI 规划与引用证据保存在 `source_blocks`，学习者无法连续阅读；预置卡包也只有章节摘要和知识卡，没有独立课程正文。

本方案把一个 Chapter 表达为同一份学习内容的三个互不混淆的使用状态：

1. **原文 / 课程正文**：连续阅读材料，不改变复习状态。
2. **知识卡**：浏览本章全部卡片，可以展开答案，不改变复习状态。
3. **正式复习**：只使用 FSRS 队列，显示答案后才能评分并推进学习状态。

核心目标不是复制 RemNote 的块编辑器，而是复用它最有价值的学习模式：学习者可以在上下文阅读和主动回忆之间快速往返。

## 2. MVP 决策

### 2.1 同一 Chapter、两个浏览视图

原文和知识卡不能做成两个彼此无关的页面或两份内容副本。Chapter 仍是学习者的导航边界，视图只改变主内容区：

```text
┌──────── Chapter 目录 ────────┬──────────────────────────────────┐
│ 01 合约外壳                  │ [ 原文/课程正文 | 知识卡 ]  开始复习 │
│ 02 值类型                    ├──────────────────────────────────┤
│ 03 函数签名                  │                                  │
│ ...                          │        当前模式的主内容区          │
│                              │                                  │
└──────────────────────────────┴──────────────────────────────────┘
```

浏览视图状态写入 URL：

```text
/learn/projects/:projectId/chapters/:chapterId?view=reading
/learn/projects/:projectId/chapters/:chapterId?view=cards
```

URL 是权威状态，因此刷新、浏览器前进后退和分享内部链接都能保持当前模式。

### 2.2 正式复习保持独立

知识卡浏览不显示“困难 / 掌握 / 轻松”，也不调用 Review RPC。正式评分只出现在现有 Study Session 中，避免学习者仅仅展开答案就意外推进 FSRS。

### 2.3 UPLOAD 首先复用 Source Block

第一阶段不保存 PDF 二进制，也不重新调用 AI。上传时已经持久化的 `source_blocks` 包含顺序、页码、块类型和文本，足以提供结构化原文阅读。

MVP 的“原文”表示从 PDF 或粘贴内容提取出的忠实结构化文本，不保证还原 PDF 字体、图片和精确排版。精确 PDF 阅读器列入后续阶段。

### 2.4 PACK 正文必须是作者内容

现有 `solidity-foundations@4.0.0` 只有知识卡和章节元数据。不能把卡片答案拼接后标成“原文”。

PACK 使用“课程正文”标签，并通过新的不可变 Card Pack Version 发布作者编写的 `readingBlocks`。v1 到 v4 保持不可变，完整双视图从 `solidity-foundations@5.0.0` 开始提供。

### 2.5 不增加 AI、Runner 或 Monad 流程

双视图是读取模型和界面能力：

- 不使用 LangChain 或 LangGraph。
- 不创建 Workflow Job 或 Work Unit。
- 不在切换视图时生成内容。
- 不修改 Monad commitment。
- 不影响 Worker Reward。

## 3. 当前系统基础与缺口

### 3.1 已有能力

- `source_blocks` 已保存 UPLOAD Project 的结构化原文。
- `chapters.start_block/end_block` 已定义 Chapter 对应的连续原文范围。
- `chapters.page_start/page_end` 已提供页码范围。
- Chapter Study API 已返回全部卡片、当前状态和 FSRS 队列。
- Knowledge Card 已保留逐字 `quote` 和 `page`。
- PACK Project 已与 Upload AI/Runner/Monad 生命周期隔离。

### 3.2 当前缺口

- 没有 owner-scoped 的 Chapter 原文读取 API。
- Chapter 页面只有知识卡列表，没有视图分段控件。
- 卡片引用只有页码和逐字引用，没有稳定的浏览定位结果。
- 卡片浏览和正式复习的产品语义还没有在组件层明确拆分。
- Card Pack Schema 没有课程正文块。
- 原始 PDF 二进制未持久化，暂时不能做像素级 PDF 查看。

## 4. 用户体验合同

### 4.1 Chapter 顶部

保留标题、摘要、进度和开始复习命令，在标题下增加固定的分段控件：

```text
UPLOAD： [原文] [知识卡]
PACK：   [课程正文] [知识卡]
```

按钮规则：

- 第一次打开有正文的 Chapter，默认 `reading`。
- PACK v1-v4 没有课程正文，默认 `cards`，不显示不可用的空标签。
- 从卡片点击来源时，强制切换到 `reading` 并定位引用。
- 从正式复习退出时，返回进入复习前的 Chapter 浏览视图。

### 4.2 原文阅读模式

- 主阅读列最大宽度约 720px。
- heading、paragraph、code 使用不同但克制的排版。
- 跨页时显示页码分隔。
- 保持 Source Block 原始顺序。
- URL hash 使用稳定块锚点，例如 `#source-block-17`。
- 被卡片定位的引用块短暂高亮，但不改变布局尺寸。
- 原文内容只在切换到阅读模式时懒加载。

### 4.3 知识卡浏览模式

- 展示本 Chapter 的全部卡片，不使用今日队列过滤。
- 卡片显示类型、NEW/LEARNING/DUE/SCHEDULED 状态和关键点。
- 点击卡片可展开答案、代码、运行结果和来源。
- 每张有定位结果的卡片提供“查看原文”图标按钮。
- 浏览模式不创建 Review Session，不发送评分请求。

### 4.4 正式复习模式

继续使用现有 `StudySessionView`：

- 只学习当前 FSRS queue。
- 揭晓答案后显示评分。
- 评分采用现有串行写队列和乐观前进。
- 完成后返回原 Chapter，而不是跳回资料库首页。

### 4.5 移动端

- Chapter Rail 收入抽屉。
- 分段控件在内容顶部保持可见。
- 原文保持单列，不做左右分屏。
- 卡片代码块允许横向滚动。
- 页面不得出现标题、分段控件和复习按钮相互覆盖。

## 5. 统一读取合同

在 `packages/shared/src/project-v2.ts` 增加以下 Schema。字段名称以最终实现为准，但必须保留来源差异：

```ts
const ChapterReadingBlockSchema = z.object({
  blockId: z.string().min(1).max(120),
  position: z.number().int().nonnegative(),
  kind: z.enum(["heading", "paragraph", "code", "callout"]),
  text: z.string().min(1).max(30_000),
  pageNumber: z.number().int().positive().nullable(),
  language: z.string().max(40).nullable(),
}).strict();

const ChapterCardReadingLinkSchema = z.object({
  cardId: Bytes32Schema,
  blockId: z.string().min(1).max(120),
  match: z.enum(["EXPLICIT", "QUOTE", "PAGE_FALLBACK"]),
}).strict();

const ChapterReadingResponseSchema = z.object({
  projectId: Bytes32Schema,
  chapterId: z.number().int().min(0).max(15),
  origin: z.enum(["UPLOAD_SOURCE", "PACK_LESSON"]),
  title: z.string().min(1).max(200),
  pageStart: z.number().int().positive().nullable(),
  pageEnd: z.number().int().positive().nullable(),
  blocks: z.array(ChapterReadingBlockSchema),
  cardLinks: z.array(ChapterCardReadingLinkSchema),
}).strict();
```

不要把两种来源强行改成一种 provenance：

- `UPLOAD_SOURCE` 仍来自真实 `source_blocks`。
- `PACK_LESSON` 仍来自不可变 Card Pack 内容。
- PACK 不创建伪造 Source Block、PDF 页码或 Work Unit。

## 6. 服务端读取模块

新增深 Module：

```text
apps/web/lib/server/project-reading.ts
```

建议接口：

```ts
interface ProjectReadingStore {
  loadOwnedProjectChapter(projectId, chapterId, owner): Promise<... | null>;
  loadUploadBlocks(projectId, startBlock, endBlock): Promise<...[]>;
  loadPackReadingBlocks(packVersionId, packChapterId): Promise<...[]>;
  loadChapterCards(projectId, chapterId): Promise<...[]>;
}

getChapterReadingForOwner(projectId, chapterId, owner, store)
  -> ChapterReadingResponse
```

职责边界：

- Route 只负责 Wallet Session、参数 Schema 和错误映射。
- `project-reading.ts` 决定读取 UPLOAD 还是 PACK。
- Adapter 负责 Supabase 表字段。
- React 组件不直接读取 `source_blocks` 或 Card Pack 表。

## 7. API

新增：

```text
GET /api/projects/:projectId/chapters/:chapterId/reading
```

处理顺序：

```text
Wallet Session
  -> 校验 projectId / chapterId
  -> 查询 owner-owned Learning Project 与 Chapter
  -> 根据 project_kind 选择读取来源
  -> 解析卡片引用定位
  -> ChapterReadingResponseSchema.parse
  -> Response.json
```

错误合同：

| 场景 | HTTP | code |
| --- | ---: | --- |
| Project 或 Chapter 不属于当前 owner | 404 | `chapter_not_found` |
| PACK 版本没有课程正文 | 404 | `reading_not_available` |
| 来源数据损坏或顺序不连续 | 500 | `reading_load_failed` |

UPLOAD 原文属于用户资料，响应使用 `Cache-Control: private, no-store`。PACK Lesson 可以按不可变 Pack Version 做服务端缓存，但不能让缓存绕过 owner 校验。

## 8. UPLOAD 原文读取

### 8.1 查询范围

读取当前 Chapter 的：

```text
source_blocks.block_index between chapters.start_block and chapters.end_block
order by block_index
```

不能一次返回整个 Project 的 60,000 字符，也不能由浏览器提交任意 start/end 范围。

### 8.2 Block 映射

```text
source_blocks.block_index  -> blockId = source-block-{block_index}
source_blocks.kind         -> heading / paragraph / code
source_blocks.text         -> text
source_blocks.page_number  -> pageNumber
```

`source_blocks` 是事实来源，不在读取时重新总结、翻译或改写。

### 8.3 旧卡片引用定位

现有 UPLOAD 卡片只有 `source.page` 和 `source.quote`。MVP 在服务端解析定位：

1. 只在相同 `page_number` 的 Block 中匹配。
2. 对 Block 和 quote 执行相同的 NFKC、空白压缩和标点规范化。
3. 优先完整 quote 包含匹配。
4. 无完整匹配时，允许唯一的高覆盖率前缀匹配。
5. 仍未匹配时只返回页码 fallback，不伪造精确 Block。

匹配结果只属于读取响应，不回写或修改已 commitment 的旧 Knowledge Card。

后续新生成卡片可以增加可选 `sourceBlockIndex`，但它必须保持在所属 Work Unit 和 Chapter 范围内。

## 9. PACK 课程正文与 v5

### 9.1 新表

建议增加：

```sql
create table public.card_pack_chapter_reading_blocks (
  pack_version_id uuid not null,
  chapter_id smallint not null,
  block_id text not null,
  position smallint not null,
  kind text not null,
  text text not null,
  language text,
  primary key (pack_version_id, chapter_id, block_id),
  unique (pack_version_id, chapter_id, position),
  foreign key (pack_version_id, chapter_id)
    references public.card_pack_chapters(pack_version_id, chapter_id)
    on delete restrict
);
```

它继承 Card Pack Version 的发布后不可变保护。正文保存在公共 Pack Version，用户阅读进度和 FSRS 状态仍保存在安装后的 Learning Project。

### 9.2 v5 内容格式

每章 fixture 增加：

```json
{
  "readingBlocks": [
    { "blockId": "contract-shell-intro", "position": 0, "kind": "heading", "text": "从源码到链上实例" },
    { "blockId": "contract-shell-source", "position": 1, "kind": "paragraph", "text": "..." },
    { "blockId": "contract-shell-example", "position": 2, "kind": "code", "language": "solidity", "text": "..." }
  ]
}
```

Pack Card 增加可选导航字段 `readingBlockId`。v5 发布质量门要求：

- 每章至少一个 heading、两个 paragraph。
- 编程章节至少一个 Solidity code block。
- 每个 reading block ID 唯一且 position 连续。
- 每张卡的 `readingBlockId` 必须存在于同章。
- 正文不能由安装时 AI 临时生成。
- v1-v4 内容和 hash 不得修改。

### 9.3 v4 兼容

- v4 已安装 Project 继续正常浏览和复习知识卡。
- v4 Chapter 不显示空的“课程正文”模式。
- v5 作为新 Card Pack Version 发布，由用户明确安装或升级。
- 不把 v5 正文静默写进既有 v4 Project。

## 10. 前端组件拆分

当前 `project-learning-workspace.tsx` 已同时承担登录、Project/Chapter 加载、知识卡列表和复习会话。实施时应拆分，避免继续扩大单文件状态耦合：

```text
apps/web/components/project-learning-workspace.tsx
apps/web/components/chapter-learning-workspace.tsx
apps/web/components/chapter-view-switcher.tsx
apps/web/components/chapter-reading-view.tsx
apps/web/components/chapter-card-browser.tsx
apps/web/components/study-session-view.tsx
```

建议状态：

```ts
type ChapterView = "reading" | "cards";

selectedView       // 来自 URL
reading            // 懒加载 ChapterReadingResponse
readingLoading
readingError
expandedCardIds    // 仅浏览 UI 状态
highlightedBlockId // 卡片跳转原文时短暂设置
```

`ChapterCardBrowser` 只接收已有 `ChapterStudyResponse.cards`，不持有评分写入能力。`StudySessionView` 继续通过显式 command 进入。

## 11. 双向跳转

### 11.1 卡片到原文

```text
点击“查看原文”
  -> 更新 URL 为 ?view=reading#source-block-N
  -> 若原文未加载则请求 reading API
  -> scrollIntoView({ block: "center" })
  -> 设置 data-highlight=true
  -> 动画结束后只移除高亮，不移除 URL hash
```

### 11.2 原文到卡片

原文 Block 可显示紧凑的关联卡片标记。点击后：

```text
?view=cards#card-{cardId}
```

卡片列表滚动到目标并展开。关联标记只在 `cardLinks` 非空时显示。

### 11.3 无定位结果

无精确 Block 的旧卡仍显示页码和逐字引用，但不显示假的跳转。UI 可以跳到该页第一个 Block，并明确使用 `PAGE_FALLBACK`，不能把它表现成精确引用命中。

## 12. 性能和可靠性

- 原文 API 只按 Chapter 范围读取。
- `reading` 模式第一次打开才请求数据。
- 同一 Chapter 响应在当前页面会话内缓存。
- 切换到 cards 不重新请求 Study API。
- 切换视图不创建 Review Session。
- 对长 Block 使用 `overflow-wrap`，代码使用独立横向滚动容器。
- 当前最多 30 页，不在 MVP 引入虚拟列表；使用 CSS `content-visibility` 即可。
- 读取失败只影响原文模式，知识卡浏览和正式复习仍可使用。

目标指标：

- 已加载后的视图切换无网络等待。
- Chapter reading API 在开发数据量下响应小于 500ms。
- 新生成 UPLOAD 卡片的原文定位覆盖率为 100%。
- PACK v5 卡片的显式 readingBlockId 覆盖率为 100%。
- 仅浏览知识卡时 ReviewLog 和 FSRS 状态零变化。

## 13. 安全边界

- 所有 UPLOAD reading API 必须先验证 Wallet Session 和 Project owner。
- 浏览器不能传 startBlock/endBlock 控制查询范围。
- 错误日志不得输出整段 Source Block 或用户原文。
- PACK reading content 可以公开，但安装后的 Project 和进度仍 owner-scoped。
- 原文渲染默认为纯文本；后续支持 Markdown 时必须使用严格 sanitizer。
- 代码块只显示文本，不执行任意 Solidity 或 JavaScript。

## 14. 测试计划

### 14.1 Shared

- `ChapterReadingResponseSchema` 接受 UPLOAD 和 PACK 两种来源。
- 拒绝重复 blockId、非连续 position、空正文和非法 kind。
- Card link 只能引用响应内存在的 blockId。

### 14.2 Server Module

- owner 能读取自己的 Chapter 原文。
- 其他钱包得到 404，不泄漏 Project 是否存在。
- 只返回 Chapter start/end 范围内 Block。
- Block 顺序、页码和文本保持不变。
- quote 能定位唯一 Block。
- 无法定位时返回 page fallback，不伪造 blockId。
- PACK v4 返回 `reading_not_available`。
- PACK v5 返回不可变课程正文。

### 14.3 API

- 未登录返回 401。
- 非法 projectId/chapterId 返回稳定错误。
- UPLOAD 响应使用 private/no-store。
- 不返回 owner、Work Unit、Worker 或内部 Source Hash。

### 14.4 Web

- URL query 能控制 reading/cards。
- 刷新和前进后退保留模式。
- 浏览卡片不会调用 Review API。
- 卡片来源能跳到正确 Block。
- 原文关联标记能跳回正确卡片。
- 正式复习完成后回到进入前模式。
- PACK v4 不显示空正文标签。
- 桌面和移动端没有导航、标题、代码和按钮重叠。

### 14.5 回归

- 现有 FSRS 调度和串行评分测试保持通过。
- UPLOAD Project 的 AI、Runner、Monad 和 Reward 流程不变。
- PACK 安装仍直接 READY，且不创建 Workflow Job 或 Work Unit。
- Card Pack v1-v4 hash 和发布幂等性不变。

## 15. 分阶段实施

### Phase 1：UPLOAD 原文读取合同

- 增加 Shared Schema。
- 新增 `project-reading.ts` 和 owner-scoped Store。
- 新增 reading Route。
- 完成 Source Block 范围与顺序测试。

完成标准：可以通过 API 读取任一 UPLOAD Chapter 的结构化原文。

### Phase 2：Chapter 双视图

- 拆分 Chapter UI 组件。
- 增加分段控件和 URL 状态。
- 实现原文排版和知识卡浏览展开。
- 保留现有正式复习入口。

完成标准：用户无需离开 Chapter 即可切换原文与全部知识卡。

### Phase 3：引用双向定位

- 实现旧卡 quote/page 匹配。
- 增加卡片查看原文按钮。
- 增加原文关联卡片标记。
- 完成精确命中和 fallback 测试。

完成标准：所有能够精确解析的卡片可以一键定位到原文。

### Phase 4：Card Pack v5 课程正文

- 新增 Pack Reading Block migration。
- 扩展 Card Pack Schema、生成器、校验器和 Publisher。
- 为 Solidity 16 章编写结构化课程正文。
- 为每张 Pack Card 绑定 readingBlockId。

完成标准：Solidity v5 可以在课程正文与知识卡间双向跳转，安装仍不调用 AI。

### Phase 5：视觉与演示验收

- Playwright 验证桌面与移动端。
- 检查长标题、长代码、加载、空状态和错误状态。
- 更新生产演练手册。
- 完成真实 PDF 和 Solidity Pack 的演示路径。

实施状态：Shared/Web/Runner 全量 lint、typecheck、test 和 production build 已通过；远端已执行 `20260802000300_card_pack_reading_v5.sql` 并发布 v5。桌面/移动端使用同一单列阅读与响应式 Chapter Rail，启动开发服务器后按第 17 节验收。

## 16. 黑客松范围建议

以下内容已作为 Hackathon MVP 完成：

1. UPLOAD Chapter 原文阅读。
2. 原文 / 知识卡分段切换。
3. 卡片跳转逐字引用。
4. 浏览与正式复习严格分离。
5. Solidity v5 全部 16 章的课程正文与显式卡片锚点。

以下内容不应阻塞 MVP：

- PDF 像素级查看器。
- 原文批注和多人编辑。
- 用户在线编辑知识卡。
- AI 实时改写正文。
- 全文搜索和语义搜索。
- 阅读位置跨设备同步。

## 17. 演示验收脚本

1. 打开一个 READY 的上传资料 Chapter。
2. 默认看到按页码和标题组织的原文。
3. 切换到知识卡，展开一张卡的答案。
4. 点击“查看原文”，页面切回原文并高亮逐字引用。
5. 点击原文旁的关联卡片标记，回到对应知识卡。
6. 点击“开始复习”，完成一张卡的 FSRS 评分。
7. 退出复习，确认回到原来的 Chapter 视图。
8. 打开 Solidity v5 Pack Chapter，确认标签显示“课程正文”而不是“PDF 原文”。
9. 停止 Runner 后重复阅读和复习，功能仍正常。
10. 查询数据库，确认浏览过程没有新增 ReviewLog，只有正式评分产生状态变化。

## 18. 后续：精确 PDF 查看

如果 Hackathon 后需要显示真正的原始 PDF，再单独实施：

- 上传时把 PDF 二进制保存到私有 Supabase Storage。
- `learning_projects` 保存 object path、hash 和大小。
- 服务端签发短期 owner-scoped URL。
- 使用 PDF.js 渲染并按页码定位。
- Source Block 仍负责引用和 AI provenance，PDF 只负责视觉阅读。
- 制定删除、过期、存储限额和恶意文件扫描策略。

这一阶段不能用公共 URL 暴露用户资料，也不能让 PDF Storage 成为 AI 或复习流程的新单点依赖。
