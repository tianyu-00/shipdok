// Names both the API and the worker must agree on. Keep them here, not copied into each app.
export const DEPLOY_QUEUE = 'deploy';

// Docker ownership labels. Every lookup and cleanup filters on these.
export const LABEL = {
  managed: 'shipdok.managed',
  app: 'shipdok.app-id',
  deployment: 'shipdok.deployment-id',
  role: 'shipdok.role', // candidate | live
};
