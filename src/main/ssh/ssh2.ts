// ssh2 is CommonJS; Node's ESM loader cannot see all of its named exports.
import ssh2 from 'ssh2'

export const Client = ssh2.Client
export type Client = import('ssh2').Client
export const utils = ssh2.utils
