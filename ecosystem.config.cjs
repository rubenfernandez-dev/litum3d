module.exports = {
  apps: [
    {
      name: 'litum3d',
      script: 'server.js',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        PORT: process.env.PORT || 3000,
      },
      watch: false,
      max_memory_restart: '300M',
      error_file: './logs/err.log',
      out_file: './logs/out.log',
      time: true,
    },
  ],
};
