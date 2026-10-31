export const permissionDescriptions = {
  'https://www.googleapis.com/auth/youtube.readonly': 'Consultar tu canal y sus datos para identificarlo en LOP.',
  'https://www.googleapis.com/auth/youtube.upload': 'Permitir la carga de videos cuando esa función esté disponible.',
  pages_show_list: 'Mostrar las páginas de Facebook que administras.',
  pages_read_engagement: 'Consultar información y actividad de tus páginas.',
  pages_manage_posts: 'Administrar publicaciones de tus páginas cuando esa función esté disponible.',
  business_management: 'Consultar los negocios y recursos que puedes administrar.',
  instagram_basic: 'Identificar tu cuenta profesional de Instagram.',
  instagram_content_publish: 'Permitir publicaciones en Instagram cuando esa función esté disponible.',
  instagram_manage_insights: 'Consultar estadísticas de tu cuenta profesional.',
  'user.info.basic': 'Consultar tu nombre y avatar de TikTok para identificar la cuenta.',
  openid: 'Confirmar tu identidad con Google.',
  email: 'Consultar el correo de tu cuenta de Google.',
  profile: 'Consultar tu nombre y foto de Google.',
  'https://www.googleapis.com/auth/userinfo.email': 'Consultar el correo de tu cuenta de Google.',
  'https://www.googleapis.com/auth/userinfo.profile': 'Consultar tu nombre y foto de Google.',
};

export function getAccountPermissions(account, required = []) {
  const granted = account.grantedScopes || [];
  return [...new Set([...required, ...granted])].map((scope) => ({
    scope,
    description: permissionDescriptions[scope] || 'Permiso adicional registrado por la plataforma; su uso requiere revisión.',
    status: !granted.includes(scope) ? 'Pendiente de autorización'
      : account.status !== 'connected' || (account.expiresAt && account.expiresAt <= Date.now()) ? 'Autorización no vigente'
        : account.verificationError ? 'Registrado · requiere revisión'
        : !account.verifiedAt ? 'Registrado · pendiente de verificar'
          : 'Concedido en la última comprobación',
  }));
}
