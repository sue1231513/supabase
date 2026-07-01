# supabase-multi-org-mcp
 
自建 MCP 服务器,用**一个** Supabase Personal Access Token(PAT)同时管理你名下多个组织的项目,
绕开 claude.ai 官方 Supabase 连接器"一次只能授权一个组织"的限制(这是 Supabase OAuth 连接器本身
的已知限制,不是 claude.ai 的问题:https://github.com/supabase/mcp/issues/304)。
 
## 为什么一个 PAT 就够
 
Supabase 的 Personal Access Token 是**账号级别**的,不是组织级别的。只要你的账号xxx
同时是 `xxx` 和 `xxx` 这两个组织的成员,一个 PAT 就能操作两边所有项目,不需要
给每个组织单独生成 token。
 
## 包含的 29 个工具
 
项目管理:`list_projects` `get_project` `create_project` `get_project_url` `pause_project` `restore_project`
 
组织:`list_organizations` `get_organization`
 
数据库:`execute_sql` `apply_migration` `list_migrations` `list_tables` `list_extensions`
 
开发分支:`create_branch` `list_branches` `merge_branch` `rebase_branch`(不可用,见下)`reset_branch` `delete_branch`
 
Edge Functions:`list_edge_functions` `get_edge_function` `deploy_edge_function`
 
其他:`get_publishable_keys` `get_logs` `get_advisors` `generate_typescript_types` `get_cost`(不可用)`confirm_cost`(不可用)`search_docs`
 
### 两个工具目前用不了,不是漏写
 
- **`rebase_branch`**:Supabase 公开的 Management API 没有独立的 rebase 端点,调用会直接返回报错说明,
  不会偷偷改成语义不同的 `reset`。
- **`get_cost` / `confirm_cost`**:创建项目/分支前的费用预估,只存在于官方 Dashboard 内部,公开 API
  没有开放,调用会直接报错。费用请去 Supabase Dashboard 的 Billing 页面看。
## 部署到 Zeabur
 
1. 把这个文件夹推到你的 GitHub 仓库(比如 `sue1231513/supabase`)
2. Zeabur 新建一个 Service,选择从这个 GitHub 仓库部署,构建方式选 Node.js(Zeabur 会自动识别
   `package.json`,跑 `npm install` + `npm start`)
3. 在 Zeabur 这个 service 的 **环境变量** 里加两个:
   - `SUPABASE_PAT`:你在 Supabase 后台 Account → Access Tokens 生成的 PAT
   - `MCP_PROXY_SECRET`:自己定一个高强度随机字符串,用来防止别人拿着 URL 白嫖你的 Supabase 权限
4. 部署完成后,Zeabur 会给一个域名,比如 `https://supabase-multi-org-mcp.zeabur.app`
5. 访问 `https://你的域名/health` 应该返回 `{"status":"ok",...}`,说明服务活着
## 连接到 claude.ai
 
1. Claude 设置 → Connectors → **Add custom connector**
2. Name:随便填,比如"Supabase 多组织"
3. Remote MCP server URL 填:
```
   https://你的域名/mcp?key=你在MCP_PROXY_SECRET里填的那个字符串
```
4. Advanced settings 里的 OAuth Client ID / Secret **不用填**,留空
5. 点 Add,新对话里选中这个连接器就能用了
## 本地调试
 
```bash
cp .env.example .env
# 编辑 .env,填入真实的 SUPABASE_PAT 和 MCP_PROXY_SECRET
npm install
npm start
```
 
用 `curl` 简单测试(以 `list_organizations` 为例,MCP 走的是 JSON-RPC over HTTP):
 
```bash
curl -X POST "http://localhost:3000/mcp?key=你的MCP_PROXY_SECRET" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc":"2.0",
    "id":1,
    "method":"initialize",
    "params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl-test","version":"1.0"}}
  }'
```
 
## 安全提醒
 
- `SUPABASE_PAT` 权限等于你整个 Supabase 账号,不只是这一个项目,**千万别提交进 GitHub**,`.gitignore`
  里已经排除了 `.env`,但仍要小心不要手滑复制进代码文件里
- `MCP_PROXY_SECRET` 一定要配置,不配置的话这个服务对着 URL 就是完全公开的,任何人都能操作你的
  Supabase 账号下所有项目
- 这个服务部署在 Zeabur 上跑的是你自己的服务器,不受 claude.ai 内容安全策略约束,连接的时候
  claude.ai 会提示"这不是 Anthropic 验证过的连接器",这是正常的,自建的都会有这提示
