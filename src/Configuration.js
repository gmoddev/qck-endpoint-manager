const RequiredKeys = [
  'APP_NAME',
  'PUBLIC_HOST',
  'ADMIN_HOST',
  'SESSION_SECRET',
  'OAUTH_PROVIDER_NAME',
  'OAUTH_AUTHORIZE_URL',
  'OAUTH_TOKEN_URL',
  'OAUTH_USERINFO_URL',
  'OAUTH_CLIENT_ID',
  'OAUTH_CLIENT_SECRET',
  'OAUTH_AUTHORIZED_USER_ID',
];

function IsHostname(Value) {
  return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(Value);
}

function IsHttpsUrl(Value) {
  try {
    return new URL(Value).protocol === 'https:';
  } catch {
    return false;
  }
}

export function ValidateEnvironment(Environment = process.env) {
  const Errors = [];
  for (const Key of RequiredKeys) {
    const Value = String(Environment[Key] || '').trim();
    if (!Value || /replace|example\.com/i.test(Value)) Errors.push(`${Key} is missing or still contains a placeholder.`);
  }
  if (!IsHostname(String(Environment.PUBLIC_HOST || ''))) Errors.push('PUBLIC_HOST must be a hostname without a protocol, path, or port.');
  if (!IsHostname(String(Environment.ADMIN_HOST || ''))) Errors.push('ADMIN_HOST must be a hostname without a protocol, path, or port.');
  if (Environment.PUBLIC_HOST === Environment.ADMIN_HOST) Errors.push('PUBLIC_HOST and ADMIN_HOST must be different hostnames.');
  if (String(Environment.SESSION_SECRET || '').length < 32) Errors.push('SESSION_SECRET must contain at least 32 characters.');
  for (const Key of ['OAUTH_AUTHORIZE_URL', 'OAUTH_TOKEN_URL', 'OAUTH_USERINFO_URL']) {
    if (!IsHttpsUrl(String(Environment[Key] || ''))) Errors.push(`${Key} must be an HTTPS URL.`);
  }
  if (Errors.length) throw new Error(`Configuration is invalid:\n- ${[...new Set(Errors)].join('\n- ')}`);
  return true;
}
