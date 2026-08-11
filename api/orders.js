import cancelHandler from '../lib/api/orders/cancel.js';
import statusHandler from '../lib/api/orders/status.js';

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const action = url.searchParams.get('action');

    if (action === 'cancel') return cancelHandler.fetch(request);
    if (action === 'status') return statusHandler.fetch(request);

    return Response.json({ error: 'NOT_FOUND' }, { status: 404 });
  }
};
