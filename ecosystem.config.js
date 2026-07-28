module.exports = {
  apps: [
    {
      name: 'weight-bot',
      script: 'index.js',
      interpreter: 'node',
      cwd: __dirname,
      env: {
        NODE_ENV: 'production',
        WEIGHT_DB_PATH: '/var/lib/weight-bot/weight.db',
      },
      autorestart: true,
      watch: false,
      max_restarts: 10,
      restart_delay: 5000,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },
  ],
};
