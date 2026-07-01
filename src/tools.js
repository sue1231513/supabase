import * as z from 'zod/v4';
import { callManagementApi, deployEdgeFunctionMultipart, deriveProjectPublicUrl } from './supabaseApi.js';
import { logError, logInfo } from './logger.js';
 
function ok(data) {
  return {
    content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }],
  };
}
 
function fail(message) {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}
 
// 统一包装:自动 try-catch + 打日志 + 转换成 MCP 要求的返回格式,
// 禁止空 catch,任何异常都会被记录到位置+堆栈+关键参数。
function wrapHandler(toolName, handler) {
  return async (params, extra) => {
    try {
      logInfo(`tool:${toolName}`, '开始执行', { params });
      const result = await handler(params, extra);
      return ok(result);
    } catch (error) {
      logError(`tool:${toolName}`, '工具执行失败', error, { params });
      return fail(`${toolName} 执行失败: ${error.message}`);
    }
  };
}
 
/**
 * 把所有 29 个 Supabase 管理工具注册到传入的 McpServer 实例上。
 */
export function registerAllTools(server) {
  // ---------- 项目管理 ----------
 
  server.registerTool(
    'list_projects',
    {
      description: '列出账号下所有 Supabase 项目(跨所有组织)。可选按组织 slug 过滤。',
      inputSchema: {
        organization_slug: z.string().optional().describe('可选,只看某个组织下的项目,例如 "juban-plugin"'),
      },
    },
    wrapHandler('list_projects', async ({ organization_slug }) => {
      const projects = await callManagementApi({ method: 'GET', path: '/v1/projects' });
      if (!organization_slug) return projects;
      return projects.filter((p) => p.organization_slug === organization_slug);
    })
  );
 
  server.registerTool(
    'get_project',
    {
      description: '获取单个 Supabase 项目的详情。',
      inputSchema: { project_ref: z.string().describe('项目的 ref,即 project_id') },
    },
    wrapHandler('get_project', async ({ project_ref }) =>
      callManagementApi({ method: 'GET', path: `/v1/projects/${project_ref}` })
    )
  );
 
  server.registerTool(
    'create_project',
    {
      description: '创建一个新的 Supabase 项目。会占用免费额度或产生费用,请谨慎调用。',
      inputSchema: {
        name: z.string().describe('项目名称'),
        organization_id: z.string().describe('目标组织的 id(不是 slug),可先用 list_organizations 查'),
        region: z.string().describe('区域代码,例如 us-east-1'),
        db_pass: z.string().describe('数据库密码,建议高强度随机字符串'),
        plan: z.enum(['free', 'pro']).optional().describe('方案,默认 free'),
      },
    },
    wrapHandler('create_project', async ({ name, organization_id, region, db_pass, plan }) =>
      callManagementApi({
        method: 'POST',
        path: '/v1/projects',
        body: { name, organization_id, region, db_pass, plan: plan || 'free' },
      })
    )
  );
 
  server.registerTool(
    'get_project_url',
    {
      description: '获取项目对外的 API URL(形如 https://{ref}.supabase.co)。会先验证项目是否存在。',
      inputSchema: { project_ref: z.string() },
    },
    wrapHandler('get_project_url', async ({ project_ref }) => {
      await callManagementApi({ method: 'GET', path: `/v1/projects/${project_ref}` });
      return { project_ref, url: deriveProjectPublicUrl(project_ref) };
    })
  );
 
  server.registerTool(
    'pause_project',
    {
      description: '暂停一个 Supabase 项目。',
      inputSchema: { project_ref: z.string() },
    },
    wrapHandler('pause_project', async ({ project_ref }) =>
      callManagementApi({ method: 'POST', path: `/v1/projects/${project_ref}/pause`, allowEmptyResponse: true })
    )
  );
 
  server.registerTool(
    'restore_project',
    {
      description: '恢复一个已暂停的 Supabase 项目。',
      inputSchema: { project_ref: z.string() },
    },
    wrapHandler('restore_project', async ({ project_ref }) =>
      callManagementApi({ method: 'POST', path: `/v1/projects/${project_ref}/restore`, allowEmptyResponse: true })
    )
  );
 
  // ---------- 组织 ----------
 
  server.registerTool(
    'list_organizations',
    {
      description: '列出这个 PAT 所属账号能访问的所有组织(包括多个组织)。',
      inputSchema: {},
    },
    wrapHandler('list_organizations', async () => callManagementApi({ method: 'GET', path: '/v1/organizations' }))
  );
 
  server.registerTool(
    'get_organization',
    {
      description: '获取单个组织的详情。',
      inputSchema: { organization_slug: z.string() },
    },
    wrapHandler('get_organization', async ({ organization_slug }) =>
      callManagementApi({ method: 'GET', path: `/v1/organizations/${organization_slug}` })
    )
  );
 
  // ---------- 数据库操作 ----------
 
  server.registerTool(
    'execute_sql',
    {
      description: '在指定项目的数据库上执行任意 SQL 语句,返回查询结果。',
      inputSchema: {
        project_ref: z.string(),
        query: z.string().describe('要执行的 SQL 语句'),
      },
    },
    wrapHandler('execute_sql', async ({ project_ref, query }) =>
      callManagementApi({ method: 'POST', path: `/v1/projects/${project_ref}/database/query`, body: { query } })
    )
  );
 
  server.registerTool(
    'apply_migration',
    {
      description: '对项目应用一次数据库迁移(DDL 类操作走这个,而不是 execute_sql)。',
      inputSchema: {
        project_ref: z.string(),
        name: z.string().describe('迁移名称,snake_case'),
        query: z.string().describe('迁移用的 SQL'),
      },
    },
    wrapHandler('apply_migration', async ({ project_ref, name, query }) =>
      callManagementApi({
        method: 'POST',
        path: `/v1/projects/${project_ref}/database/migrations`,
        body: { name, query },
      })
    )
  );
 
  server.registerTool(
    'list_migrations',
    {
      description: '列出项目已经应用过的迁移历史。',
      inputSchema: { project_ref: z.string() },
    },
    wrapHandler('list_migrations', async ({ project_ref }) =>
      callManagementApi({ method: 'GET', path: `/v1/projects/${project_ref}/database/migrations` })
    )
  );
 
  server.registerTool(
    'list_tables',
    {
      description: '列出指定 schema 下的所有表(默认 public schema)。',
      inputSchema: {
        project_ref: z.string(),
        schema: z.string().optional().describe('默认 public'),
      },
    },
    wrapHandler('list_tables', async ({ project_ref, schema }) => {
      const targetSchema = schema || 'public';
      const query = `SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = '${targetSchema.replace(/'/g, "''")}' ORDER BY table_name;`;
      return callManagementApi({ method: 'POST', path: `/v1/projects/${project_ref}/database/query`, body: { query } });
    })
  );
 
  server.registerTool(
    'list_extensions',
    {
      description: '列出项目数据库已安装的 Postgres 扩展。',
      inputSchema: { project_ref: z.string() },
    },
    wrapHandler('list_extensions', async ({ project_ref }) => {
      const query = "SELECT extname, extversion FROM pg_extension ORDER BY extname;";
      return callManagementApi({ method: 'POST', path: `/v1/projects/${project_ref}/database/query`, body: { query } });
    })
  );
 
  // ---------- 开发分支 ----------
 
  server.registerTool(
    'create_branch',
    {
      description: '为项目创建一个开发分支(独立的数据库副本)。',
      inputSchema: {
        project_ref: z.string(),
        branch_name: z.string(),
      },
    },
    wrapHandler('create_branch', async ({ project_ref, branch_name }) =>
      callManagementApi({
        method: 'POST',
        path: `/v1/projects/${project_ref}/branches`,
        body: { branch_name },
      })
    )
  );
 
  server.registerTool(
    'list_branches',
    {
      description: '列出项目所有的开发分支。',
      inputSchema: { project_ref: z.string() },
    },
    wrapHandler('list_branches', async ({ project_ref }) =>
      callManagementApi({ method: 'GET', path: `/v1/projects/${project_ref}/branches` })
    )
  );
 
  server.registerTool(
    'merge_branch',
    {
      description: '把开发分支的变更合并回生产环境。',
      inputSchema: { branch_id: z.string().describe('分支的 id 或 ref') },
    },
    wrapHandler('merge_branch', async ({ branch_id }) =>
      callManagementApi({ method: 'POST', path: `/v1/branches/${branch_id}/merge` })
    )
  );
 
  server.registerTool(
    'rebase_branch',
    {
      description:
        '[暂不可用] Supabase 公开的 Management API 目前没有独立的 rebase 端点,只有语义不同的 reset 端点(把分支重置回生产环境当前状态,不是重放迁移)。为避免误用,这个工具会直接报错,不会静默调用 reset。如果确实要把分支重置到生产环境最新状态,请改用 reset_branch。',
      inputSchema: { branch_id: z.string() },
    },
    wrapHandler('rebase_branch', async () => {
      throw new Error(
        'Supabase Management API 未提供公开的 rebase 端点,这个操作目前做不到。如果你要的是"把分支重置为生产环境最新状态",请改用 reset_branch 工具。'
      );
    })
  );
 
  server.registerTool(
    'reset_branch',
    {
      description: '把开发分支重置回生产环境当前状态(会丢弃分支上未合并的改动)。',
      inputSchema: { branch_id: z.string() },
    },
    wrapHandler('reset_branch', async ({ branch_id }) =>
      callManagementApi({ method: 'POST', path: `/v1/branches/${branch_id}/reset` })
    )
  );
 
  server.registerTool(
    'delete_branch',
    {
      description: '删除一个开发分支。',
      inputSchema: { branch_id: z.string() },
    },
    wrapHandler('delete_branch', async ({ branch_id }) =>
      callManagementApi({ method: 'DELETE', path: `/v1/branches/${branch_id}`, allowEmptyResponse: true })
    )
  );
 
  // ---------- Edge Functions ----------
 
  server.registerTool(
    'list_edge_functions',
    {
      description: '列出项目下所有的 Edge Function。',
      inputSchema: { project_ref: z.string() },
    },
    wrapHandler('list_edge_functions', async ({ project_ref }) =>
      callManagementApi({ method: 'GET', path: `/v1/projects/${project_ref}/functions` })
    )
  );
 
  server.registerTool(
    'get_edge_function',
    {
      description: '获取单个 Edge Function 的详情。',
      inputSchema: { project_ref: z.string(), function_slug: z.string() },
    },
    wrapHandler('get_edge_function', async ({ project_ref, function_slug }) =>
      callManagementApi({ method: 'GET', path: `/v1/projects/${project_ref}/functions/${function_slug}` })
    )
  );
 
  server.registerTool(
    'deploy_edge_function',
    {
      description:
        '部署(创建或更新)一个 Edge Function。走 multipart/form-data,和其他工具的 JSON 请求方式不同。',
      inputSchema: {
        project_ref: z.string(),
        slug: z.string().describe('函数的 slug,也是调用路径的一部分'),
        name: z.string().optional().describe('函数显示名称,默认等于 slug'),
        entrypoint_path: z.string().optional().describe('入口文件名,默认 index.ts'),
        files: z
          .array(z.object({ name: z.string(), content: z.string() }))
          .min(1)
          .describe('函数源码文件列表,至少包含入口文件'),
      },
    },
    wrapHandler('deploy_edge_function', async ({ project_ref, slug, name, entrypoint_path, files }) =>
      deployEdgeFunctionMultipart({
        projectRef: project_ref,
        slug,
        name,
        entrypointPath: entrypoint_path,
        files,
      })
    )
  );
 
  // ---------- 密钥 / 日志 / 建议 / 其他 ----------
 
  server.registerTool(
    'get_publishable_keys',
    {
      description: '获取项目的 API keys(anon/publishable 等),不包含 service_role 密钥的明文除非账号权限允许。',
      inputSchema: { project_ref: z.string() },
    },
    wrapHandler('get_publishable_keys', async ({ project_ref }) =>
      callManagementApi({ method: 'GET', path: `/v1/projects/${project_ref}/api-keys` })
    )
  );
 
  server.registerTool(
    'get_logs',
    {
      description:
        '查询项目日志(edge_logs/postgres_logs 等)。不传时间范围时默认只查最近 1 分钟,时间跨度最长 24 小时。',
      inputSchema: {
        project_ref: z.string(),
        sql: z.string().optional().describe('自定义查询日志用的 SQL,不传则只查 edge_logs'),
        iso_timestamp_start: z.string().optional(),
        iso_timestamp_end: z.string().optional(),
      },
    },
    wrapHandler('get_logs', async ({ project_ref, sql, iso_timestamp_start, iso_timestamp_end }) =>
      callManagementApi({
        method: 'GET',
        path: `/v1/projects/${project_ref}/analytics/endpoints/logs.all`,
        query: { sql, iso_timestamp_start, iso_timestamp_end },
      })
    )
  );
 
  server.registerTool(
    'get_advisors',
    {
      description: '获取项目的安全或性能建议(lint 结果)。',
      inputSchema: {
        project_ref: z.string(),
        type: z.enum(['security', 'performance']),
      },
    },
    wrapHandler('get_advisors', async ({ project_ref, type }) =>
      callManagementApi({ method: 'GET', path: `/v1/projects/${project_ref}/advisors/${type}` })
    )
  );
 
  server.registerTool(
    'generate_typescript_types',
    {
      description: '为项目当前数据库 schema 生成 TypeScript 类型定义。',
      inputSchema: {
        project_ref: z.string(),
        included_schemas: z.string().optional().describe('逗号分隔的 schema 列表,默认 public'),
      },
    },
    wrapHandler('generate_typescript_types', async ({ project_ref, included_schemas }) =>
      callManagementApi({
        method: 'GET',
        path: `/v1/projects/${project_ref}/types/typescript`,
        query: { included_schemas },
      })
    )
  );
 
  server.registerTool(
    'get_cost',
    {
      description:
        '[不可用] Supabase 公开的 Management API 没有提供"创建项目/分支前预估费用"的公开端点,这个功能只存在于官方 Dashboard 内部,调用会直接报错。',
      inputSchema: { organization_slug: z.string().optional() },
    },
    wrapHandler('get_cost', async () => {
      throw new Error(
        'get_cost 在公开的 Supabase Management API 里没有对应端点,无法实现,不是漏写。费用请直接去 Supabase Dashboard 的 Billing 页面查看。'
      );
    })
  );
 
  server.registerTool(
    'confirm_cost',
    {
      description: '[不可用] 同 get_cost,官方 Dashboard 内部专用,公开 API 没有开放,调用会直接报错。',
      inputSchema: {},
    },
    wrapHandler('confirm_cost', async () => {
      throw new Error('confirm_cost 在公开的 Supabase Management API 里没有对应端点,无法实现,不是漏写。');
    })
  );
 
  server.registerTool(
    'search_docs',
    {
      description: '用 GraphQL 查询搜索 Supabase 官方文档。',
      inputSchema: {
        graphql_query: z.string().describe('合法的 GraphQL 查询语句,针对 Supabase 文档站的 GraphQL schema'),
      },
    },
    wrapHandler('search_docs', async ({ graphql_query }) => {
      const res = await fetch('https://api.supabase.com/platform/docs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: graphql_query }),
      });
      const text = await res.text();
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (parseError) {
        logError('tool:search_docs', '文档搜索返回内容不是合法 JSON', parseError, { status: res.status });
        throw new Error(`文档搜索接口返回了非预期内容 (HTTP ${res.status})`);
      }
      if (!res.ok) {
        throw new Error(`文档搜索失败: HTTP ${res.status}`);
      }
      return parsed;
    })
  );
}
