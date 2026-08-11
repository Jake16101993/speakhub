import historyHandler from '../lib/api/customers/history.js';
import loginHandler from '../lib/api/customers/login.js';

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const action = url.searchParams.get('action');

    if (action === 'history') return historyHandler.fetch(request);
    if (action === 'login') return loginHandler.fetch(request);

    return Response.json({ error: 'NOT_FOUND' }, { status: 404 });
  }
};
