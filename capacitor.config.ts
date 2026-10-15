import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: process.env.FORSURE_APP_VARIANT === 'messenger' ? 'fans.forsure.messenger' : 'fans.forsure.app',
  appName: process.env.FORSURE_APP_VARIANT === 'messenger' ? 'ForSure Messages' : 'Forsure',
  webDir: 'dist',
  plugins: {
    CapacitorHttp: {
      enabled: true,
    },
  },
  ios: {
    contentInset: 'automatic',
  },
};

export default config;
