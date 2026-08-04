import { createVercelAegisHandler } from '../infra/aegis-server/vercel-adapter.mjs';

export const config = { maxDuration: 30 };

export default createVercelAegisHandler('/v1/rpc/aegis_ack_device_messages');
