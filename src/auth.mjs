// 身份主体来自受控运行环境配置（ACCEPTANCE_PRINCIPALS，JSON 数组），
// 未配置时使用仅供本地开发的内置主体。项目级权限由授权事件决定，
// 观察员仅对其被授权的项目有只读访问。

export function loadPrincipals(env = process.env) {
  if (env.ACCEPTANCE_PRINCIPALS) return JSON.parse(env.ACCEPTANCE_PRINCIPALS);
  return [
    { principalId: "buyer-1", org: "buyer-org", token: "dev-buyer-token" },
    { principalId: "supplier-1", org: "supplier-org", token: "dev-supplier-token" },
    { principalId: "observer-1", org: "audit-org", token: "dev-observer-token" },
    { principalId: "observer-2", org: "audit-org", token: "dev-observer-2-token" },
  ];
}

export function authenticate(request, principals) {
  const header = request.headers.authorization ?? "";
  const match = /^Bearer\s+(.+)$/.exec(header);
  if (!match) return null;
  return principals.find((principal) => principal.token === match[1]) ?? null;
}
