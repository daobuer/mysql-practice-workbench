# AGENTS.md

## 项目概览
MySQL 练习场是一个单端口全栈应用：原生 HTML/CSS/JavaScript 前端生成 SQL，NestJS + mysql2 后端校验结构化操作并连接真实 MySQL 执行。不使用前端框架，不返回 Mock 数据。

## 构建与检查
- 包管理器仅使用 pnpm。
- `pnpm dev`：tsx watch 开发服务，读取 `DEPLOY_RUN_PORT`。
- `pnpm typecheck`：检查两个前端 JS 文件语法并运行 TypeScript 严格检查。
- `pnpm build`：编译到 `dist/`。
- `pnpm start`：运行生产构建。
- 沙箱内统一使用 test_run 执行静态检查与接口测试，不用 shell 替代。

## 目录定位
- `public/index.html`：页面结构、连接弹窗、结果与历史区域。
- `public/styles.css`：实验记录纸视觉、桌面与移动端布局。
- `public/app.js`：级联状态、动态表单、元数据加载、请求与结果渲染。
- `public/sql.js`：前端操作目录与字面量 SQL 预览。
- `src/sql.builder.ts`：后端白名单校验、参数化 SQL 与保护规则。
- `src/mysql.service.ts`：连接生命周期、information_schema 元数据和真实执行。
- `src/app.controller.ts`：API 路由。
- `src/main.ts`：Nest 启动、静态资源与端口配置。
- `DESIGN.md`：视觉和交互规范，UI 改动前先读。

## API
- `GET /api/health`：服务健康检查。
- `POST /api/connection/test`：请求体含 `connection`，测试真实连接。
- `POST /api/metadata`：请求体含 `connection` 和可选 `database`，读取库表字段。
- `POST /api/execute`：请求体含 `connection` 和 `operation`，支持 createDatabase、connectDatabase、createTable、insert、select、update、delete。

## 安全与维护约束
- 前端不得接收或提交任意 SQL 给后端执行；新增操作必须扩展结构化 Operation 联合类型和两端 SQL 生成器。
- 查询值只能参数绑定；标识符、类型、运算符、排序、LIMIT 必须白名单校验。
- UPDATE 与 DELETE 不得取消 WHERE 强制保护；连接不得开启 multipleStatements。
- 密码仅存在内存并随请求发送，禁止写入 localStorage、历史记录或日志。
- 新增或修改操作时同步检查 `public/sql.js` 与 `src/sql.builder.ts`，并用真实 MySQL/MariaDB 验证，不用假数据替代。
- 动态结果使用 textContent/DOM 节点渲染，避免数据库内容通过 innerHTML 造成 XSS。
