import { ValidateEnvironment } from '../src/Configuration.js';

try {
  process.loadEnvFile?.();
} catch (Error) {
  if (Error.code !== 'ENOENT') throw Error;
}
ValidateEnvironment(process.env);
console.log('[EndpointManager:Config] Configuration is valid.');
