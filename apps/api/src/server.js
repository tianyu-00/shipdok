import { assertConfig, config } from './config.js';
import { createApp } from './app.js';

assertConfig();
createApp().listen(config.port, config.host, () => {
  console.log(`API listening on http://${config.host}:${config.port}`);
});
