import createHandler from '../lib/api/payos/create.js';
import reconcileHandler from '../lib/api/payos/reconcile.js';
import webhookHandler from '../lib/api/payos/webhook.js';

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const action = url.searchParams.get('action');

    if (action === 'create') return createHandler.fetch(request);
    if (action === 'reconcile') return reconcileHandler.fetch(request);
    if (action === 'webhook') return webhookHandler.fetch(request);

    return Response.json({ error: 'NOT_FOUND' }, { status: 404 });
  }
};
