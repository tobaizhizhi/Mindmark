# Mindmark 原版 PDF 预览与可复制文字架构方案

> 状态：已实施（MVP）
>
> 日期：2026-08-02
>
> 适用范围：上传 PDF 类型的 Learning Project
>
> 关联文档：DOCUMENT_CARD_DUAL_VIEW_IMPLEMENTATION_PLAN.md

## 1. 背景

当前上传流程只在浏览器中读取 PDF，并将页面文字转换为 SourcePage。服务端最终保存的是 source_blocks、文件名、MIME 类型、页数和提取字符数。

原始 PDF 二进制不会上传，因此当前“原文”是结构化提取文本，不是保留原始排版的 PDF。已经上传的旧项目无法恢复原文件，必须重新上传。

本方案增加原始 PDF 持久化，同时保留现有结构化文本，使 Chapter 内可以切换：

    原版 PDF（原始排版、可复制文字）
    提取正文（结构化文本、来源块定位）
    知识卡（主动回忆和卡片浏览）

## 2. 设计目标

### 2.1 MVP 必须支持

1. 新上传 PDF 可以长期查看原始排版。
2. 普通文字型 PDF 可以鼠标选中并复制文字。
3. 支持 Ctrl/Cmd+C 和“复制本页文字”命令。
4. 从章节和知识卡跳转到对应 PDF 页。
5. 原始 PDF 加载失败时退回提取正文。
6. 原始文件只允许项目所有者访问。
7. 同一个 PDF 可以创建多个项目，每个项目有独立文件路径。
8. 不把 PDF 二进制写入数据库、区块链或 Outline Hash。

### 2.2 不在 MVP 范围

- PDF 内容在线编辑。
- 跨项目全文搜索。
- 全量扫描件 OCR。
- 将 PDF 上传到 Monad 或 IPFS。

## 3. 总体架构

    浏览器选择 PDF
           │
           ├── PDF.js 提取文字 ──> SourcePage ──> 章节分析 / 知识卡生成
           │
           └── 原始文件上传 ────> Supabase 私有 Storage
                                          │
                                          └── 路径和哈希写入 learning_projects

    Chapter 学习页
           │
           ├── 原版 PDF：Canvas + Text Layer
           ├── 提取正文：source_blocks
           └── 知识卡：knowledge_cards

原始 PDF 与提取正文是同一资料的两种读取表示：

- PDF 用于视觉还原、复制和页码导航。
- source_blocks 用于章节范围、AI 证据、卡片来源和降级展示。

## 4. 数据模型

### 4.1 learning_projects 新增字段

新增数据库迁移：

    alter table public.learning_projects
      add column source_storage_bucket text,
      add column source_storage_path text,
      add column source_file_sha256 text,
      add column source_file_size bigint,
      add column source_file_status text not null default 'MISSING';

source_file_status 取值：

    MISSING | UPLOADING | READY | FAILED

字段约束：

- Bucket 固定为 learning-source-files。
- 路径必须包含项目 ID，禁止使用客户端任意路径。
- 文件大小不超过 15 MB。
- 只有 UPLOAD 项目允许写入原始 PDF。

现有哈希语义不能混用：

    source_hash        = 提取后的 Source Block 哈希
    source_file_sha256 = 原始 PDF 文件哈希

### 4.2 Storage

创建私有 Bucket：

    learning-source-files

对象路径：

    /{ownerAddress}/{projectId}/source.pdf

相同 PDF 创建多个项目时，按项目路径分别保存，不能使用全局文件唯一约束。

Bucket 要求：

- public = false
- file_size_limit = 15 MB
- allowed_mime_types = application/pdf

删除项目时同步删除对象。数据库级联删除不会自动清理 Storage，需要删除服务或定期清理任务处理孤儿文件。

## 5. 上传流程

### 5.1 浏览器阶段

继续使用现有 PDF.js 提取流程：

1. 校验大小和 PDF 文件头。
2. 提取 SourcePage。
3. 本地显示页数和字符数。
4. 保留 File 对象直到项目注册完成。

提取失败时不上传原文件，避免保存无法学习的扫描件。

### 5.2 项目注册

保留接口：

    POST /api/projects/intake

该接口继续负责注册项目、保存 source_blocks 和启动结构分析。

### 5.3 原文件上传

新增接口：

    POST /api/projects/{projectId}/source-file
    Content-Type: multipart/form-data

服务端流程：

1. 校验钱包会话和项目 owner。
2. 校验项目类型为 UPLOAD。
3. 校验大小、MIME 和 PDF 文件签名。
4. 计算 source_file_sha256。
5. 上传到固定 Storage 路径。
6. 更新文件字段和状态。
7. 返回 READY、大小和哈希。

原文件上传失败时不阻止提取正文和知识卡生成；项目会显示“原版 PDF 未就绪”，并提供重新上传入口。

同一个项目重复上传时覆盖固定路径；不同项目即使内容相同，也使用不同路径。

## 6. 文件访问 API

新增接口：

    GET /api/projects/{projectId}/source-file

服务端验证 owner 后返回 5-10 分钟有效的 Signed URL：

    {
      "available": true,
      "url": "https://...",
      "filename": "operating-system.pdf",
      "fileSize": 7340032,
      "expiresAt": "2026-08-02T12:00:00Z"
    }

不生成永久公开链接，也不将 Signed URL 写入数据库或 localStorage。

如果 Storage Signed URL 不支持浏览器 Range 请求，则增加内容代理：

    GET /api/projects/{projectId}/source-file/content

代理必须支持 Range、Content-Length、Content-Range 和 Accept-Ranges，避免大 PDF 每次整文件下载。

## 7. PDF.js 可复制预览

### 7.1 双层渲染

每页必须使用 Canvas 和文字层叠加：

    .pdf-page
    ├── canvas.pdf-canvas       // 原始视觉渲染
    └── .pdf-text-layer         // 可复制文字层

渲染流程：

1. 使用 PDF.js getDocument 加载 PDF。
2. 使用 getPage 获取页面。
3. 使用 page.render 绘制 Canvas。
4. 使用 page.getTextContent 获取文字和坐标。
5. 使用 PDF.js TextLayer API 渲染文字 span。
6. 根据同一个 viewport 同步 Canvas 和 Text Layer 尺寸。

不能只渲染 Canvas。Canvas 内的文字不是 DOM 文本，无法正常选择和复制。

### 7.2 复制行为

文字层必须允许文本选择：

    .pdf-text-layer {
      user-select: text;
      cursor: text;
      pointer-events: auto;
    }

默认支持：

- 鼠标拖选。
- Ctrl/Cmd+C。
- 浏览器右键复制。
- “复制本页文字”按钮。

复制按钮使用 getTextContent 的 str 字段按 PDF 顺序拼接，并调用 navigator.clipboard.writeText。Clipboard API 不可用时使用隐藏 textarea 降级。

### 7.3 扫描件

如果 getTextContent 没有文字：

- 仍显示 Canvas 页面。
- 禁用“复制本页文字”。
- 显示“此页没有可复制文本”。
- 不影响原版视觉预览。

后续 OCR 产生的文字应作为新的 source_blocks 版本保存，不能覆盖原 PDF。

## 8. Chapter 页面改造

视图状态从 reading/cards 改为：

    pdf | text | cards

UPLOAD 项目显示：

    原版 PDF | 提取正文 | 知识卡

PACK 项目显示：

    课程正文 | 知识卡

默认策略：

1. 文件状态为 READY：默认 pdf。
2. 文件缺失或失败：默认 text。
3. PACK 项目：默认 text。
4. 用户选择写入 URL：?view=pdf、?view=text、?view=cards。

Chapter 已有 page_start/page_end，PDF 视图只加载当前章节页面。

卡片来源跳转：

    知识卡来源
      ↓
    切换到 ?view=pdf
      ↓
    跳转到 source.page
      ↓
    高亮对应文字；无法精确匹配时高亮整页

建议新增组件：

    components/pdf-document-viewer.tsx
    components/pdf-page-view.tsx
    components/pdf-copy-button.tsx
    lib/client/pdf-viewer.ts

chapter-reading-view.tsx 继续只负责提取正文，chapter-card-browser.tsx 继续只负责知识卡浏览；PDF Viewer 不生成卡片，也不修改复习状态。

## 9. 性能、安全和兼容

### 9.1 性能

- 只加载当前 Chapter 页面。
- 使用 IntersectionObserver 懒渲染。
- 页面离开视口后释放 Canvas。
- 使用 PDF.js Worker。
- 使用 Storage Range 请求。
- 移动端默认 fit-width。
- PDF 失败只影响 PDF 视图，不影响正文和卡片。

### 9.2 安全

- Bucket 必须私有。
- 所有读取经过钱包 owner 校验。
- Signed URL 有效期不超过 10 分钟。
- 路径由服务端生成。
- 原 PDF 不上链、不进入 Outline Hash。
- 删除项目时删除 Storage 对象。
- 不记录 Signed URL。

### 9.3 旧项目

旧项目默认 source_file_status = MISSING：

    原版 PDF：显示未上传状态，可重新上传
    提取正文：继续可用
    知识卡：继续可用

旧项目需要重新上传原始 PDF。重新上传只更新文件字段，不重新生成章节，不改变现有 Outline Hash。

## 10. 测试与验收

### 10.1 测试

- 文件头、MIME、大小和 SHA-256 校验。
- owner 越权读取被拒绝。
- Signed URL 过期和项目删除。
- 相同 PDF 创建多个项目不覆盖。
- PDF.js Text Layer 文本顺序正确。
- 鼠标选择和复制本页文字。
- 无文字层页面正确降级。
- Chapter 页正确加载 page_start/page_end。
- 卡片来源跳转到 PDF 页面。
- 移动端 Canvas 与 Text Layer 不错位。

### 10.2 MVP 验收路径

    上传 PDF
      ↓
    分析章节并生成知识卡
      ↓
    打开 Chapter
      ↓
    查看原始 PDF 排版
      ↓
    拖选并复制文字
      ↓
    切换到提取正文
      ↓
    切换到知识卡
      ↓
    从卡片来源跳回 PDF 对应页

原始 PDF 只服务阅读和复制；章节划分、知识卡生成、复习调度和 Monad 提交继续复用现有流程。

## 11. 实施顺序

### Phase 1：文件持久化（已完成）

- Storage Bucket 和数据库迁移。
- 原始文件上传接口。
- Signed URL 接口。
- 新项目保存原始 PDF。

### Phase 2：可复制 PDF Viewer（已完成）

- Canvas + Text Layer 双层渲染。
- 复制本页、缩放、页码和章节范围。
- 扫描件降级状态。

### Phase 3：学习流程联动（已完成）

- 增加 pdf/text/cards 三态视图。
- 卡片来源跳转 PDF。
- 旧项目重新上传入口。
- PDF 失败自动退回提取正文。

### Phase 4：稳定性增强（后续）

- Range 请求和懒加载。
- Storage 孤儿文件清理。
- OCR 扩展点。
- 大文件和移动端性能优化。
