// GAP-INF2 CLOSED: PM2 process manager configuration.
// Usage: pm2 start ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: 'majlis-agent',
      script: 'dist/index.js',
      node_args: '--env-file=.env',
      instances: 1, // SQLite requires single instance
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
      },
      // Logging
      error_file: './logs/agent-error.log',
      out_file: './logs/agent-out.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },
  ],
};
